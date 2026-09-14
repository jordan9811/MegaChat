/**
 * GATE — "Follow my stream status" actually follows the stream.
 *
 * The toggle shipped promising "bring this room live automatically when I start
 * streaming" and for months did nothing of the kind: twitchAuto was stored, the
 * UI read it to adopt the owner's channel name, and no server code read it at
 * all. This proves the loop exists and, more importantly, proves the TWO SPEEDS
 * the behaviour is built on — because getting those the same way round would be
 * worse than not having the feature:
 *
 *   going live        → room opens
 *   stream drops      → off the board IMMEDIATELY, still active (a blip must
 *                       never end a conversation in progress)
 *   dark for a while  → room pauses
 *
 * Runs against a FAKE Twitch (TWITCH_ID_BASE / TWITCH_API_BASE, the override
 * twitch-api.js already documents) so liveness is something this file decides,
 * and with FOLLOW_POLL_MS / FOLLOW_OFF_CONFIRM_MS turned down so the confirm
 * window is seconds rather than five minutes.
 */
import http from 'node:http';
import { startGateServer } from './_gate-helpers.mjs';

const PORT = 3287;
const TWITCH_PORT = 3288;
const APP = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const POLL_MS = 1000;
const OFF_CONFIRM_MS = 4000;

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  (${detail})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
};

// ── fake Twitch ────────────────────────────────────────────────────────────
// `live` is a switch this test flips. /helix/streams returns a row ONLY for a
// live channel, which is exactly how the real endpoint signals offline.
let live = false;
let helixCalls = 0;
let maxLoginsInOneCall = 0;

const twitch = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${TWITCH_PORT}`);
  if (url.pathname === '/oauth2/token') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ access_token: 'fake-token', expires_in: 3600 }));
  }
  if (url.pathname === '/helix/streams') {
    helixCalls++;
    const logins = url.searchParams.getAll('user_login');
    maxLoginsInOneCall = Math.max(maxLoginsInOneCall, logins.length);
    const data = live ? logins.map((l) => ({ user_login: l, viewer_count: 7 })) : [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data }));
  }
  res.writeHead(404).end('{}');
});
await new Promise((r) => twitch.listen(TWITCH_PORT, r));

// ── app ────────────────────────────────────────────────────────────────────
const { child, dataDir } = await startGateServer({
  port: PORT,
  label: 'follow-stream',
  env: {
    TWITCH_CLIENT_ID: 'gate-client',
    TWITCH_CLIENT_SECRET: 'gate-secret',
    TWITCH_ID_BASE: `http://localhost:${TWITCH_PORT}`,
    TWITCH_API_BASE: `http://localhost:${TWITCH_PORT}`,
    FOLLOW_POLL_MS: String(POLL_MS),
    FOLLOW_OFF_CONFIRM_MS: String(OFF_CONFIRM_MS),
    KEEP_ORPHAN_ROOMS: 'true',
  },
});

const api = async (path, init) => {
  const r = await fetch(`${APP}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const onBoard = async (roomId) => {
  const { body } = await api('/api/rooms/public');
  return (body.rooms || []).some((r) => r.id === roomId);
};
const isActive = async (roomId) => {
  const { body } = await api(`/api/config?room=${encodeURIComponent(roomId)}`);
  return body.roomActive === true;
};
/** Wait for a predicate, so the test never races the 1s tick. */
const until = async (label, fn, ms = 12000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(250);
  }
  console.log(`    (timed out waiting for ${label})`);
  return false;
};

try {
  console.log('\n── follow my stream ──────────────────────────────────────');

  // A room that follows a channel, created paused, while that channel is dark.
  const created = await api('/api/dashboard/create', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Follow Gate Room',
      password: 'gate-pass-1234',
      config: { twitchChannel: 'gatestreamer', twitchAuto: true, unlisted: false },
    }),
  });
  const roomId = created.body?.roomId || created.body?.room?.id;
  ok('room created with twitchAuto + channel', !!roomId, `id=${roomId} status=${created.status}`);
  if (!roomId) throw new Error('cannot continue without a room');

  // The room password rides in x-room-password, not the body (auth.js:111).
  const stopped = await fetch(`${APP}/api/dashboard/rooms/${roomId}/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-room-password': 'gate-pass-1234' },
  });
  // This one is load-bearing for A1: if the room is already active, "going
  // live opens it" proves nothing at all.
  ok('starts paused', (await isActive(roomId)) === false, `stop=${stopped.status}`);

  // ── A. going live opens the room ────────────────────────────────────────
  live = true;
  ok('A1 going live → room becomes active',
    await until('active', async () => await isActive(roomId)));
  ok('A2 and it is on the discovery board',
    await until('on board', async () => await onBoard(roomId)));

  // ── B. the stream drops ─────────────────────────────────────────────────
  live = false;
  ok('B1 dark → OFF the board immediately',
    await until('off board', async () => !(await onBoard(roomId))));
  // The whole point: it must still be ACTIVE at this moment. Checked right
  // after it leaves the board, well inside the confirm window.
  ok('B2 …but the room is STILL ACTIVE (a blip must not end a conversation)',
    (await isActive(roomId)) === true);

  // ── C. a blip recovers without ever pausing ─────────────────────────────
  live = true;
  ok('C1 stream returns → back on the board',
    await until('back on board', async () => await onBoard(roomId)));
  ok('C2 never paused through the blip', (await isActive(roomId)) === true);

  // ── D. sustained dark pauses the room ───────────────────────────────────
  live = false;
  ok('D1 dark past the confirm window → room pauses',
    await until('paused', async () => (await isActive(roomId)) === false, OFF_CONFIRM_MS + 8000));

  // ── E. cost shape: one batched call per tick, not one per room ──────────
  // This is the claim the whole design rests on — that the cost of asking does
  // not grow with the number of rooms. A single-room test cannot show it, so
  // add a second following room and prove BOTH logins ride one request.
  const second = await api('/api/dashboard/create', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Second Follow Room',
      password: 'gate-pass-1234',
      config: { twitchChannel: 'othergatestreamer', twitchAuto: true, unlisted: false },
    }),
  });
  const secondId = second.body?.roomId || second.body?.room?.id;
  ok('second following room created', !!secondId, `id=${secondId} status=${second.status}`);
  const callsBefore = helixCalls;
  maxLoginsInOneCall = 0;
  await sleep(POLL_MS * 3);
  const ticks = helixCalls - callsBefore;
  ok('E1 two rooms are asked about in ONE request, not two',
    maxLoginsInOneCall >= 2,
    `maxLoginsPerCall=${maxLoginsInOneCall}`);
  ok('E2 request count is per TICK, not per room',
    ticks > 0 && ticks <= 4,
    `${ticks} requests across ~3 ticks for 2 rooms`);

  // ── F. "could not ask" must never pause anything ────────────────────────
  live = true;
  await until('active again', async () => await isActive(roomId));
  twitch.close();                       // Twitch is now unreachable
  await new Promise((r) => twitch.closeAllConnections?.() ?? r());
  await sleep(POLL_MS * 4);
  ok('F1 Twitch unreachable → room left ALONE, not paused',
    (await isActive(roomId)) === true);
} catch (e) {
  fail++;
  console.log(`  FAIL  harness threw: ${e.message}`);
} finally {
  child.kill();
  try { twitch.close(); } catch { /* already closed */ }
  console.log(`\n  ${pass} passed, ${fail} failed   (data: ${dataDir})\n`);
  process.exit(fail ? 1 : 0);
}
