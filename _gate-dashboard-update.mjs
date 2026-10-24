/**
 * GATE — the dashboard's room save is all or nothing, and seat balances are
 * shown in the seat's own token (stores-7, server-7).
 *
 * THE DEFECTS
 *   stores-7  PUT /api/dashboard/rooms/:roomId saved the new password and the
 *             handle, THEN asked updateRoom, which refused the layout: the
 *             editor said "Layout refused" while the password and handle had
 *             already changed on disk.
 *   server-7  the owner's seat list formatted every balance with a fixed
 *             6-decimal formatter, so an 18-decimal token's balance read
 *             10^12 times too large.
 *
 * WHAT IT PROVES — over real HTTP against the real routes (attachDashboardRoutes
 * on an in-process Express app, room password auth as the dashboard sends it):
 *   R1-R3 a save carrying a refused layout, a new handle and a new password
 *         answers 400 and changes NOTHING: the old password still unlocks,
 *         the new one does not, no handle, the name unchanged
 *   R4    a taken handle answers 409, also changing nothing
 *   R5    a valid save applies all of it
 *   M1-M2 an 18-decimal seat holding 1.5 tokens reads "1.5"; a 6-decimal
 *         seat still reads as before
 *
 * Gates authenticate; they never bypass: every call carries the room password.
 * Spends nothing, starts no server process, writes only under the OS temp dir.
 *
 *   node _gate-dashboard-update.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-dash-update-'));
process.env.DATA_DIR = SCRATCH; // before any store is imported
delete process.env.ROOM_DEFAULT_PASSWORD;
const mod = (f) => import(pathToFileURL(path.join(HERE, f)).href);

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};

console.log('\n── dashboard: room save, seat balances ──────────────────');

const express = createRequire(path.join(HERE, 'package.json'))('express');
const rooms = await mod('rooms-store.js');
const { attachDashboardRoutes } = await mod('dashboard-routes.js');

// The 6-decimal formatter server.js hands the routes, as it is at HEAD.
function atomicToUsdc(atomic) {
  const v = BigInt(atomic);
  const whole = v / 1000000n;
  const frac = (v % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
const activeSeats = new Map();
const app = express();
app.use(express.json());
attachDashboardRoutes(app, {
  baseUrl: 'http://gate.test', activeSeats, removeParticipant() {}, setSeatPinned() {},
  atomicToUsdc, twitchLiveCached: () => false, listAirings: () => [],
});
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;
const call = (method, p, { body, password } = {}) => fetch(`${BASE}${p}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(password ? { 'X-Room-Password': password } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const unlocks = async (id, pw) => (await call('POST', '/api/dashboard/unlock', { body: { roomId: id, password: pw } })).status === 200;
const onDisk = (id) => JSON.parse(fs.readFileSync(path.join(SCRATCH, 'rooms.json'), 'utf8')).rooms[id];

const BAD_LAYOUT = { origin: 'top-right', direction: 'down', tile: { w: 1920, h: 1080, gap: 0 } };
try {
  const room = await rooms.createRoomWithPassword('Gate room', {}, 'pw-original');
  const other = rooms.createRoom('Other room');
  rooms.setRoomHandle(other.id, 'gatetaken');

  const refused = await call('PUT', `/api/dashboard/rooms/${room.id}`, {
    password: 'pw-original',
    body: { name: 'Leaked name', handle: 'gatefresh', newPassword: 'pw-leaked-1', config: { layout: BAD_LAYOUT } },
  });
  ok('R1 a save with a layout that buries the badge is refused (400 Layout refused)',
    refused.status === 400 && refused.body.code === 'layout_refused', `http ${refused.status} ${refused.body.error || ''}`);
  ok('R2 ...and the password is UNCHANGED: the old one unlocks, the new one does not',
    (await unlocks(room.id, 'pw-original')) && !(await unlocks(room.id, 'pw-leaked-1')));
  ok('R3 ...nor did the handle or the name change, in memory or on disk',
    !rooms.getRoomRecord(room.id).handle && !onDisk(room.id).handle && onDisk(room.id).name === 'Gate room',
    JSON.stringify({ handle: onDisk(room.id).handle ?? null, name: onDisk(room.id).name }));

  // Each case below has its own room, so one case's leak cannot fail the next.
  const roomB = await rooms.createRoomWithPassword('Gate room B', {}, 'pw-b-original');
  const taken = await call('PUT', `/api/dashboard/rooms/${roomB.id}`, {
    password: 'pw-b-original', body: { name: 'Also leaked', handle: 'gatetaken', newPassword: 'pw-leaked-2' },
  });
  ok('R4 a taken handle answers 409 and changes nothing, the password included',
    taken.status === 409 && (await unlocks(roomB.id, 'pw-b-original')) && onDisk(roomB.id).name === 'Gate room B', `http ${taken.status}`);

  const roomC = await rooms.createRoomWithPassword('Gate room C', {}, 'pw-c-original');
  const saved = await call('PUT', `/api/dashboard/rooms/${roomC.id}`, {
    password: 'pw-c-original', body: { name: 'Saved name', handle: 'gatesaved', newPassword: 'pw-new-1234' },
  });
  ok('R5 a valid save applies name, handle and password together',
    saved.status === 200 && saved.body.room?.handle === 'gatesaved' && onDisk(roomC.id).name === 'Saved name'
      && (await unlocks(roomC.id, 'pw-new-1234')) && !(await unlocks(roomC.id, 'pw-c-original')), `http ${saved.status}`);

  // Seat balances, in the seat's token.
  const seatRoom = await rooms.createRoomWithPassword('Seat room', {}, 'pw-seats');
  activeSeats.set('seat-18', { id: 'seat-18', streamRoomId: seatRoom.id, username: 'eighteen', live: true, paymentMode: 'passkey_stream',
    remainingAtomic: 1_500_000_000_000_000_000n, spentAtomic: 250_000_000_000_000_000n, paymentTokenDecimals: 18 });
  activeSeats.set('seat-6', { id: 'seat-6', streamRoomId: seatRoom.id, username: 'six', live: true, paymentMode: 'passkey_stream',
    remainingAtomic: 1_250_000n, spentAtomic: 10n, paymentTokenDecimals: 6 });
  const view = await call('GET', `/api/dashboard/rooms/${seatRoom.id}`, { password: 'pw-seats' });
  const seat = (id) => (view.body.seats || []).find((s) => s.id === id);
  ok('M1 an 18-decimal seat holding 1.5 tokens reads "1.5" remaining, "0.25" spent',
    seat('seat-18')?.remaining === '1.5' && seat('seat-18')?.spent === '0.25', JSON.stringify(seat('seat-18') && [seat('seat-18').remaining, seat('seat-18').spent]));
  ok('M2 a 6-decimal seat reads as it always did',
    seat('seat-6')?.remaining === '1.25' && seat('seat-6')?.spent === '0.00001', JSON.stringify(seat('seat-6') && [seat('seat-6').remaining, seat('seat-6').spent]));
} catch (e) {
  ok(`unexpected: ${e.stack || e.message}`, false);
} finally {
  await new Promise((r) => server.close(r));
  fs.rmSync(SCRATCH, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
