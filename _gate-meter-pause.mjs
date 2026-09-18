/**
 * GATE — L35: the meter STOPS while the overlay is hidden, driven, not read.
 *
 * Pass C Session 2 wired `if (!seatEscrow.shouldCharge(room)) continue;` into
 * tickAllMeters and could only read it back, because no seat that ticks
 * without a funded wallet existed in any harness. This is that fixture: a
 * viewer EARNS points by watching (rewards over the room WebSocket), spends
 * them on a seat (`points_stream`, which ticks locally with no chain at all),
 * goes live over the same WebSocket the real join page uses, and is metered
 * by the real tick loop. Then the room's owner posts overlay_hidden the way
 * the manage page does, and the seat ledger — the server's own append-only
 * record of every tick — must stop growing until overlay_visible.
 *
 * The evidence is the ledger file on disk, not a WebSocket message the gate
 * could have misread: an ACCRUE row is written only by the tick loop, only
 * after a tick was applied.
 */
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import WebSocket from 'ws';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'mc-meter-pause-'));
process.env.DATA_DIR = SCRATCH;

const PORT = 3321;
const APP = `http://localhost:${PORT}`;
const VIEWER = '0x00000000000000000000000000000000000000a1';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n── L35: the meter pause, driven ────────────────────────────');

const rooms = await import('./rooms-store.js');
const { roomOwnerKey } = await import('./auth.js');
const { startGateServer, mintBountyAuth } = await import('./_gate-helpers.mjs');

// Seed BEFORE boot: a room that pays points for watching and charges points
// per second for a seat, owned by the identity whose cookie posts visibility.
const auth = mintBountyAuth({ handles: ['pausehost'], dataDir: SCRATCH });
const room = rooms.createRoom('meter pause room', {
  passkeyTickPrice: '1', passkeyTickSeconds: 1, maxSession: '500', maxSeats: 3,
  rewards: { enabled: true, earnInterval: 1, earnAmount: '50', earnCap: '500', rewardType: 'points' },
});
rooms.setRoomOwner(room.id, roomOwnerKey({ provider: 'twitch', platformId: '1000' }));

