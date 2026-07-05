/**
 * Gate: GROUP 6 connection stability. Builds a REAL live metered seat via the
 * Gateway/MetaMask path (same EIP-1193 shim as _gate-pin.mjs — passkeys are
 * domain-locked off localhost), then proves:
 *   A. a WS blip does NOT kill the seat: client auto-reconnects, re-registers,
 *      meter keeps running, dashboard shows quality=unstable then connected
 *   B. reconnect grace expiry: with reconnection blocked, the seat is freed +
 *      refunded after SEAT_RECONNECT_GRACE_MS (default 30s) — not before
 * Run with the unified app on :3000.
 */
import puppeteer from 'puppeteer-core';
import { createPublicClient, createWalletClient, http, erc20Abi, parseEther } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { estimateArcFeesWithFloor } from './token-utils.js';

try { process.loadEnvFile(); } catch { /* env set externally */ }

const BASE = 'http://localhost:3000';
let ROOM = null;
const ROOM_PW = 'stab-gate-' + Date.now().toString(36);
const RPC = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';
const USDC = process.env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000';
const GRACE_MS = Math.max(5000, parseInt(process.env.SEAT_RECONNECT_GRACE_MS || '30000', 10) || 30000);
const chain = {
  id: Number(process.env.ARC_CHAIN_ID || 5042002), name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC] }, public: { http: [RPC] } },
};
const pub = createPublicClient({ chain, transport: http(RPC) });
const seller = privateKeyToAccount(process.env.SELLER_PRIVATE_KEY);
const sellerWallet = createWalletClient({ account: seller, chain, transport: http(RPC) });
const viewer = privateKeyToAccount(generatePrivateKey());
const viewerWallet = createWalletClient({ account: viewer, chain, transport: http(RPC) });

let failures = 0;
const ok = (m) => console.log('  OK ', m);
const bad = (m) => { failures++; console.error('  FAIL', m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dash = async (path = '', opts = {}) => {
  const res = await fetch(`${BASE}/api/dashboard/rooms/${ROOM}${path}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Room-Password': ROOM_PW },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const findSeat = (data, id) => (data.seats || []).find((s) => s.id === id);

// ── Create a dedicated gate room ─────────────────────────────────────────────
{
  const res = await fetch(`${BASE}/api/dashboard/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Stability Gate', password: ROOM_PW }),
  });
  const created = await res.json().catch(() => ({}));
  if (res.status !== 201 || !created.room?.id) {
    console.error('  FAIL could not create gate room:', res.status, JSON.stringify(created));
    process.exit(1);
  }
  ROOM = created.room.id;
  console.log('  [setup] gate room', ROOM);
}

// ── Fund a fresh viewer + node-side signing for the page shim ────────────────
console.log('  [setup] funding fresh viewer', viewer.address);
{
  const fees = await estimateArcFeesWithFloor(pub);
  const t1 = await sellerWallet.sendTransaction({ to: viewer.address, value: parseEther('0.05'), ...fees });
  await pub.waitForTransactionReceipt({ hash: t1 });
  // 5 USDC funding for a 1.8 deposit: the Arc USDC ERC-20 mirrors the native
  // balance, and depositing ~90% of it reverts ("transfer amount exceeds
  // balance") — keep the deposit well under half of the balance like the
  // ratios that work. 1.8 available = 180s of meter runway for both phases.
  const t2 = await sellerWallet.writeContract({
    address: USDC, abi: erc20Abi, functionName: 'transfer', args: [viewer.address, 5_000_000n], ...fees,
  });
  await pub.waitForTransactionReceipt({ hash: t2 });
}

async function nodeEth(method, params) {
  switch (method) {
    case 'eth_sendTransaction': {
      const [tx] = params;
      const fees = await estimateArcFeesWithFloor(pub);
      return viewerWallet.sendTransaction({
        to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, ...fees,
      });
    }
    case 'eth_signTypedData_v4': {
      const [, json] = params;
      const td = JSON.parse(json);
      const { EIP712Domain, ...types } = td.types;
      return viewer.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message });
    }
    default:
      return pub.request({ method, params });
  }
}

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-capture',
         '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 1400 });
await page.exposeFunction('__nodeEth', async (method, paramsJson) => {
  try { return JSON.stringify({ ok: true, res: (await nodeEth(method, JSON.parse(paramsJson))) ?? null }); }
  catch (e) { return JSON.stringify({ ok: false, err: e.shortMessage || e.message }); }
});
await page.evaluateOnNewDocument((addr, chainIdHex) => {
  window.prompt = (msg, def) => (window.__promptValue ?? def ?? null);
  // WebSocket harness: track live page sockets so the gate can chop them
  // (simulated network blip), and optionally block NEW connections to force
  // the server's reconnect grace to expire.
  window.__sockets = [];
  window.__blockWs = false;
  const RealWS = window.WebSocket;
  window.WebSocket = function (...args) {
    if (window.__blockWs) throw new Error('gate: ws blocked');
    const s = new RealWS(...args);
    window.__sockets.push(s);
    return s;
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.ethereum = {
    isMetaMask: true, on: () => {}, removeListener: () => {},
    async request({ method, params = [] }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr];
      if (method === 'eth_chainId') return chainIdHex;
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
      const { ok, res, err } = JSON.parse(await window.__nodeEth(method, JSON.stringify(params)));
      if (!ok) throw new Error(err);
      return res;
    },
  };
}, viewer.address, '0x4cef52');

