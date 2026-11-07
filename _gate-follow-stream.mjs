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
// The manage-page witness (server.js closePlan), turned down like the rest.
const OWNER_OFF_MS = 1500;      // stream ended, owner online, OBS still up
const LEAVE_GRACE_MS = 1000;    // a goodbye, then the reload grace
const BEAT_STALE_MS = 5000;     // no beat this long = the page went quiet; also how long a Start holds
const MANAGER_TICK_MS = 250;
// The keyed overlay: the server derives the room's key from AUTH_SECRET, so
// the gate derives the same one (overlay-key.js overlayKeyFor).
const AUTH_SECRET = 'follow-gate-overlay-secret';
process.env.AUTH_SECRET = AUTH_SECRET; // this process derives keys with it; the server is given it below
const { overlayKeyFor } = await import('./overlay-key.js');
const overlayKey = (roomId) => overlayKeyFor(roomId);
// GATE_TREE runs this file against another checkout (the previous commit) to
// show the new assertions fail there: the test has to discriminate.
const TREE = process.env.GATE_TREE || undefined;

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
// Per-channel liveness and titles for the later sections, which must not
// move the first room: `live` stays false while they run.
const liveSet = new Set();
const titles = new Map();
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
    const data = logins.filter((l) => live || liveSet.has(l))
      .map((l) => ({ user_login: l, viewer_count: 7, title: titles.get(l) || '' }));
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
    FOLLOW_OFF_OWNER_MS: String(OWNER_OFF_MS),
    MANAGER_LEAVE_GRACE_MS: String(LEAVE_GRACE_MS),
    MANAGER_BEAT_STALE_MS: String(BEAT_STALE_MS),
    MANAGER_TICK_MS: String(MANAGER_TICK_MS),
    AUTH_SECRET,
    KEEP_ORPHAN_ROOMS: 'true',
  },
  ...(TREE ? { cwd: TREE } : {}),
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
const PW = 'gate-pass-1234';
const asManager = { 'Content-Type': 'application/json', 'x-room-password': PW };
const mkRoom = async (name, channel) => {
  const r = await api('/api/dashboard/create', {
    method: 'POST',
    body: JSON.stringify({ name, password: PW, config: { twitchChannel: channel, twitchAuto: true, unlisted: false } }),
  });
  return r.body?.roomId || r.body?.room?.id || null;
};
const post = (path, body) => fetch(`${APP}${path}`, { method: 'POST', headers: asManager, body: body ? JSON.stringify(body) : undefined });
const startRoom = (id) => post(`/api/dashboard/rooms/${id}/start`);
const stopRoom = (id) => post(`/api/dashboard/rooms/${id}/stop`);
const presence = (id, tab, state = 'here') => post(`/api/dashboard/rooms/${id}/presence`, { tab, state });
/** The manage page, as far as the server can tell: a beat every 400ms. */
const managePage = (id, tab) => {
  void presence(id, tab);
  const t = setInterval(() => void presence(id, tab), 400);
  return { close: async () => { clearInterval(t); await presence(id, tab, 'gone'); }, stop: () => clearInterval(t) };
};
const session = async (id) => {
  const r = await fetch(`${APP}/api/dashboard/rooms/${id}`, { headers: asManager });
  return r.json().catch(() => ({}));
};
// "On the board" no longer proves the server saw the stream: a room its
// owner holds open shows before it is live. Ask what the server saw.
const seenLive = async (id) => (await session(id)).follow?.state === 'live';
const putRoom = (id, body) => fetch(`${APP}/api/dashboard/rooms/${id}`, { method: 'PUT', headers: asManager, body: JSON.stringify(body) })
  .then((r) => r.json().catch(() => ({})));
