/**
 * Live join-page verification driver (puppeteer-core + system Chrome).
 *
 *   node _verify-join.mjs baseline   — reproduce the bugs, no assertions
 *   node _verify-join.mjs full       — assert the fixed flows end-to-end
 *
 * MetaMask is simulated by a minimal EIP-1193 shim injected before page
 * scripts; signing/sending runs in NODE via viem with SELLER_PRIVATE_KEY
 * (the key never enters page JS). Passkeys use a CDP virtual authenticator.
 */
import puppeteer from 'puppeteer-core';
import { createPublicClient, createWalletClient, http, erc20Abi, parseEther } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { estimateArcFeesWithFloor } from './token-utils.js';
import path from 'node:path';
import fs from 'node:fs';

try { process.loadEnvFile(); } catch { /* env already set */ }

const MODE = process.argv[2] || 'baseline';
const BASE = process.env.VERIFY_BASE || 'http://localhost:3000';
const SHOTS = path.join(process.cwd(), 'join-fix-evidence');
fs.mkdirSync(SHOTS, { recursive: true });

const RPC = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';
const USDC = process.env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000';
const chain = {
  id: Number(process.env.ARC_CHAIN_ID || 5042002), name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC] }, public: { http: [RPC] } },
};
const pub = createPublicClient({ chain, transport: http(RPC) });
const seller = privateKeyToAccount(process.env.SELLER_PRIVATE_KEY);
const sellerWallet = createWalletClient({ account: seller, chain, transport: http(RPC) });

// The simulated MetaMask user is a FRESH viewer wallet (a seller-as-viewer
// join is rejected as self_transfer by the facilitator). In full mode it is
// funded from the seller: native USDC for gas + ERC-20 USDC to deposit.
const account = MODE === 'full'
  ? privateKeyToAccount(generatePrivateKey())
  : seller; // baseline only reads state — the seller works fine for that
const wallet = createWalletClient({ account, chain, transport: http(RPC) });
console.log('[verify] simulated MetaMask address:', account.address);

if (MODE === 'full' && account.address !== seller.address) {
  console.log('[verify] funding fresh viewer wallet from seller…');
  const fees = await estimateArcFeesWithFloor(pub);
  const gasTx = await sellerWallet.sendTransaction({
    to: account.address, value: parseEther('0.05'), ...fees,
  });
  await pub.waitForTransactionReceipt({ hash: gasTx });
  const usdcTx = await sellerWallet.writeContract({
    address: USDC, abi: erc20Abi, functionName: 'transfer',
    args: [account.address, 1_000_000n], ...fees, // 1.0 USDC (6 decimals)
  });
  await pub.waitForTransactionReceipt({ hash: usdcTx });
  console.log('[verify] viewer funded: 0.05 native (gas) + 1.0 USDC (ERC-20)');
}

let failures = 0;
const ok = (m) => console.log('  ✅', m);
const bad = (m) => { failures++; console.error('  ❌', m); };
const note = (m) => console.log('  ℹ️', m);
const expect = (cond, okMsg, badMsg) => (cond ? ok(okMsg) : bad(badMsg));

