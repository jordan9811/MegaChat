/**
 * Gate: PART 3 co-streamer pin. Builds a REAL live metered seat via the
 * Gateway/MetaMask path (EIP-1193 shim — no Circle passkey dependency, which
 * matters because the Circle client key currently allowlists only the Railway
 * domain, so passkeys don't work on localhost). Then: pin → charges stop +
 * pinned state; unpin → charges resume; kick → seat removed.
 * Gateway meter ticks every 10s, so freeze/resume windows are 15s.
 */
import puppeteer from 'puppeteer-core';
import { createPublicClient, createWalletClient, http, erc20Abi, parseEther } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { estimateArcFeesWithFloor } from './token-utils.js';

try { process.loadEnvFile(); } catch { /* env set externally */ }

const BASE = 'http://localhost:3000';
// Self-contained: the gate creates its OWN room with a known password (the
// default room's password may have been changed via the dashboard).
let ROOM = null;
const ROOM_PW = 'pin-gate-' + Date.now().toString(36);
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
const viewer = privateKeyToAccount(generatePrivateKey());
const viewerWallet = createWalletClient({ account: viewer, chain, transport: http(RPC) });

let failures = 0;
const ok = (m) => console.log('  OK ', m);
const bad = (m) => { failures++; console.error('  FAIL', m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dash = async (path, opts = {}) => {
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
    body: JSON.stringify({ name: 'Pin Gate', password: ROOM_PW }),
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
  const t2 = await sellerWallet.writeContract({
    address: USDC, abi: erc20Abi, functionName: 'transfer', args: [viewer.address, 1_000_000n], ...fees,
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
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
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
const user = `pin-${Date.now().toString(36)}`;
await page.type('#username', user);
await page.click('#connectBtn');
await sleep(3000);
console.log('  [setup] depositing 0.5 USDC to Gateway via page UI');
await page.evaluate(() => { window.__promptValue = '0.5'; });
await page.click('#depositBtn');
await page.waitForFunction(
  () => /Deposited|failed/.test(document.getElementById('message')?.textContent || ''),
  { timeout: 180000 },
);
// Wait for the Gateway to reflect the deposit before joining.
let available = 0;
for (let i = 0; i < 24; i++) {
  const bal = await (await fetch(`${BASE}/api/balance/${viewer.address}?room=${ROOM}`)).json();
  available = parseFloat(bal.available || '0');
  if (available >= 0.5) break;
  await sleep(5000);
}
available >= 0.5 ? ok(`gateway balance ready (${available})`) : bad('gateway balance never reflected deposit');

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

let { status, data } = await dash('');
status === 200 ? ok('dashboard unlocked with room password') : bad('dashboard status ' + status);
const seat = (data.seats || []).find((s) => s.username === user);
if (!seat) { bad('seat not found in dashboard'); process.exit(1); }
ok(`live seat ${seat.id.slice(0, 8)}…`);

// ── PIN: charges must stop (gateway tick = 10s → 15s windows) ────────────────
console.log('  [pin] waiting for first paid tick…');
let spentBeforePin = 0;
for (let i = 0; i < 8; i++) {
  await sleep(4000);
  ({ data } = await dash(''));
  spentBeforePin = parseFloat(findSeat(data, seat.id)?.spent || '0');
  if (spentBeforePin > 0) break;
}
spentBeforePin > 0 ? ok(`meter charging pre-pin (spent ${spentBeforePin})`) : bad('meter never charged pre-pin');

const pinRes = await dash(`/pin/${seat.id}`, { method: 'POST', body: { pinned: true } });
(pinRes.status === 200 && pinRes.data.pinned === true) ? ok('pin accepted') : bad('pin failed: ' + JSON.stringify(pinRes.data));
({ data } = await dash(''));
findSeat(data, seat.id).pinned === true ? ok('dashboard shows PINNED') : bad('dashboard not pinned');

const spentAtPin = parseFloat(findSeat(data, seat.id).spent);
await sleep(15000);
({ data } = await dash(''));
const spentAfterPin = parseFloat(findSeat(data, seat.id).spent);
spentAfterPin === spentAtPin
  ? ok(`PIN STOPS CHARGES (spent frozen at ${spentAtPin} across 15s = 1.5 ticks)`)
  : bad(`still charging while pinned: ${spentAtPin} → ${spentAfterPin}`);

const badPin = await fetch(`${BASE}/api/dashboard/rooms/${ROOM}/pin/${seat.id}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Room-Password': 'wrong' },
  body: JSON.stringify({ pinned: false }),
});
badPin.status === 401 ? ok('pin is password-gated (401 on wrong password)') : bad('pin not gated: ' + badPin.status);

// ── UNPIN: charges resume ────────────────────────────────────────────────────
const unpinRes = await dash(`/pin/${seat.id}`, { method: 'POST', body: { pinned: false } });
unpinRes.data.pinned === false ? ok('unpin accepted') : bad('unpin failed');
let spentAfterUnpin = spentAfterPin;
for (let i = 0; i < 6; i++) {
  await sleep(5000);
  ({ data } = await dash(''));
  spentAfterUnpin = parseFloat(findSeat(data, seat.id).spent);
  if (spentAfterUnpin > spentAfterPin) break;
}
spentAfterUnpin > spentAfterPin
  ? ok(`UNPIN RESUMES CHARGES (${spentAfterPin} → ${spentAfterUnpin})`)
  : bad(`meter did not resume: still ${spentAfterUnpin}`);

// ── KICK still works ─────────────────────────────────────────────────────────
const kickRes = await dash(`/kick/${seat.id}`, { method: 'POST' });
kickRes.status === 200 ? ok('kick still works') : bad('kick failed: ' + kickRes.status);
await sleep(1500);
({ data } = await dash(''));
!findSeat(data, seat.id) ? ok('seat removed after kick') : bad('seat still present after kick');

await browser.close();
console.log(failures === 0 ? 'GATE PASS' : `GATE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