// ── Connect → deposit 0.5 → join → GO LIVE ──────────────────────────────────
await page.goto(`${BASE}/join?room=${ROOM}`, { waitUntil: 'networkidle2', timeout: 60000 });
await sleep(1500);
const user = `stab-${Date.now().toString(36)}`;
await page.type('#username', user);
await page.click('#connectBtn');
await sleep(3000);
console.log('  [setup] depositing 1.8 USDC to Gateway via page UI');
await page.evaluate(() => { window.__promptValue = '1.8'; });
await page.click('#depositBtn');
await page.waitForFunction(
  () => /Deposited|failed/.test(document.getElementById('message')?.textContent || ''),
  { timeout: 180000 },
);
console.log(
  '  [setup] deposit result:',
  (await page.evaluate(() => document.getElementById('message')?.textContent || '')).slice(0, 120),
);
// Gateway finalization lags the on-chain deposit (longer for larger amounts).
// 1.0 USDC available = 100s of meter runway, enough for both phases; keep
// polling up to 5 min before giving up.
let available = 0;
for (let i = 0; i < 60; i++) {
  const bal = await (await fetch(`${BASE}/api/balance/${viewer.address}?room=${ROOM}`)).json();
  available = parseFloat(bal.available || '0');
  if (available >= 1.0) break;
  if (i % 6 === 5) console.log(`  [setup] waiting on gateway finality… available=${available}`);
  await sleep(5000);
}
available >= 1.0 ? ok(`gateway balance ready (${available})`) : bad('gateway balance never reflected deposit');

console.log('  [setup] joining');
await page.click('#joinBtn');
await page.waitForFunction(
  () => {
    const m = document.getElementById('message');
    return !!m && m.classList.contains('show') && /Authorized|❌/.test(m.textContent);
  },
  { timeout: 120000 },
);
await page.waitForFunction(
  () => /Go Live/i.test(document.getElementById('joinBtn')?.textContent || ''),
  { timeout: 20000 },
);
await page.click('#joinBtn'); // GO LIVE → meter starts (0.1 USDC / 10s)
await sleep(2000);

let { status, data } = await dash();
status === 200 ? ok('dashboard unlocked') : bad('dashboard status ' + status);
const seat = (data.seats || []).find((s) => s.username === user);
if (!seat) { bad('seat not found in dashboard'); process.exit(1); }
ok(`live seat ${seat.id.slice(0, 8)}…`);
seat.quality === 'good' && seat.connected === true
  ? ok('quality=good while connected')
  : bad(`expected good/connected, got quality=${seat.quality} connected=${seat.connected}`);

// ── Phase A: blip → auto-recover ─────────────────────────────────────────────
console.log('  [A] chopping page sockets (simulated network blip)');
const chopped = await page.evaluate(() => {
  const open = window.__sockets.filter((s) => s.readyState === 1).length;
  window.__sockets.forEach((s) => { try { s.close(); } catch {} });
  window.__sockets.length = 0;
  return open;
});
ok(`chopped ${chopped} open socket(s)`);
await sleep(2500);
({ data } = await dash());
let s = findSeat(data, seat.id);
s ? ok('seat SURVIVES the blip (grace running)') : bad('seat was dropped immediately on WS close');
s && s.quality === 'unstable'
  ? ok(`dashboard shows quality=unstable (connected=${s.connected})`)
  : bad(`expected unstable during blip, got ${s && s.quality}`);

// client backoff starts at ~1s — give it a few seconds to rebind
await sleep(6000);
({ data } = await dash());
s = findSeat(data, seat.id);
s && s.connected === true
  ? ok('client auto-reconnected and re-registered the seat')
  : bad(`client did not re-register (connected=${s && s.connected})`);
s && s.quality === 'unstable'
  ? ok('recent blip keeps quality=unstable (flakiness memory)')
  : bad(`expected unstable within 2min of blip, got ${s && s.quality}`);

// meter must keep running across the blip (gateway tick = 10s)
const spentBefore = parseFloat(s?.spent || '0');
await sleep(12000);
({ data } = await dash());
s = findSeat(data, seat.id);
const spentAfter = parseFloat(s?.spent || '0');
spentAfter > spentBefore
  ? ok(`meter unaffected across blip (${spentBefore} → ${spentAfter})`)
  : bad(`meter stalled across blip (${spentBefore} → ${spentAfter})`);

// live meter updates flow again on the fresh socket
const meterUpdating = await page.evaluate(() => {
  const t0 = document.getElementById('meterSpent')?.textContent;
  return new Promise((res) => setTimeout(() => {
    res({ t0, t1: document.getElementById('meterSpent')?.textContent });
  }, 11000));
});
meterUpdating.t0 !== meterUpdating.t1
  ? ok(`join page meter resumed live updates (${meterUpdating.t0} → ${meterUpdating.t1})`)
  : bad('join page meter frozen after reconnect');

// ── Phase B: blocked reconnect → grace expiry frees the seat ────────────────
console.log(`  [B] blocking reconnection; grace = ${GRACE_MS / 1000}s`);
await page.evaluate(() => {
  window.__blockWs = true;
  window.__sockets.forEach((s) => { try { s.close(); } catch {} });
  window.__sockets.length = 0;
});
const halfGrace = Math.floor(GRACE_MS / 2);
await sleep(halfGrace);
({ data } = await dash());
findSeat(data, seat.id)
  ? ok(`seat still held mid-grace (${halfGrace / 1000}s in)`)
  : bad('seat dropped before grace expired');
await sleep(GRACE_MS - halfGrace + 12000);
({ data } = await dash());
!findSeat(data, seat.id)
  ? ok('grace expiry freed + refunded the seat')
  : bad('seat still alive well past grace');

await browser.close();
console.log(failures === 0 ? 'GATE PASS' : `GATE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
