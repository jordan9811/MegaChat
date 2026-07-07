/**
 * GATE — Tempo migration Phase 3 (feature parity sweep). REAL MAINNET, dust.
 *
 * Full flow: create room (password) → per-room auth → payout wallet persists →
 * join with stingers → overlay page + seat_added broadcast → MPP meter ticks →
 * PIN pauses billing / unpin resumes → browse lists the room → rewards config
 * (dry-run) → KICK settles the channel server-side and the viewer's unspent
 * deposit still comes back from escrow.
 */
import WebSocket from 'ws';
import { createWalletClient, createPublicClient, http, erc20Abi, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempo } from 'viem/chains';
import { tempo as tempoClient } from 'mppx/client';

process.loadEnvFile(new URL('./.env', import.meta.url).pathname.replace(/^\//, ''));

const BASE = process.env.GATE_BASE_URL || 'http://localhost:3000';
const WS_URL = BASE.replace(/^http/, 'ws');
const USDC = process.env.TEMPO_USDC_ADDRESS;
const SELLER = process.env.SELLER_WALLET_ADDRESS;
// Payout target distinct from the platform seller wallet, so routing is provable.
const PAYOUT = process.env.REWARD_POOL_WALLET_ADDRESS && /^0x[0-9a-fA-F]{40}$/.test(process.env.REWARD_POOL_WALLET_ADDRESS)
  ? process.env.REWARD_POOL_WALLET_ADDRESS
  : SELLER;
const PASSWORD = 'gate-phase3-pass';

let pass = 0, fail = 0, warn = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const note = (name, extra) => { warn++; console.warn(`  WARN  ${name} — ${extra}`); };

const viewer = privateKeyToAccount(process.env.TEST_VIEWER_KEY);
const pub = createPublicClient({ chain: tempo, transport: http() });
const balanceOf = (addr) =>
  pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [addr] });

const api = async (path, opts = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.password ? { 'X-Room-Password': opts.password } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

console.log('\n— 1. create room + per-room auth + payout wallet —');
const created = await api('/api/dashboard/create', {
  method: 'POST',
  body: {
    name: 'Phase3 Gate Room',
    password: PASSWORD,
    config: {
      passkeyTickPrice: '0.001',
      passkeyTickSeconds: 1,
      maxSession: '0.1',
      maxSeats: 3,
      payoutAddress: PAYOUT,
      unlisted: false,
      rewards: { enabled: false, earnInterval: 60, earnAmount: '0.1', earnCap: '5', rewardType: 'points', rewardTokenAddress: null },
    },
  },
});
const roomId = created.data?.room?.id;
ok('room created', created.status === 201 && !!roomId, `room=${roomId} join=${created.data.joinUrl}`);
ok('payout wallet persisted', created.data?.room?.payoutAddress === PAYOUT, String(created.data?.room?.payoutAddress));
if (PAYOUT === SELLER) note('payout target', 'REWARD_POOL_WALLET_ADDRESS not set — payout falls back to seller (routing not independently provable)');

const noAuth = await api(`/api/dashboard/rooms/${roomId}`);
ok('dashboard requires password', noAuth.status === 401);
const badAuth = await api(`/api/dashboard/rooms/${roomId}`, { password: 'wrong-pass' });
ok('wrong password rejected', badAuth.status === 401);
const goodAuth = await api(`/api/dashboard/rooms/${roomId}`, { password: PASSWORD });
ok('unlock with password', goodAuth.status === 200 && goodAuth.data?.room?.id === roomId);

console.log('\n— 2. pages serve (join / dashboard / overlay / browse) —');
for (const [name, path, marker] of [
  ['join page', `/join?room=${roomId}`, 'Sign up'],
  ['dashboard page', '/dashboard', 'MegaChat'],
  ['overlay page', `/overlay?room=${roomId}`, ''],
  ['landing/browse', '/', 'MegaChat'],
]) {
  const r = await fetch(`${BASE}${path}`);
  const text = await r.text();
  ok(`${name} 200`, r.ok && (!marker || text.includes(marker)));
}

console.log('\n— 3. join with stingers → live → overlay broadcast —');
const viewerBefore = await balanceOf(viewer.address);
const payoutBefore = await balanceOf(PAYOUT);

const joinRes = await api(`/api/join/mpp`, {
  method: 'POST',
  body: { username: 'gate3', address: viewer.address, room: roomId, flyIn: 'storm', flyOut: 'crt' },
});
const join = joinRes.data;
ok('mpp join in new room', joinRes.status === 200 && join.success, `seat=${join.seatId} cap=${join.sessionCap}`);

const events = [];
const ws = new WebSocket(WS_URL);
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
ws.send(JSON.stringify({ type: 'subscribe_room', room: roomId }));
ws.on('message', (raw) => { try { events.push(JSON.parse(raw.toString())); } catch { /* */ } });
ws.send(JSON.stringify({ type: 'camera_ready', seatId: join.seatId }));
await new Promise((r) => setTimeout(r, 800));
const added = events.find((e) => e.type === 'seat_added' && e.seat?.id === join.seatId);
ok('seat_added broadcast to overlay', !!added);
ok('stingers travel with the seat', added?.seat?.flyIn === 'storm' && added?.seat?.flyOut === 'crt',
  `${added?.seat?.flyIn}/${added?.seat?.flyOut}`);

console.log('\n— 4. meter ticks, PIN pauses billing, unpin resumes —');
const wallet = createWalletClient({ account: viewer, chain: tempo, transport: http() });
const session = tempoClient.session.manager({
  client: wallet, account: viewer,
  maxDeposit: String(join.sessionCap),
  decimals: join.paymentTokenDecimals ?? 6,
});
const tick = async () => {
  const resp = await session.fetch(`${BASE}${join.tickUrl}`, { method: 'POST' });
  return resp.json().catch(() => ({}));
};

let last = null;
for (let i = 0; i < 4; i++) { last = await tick(); await new Promise((r) => setTimeout(r, 1000)); }
ok('meter charges while live', parseFloat(last?.spent || '0') >= 0.003, `spent=${last?.spent}`);

const pin = await api(`/api/dashboard/rooms/${roomId}/pin/${join.seatId}`, { method: 'POST', password: PASSWORD, body: { pinned: true } });
ok('pin (co-host) via dashboard', pin.status === 200 && pin.data.pinned === true);
const spentAtPin = last.spent;
const p1 = await tick();
await new Promise((r) => setTimeout(r, 1000));
const p2 = await tick();
ok('pinned ticks are FREE', p1.pinned === true && p2.pinned === true && p2.spent === spentAtPin,
  `spent stayed ${p2.spent}`);

await api(`/api/dashboard/rooms/${roomId}/pin/${join.seatId}`, { method: 'POST', password: PASSWORD, body: { pinned: false } });
await new Promise((r) => setTimeout(r, 300));
const afterUnpin = await tick();
ok('unpin resumes billing', parseFloat(afterUnpin.spent) > parseFloat(spentAtPin), `spent=${afterUnpin.spent}`);

console.log('\n— 5. browse directory —');
const browse = await api('/api/rooms/public');
const card = (browse.data.rooms || []).find((r) => r.id === roomId);
ok('room listed in browse', !!card, card ? `live=${card.live} price=${card.passkeyTickPrice}/${card.passkeyTickSeconds}s` : '');
ok('live seat counted', card?.live === 1, String(card?.live));

console.log('\n— 6. rewards (dry-run points) —');
const rw = await api(`/api/dashboard/rooms/${roomId}`, {
  method: 'PUT', password: PASSWORD,
  body: { config: { rewards: { enabled: true, earnInterval: 60, earnAmount: '1', earnCap: '5', rewardType: 'points', rewardTokenAddress: null } } },
});
ok('rewards enabled via dashboard', rw.status === 200 && rw.data.room?.rewards?.enabled === true);
const rwWs = new WebSocket(WS_URL);
const rwCfg = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 5000);
  rwWs.on('open', () => rwWs.send(JSON.stringify({ type: 'rewards_register', wallet: viewer.address, roomId })));
  rwWs.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'rewards_config') { clearTimeout(timer); resolve(m); }
    } catch { /* */ }
  });
});
ok('rewards_config broadcast (enabled)', rwCfg?.enabled === true, `rewardType=${rwCfg?.rewardType}`);
rwWs.close();

