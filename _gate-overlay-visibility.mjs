/**
 * GATE — the overlay visibility check, and the signals it produces.
 *
 * Pass A shipped `_smoke-obs-overlay.mjs`, which asks a REAL OBS one question
 * once. This is the running version: it polls while a room is live and emits
 * the four signals Part 3 will consume — and it has to be right about which
 * ones it emits, because "the overlay was never hidden" is the expensive
 * direction to be wrong in.
 *
 * WHAT IS PROVEN HERE, and what deliberately is not:
 *
 *   PROVEN against the shared mock in six scene states: the state machine
 *   (visible / not-in-scene / disabled / off-canvas / covered), the conservative
 *   occlusion arithmetic, the scale arithmetic, the store's transitions-only
 *   contract, and the fact that the FLOOR is applied server-side.
 *
 *   NOT PROVEN, and the mock cannot prove it: which direction real OBS orders
 *   sceneItemIndex. The mock returns the array position and this gate asserts
 *   the logic against that stated convention. If real OBS is the other way
 *   round, the failure is a MISSED detection, never a false accusation, and
 *   never a payout difference — see the header of web/lib/obs-visibility.mjs.
 *   One real OBS session settles it; that is the same session B1 tracks.
 *
 *   NOT PROVEN: that any of this is anti-cheat. It runs in the streamer's
 *   browser against the streamer's OBS. Broadcast capture stays the payout
 *   authority, and this gate asserts that settlement is untouched.
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { makeMockObs } from './_gate-mock-obs.mjs';
import { startGateServer, mintBountyAuth } from './_gate-helpers.mjs';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'mc-visibility-gate-'));
process.env.DATA_DIR = SCRATCH;

const OBS_PORT = 4481;          // 4455 is forbidden; 446x/447x are taken
const APP_PORT = 3278;
const APP = `http://localhost:${APP_PORT}`;
const OVERLAY = 'MegaChat Overlay';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};

console.log('\n── overlay visibility ───────────────────────────────────');

const { ObsClient } = await import('./web/lib/obs-client.mjs');
const { checkOverlayVisibility, VISIBILITY, HIDDEN_REASON, occluderRect, coveredFraction, effectiveScale } =
  await import('./web/lib/obs-visibility.mjs');
const store = await import('./overlay-visibility.js');

const FULL = { positionX: 0, positionY: 0, scaleX: 1, scaleY: 1, sourceWidth: 1920, sourceHeight: 1080, width: 1920, height: 1080, boundsType: 'OBS_BOUNDS_NONE' };

/** A scene seeded with the overlay plus whatever else the case needs. */
async function withScene(items, fn) {
  const mock = makeMockObs({
    port: OBS_PORT,
    seed: { programScene: 'Live', scenes: { Live: items }, canvas: { baseWidth: 1920, baseHeight: 1080 } },
  });
  const client = new ObsClient({ url: `ws://127.0.0.1:${OBS_PORT}`, password: 'gate-obs-password' });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    try { client.close(); } catch { /* already gone */ }
    await mock.close();
  }
}

const overlayItem = (extra = {}) => ({ sceneItemId: 1, sourceName: OVERLAY, enabled: true, transform: { ...FULL }, ...extra });

// ── A. pure arithmetic, no OBS at all ───────────────────────────────────
{
  // An occluder's rect is UNDER-estimated; effectiveRect over-estimates. The
  // two biases are opposite on purpose — over-estimating an occluder
  // over-reports coverage, which accuses an honest streamer.
  const noReported = { positionX: 0, positionY: 0, sourceWidth: 100, sourceHeight: 100, scaleX: 2, scaleY: 2, boundsType: 'OBS_BOUNDS_NONE' };
  ok('A1 an occluder with no reported size falls back to the derived one',
    occluderRect(noReported).width === 200);
  ok('A2 and a reported size WINS over a larger derived one (no max())',
    occluderRect({ ...noReported, width: 50, height: 50 }).width === 50, 'reported 50 vs derived 200');

  const target = { x: 0, y: 0, width: 100, height: 100 };
  ok('A3 coverage is plain intersection, not the ±width convention',
    coveredFraction(target, { x: 50, y: 0, width: 50, height: 100 }) === 0.5);
  ok('A4 a non-touching rect covers nothing',
    coveredFraction(target, { x: 200, y: 200, width: 50, height: 50 }) === 0);

  ok('A5 scale is derived from the RENDERED height, not the reported scaleY',
    effectiveScale({ sourceHeight: 1080, scaleY: 1 }, { height: 540 }).scaleY === 0.5,
    'bounds modes leave scaleY describing something else');
}

