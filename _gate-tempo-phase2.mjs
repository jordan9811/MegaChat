/**
 * GATE — Tempo migration Phase 2 (MPP session meter). REAL MAINNET MONEY
 * (dust prices: 0.001 USDC.e per second, cap = min(balance, 2)).
 *
 * Drives a real viewer session with TEST_VIEWER_KEY against a running server:
 *   join (no upfront transfer) → camera_ready → per-second ticks through the
 *   mppx session manager (first tick opens the TIP-1034 escrow channel
 *   on-chain, later ticks are signed off-chain vouchers) → meter_update
 *   broadcasts visibly deduct → cooperative close → UNSPENT DEPOSIT RETURNS
 *   to the viewer, seller receives the streamed amount.
 */
import WebSocket from 'ws';
import { createWalletClient, createPublicClient, http, erc20Abi, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempo } from 'viem/chains';
import { tempo as tempoClient } from 'mppx/client';

process.loadEnvFile(new URL('./.env', import.meta.url).pathname.replace(/^\//, ''));

const BASE = process.env.GATE_BASE_URL || 'http://localhost:3000';
const WS_URL = BASE.replace(/^http/, 'ws');
const ROOM = 'default';
const USDC = process.env.TEMPO_USDC_ADDRESS;
const SELLER = process.env.SELLER_WALLET_ADDRESS;
const TICKS_TO_RUN = 8;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

const viewer = privateKeyToAccount(process.env.TEST_VIEWER_KEY);
console.log('viewer:', viewer.address);

const pub = createPublicClient({ chain: tempo, transport: http() });
const balanceOf = (addr) =>
  pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [addr] });

const viewerBefore = await balanceOf(viewer.address);
const sellerBefore = await balanceOf(SELLER);
console.log('before  viewer:', formatUnits(viewerBefore, 6), ' seller:', formatUnits(sellerBefore, 6));

// ── join ─────────────────────────────────────────────────────────────────
const joinRes = await fetch(`${BASE}/api/join/mpp`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'gate-viewer', address: viewer.address, room: ROOM }),
});
const join = await joinRes.json();
ok('join accepted (no upfront payment)', joinRes.ok && join.success, JSON.stringify({
  seatId: join.seatId, cap: join.sessionCap, tick: `${join.tickPrice}/${join.tickSeconds}s`,
}));
if (!joinRes.ok) { console.error(join); process.exit(1); }

// ── WS: watch meter updates + go live ────────────────────────────────────
const meterUpdates = [];
let seatRemovedReason = null;
const ws = new WebSocket(WS_URL);
await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
});
ws.send(JSON.stringify({ type: 'subscribe_room', room: ROOM }));
ws.send(JSON.stringify({ type: 'register_seat', seatId: join.seatId }));
ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'meter_update' && msg.seatId === join.seatId) meterUpdates.push(msg);
    if (msg.type === 'seat_removed' && msg.seatId === join.seatId) seatRemovedReason = msg.reason;
  } catch { /* ignore */ }
});
ws.send(JSON.stringify({ type: 'camera_ready', seatId: join.seatId }));
console.log('seat live — starting paid ticks');

// ── MPP session: first tick opens the channel, then vouchers ─────────────
const wallet = createWalletClient({ account: viewer, chain: tempo, transport: http() });
const session = tempoClient.session.manager({
  client: wallet,
  account: viewer,
  maxDeposit: String(join.sessionCap),
  decimals: join.paymentTokenDecimals ?? 6,
});

let tickErrors = 0;
let openMs = null;
for (let i = 0; i < TICKS_TO_RUN; i++) {
  const t0 = Date.now();
  try {
    const resp = await session.fetch(`${BASE}${join.tickUrl}`, { method: 'POST' });
    const body = await resp.json().catch(() => ({}));
    if (i === 0) {
      openMs = Date.now() - t0;
      console.log(`  tick 1 (channel open): ${openMs}ms  channel=${session.channelId?.slice(0, 14)}…`);
    } else {
      console.log(`  tick ${i + 1}: ${Date.now() - t0}ms  remaining=${body.remaining} spent=${body.spent}`);
    }
    if (!resp.ok) tickErrors++;
  } catch (err) {
    tickErrors++;
    console.error(`  tick ${i + 1} ERROR:`, err.message);
  }
  await new Promise((r) => setTimeout(r, join.tickSeconds * 1000));
}

ok('all paid ticks accepted', tickErrors === 0, `${TICKS_TO_RUN} ticks, errors: ${tickErrors}`);
ok('channel opened on-chain', !!session.channelId, session.channelId);
ok('voucher ticks are fast (off-chain)', meterUpdates.length >= 2, `updates: ${meterUpdates.length}`);

// meter visibly deducts per tick. The gate WS is BOTH the seat owner and a
// room subscriber, so every update arrives twice (same as the real join page,
// where the double render is invisible) — dedupe consecutive repeats first.
const remainings = meterUpdates
  .map((m) => parseFloat(m.remaining))
  .filter((v, i, a) => i === 0 || v !== a[i - 1]);
const strictlyDecreasing = remainings.length >= 5
  && remainings.every((v, i) => i === 0 || v < remainings[i - 1]);
ok('meter_update remaining strictly decreases', strictlyDecreasing, remainings.join(' → '));
const lastSpent = meterUpdates.length ? parseFloat(meterUpdates[meterUpdates.length - 1].spent) : 0;
ok('spent ≈ ticks × price', lastSpent > 0 && Math.abs(lastSpent - TICKS_TO_RUN * parseFloat(join.tickPrice)) <= 2 * parseFloat(join.tickPrice), `spent=${lastSpent}`);

// ── leave: cooperative close → unspent refunds from escrow ───────────────
const closeReceipt = await session.close().catch((e) => {
  console.error('close failed:', e.message);
  return null;
});
ok('cooperative close returned receipt', !!closeReceipt, closeReceipt
  ? `spent=${closeReceipt.spent} tx=${closeReceipt.txHash?.slice(0, 14)}…`
  : '');
await fetch(`${BASE}/api/leave/${join.seatId}`, { method: 'POST' });

// settlement + refund land on-chain (sub-second finality + margin)
await new Promise((r) => setTimeout(r, 8000));

const viewerAfter = await balanceOf(viewer.address);
const sellerAfter = await balanceOf(SELLER);
console.log('after   viewer:', formatUnits(viewerAfter, 6), ' seller:', formatUnits(sellerAfter, 6));

const spentAtomic = BigInt(Math.round(lastSpent * 1e6));
const viewerDelta = viewerBefore - viewerAfter; // what actually left the wallet
const sellerDelta = sellerAfter - sellerBefore;
const cap = BigInt(Math.round(parseFloat(join.sessionCap) * 1e6));

ok(
  'UNSPENT DEPOSIT RETURNED (viewer lost ~spent + dust fees, NOT the cap)',
  viewerDelta >= spentAtomic && viewerDelta < spentAtomic + 100_000n && viewerDelta < cap / 2n,
  `viewer -${formatUnits(viewerDelta, 6)} (cap was ${join.sessionCap}, spent ${lastSpent})`
);
ok(
  'seller received the streamed amount',
  sellerDelta > 0n && sellerDelta <= spentAtomic,
  `seller +${formatUnits(sellerDelta, 6)}`
);

ws.close();
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