const srv = await startGateServer({
  port: PORT, dataDir: SCRATCH, label: 'meter-pause',
  env: { ...auth.env, KEEP_ORPHAN_ROOMS: 'true' },
});
const asOwner = { Cookie: auth.cookieFor('pausehost') };
const post = (p, body, headers = {}) => fetch(`${APP}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const ledgerPath = path.join(SCRATCH, 'seat-ledger.jsonl');
const accrues = () => (existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.includes('"SEAT_ACCRUE"')).length : 0);
const rowsOf = (type) => (existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.includes(`"${type}"`)).length : 0);

let ws = null;
try {
  // ── 1. earn a balance by watching ─────────────────────────────────────────
  ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const earned = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no rewards_earned within 8s')), 8_000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe_room', room: room.id }));
      ws.send(JSON.stringify({ type: 'rewards_register', wallet: VIEWER, roomId: room.id }));
      ws.send(JSON.stringify({ type: 'rewards_visibility', visible: true }));
    });
    let total = 0;
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'rewards_earned' && m.credited) { total += Number(m.credited); if (total >= 100) { clearTimeout(t); resolve(total); } }
    });
    ws.on('error', reject);
  });
  ok('1. a viewer earns a points balance by watching', earned >= 100, `${earned} PTS`);

  // ── 2. spend it on a seat: points_stream ticks locally, no chain ─────────
  const terms = await post('/api/join/passkey', { username: 'pausee', address: VIEWER, room: room.id });
  ok('2. the join offers the earned balance as payment', terms.body.useRewardCredit === true, JSON.stringify(terms.body).slice(0, 100));
  const joined = await post('/api/join/passkey', { username: 'pausee', address: VIEWER, room: room.id, useRewardCredit: true });
  ok('2. the seat is granted on points', joined.status === 200 && joined.body.paymentMode === 'points_stream', `${joined.status} ${joined.body.paymentMode}`);
  const seatId = joined.body.seatId || joined.body.seat?.id;
  ok('2. ...and has an id', !!seatId, seatId || JSON.stringify(joined.body).slice(0, 120));

  // ── 3. go live the way the join page does ────────────────────────────────
  ws.send(JSON.stringify({ type: 'register_seat', seatId }));
  ws.send(JSON.stringify({ type: 'camera_ready', seatId }));
  await sleep(3_500);
  const a1 = accrues();
  ok('3. once live, the real tick loop meters the seat: ACCRUE rows appear', a1 >= 2, `${a1} tick(s) in 3.5s`);
  ok('3. the seat has a pending bucket (SEAT_OPEN row)', rowsOf('SEAT_OPEN') === 1);

  // ── 4. the overlay goes hidden: the loop must SKIP this room ─────────────
  const hidden = await post(`/api/rooms/${room.id}/overlay-visibility`, { signal: 'overlay_hidden', reason: 'scene' }, asOwner);
  ok('4. the room owner reports overlay_hidden', hidden.status === 200 && hidden.body.signal === 'overlay_hidden', `http ${hidden.status}`);
  await sleep(1_200); // let any in-flight tick land
  const a2 = accrues();
  await sleep(3_500);
  const a3 = accrues();
  ok('4. THE METER STOPS: no ACCRUE row for 3.5s while hidden — the `continue` in tickAllMeters is real',
    a3 === a2, `${a2} → ${a3}`);
  ok('4. ...and the seat is PAUSED in its own ledger', rowsOf('SEAT_PAUSE') === 1);

  // ── 5. the overlay comes back: ticks resume ──────────────────────────────
  const back = await post(`/api/rooms/${room.id}/overlay-visibility`, { signal: 'overlay_visible', scale: { scaleY: 1 } }, asOwner);
  ok('5. the owner reports overlay_visible', back.status === 200);
  await sleep(3_500);
  const a4 = accrues();
  ok('5. ticks RESUME after the overlay is back', a4 > a3, `${a3} → ${a4}`);
  ok('5. the pause was closed with a resume, a buried-seconds refund and a sweep',
    rowsOf('SEAT_RESUME') === 1 && rowsOf('SEAT_REFUND_BURIED') === 1 && rowsOf('SEAT_SWEEP') >= 1,
    `resume=${rowsOf('SEAT_RESUME')} refund=${rowsOf('SEAT_REFUND_BURIED')} sweep=${rowsOf('SEAT_SWEEP')}`);

  // ── 5b. E43: the refund reached the settlement door and was RETAINED ─────
  // Points are not money. The buried-seconds refund must be recorded at the
  // door (so it is accounted for) and never become an outbound USDC intent
  // the platform wallet would pay once a payout key lands.
  const doorPath = path.join(SCRATCH, 'settlement.jsonl');
  const doorRows = existsSync(doorPath) ? readFileSync(doorPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const mine = doorRows.filter((r) => typeof r.ref === 'string' && r.ref.startsWith(`seat:${seatId}:`));
  ok('5. E43: the points refund is at the door as RETAINED (off-chain credit), not as a payable INTENT',
    mine.length >= 1 && mine.every((r) => r.type === 'RETAINED') && mine.some((r) => /off-chain/.test(r.why || '')),
    mine.map((r) => `${r.type}:${r.ref.split(':').slice(2).join(':')}`).join(' ') || 'no rows for this seat');

  // ── 6. the seat is still live: a pause is not a kick ─────────────────────
  const seats = await fetch(`${APP}/api/seats?room=${room.id}`).then((r) => r.json()).catch(() => ({}));
  const still = (seats.seats || []).some((s) => s.id === seatId || s.seatId === seatId);
  ok('6. a paused seat was never kicked — pausing is not out_of_funds', still, still ? 'still seated' : JSON.stringify(seats).slice(0, 120));
} finally {
  try { ws?.close(); } catch { /* gone */ }
  if (fail) { console.log(`--- server output (tail) ---`); console.log(srv.stderr().slice(-4000)); }
  srv.kill();
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