console.log('\n— 7. KICK → server settles channel → unspent returns to viewer —');
const kick = await api(`/api/dashboard/rooms/${roomId}/kick/${join.seatId}`, { method: 'POST', password: PASSWORD });
ok('kick via dashboard', kick.status === 200);
await new Promise((r) => setTimeout(r, 700));
const removed = events.find((e) => e.type === 'seat_removed' && e.seatId === join.seatId);
ok('seat_removed broadcast (kicked)', removed?.reason === 'kicked', removed?.reason);

// The server SETTLES (claims streamed amount for the payee) on kick; the
// kicked client's browser reacts to seat_removed by closing the channel,
// which releases the remaining deposit (join-page.ts stopMppTicks(true)).
// Mirror that client behavior here.
const kickClose = await session.close().catch((e) => {
  note('client close after kick', e?.message || String(e));
  return null;
});
ok('client closes channel after kick (as the join page does)', !!kickClose,
  kickClose?.txHash ? `tx=${kickClose.txHash.slice(0, 14)}…` : '');

// Settlement + release need a moment to land on-chain.
await new Promise((r) => setTimeout(r, 9000));
const viewerAfter = await balanceOf(viewer.address);
const payoutAfter = await balanceOf(PAYOUT);
const viewerDelta = viewerBefore - viewerAfter;
const payoutDelta = payoutAfter - payoutBefore;
const capAtomic = BigInt(Math.round(parseFloat(join.sessionCap) * 1e6));
console.log(`viewer -${formatUnits(viewerDelta, 6)} of cap ${join.sessionCap} · payout +${formatUnits(payoutDelta, 6)}`);
ok('viewer refunded after KICK (lost ~spent+fees, not the cap)',
  viewerDelta > 0n && viewerDelta < capAtomic / 2n, `-${formatUnits(viewerDelta, 6)}`);
ok('payout wallet received the streamed amount', payoutDelta > 0n, `+${formatUnits(payoutDelta, 6)}`);

// Cleanup: stop the gate room so it drops out of the live directory.
await api(`/api/dashboard/rooms/${roomId}/stop`, { method: 'POST', password: PASSWORD });
ws.close();

console.log(`\nRESULT: ${pass} pass, ${fail} fail, ${warn} warn`);
process.exit(fail === 0 ? 0 : 1);