async function nodeEth(method, params) {
  switch (method) {
    case 'eth_call':
      return pub.request({ method, params });
    case 'eth_getTransactionReceipt': {
      const r = await pub.request({ method, params });
      return r; // null until mined — page polls
    }
    case 'eth_sendTransaction': {
      const [tx] = params;
      const fees = await estimateArcFeesWithFloor(pub);
      const hash = await wallet.sendTransaction({
        to: tx.to, data: tx.data,
        value: tx.value ? BigInt(tx.value) : undefined,
        ...fees,
      });
      console.log('  [shim] sent tx', method, '→', hash);
      return hash;
    }
    case 'eth_signTypedData_v4': {
      const [, json] = params;
      const td = JSON.parse(json);
      const { EIP712Domain, ...types } = td.types;
      return account.signTypedData({
        domain: td.domain, types, primaryType: td.primaryType, message: td.message,
      });
    }
    default:
      return pub.request({ method, params });
  }
}

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: [
    '--no-first-run', '--disable-features=Translate',
    // Fake camera so the vdo.ninja publisher can actually acquire media.
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-capture',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

async function newPage({ withWallet }) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 1400 });
  page.on('console', (m) => console.log(`  [page:${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => console.log('  [page:EXCEPTION]', e.message));
  await page.exposeFunction('__nodeEth', async (method, paramsJson) => {
    try {
      const res = await nodeEth(method, JSON.parse(paramsJson));
      return JSON.stringify({ ok: true, res: res ?? null });
    } catch (e) {
      return JSON.stringify({ ok: false, err: e.shortMessage || e.message });
    }
  });
  await page.evaluateOnNewDocument((addr, chainIdHex, inject) => {
    // Deterministic deposit amount instead of a blocking prompt() dialog.
    window.prompt = (msg, def) => (window.__promptValue ?? def ?? null);
    if (!inject) return;
    const listeners = {};
    window.ethereum = {
      isMetaMask: true,
      on: (ev, fn) => { (listeners[ev] ||= []).push(fn); },
      removeListener: () => {},
      async request({ method, params = [] }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr];
        if (method === 'eth_chainId') return chainIdHex;
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
        const raw = await window.__nodeEth(method, JSON.stringify(params));
        const { ok, res, err } = JSON.parse(raw);
        if (!ok) throw new Error(err);
        return res;
      },
    };
  }, account.address, '0x4cef52', withWallet);
  return page;
}

const $text = (page, sel) => page.$eval(sel, (el) => el.textContent.trim()).catch(() => null);
const $disabled = (page, sel) => page.$eval(sel, (el) => el.disabled).catch(() => null);
const shot = async (page, name) => {
  const file = path.join(SHOTS, `${MODE}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  note(`screenshot → ${path.relative(process.cwd(), file)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n═══ [A] MetaMask / Gateway flow (${MODE}) ═══`);
{
  const page = await newPage({ withWallet: true });
  await page.goto(`${BASE}/join?room=default`, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('#connectBtn', { timeout: 30000 });
  await sleep(1500); // loadConfig + initWallet
  await shot(page, 'A1-initial');

  note(`initial: depositBtn.disabled=${await $disabled(page, '#depositBtn')} joinBtn.disabled=${await $disabled(page, '#joinBtn')}`);

  await page.type('#username', 'verify-mm');
  await page.click('#connectBtn');
  await sleep(4000); // connect + refreshBalance round trip
  await shot(page, 'A2-connected');

  const walletInfo = await $text(page, '#walletInfo');
  const remaining = await $text(page, '#meterRemaining');
  const depDisabled = await $disabled(page, '#depositBtn');
  const joinDisabled = await $disabled(page, '#joinBtn');
  note(`connected: walletInfo="${walletInfo}"`);
  note(`connected: meterRemaining="${remaining}" depositBtn.disabled=${depDisabled} joinBtn.disabled=${joinDisabled}`);

  if (MODE === 'full') {
    expect(walletInfo && walletInfo.includes(account.address.slice(2, 10)), 'wallet address shown after connect', `wallet address missing from walletInfo ("${walletInfo}")`);
    // Fresh viewer wallet: correct display is a real "0 USDC" (fetched), not a
    // blank "—". The funded-wallet display (10 USDC) is proven in baseline;
    // the post-deposit assertion below proves live balance reflection.
    expect(remaining != null && /USDC/.test(remaining), `balance fetch rendered ("${remaining}")`, `balance never rendered ("${remaining}")`);
    expect(depDisabled === false, 'deposit button ENABLED when connected', 'deposit button still disabled after connect');

    // Real deposit: approve + deposit 0.2 USDC through the page's own code path.
    await page.evaluate(() => { window.__promptValue = '0.2'; });
    const balBefore = await (await fetch(`${BASE}/api/balance/${account.address}?room=default`)).json();
    note(`gateway available before deposit: ${balBefore.available}`);
    await page.click('#depositBtn');
    // approve tx + deposit tx, each waits for receipt (2s poll)
    await page.waitForFunction(
      () => document.getElementById('message')?.textContent.includes('Deposited')
         || document.getElementById('message')?.textContent.includes('failed'),
      { timeout: 180000 },
    );
    const depositMsg = await $text(page, '#message');
    expect(/Deposited 0.2 USDC/.test(depositMsg), 'deposit flow completed through page UI', `deposit flow failed: "${depositMsg}"`);
    await shot(page, 'A3-deposited');

    // Poll the gateway until the deposit reflects (finalization can lag).
    let balAfter = null;
    for (let i = 0; i < 24; i++) {
      balAfter = await (await fetch(`${BASE}/api/balance/${account.address}?room=default`)).json();
      if (parseFloat(balAfter.available) > parseFloat(balBefore.available)) break;
      await sleep(5000);
    }
    note(`gateway available after deposit: ${balAfter.available} (before: ${balBefore.available})`);
    expect(parseFloat(balAfter.available) > parseFloat(balBefore.available), 'Gateway balance INCREASED after page-driven deposit', 'Gateway balance did not increase after deposit');

    // The PAGE must reflect the finalized deposit — this is the reported
    // "balance shows 0" symptom. Trigger the page's own refresh and read the meter.
    await page.evaluate(() => window.refreshBalance && window.refreshBalance());
    await sleep(2500);
    const remainingAfterDeposit = await $text(page, '#meterRemaining');
    expect(
      parseFloat(remainingAfterDeposit) > 0,
      `page meter reflects Gateway deposit ("${remainingAfterDeposit}")`,
      `page meter still not reflecting deposit ("${remainingAfterDeposit}")`,
    );
    await shot(page, 'A3b-balance-reflected');

    // Join: 402 → sign EIP-3009 in shim → settle → seat.
    await page.click('#joinBtn');
    await page.waitForFunction(
      () => document.getElementById('message')?.textContent.includes('Authorized')
         || document.getElementById('message')?.textContent.includes('❌'),
      { timeout: 120000 },
    );
    const joinMsg = await $text(page, '#message');
    expect(/Authorized/.test(joinMsg), 'JOIN succeeded (payment settled, seat granted)', `join failed: "${joinMsg}"`);
    await shot(page, 'A4-joined');
    const meterAfterJoin = await $text(page, '#meterRemaining');
    note(`meter after join: remaining="${meterAfterJoin}"`);
    // Leave so the seat refunds and doesn't tick forever.
    await page.evaluate(() => window.leaveStream && window.leaveStream());
    await sleep(3000);
    note('left the seat (refund path exercised)');
  } else {
    // Baseline: click Join to capture the reported failure.
    await page.click('#joinBtn');
    await sleep(8000);
    const joinMsg = await $text(page, '#message');
    note(`baseline join result: "${joinMsg}"`);
    await shot(page, 'A5-join-attempt');
  }
  await page.close();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n═══ [B] Passkey flow, brand-new user (${MODE}) ═══`);
{
  const page = await newPage({ withWallet: false }); // no MetaMask: passkey-only user
  const cdp = await page.createCDPSession();
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    },
  });
  note(`virtual authenticator ready (${authenticatorId})`);

  await page.goto(`${BASE}/join?room=default`, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('#passkeyBtn', { timeout: 30000 });
  await page.evaluate(() => localStorage.clear()); // brand-new user
  await sleep(1200);
  await shot(page, 'B1-initial');

  const freshUser = `verify-${Date.now().toString(36)}`;
  await page.type('#username', freshUser);
  note(`fresh username: ${freshUser}`);

  const passkeyBtnText = await $text(page, '#passkeyBtn');
  const createBtnExists = await page.$('#passkeyCreateBtn') !== null;
  note(`passkey buttons: main="${passkeyBtnText}" createBtn=${createBtnExists ? 'present' : 'absent'}`);

  if (MODE === 'full') {
    expect(createBtnExists || /create/i.test(passkeyBtnText), 'explicit CREATE path offered to new users', 'no create-passkey path in UI');
    // New user creates a passkey.
    await page.click(createBtnExists ? '#passkeyCreateBtn' : '#passkeyBtn');
    await page.waitForFunction(
      () => /connected/i.test(document.getElementById('walletInfo')?.textContent || '')
         || /❌/.test(document.getElementById('message')?.textContent || ''),
      { timeout: 90000 },
    );
    const info = await $text(page, '#walletInfo');
    const msg = await $text(page, '#message');
    expect(/0x[0-9a-fA-F]{6}/.test(info || ''), `smart account address shown ("${(info || '').slice(0, 80)}…")`, `no address in connected state (info="${info}", msg="${msg}")`);
    const mainText = await $text(page, '#passkeyBtn');
    const createText = createBtnExists ? await $text(page, '#passkeyCreateBtn') : '';
    expect(/connected/i.test(info + mainText + createText), 'clear connected indicator shown', `no connected indicator (btn="${mainText}")`);
    await shot(page, 'B2-created-connected');

    // Returning user: reload, sign in with the existing passkey (same authenticator).
    await page.reload({ waitUntil: 'networkidle2' });
    await sleep(1200);
    await page.type('#username', freshUser);
    await page.click('#passkeyBtn'); // sign-in path
    await page.waitForFunction(
      () => /Smart account/i.test(document.getElementById('walletInfo')?.textContent || '')
         || /❌/.test(document.getElementById('message')?.textContent || ''),
      { timeout: 90000 },
    );
    const info2 = await $text(page, '#walletInfo');
    expect(/0x[0-9a-fA-F]{6}/.test(info2 || ''), 'returning user signed in with existing passkey', `sign-in failed for returning user (info="${info2}")`);
    await shot(page, 'B3-signin-returning');
  } else {
    // Baseline: brand-new user clicks the only button ("Sign in with Passkey").
    await page.click('#passkeyBtn');
    await sleep(15000);
    const info = await $text(page, '#walletInfo');
    const msg = await $text(page, '#message');
    note(`baseline passkey result: walletInfo="${info}" message="${msg}"`);
    await shot(page, 'B4-passkey-attempt');
  }
  await page.close();
}

// ─────────────────────────────────────────────────────────────────────────────
if (MODE === 'full') {
  console.log('\n═══ [C] Join button state machine — passkey-first click (unfunded) ═══');
  const page = await newPage({ withWallet: false });
  const cdp = await page.createCDPSession();
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    },
  });

  await page.goto(`${BASE}/join?room=default`, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('#joinBtn', { timeout: 30000 });
  await page.evaluate(() => localStorage.clear());
  await sleep(1500);

  const initialLabel = await $text(page, '#joinBtn');
  const initialDisabled = await $disabled(page, '#joinBtn');
  expect(/Join Stream/i.test(initialLabel) && initialDisabled === false,
    `join button starts enabled as "${initialLabel}" while DISCONNECTED (passkey-first)`,
    `join button wrong initial state: "${initialLabel}" disabled=${initialDisabled}`);

  // Passkey buttons above MetaMask (prominence) — compare DOM positions.
  const passkeyAboveMM = await page.evaluate(() => {
    const pk = document.getElementById('passkeyCreateBtn');
    const mm = document.getElementById('connectBtn');
    return !!(pk && mm) && (pk.compareDocumentPosition(mm) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
  expect(passkeyAboveMM, 'passkey buttons render ABOVE MetaMask (primary path)', 'MetaMask still above passkey');

  const user = `flow-${Date.now().toString(36)}`;
  await page.type('#username', user);
  note(`username: ${user} — clicking JOIN with no wallet connected`);
  await page.click('#joinBtn');
  // Auto passkey register → connected → terms → zero balance error.
  await page.waitForFunction(
    () => /❌/.test(document.getElementById('message')?.textContent || ''),
    { timeout: 90000 },
  );
  const info = await $text(page, '#walletInfo');
  const msg = await $text(page, '#message');
  expect(/🟢 Connected/.test(info) && /0x[0-9a-fA-F]{6}/.test(info),
    `clicking Join ran passkey auth and shows connected state ("${(info || '').slice(0, 70)}…")`,
    `no connected state after Join click (info="${info}")`);
  note(`unfunded join result (expected funds error): "${(msg || '').slice(0, 110)}"`);
  await sleep(1000);
  const labelAfterFail = await $text(page, '#joinBtn');
  expect(/Join Stream/i.test(labelAfterFail) && (await $disabled(page, '#joinBtn')) === false,
    'button returned to idle "Join Stream" after funds error',
    `button stuck: "${labelAfterFail}"`);
  await shot(page, 'C1-connected-unfunded');

  console.log('\n═══ [D] Funded passkey ride: Join → camera above button → Go Live → LIVE ═══');
  const smartAddr = await page.evaluate(() => window.PasskeyWallet.getPasskeyAddress());
  note(`funding smart account ${smartAddr} with 0.5 USDC from seller…`);
  const fees = await estimateArcFeesWithFloor(pub);
  const fundTx = await sellerWallet.writeContract({
    address: USDC, abi: erc20Abi, functionName: 'transfer',
    args: [smartAddr, 500_000n], ...fees,
  });
  await pub.waitForTransactionReceipt({ hash: fundTx });

  await page.click('#joinBtn');
  // Only a VISIBLE message counts — joinSeat clears the stale one on entry.
  await page.waitForFunction(
    () => {
      const m = document.getElementById('message');
      return !!m && m.classList.contains('show') && /Authorized|❌/.test(m.textContent);
    },
    { timeout: 240000 },
  );
  const joinMsg = await $text(page, '#message');
  expect(/Authorized/.test(joinMsg), 'passkey JOIN succeeded (approve userOp accepted, seat granted)', `passkey join failed: "${joinMsg}"`);

  const stageShown = await page.$eval('#cameraStage', (el) => el.classList.contains('show'));
  expect(stageShown, 'camera stage appeared after seat granted', 'camera stage not shown');
  const stageAboveBtn = await page.evaluate(() => {
    const stage = document.getElementById('cameraStage');
    const btn = document.getElementById('joinBtn');
    return (stage.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
  expect(stageAboveBtn, 'camera preview renders ABOVE the join button', 'camera stage not above the button');
  note(`button right after seat: "${await $text(page, '#joinBtn')}"`);

  // Detection or the 5s fallback must turn the SAME button into GO LIVE.
  await page.waitForFunction(
    () => /Go Live/i.test(document.getElementById('joinBtn')?.textContent || ''),
    { timeout: 20000 },
  );
  ok('SAME button relabeled to "Go Live" once camera stage was up');
  const fit = await page.evaluate(() => {
    const s = document.getElementById('cameraStage').getBoundingClientRect();
    const b = document.getElementById('joinBtn').getBoundingClientRect();
    return { span: Math.round(b.bottom - s.top), stageTop: Math.round(s.top), btnBottom: Math.round(b.bottom) };
  });
  expect(fit.span > 0 && fit.span < 900,
    `camera box + button fit one viewport together (span ${fit.span}px)`,
    `camera box and button too far apart (span ${fit.span}px)`);
  await shot(page, 'D1-go-live-ready');

  await page.click('#joinBtn');
  await page.waitForFunction(
    () => /LIVE/i.test(document.getElementById('joinBtn')?.textContent || ''),
    { timeout: 15000 },
  );
  const liveStatus = await page.$eval('#camStatus', (el) => el.className);
  expect(/live/.test(liveStatus), `GO LIVE click → LIVE state (camStatus="${liveStatus}")`, `camStatus not live: "${liveStatus}"`);
  note(`button now: "${await $text(page, '#joinBtn')}" — letting the meter tick ~6s (real transferFrom pulls)…`);
  await sleep(6000);
  await shot(page, 'D2-live');

  await page.click('#leaveBtn');
  await page.waitForFunction(
    () => /Join Stream/i.test(document.getElementById('joinBtn')?.textContent || ''),
    { timeout: 15000 },
  );
  ok('leave resets the button to idle "Join Stream"');
  await shot(page, 'D3-after-leave');
  await page.close();
}

await browser.close();
console.log(failures === 0 ? `\nVERIFY ${MODE.toUpperCase()} PASS` : `\nVERIFY ${MODE.toUpperCase()} FAIL — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