// ── B. the state machine, against the mock ──────────────────────────────
{
  let r = await withScene([overlayItem()], (c) => checkOverlayVisibility(c));
  ok('B1 a full-canvas overlay alone in the scene is visible', r.signal === VISIBILITY.VISIBLE, r.detail);
  ok('B2 and its scale is measured at 1', r.scale?.scaleY === 1, `scaleY=${r.scale?.scaleY}`);

  r = await withScene([overlayItem({ enabled: false })], (c) => checkOverlayVisibility(c));
  ok('B3 the eye unticked reads as hidden/disabled',
    r.signal === VISIBILITY.HIDDEN && r.reason === HIDDEN_REASON.DISABLED, `${r.signal}/${r.reason}`);

  r = await withScene([{ sceneItemId: 9, sourceName: 'Just a webcam', enabled: true, transform: { ...FULL } }],
    (c) => checkOverlayVisibility(c));
  ok('B4 the overlay missing from the program scene reads as hidden/scene',
    r.signal === VISIBILITY.HIDDEN && r.reason === HIDDEN_REASON.SCENE, `${r.signal}/${r.reason}`);

  r = await withScene([overlayItem({ transform: { ...FULL, positionX: 5000, positionY: 5000 } })],
    (c) => checkOverlayVisibility(c));
  ok('B5 dragged off the canvas reads as hidden/offcanvas',
    r.signal === VISIBILITY.HIDDEN && r.reason === HIDDEN_REASON.OFFCANVAS, `${r.signal}/${r.reason}`);

  // THE ONE THE SMOKE TEST COULD NOT SEE: something on top of it.
  r = await withScene([
    overlayItem(),
    { sceneItemId: 2, sourceName: 'BRB screen', enabled: true, transform: { ...FULL } },
  ], (c) => checkOverlayVisibility(c));
  ok('B6 a full-screen source ABOVE the overlay reads as hidden/covered',
    r.signal === VISIBILITY.HIDDEN && r.reason === HIDDEN_REASON.COVERED, `${r.signal}/${r.reason} by ${r.occlusion?.by}`);

  // Same source, BELOW the overlay — must not count.
  r = await withScene([
    { sceneItemId: 2, sourceName: 'Game capture', enabled: true, transform: { ...FULL } },
    overlayItem({ sceneItemId: 3 }),
  ], (c) => checkOverlayVisibility(c));
  ok('B7 the same source BELOW the overlay does not count as covering it',
    r.signal === VISIBILITY.VISIBLE, `${r.signal} (above=${r.occlusion?.above})`);

  // A disabled occluder is not an occluder.
  r = await withScene([
    overlayItem(),
    { sceneItemId: 2, sourceName: 'Hidden BRB', enabled: false, transform: { ...FULL } },
  ], (c) => checkOverlayVisibility(c));
  ok('B8 a switched-off source above it covers nothing', r.signal === VISIBILITY.VISIBLE, r.signal);

  // A corner overlap is not a bury.
  r = await withScene([
    overlayItem(),
    { sceneItemId: 2, sourceName: 'Chat box', enabled: true, transform: { ...FULL, positionX: 1500, positionY: 800, width: 420, height: 280, sourceWidth: 420, sourceHeight: 280 } },
  ], (c) => checkOverlayVisibility(c));
  ok('B9 a chat box over one corner is NOT a bury', r.signal === VISIBILITY.VISIBLE,
    `covered ${Math.round((r.occlusion?.fraction ?? 0) * 100)}% — under the ${Math.round(0.6 * 100)}% threshold`);

  // Scaled down: still VISIBLE from the client. The floor is the server's.
  r = await withScene([overlayItem({ transform: { ...FULL, scaleX: 0.25, scaleY: 0.25, width: 480, height: 270 } })],
    (c) => checkOverlayVisibility(c));
  ok('B10 a scaled-down overlay is still VISIBLE to the client — the floor is not its call',
    r.signal === VISIBILITY.VISIBLE && r.scale?.scaleY === 0.25, `scaleY=${r.scale?.scaleY}`);

  // No client at all.
  r = await checkOverlayVisibility(null);
  ok('B11 no obs-websocket reads as obs_disconnected, blamelessly',
    r.signal === VISIBILITY.DISCONNECTED && r.checked === false);
}

// ── C. the store: transitions only, windows, refusals ───────────────────
{
  store._resetForTests();
  const R = 'gateroom';
  ok('C1 the first signal is recorded', store.recordSignal(R, { signal: 'overlay_visible', at: 1000 }).appended);
  ok('C2 a repeat of the same signal is NOT a new row',
    store.recordSignal(R, { signal: 'overlay_visible', at: 2000 }).appended === false);
  store.recordSignal(R, { signal: 'overlay_hidden', reason: 'covered', at: 3000 });
  store.recordSignal(R, { signal: 'overlay_visible', at: 9000 });
  const w = store.hiddenWindows(R);
  ok('C3 a hidden span becomes a window with a start and an end',
    w.length === 1 && w[0].startedAt === 3000 && w[0].endedAt === 9000, JSON.stringify(w[0]));
  store.recordSignal(R, { signal: 'overlay_hidden', reason: 'scene', at: 11000 });
  ok('C4 a window still open reads as open, not as closed-now',
    store.hiddenWindows(R).at(-1).endedAt === null);
  let threw = null;
  try { store.recordSignal(R, { signal: 'overlay_invisible' }); } catch (e) { threw = e; }
  ok('C5 an unknown signal is refused, not stored', !!threw, threw?.message);
}

