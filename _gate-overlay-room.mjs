/**
 * GATE — the overlay URL must survive the next stream.
 *
 * The overlay reads `?bounty=<airSessionId>`, so its URL is valid for exactly
 * ONE session. In production the one-click OBS flow re-adds the browser source
 * every stream and hides that entirely. Anyone who configures the source BY
 * HAND — pasting the URL once, as a streamer reasonably would — gets a dead
 * overlay on their next stream: it renders nothing, verification reports zero,
 * and the streamer is told their broadcast carried no badge.
 *
 * That failure consumed THREE real broadcasts in one testing session, and it
 * presented as a capture bug every time: black frames, 0/5, SOURCE_UNAVAILABLE.
 * Nothing in the pipeline distinguishes "the overlay is not in the scene" from
 * "capture is broken" — the frames look identical.
 *
 * So `?bountyRoom=<roomId>` follows whatever session is OPEN in that room, and
 * the URL never changes. This gate holds that contract IN A REAL BROWSER,
 * because the failure it prevents is a rendering failure and no amount of
 * route-level assertion can see a badge that was never painted.
 *
 * TWO THINGS IT DELIBERATELY CHECKS THE HARD WAY:
 *   - the CANVAS, not textContent. The code renders as a matrix on a canvas
 *     and leaves textContent empty, so a naive text assertion passes on a
 *     blank overlay. The first version of this test did exactly that.
 *   - past the FIRST poll interval, which is max(5000, rotateMs/4) with
 *     rotateMs starting at 60000 — a full 15s regardless of real rotation.
 *     Asserting at 4s reported a working overlay as broken.
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';

const PORT = 3317;
const APP = `http://localhost:${PORT}`;
const ROOM = 'gateoverlayroom';
const HANDLE = 'gatestreamer';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};

const { startGateServer } = await import('./_gate-helpers.mjs');
const { bountyConfig } = await import('./bounty-claim.config.js');
const srv = await startGateServer({
  port: PORT, dataDir: mkdtempSync(path.join(tmpdir(), 'mc-ovlroom-')),
  label: 'overlay-room', bountyAuth: { handles: [`kick:${HANDLE}`] },
  env: { BOUNTY_CLAIM: '1', BOUNTY_IDENTITY_REAL: '0', KEEP_ORPHAN_ROOMS: 'true' },
  readyTimeoutMs: 180_000,
});
const post = (p, b, as) => fetch(`${APP}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...srv.headers(as) },
  body: JSON.stringify(b),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (p, as) => fetch(`${APP}${p}`, { headers: srv.headers(as) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const AS = `kick:${HANDLE}`;
let browser;
try {
  // ── A. the room route, before any session exists ────────────────────────
  // Between streams there is legitimately no session. The overlay must render
  // nothing rather than break, so this is a clean null — never an error.
  const empty = await get(`/api/bounty/room/${ROOM}/code`, AS);
  ok('A. no open session is a clean null, not an error',
    empty.status === 200 && empty.body.code === null
    && empty.body.status === 'NO_OPEN_SESSION' && empty.body.airSessionId === null,
    `${empty.status} ${JSON.stringify(empty.body).slice(0, 90)}`);

  // ── a session in that room ──────────────────────────────────────────────
  const pl = await post('/api/bounty/pledge', {
    targets: [{ platform: 'kick', handle: HANDLE }],
    contributor: '0xgate', amount: '25', expiresInMs: 86_400_000,
  }, AS);
  await fetch(`${APP}${pl.body.uploadUrl}?durationS=8`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm', ...srv.headers(AS) },
    body: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 5)]),
  });
  const claim = await post('/api/bounty/claim',
    { platform: 'kick', handle: HANDLE, claimant: HANDLE }, AS);
  const air = await post('/api/bounty/air-session',
    { claimId: claim.body.claim.id, roomId: ROOM }, AS);
  const airId = air.body.airSession?.id;
  ok('A. an air session opens in the room', !!airId, airId || JSON.stringify(air.body));

  const idle = await get(`/api/bounty/room/${ROOM}/code`, AS);
  ok('A. session open but NO clip playing is still a null code',
    idle.body.code === null && idle.body.status === 'OPEN' && idle.body.airSessionId === airId,
    'a parked overlay legitimately shows nothing and earns nothing');

  // ── B. the room route agrees with the by-id route, exactly ──────────────
  const play = await post('/api/bounty/admin/playback',
    { airSessionId: airId, clipId: 'GOR1', durationS: 30 });
  const issued = play.body.code?.code;
  const byRoom = await get(`/api/bounty/room/${ROOM}/code`, AS);
  const byId = await get(`/api/bounty/air-session/${airId}/code`, AS);
  ok('B. the room route returns the live code', byRoom.body.code === issued,
    `room=${byRoom.body.code} issued=${issued}`);
  ok('B. ...identical to the by-id route (one code, two addresses)',
    byRoom.body.code === byId.body.code && byRoom.body.expiresAt === byId.body.expiresAt);
  ok('B. ...and carries the session id, so badge/env reports can follow it',
    byRoom.body.airSessionId === airId);

  // ── C. THE POINT: a real browser paints the badge in room mode ──────────
  browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new',
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto(`${APP}/overlay?bountyRoom=${ROOM}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Past the first poll interval — see the header note on why 4s is not enough.
  await new Promise((r) => setTimeout(r, 20_000));
  const shown = await page.evaluate(() => document.getElementById('bounty-badge')?.classList.contains('show'));
  const painted = await page.evaluate(() => {
    const c = document.getElementById('bounty-matrix');
    if (!c) return -1;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n += 1;
    return n;
  });
  ok('C. the badge is VISIBLE with no session id in the URL', shown === true);
  // The canvas is the real assertion: textContent stays empty by design, so a
  // text check passes on a completely blank overlay.
  ok('C. ...and the code matrix is actually PAINTED, not just shown',
    painted > 100, `${painted} painted pixel(s) on the matrix canvas`);
  ok('C. ...with no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');

  // ── D. the by-id form still works, unchanged ───────────────────────────
  // ITS OWN CLIP. Section C's clip is 30s long and C alone waits 20s past the
  // first poll interval, so by here the original playback has ENDED and the
  // overlay correctly shows nothing. Reusing it made this assertion fail and
  // look like a regression in the one-click path — the same
  // wrong-timing-not-wrong-code mistake this gate's header warns about.
  await post('/api/bounty/admin/playback/end', { airSessionId: airId, clipId: 'GOR1' });
  await post('/api/bounty/admin/playback',
    { airSessionId: airId, clipId: 'GOR2', durationS: 60 });
  const byIdPage = await browser.newPage();
  await byIdPage.setViewport({ width: 1280, height: 720 });
  await byIdPage.goto(`${APP}/overlay?bounty=${airId}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 20_000));
  const idShown = await byIdPage.evaluate(() => document.getElementById('bounty-badge')?.classList.contains('show'));
  ok('D. the one-click ?bounty=<id> form is untouched', idShown === true);
  await byIdPage.close();

  // ── F. THE BADGE MUST ROTATE AT THE SERVER'S RATE ──────────────────────
  // setInterval was created BEFORE the first poll returned, so it captured
  // the 60000 placeholder and locked a 15-SECOND cadence against a 4-second
  // server rotation. Every code sat on screen ~4x too long.
  //
  // That is not a cosmetic staleness bug. Timeline calibration estimates the
  // broadcast delay from which code is visible versus that code's NOMINAL
  // midpoint, so a code held 4x too long makes an on-time stream look ~10s
  // delayed. On a real pump.fun broadcast it produced skew 10366ms on a
  // stream whose true offset was near zero, and every sample then found a
  // REAL badge at 28px carrying the WRONG code: 0/9 verified.
  //
  // Measured by hashing the matrix canvas once a second, because the code
  // renders to a canvas and leaves textContent empty — the same trap that
  // made an earlier version of this gate pass on a blank overlay.
  {
    const rotatePage = await browser.newPage();
    await rotatePage.setViewport({ width: 1280, height: 720 });
    await rotatePage.goto(`${APP}/overlay?bountyRoom=${ROOM}`,
      { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 3_000));
    const SECONDS = 24;
    const hashes = [];
    for (let i = 0; i < SECONDS; i += 1) {
      await new Promise((r) => setTimeout(r, 1_000));
      const h = await rotatePage.evaluate(() => {
        const c = document.getElementById('bounty-matrix');
        if (!c) return null;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let x = 0;
        for (let k = 0; k < d.length; k += 97) x = (x * 31 + d[k]) >>> 0;
        return x;
      }).catch(() => null);
      if (h != null) hashes.push(h);
    }
    const distinct = new Set(hashes).size;
    const perCode = distinct > 0 ? SECONDS / distinct : Infinity;
    const rotateS = bountyConfig.codeRotateMs / 1000;
    // Generous ceiling: sampling granularity and network jitter both widen
    // the observed figure. The bug being caught was 4x, not 2x.
    ok('F. the badge rotates near the server rate, not 4x slower',
      perCode <= rotateS * 2.5,
      `${distinct} distinct code(s) in ${SECONDS}s = ${perCode.toFixed(1)}s per code, `
      + `server rotates every ${rotateS}s (was ~15s before the placeholder fix)`);
    ok('F. ...and it rotates at all (a frozen badge proves nothing)',
      distinct > 1, `${distinct} distinct code(s)`);
    await rotatePage.close();
  }

  // ── E. a plain room overlay renders NO badge at all ────────────────────
  // The bounty surface must stay entirely inert for an ordinary room.
  const plain = await browser.newPage();
  await plain.setViewport({ width: 1280, height: 720 });
  await plain.goto(`${APP}/overlay?room=someplainroom`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 6_000));
  const plainShown = await plain.evaluate(() => document.getElementById('bounty-badge')?.classList.contains('show'));
  ok('E. an ordinary room overlay shows no badge', plainShown !== true);
  await plain.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  srv.kill();
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