/** A keyed OBS overlay on a room: the socket the server counts as the real overlay. */
const openOverlay = (id) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://localhost:${PORT}/`);
  ws.onopen = () => { ws.send(JSON.stringify({ type: 'subscribe_room', room: id, role: 'overlay', k: overlayKey(id) })); setTimeout(() => resolve(ws), 300); };
  ws.onerror = () => reject(new Error('overlay socket failed'));
});

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
  // Not read through the manage page here on purpose: its own refresh is word
  // from the owner (server.js managerContactAt), and with no overlay up that
  // would close the room at once. B is the case where nothing is heard: the
  // blip window must decide. J checks the countdown the manage page shows.

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

  // ── H. a room opened by hand before the stream stays open ───────────────
  // Production, 2026-11-07: the owner pressed Start four times in five
  // minutes and the loop paused the room within a minute each time, because
  // the channel had been dark since the server booted, hours past the window.
  const heldId = await mkRoom('Held Room', 'heldstreamer');
  ok('H0 room created', !!heldId, `id=${heldId}`);
  await stopRoom(heldId);
  await sleep(OFF_CONFIRM_MS + 1500); // its dark state is now OLDER than the window
  await startRoom(heldId);
  const heldPage = managePage(heldId, 'held-tab');
  await sleep(OFF_CONFIRM_MS + 2500);
  ok('H1 started by hand before the stream → STILL ACTIVE past the confirm window',
    (await isActive(heldId)) === true);
  ok('H2 …and on the board: the owner opened it, stream or not',
    await onBoard(heldId));
  ok('H3 the manage page reads it as waiting, with nothing counting down',
    await (async () => { const f = (await session(heldId)).follow; return f?.state === 'waiting' && f.closesAt == null; })());
  // Press Start again right before leaving: the hold it makes must give way
  // to the goodbye, not keep a closed page's room open for the stale window.
  await startRoom(heldId);
  await sleep(500); // a beat lands after the Start
  await heldPage.close();
  const byeT0 = Date.now();
  ok('H4 manage page closed before the stream started → pauses after the reload grace, not the hold',
    await until('paused', async () => !(await isActive(heldId)), BEAT_STALE_MS - 2000),
    `${Date.now() - byeT0}ms`);
  // Going live reopens it on its own: closing early cost the owner nothing.
  liveSet.add('heldstreamer');
  ok('H5 …and going live opens it again',
    await until('active again', async () => await isActive(heldId)));
  liveSet.delete('heldstreamer');

  // ── I. the stream ends while the owner is online and OBS is closed ──────
  const endId = await mkRoom('Ending Room', 'endstreamer');
  const endPage = managePage(endId, 'end-tab');
  liveSet.add('endstreamer');
  ok('I0 live', await until('seen live', async () => await seenLive(endId)));
  liveSet.delete('endstreamer');
  const endT0 = Date.now();
  // The old rule waited the whole window (4000ms after the tick that saw it
  // dark). The owner beat after the dark and no overlay is up: an ending.
  ok('I1 stream ends, owner online, no OBS overlay → pauses well inside the blip window',
    await until('paused', async () => !(await isActive(endId)), 3000),
    `${Date.now() - endT0}ms`);
  endPage.stop();

  // ── J. the stream ends, owner online, OBS overlay still connected ───────
  // OBS open with the stream stopped: probably an ending, so a short wait
  // (FOLLOW_OFF_OWNER_MS) rather than the five-minute blip window.
  const obsId = await mkRoom('OBS Room', 'obsstreamer');
  const obsPage = managePage(obsId, 'obs-tab');
  const overlay = await openOverlay(obsId);
  liveSet.add('obsstreamer');
  ok('J0 live', await until('seen live', async () => await seenLive(obsId)));
  liveSet.delete('obsstreamer');
  ok('J1 stream ends with OBS still up → NOT paused at once',
    await until('off board', async () => !(await onBoard(obsId))) && (await isActive(obsId)) === true);
  {
    const f = (await session(obsId)).follow;
    const left = f?.closesAt ? Date.parse(f.closesAt) - Date.now() : NaN;
    ok('J2 …the manage page counts down the short wait, not the blip window',
      f?.state === 'ended' && left > 0 && left <= OWNER_OFF_MS, `closesIn=${Math.round(left)}ms`);
  }
  const obsT0 = Date.now();
  ok('J3 …and it pauses when the short wait is up',
    await until('paused', async () => !(await isActive(obsId)), OWNER_OFF_MS + 3000),
    `${Date.now() - obsT0}ms`);
  overlay.close();
  obsPage.stop();

  // ── K. the stream ends and the owner closes the manage page ────────────
  const byeId = await mkRoom('Goodbye Room', 'byestreamer');
  const byePage = managePage(byeId, 'bye-tab');
  const byeOverlay = await openOverlay(byeId); // OBS left open: the goodbye still counts
  liveSet.add('byestreamer');
  ok('K0 live', await until('seen live', async () => await seenLive(byeId)));
  byePage.stop();
  liveSet.delete('byestreamer');
  await until('off board', async () => !(await onBoard(byeId)));
  await presence(byeId, 'bye-tab', 'gone');
  ok('K1 stream ended + manage page closed → pauses after the reload grace',
    await until('paused', async () => !(await isActive(byeId)), LEAVE_GRACE_MS + 3000));
  byeOverlay.close();

  // ── L. a room that follows no stream ────────────────────────────────────
  const plainId = await mkRoom('Plain Room', null);
  const plainPage = managePage(plainId, 'plain-tab');
  await sleep(BEAT_STALE_MS + 1500);
  ok('L1 follows no stream → stays open while its manage page is open',
    (await isActive(plainId)) === true);
  await plainPage.close();
  ok('L2 …manage page closed, no OBS overlay → pauses',
    await until('paused', async () => !(await isActive(plainId)), LEAVE_GRACE_MS + 3000));
  const plainObsId = await mkRoom('Plain OBS Room', null);
  const plainObsPage = managePage(plainObsId, 'plainobs-tab');
  const plainOverlay = await openOverlay(plainObsId);
  await plainObsPage.close();
  await sleep(LEAVE_GRACE_MS + 2000);
  ok('L3 …but with a keyed OBS overlay still connected it stays open (they are streaming)',
    (await isActive(plainObsId)) === true);
  plainOverlay.close();
  ok('L4 …and pauses once the overlay is gone too',
    await until('paused', async () => !(await isActive(plainObsId)), LEAVE_GRACE_MS + 3000));
  // A room nobody has managed this boot is never closed on this signal: the
  // test room and the demo room live like that.
  const loneId = await mkRoom('Unmanaged Room', null);
  await sleep(BEAT_STALE_MS + LEAVE_GRACE_MS + 1500);
  ok('L5 a room whose manage page was never seen is left alone',
    (await isActive(loneId)) === true);
  ok('L6 the test room is left alone', (await isActive('default')) === true);

  // ── M. the room name ────────────────────────────────────────────────────
  titles.set('namestreamer', 'Stream Title Here');
  const nameId = await mkRoom('My Typed Name', 'namestreamer');
  liveSet.add('namestreamer');
  ok('M0 live', await until('seen live', async () => await seenLive(nameId)));
  await sleep(POLL_MS * 3);
  let s = await session(nameId);
  ok('M1 a name typed at creation is NOT replaced by the stream title',
    s.room?.name === 'My Typed Name', `name=${s.room?.name}`);
  ok('M2 …and the manage page is offered the title beside it',
    s.room?.nameSource === 'owner' && s.follow?.title === 'Stream Title Here',
    `nameSource=${s.room?.nameSource} title=${s.follow?.title}`);
  await putRoom(nameId, { useTwitchTitle: true });
  s = await session(nameId);
  ok('M3 "Use this name" takes the title now',
    s.room?.name === 'Stream Title Here' && s.room?.nameSource === 'twitch', `name=${s.room?.name} nameSource=${s.room?.nameSource}`);
  titles.set('namestreamer', 'Second Title');
  ok('M4 …and follows it from then on',
    await until('renamed', async () => (await session(nameId)).room?.name === 'Second Title'));
  // An autosave carrying the name it already has must not claim it.
  await putRoom(nameId, { name: 'Second Title' });
  titles.set('namestreamer', 'Third Title');
  ok('M5 a save that repeats the current name does not stop it following',
    await until('renamed again', async () => (await session(nameId)).room?.name === 'Third Title'));
  await putRoom(nameId, { name: 'Owner Edit' });
  titles.set('namestreamer', 'Fourth Title');
  await sleep(POLL_MS * 3);
  s = await session(nameId);
  ok('M6 an edit by the owner is theirs again: the title stops replacing it',
    s.room?.name === 'Owner Edit' && s.room?.nameSource === 'owner', `name=${s.room?.name}`);
  liveSet.delete('namestreamer');
  titles.set('blankstreamer', 'Blank Room Title');
  const blankId = await mkRoom('', 'blankstreamer');
  liveSet.add('blankstreamer');
  ok('M7 a room created WITHOUT a name takes the stream title',
    await until('titled', async () => (await session(blankId)).room?.name === 'Blank Room Title'));
  liveSet.delete('blankstreamer');

  // ── G. airings: the record a "recently aired" board is built on ─────────
  // Runs before F because F kills the fake Twitch.
  const recent = async () => (await api('/api/rooms/recent')).body.airings || [];
  const mine = async () => {
    const r = await fetch(`${APP}/api/dashboard/rooms/${roomId}/airings`, {
      headers: { 'x-room-password': 'gate-pass-1234' },
    });
    return (await r.json().catch(() => ({}))).airings || [];
  };

  // The owner's view is unfiltered, so an airing with no moments is visible
  // here even though the board correctly refuses to carry it.
  const closed = (await mine()).filter((a) => a.endedAt != null);
  ok('G1 a finished broadcast produced an airing',
    closed.length >= 1, `airings=${closed.length}`);
  const first = closed[0];
  // The owner endpoint returns the RAW record; durationMs is a convenience
  // the public board computes, so derive it here rather than expecting it.
  const durMs = first ? first.endedAt - first.startedAt : NaN;
  ok('G2 the airing is closed and has a real duration',
    !!first && durMs > 0, first ? `${durMs}ms` : 'none');

  // The confirm window is a hedge about PAUSING. It must not end up stamped
  // into history as five minutes of dead air on the end of a replay.
  ok('G3 closed when the stream went dark, not when the room paused',
    !!first && durMs < OFF_CONFIRM_MS,
    first ? `duration=${durMs}ms confirmWindow=${OFF_CONFIRM_MS}ms` : 'none');

  // A blip must not leave two cards behind for one broadcast.
  ok('G5 a blip reopened the airing instead of starting a second one',
    closed.length === 1, `closedAirings=${closed.length}`);

  // An airing with nothing in it is the empty board wearing a costume. This
  // one has no moments, so it must be visible to the owner and absent from
  // the board — the two endpoints disagreeing is the assertion.
  const onBoardNow = (await recent()).filter((a) => a.roomId === roomId);
  ok('G4 an empty airing is owner-visible but NOT board content',
    (first?.moments?.length || 0) === 0 && closed.length >= 1 && onBoardNow.length === 0,
    `ownerSees=${closed.length} boardSees=${onBoardNow.length} moments=${first?.moments?.length}`);

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