// ── D. over HTTP: authorization, and the floor applied server-side ──────
{
  const auth = mintBountyAuth({ handles: ['visgate'], dataDir: SCRATCH });
  const rooms = await import('./rooms-store.js');
  const room = rooms.createRoom('visibility-gate', { maxSeats: 2 });
  const { roomOwnerKey } = await import('./auth.js');
  rooms.setRoomOwner(room.id, roomOwnerKey({ provider: 'twitch', platformId: '1000' }));

  const srv = await startGateServer({
    port: APP_PORT, dataDir: SCRATCH, env: { ...auth.env, KEEP_ORPHAN_ROOMS: 'true' }, label: 'visibility',
  });
  try {
    const post = (body, headers = {}) => fetch(`${APP}/api/rooms/${room.id}/overlay-visibility`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });

    let res = await post({ signal: 'overlay_visible' });
    ok('D1 an unauthenticated post is refused', res.status === 401, `http ${res.status}`);

    res = await post({ signal: 'overlay_visible', scale: { scaleY: 1 } }, { Cookie: auth.cookieFor('visgate') });
    let body = await res.json();
    ok('D2 the room owner may post', res.ok, `http ${res.status}`);
    ok('D3 a full-size overlay is NOT below the floor', body.belowFloor === false, `badgePx=${body.badgePx}`);

    // 28 CSS px at quarter scale is 7px against a 12px floor.
    res = await post({ signal: 'overlay_visible', scale: { scaleY: 0.25 } }, { Cookie: auth.cookieFor('visgate') });
    body = await res.json();
    ok('D4 THE SERVER re-derives the floor: a quarter-scale overlay becomes overlay_scaled_below_floor',
      body.signal === 'overlay_scaled_below_floor' && body.belowFloor === true,
      `client said overlay_visible; server said ${body.signal} at ${body.badgePx?.toFixed?.(1)}px`);

    // The client cannot simply assert it is fine.
    res = await post({ signal: 'overlay_visible', scale: { scaleY: 0.1 } }, { Cookie: auth.cookieFor('visgate') });
    body = await res.json();
    ok('D5 and a client claiming "visible" at 0.1 scale still gets the floor applied',
      body.signal === 'overlay_scaled_below_floor', body.signal);

    res = await fetch(`${APP}/api/rooms/${room.id}/overlay-visibility`, { headers: { Cookie: auth.cookieFor('visgate') } });
    body = await res.json();
    ok('D6 the dashboard read returns the current state and the windows',
      body.current?.signal === 'overlay_scaled_below_floor' && Array.isArray(body.windows),
      `current=${body.current?.signal} windows=${body.windows?.length}`);

    res = await post({ signal: 'nonsense' }, { Cookie: auth.cookieFor('visgate') });
    ok('D7 an unknown signal is a 400, not a stored row', res.status === 400, `http ${res.status}`);

    res = await fetch(`${APP}/api/rooms/nosuchroom/overlay-visibility`, { headers: { Cookie: auth.cookieFor('visgate') } });
    ok('D8 a room that does not exist is a 404', res.status === 404, `http ${res.status}`);
  } finally {
    srv.kill();
  }
}

// ── E. settlement is untouched ──────────────────────────────────────────
{
  const fs = await import('fs');
  // Comments are stripped first. The first version of this assertion scanned
  // raw text and failed on its own prose — these files legitimately DISCUSS
  // escrow and refunds in the comments that explain why Part 3 will read them.
  // An assertion that cannot tell code from a sentence about code is not an
  // assertion.
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const files = ['visibility-routes.js', 'overlay-visibility.js', 'web/lib/obs-visibility.mjs'];
  const code = files.map((f) => strip(fs.readFileSync(f, 'utf8'))).join('\n');

  // The Gate H set: anything that could move money.
  const transfers = /sendTransaction|writeContract|transferFrom|\.transfer\(|signTransaction|privateKeyToAccount|walletClient/;
  ok('E1 no transfer-shaped call anywhere in the visibility path',
    !transfers.test(code), `${files.length} modules scanned`);

  // And it must not even be WIRED to the money layer — importing escrow would
  // let a later edit reach settlement without touching these tests.
  const moneyImports = /from\s+['"]\.\/(bounty-escrow|bounty-settlement|bounty-store|meter-mpp|token-utils)\.js['"]/;
  ok('E2 and it imports nothing from the escrow, settlement or meter layer',
    !moneyImports.test(code),
    'Part 2 produces signals only — Part 3 is where they are consumed');

  // Gate H itself must still be green: this pass added modules, not paths.
  const bountySrc = fs.readdirSync('.').filter((f) => /^bounty-.*\.js$/.test(f));
  const offenders = bountySrc.filter((f) => transfers.test(strip(fs.readFileSync(f, 'utf8'))));
  ok('E3 Gate H still holds across all bounty modules',
    offenders.length === 0, offenders.join(',') || `${bountySrc.length} modules, zero transfer calls`);
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
