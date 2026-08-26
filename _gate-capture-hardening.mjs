/**
 * GATE — capture hardening: OBS scene visibility, overlay self-reports, and
 * the confidence tiers that decide whether a human looks.
 *
 * Three layers, in increasing cost and increasing proof:
 *
 *   A. THE PURE LOGIC — the tier table, the folds, the geometry. Cheap, and
 *      it is where the decisions actually live.
 *   B. THE OBS CHECK against the MOCK obs-websocket, in every state a real
 *      OBS can be in: visible, hidden, not in the program scene, sized to
 *      nothing, off canvas, and NOT CONNECTED AT ALL.
 *   C. THE WHOLE THING OVER HTTP — real server, real routes, real self-capture
 *      of a stub live stream carrying REAL overlay badges, real decoder, real
 *      verify route — asserting that a session whose OBS said "visible"
 *      auto-verifies, one whose OBS said "hidden" goes to a person, and one
 *      with no OBS connection at all is treated exactly like the first.
 *
 * THAT LAST CASE IS THE POINT OF THE WHOLE FILE. A streamer pasting the URL
 * by hand has no obs-websocket and can send us nothing. If this feature ever
 * makes them worse off than a streamer who connected one, it has become a
 * requirement wearing a corroboration costume, and the gate should fail.
 *
 * Zero external network, zero spend: stub HLS on localhost, mock OBS on
 * localhost, no platform credentials in the environment at all.
 */
import http from 'http';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';
import { ObsClient } from './web/lib/obs-client.mjs';
import { makeMockObs, PASSWORD } from './_gate-mock-obs.mjs';
import {
  checkOverlayVisible, SCENE_STATE, effectiveRect, isOffCanvas,
} from './web/lib/obs-scene-check.mjs';
import {
  evaluateConfidence, canvasLooksWrong, foldSceneSamples, foldOverlayEnv, TIER,
} from './bounty-confidence.js';
import { liveEdgeSlice } from './bounty-capture.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OVERLAY = 'MegaChat Overlay';
const HLS = 3390;
const APP_PORT = 3391;
const WORK = mkdtempSync(path.join(tmpdir(), 'mc-hard-'));
const SEG_S = 2;

const ff = (args, what) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${what}: ${r.stderr?.slice(0, 300)}`);
};

// A full-canvas item, as one-click creates it.
const FULL = {
  positionX: 0, positionY: 0, scaleX: 1, scaleY: 1,
  sourceWidth: 1920, sourceHeight: 1080, width: 1920, height: 1080,
  cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, boundsType: 'OBS_BOUNDS_NONE',
};

// ══ A. THE PURE LOGIC ═════════════════════════════════════════════════════

// ── A1. geometry ──────────────────────────────────────────────────────────
{
  ok('A1. a full-canvas item measures full canvas',
    effectiveRect(FULL).width === 1920 && effectiveRect(FULL).height === 1080);

  // OBS has shipped builds that leave width/height at 0 while the item renders
  // fine. Deriving from source×scale is what stops that being read as a cheat.
  const zeroReported = { ...FULL, width: 0, height: 0 };
  ok('A1. a zeroed width/height is DERIVED rather than believed',
    effectiveRect(zeroReported).width === 1920,
    'source×scale used when OBS reports 0 — a false ZERO_AREA costs an honest streamer');

  const shrunk = { ...FULL, width: 2, height: 1, scaleX: 0.001, scaleY: 0.001 };
  ok('A1. an item genuinely scaled to nothing measures as nothing',
    effectiveRect(shrunk).width < 8 && effectiveRect(shrunk).height < 8,
    `${effectiveRect(shrunk).width}×${effectiveRect(shrunk).height}`);

  const bounded = {
    ...FULL, width: 0, height: 0, scaleX: 0, scaleY: 0,
    boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 1280, boundsHeight: 720,
  };
  ok('A1. a BOUNDS-fitted item is measured by its bounds, not its zeroed scale',
    effectiveRect(bounded).width === 1280);

  ok('A1. an on-canvas item is not off-canvas',
    !isOffCanvas(effectiveRect(FULL), 1920, 1080));
  ok('A1. an item parked past the right edge IS off-canvas',
    isOffCanvas({ x: 4000, y: 0, width: 100, height: 100 }, 1920, 1080));
  ok('A1. ...and with NO canvas known we refuse to guess',
    !isOffCanvas({ x: 4000, y: 0, width: 100, height: 100 }, 0, 0),
    'unknown canvas must not manufacture a warning');
  // Alignment can anchor positionX at the item's centre or right edge, so a
  // half-off item reads as negative. Forgiving on purpose.
  ok('A1. a partly-visible item is NOT flagged',
    !isOffCanvas({ x: -50, y: 0, width: 400, height: 200 }, 1920, 1080));
}

// ── A2. canvas plausibility (T2) ──────────────────────────────────────────
{
  const cases = [
    ['1920×1080', 1920, 1080, false],
    ['1280×720', 1280, 720, false],
    ['2560×1440 ultrawide-ish', 3440, 1440, false],
    ['1080×1920 vertical', 1080, 1920, false],
    ['1×1 (the actual cheat)', 1, 1, true],
    ['16×9 thumbnail-sized', 16, 9, true],
    ['nothing reported', 0, 0, true],
  ];
  let all = true;
  for (const [label, w, h, want] of cases) {
    const got = canvasLooksWrong({ width: w, height: h }).anomaly;
    if (got !== want) { all = false; console.error(`    ${label}: anomaly=${got}, wanted ${want}`); }
  }
  ok('A2. canvas plausibility flags the absurd and leaves real setups alone', all,
    `${cases.length} sizes incl. vertical + ultrawide`);
}

// ── A3. the tier table (T4) ───────────────────────────────────────────────
{
  const t = (a) => evaluateConfidence(a);
  ok('A3. tier 1 — external capture, auto-verified',
    t({ frameOrigin: 'external' }).tier === TIER.EXTERNAL
    && t({ frameOrigin: 'external' }).autoVerify);
  ok('A3. tier 2 — self-capture corroborated by OBS, auto-verified',
    t({ frameOrigin: 'capture', obsScene: { checked: true, visible: true } }).tier === TIER.OBS_CORROBORATED
    && t({ frameOrigin: 'capture', obsScene: { checked: true, visible: true } }).autoVerify);
  ok('A3. tier 3 — self-capture alone, auto-verified when stream context passes',
    t({ frameOrigin: 'capture' }).tier === TIER.SELF_CAPTURE
    && t({ frameOrigin: 'capture' }).autoVerify);
  ok('A3. tier 3 with FAILING stream context routes to review',
    t({ frameOrigin: 'capture', streamContextOk: false }).needsReview,
    'context is the thing holding tier 3 up; without it there is nothing');
  const warned = t({ frameOrigin: 'capture', obsScene: { checked: true, visible: false } });
  ok('A3. tier 4 — a disagreeing signal routes to a person',
    warned.tier === TIER.WARNED && warned.needsReview
    && warned.warnings.includes('OVERLAY_NOT_VISIBLE'));

  // THE ONE THAT MATTERS: no obs-websocket must land exactly where "OBS said
  // visible" lands minus the corroboration — never in the warned tier.
  const manual = t({ frameOrigin: 'capture', obsScene: { checked: false, visible: false } });
  ok('A3. NO OBS CONNECTION is tier 3 and auto-verifies — never a penalty',
    manual.tier === TIER.SELF_CAPTURE && manual.autoVerify && manual.warnings.length === 0,
    'the manual-paste streamer must not be worse off for having no obs-websocket');

  ok('A3. every warning is reported, not just the first',
    t({
      frameOrigin: 'capture',
      obsScene: { checked: true, visible: false },
      overlayEnv: { canvasAnomaly: true },
      belowQualityFloor: true,
    }).warnings.length === 3,
    'a reviewer shown one of three causes fixes one thing and closes the case');

  // MEASURED, not assumed: headless Chrome — and a background browser tab —
  // report document.visibilityState 'hidden' while rendering perfectly. Every
  // session in this gate tripped it before it was demoted to evidence-only.
  ok('A3. a hidden document is RECORDED but never routes anyone to review',
    t({ frameOrigin: 'capture', overlayEnv: { pageHidden: true } }).warnings.length === 0
    && t({ frameOrigin: 'capture', overlayEnv: { pageHidden: true } }).autoVerify,
    'a warning that fires on the good case is a tax on the honest, not a signal');

  ok('A3. frames of unknown origin do NOT get the generous default',
    t({ frameOrigin: null }).needsReview);

  // Payout is not a function of tier. Assert it structurally: the evaluator
  // returns no amount, rate, multiplier or weight of any kind.
  const keys = Object.keys(t({ frameOrigin: 'external' })).join(' ').toLowerCase();
  ok('A3. THE TIER CARRIES NO PAYOUT TERM — it decides who looks, not who is paid',
    !/(amount|rate|multiplier|weight|fraction|payout)/.test(keys), keys);
}

// ── A4. the folds only judge PAYING playbacks ─────────────────────────────
{
  const S = (playbackId, state) => ({ playbackId, state, checked: true, visible: state === 'VISIBLE' });
  ok('A4. hidden BETWEEN clips is not held against anyone',
    foldSceneSamples([S('p1', 'VISIBLE'), S(null, 'HIDDEN'), S('p9', 'HIDDEN')], ['p1']).visible === true,
    'the overlay only has to be up while a clip is playing — that is when it carries a code');
  ok('A4. hidden DURING a paying clip is',
    foldSceneSamples([S('p1', 'VISIBLE'), S('p1', 'HIDDEN')], ['p1']).visible === false);
  ok('A4. ...and the reason is named, not just counted',
    /NOT_IN_SCENE/.test(foldSceneSamples([S('p1', 'NOT_IN_SCENE')], ['p1']).detail),
    '"drag it into your live scene" and "resize it" are different support replies');
  ok('A4. no samples at all reads as UNCHECKED, not as hidden',
    foldSceneSamples([], ['p1']).checked === false
    && foldSceneSamples([], ['p1']).visible === false);
  ok('A4. an unreachable OBS is inconclusive, never a finding',
    foldSceneSamples([{ playbackId: 'p1', state: 'NO_CONNECTION', checked: false }], ['p1']).checked === false);

  const env = (playbackId, o) => ({ playbackId, visibilityState: 'visible', canvasAnomaly: false, ...o });
  ok('A4. an overlay anomaly between clips does not count',
    foldOverlayEnv([env(null, { canvasAnomaly: true }), env('p1', {})], ['p1']).canvasAnomaly === false);
  ok('A4. an overlay anomaly during a paying clip does',
    foldOverlayEnv([env('p1', { canvasAnomaly: true, detail: '1×1' })], ['p1']).canvasAnomaly === true);
  ok('A4. a hidden document during a paying clip is recorded',
    foldOverlayEnv([env('p1', { visibilityState: 'hidden' })], ['p1']).pageHidden === true);
}

// ── A5. a capture starts at the LIVE EDGE, whatever shape the playlist is ─
{
  // MEASURED on a real pump.fun broadcast (2026-08-25): their media playlist
  // is APPEND-ONLY — MEDIA-SEQUENCE pinned at 0, no ENDLIST, and the list just
  // grows. 100 minutes in it listed 3,063 segments. At ~800kB per 1080p60
  // segment, a first poll that walked the whole list would have pulled ~2.4GB
  // of back catalogue before ever reaching the live edge.
  const appendOnly = Array.from({ length: 3063 }, (_, i) => ({ seq: i, uri: `s${i}`, durationS: 2 }));
  const tail = liveEdgeSlice(appendOnly, 30_000);
  ok('A5. an APPEND-ONLY playlist is entered at the live edge, not from the start',
    tail.length <= 20 && tail[tail.length - 1].seq === 3062,
    `${tail.length} of ${appendOnly.length} segments taken, ending at the newest`);
  ok('A5. ...and it is enough media to fill the window',
    tail.reduce((a, x) => a + x.durationS * 1000, 0) >= 30_000);

  // Twitch and Kick slide: nothing may change for them.
  const sliding = Array.from({ length: 6 }, (_, i) => ({ seq: 100 + i, uri: `s${i}`, durationS: 2 }));
  ok('A5. a SLIDING playlist is taken whole, exactly as before',
    liveEdgeSlice(sliding, 30_000).length === 6);
  ok('A5. an empty playlist is not an error', liveEdgeSlice([], 30_000).length === 0);
}

// ══ B. THE OBS CHECK, AGAINST THE MOCK ════════════════════════════════════

const withMock = async (port, seedScenes, fn) => {
  const mock = makeMockObs({ port, seed: { scenes: seedScenes } });
  const client = new ObsClient({ password: PASSWORD, url: `ws://127.0.0.1:${port}` });
  try {
    await client.connect();
    return await fn(client, mock);
  } finally {
    try { client.close(); } catch { /* already gone */ }
    await mock.close();
  }
};
const item = (over = {}) => ({
  sceneItemId: 7, sourceName: OVERLAY, enabled: true, transform: { ...FULL }, ...over,
});

{
  // B1. VISIBLE — the state a correctly set-up streamer is in.
  const r = await withMock(4470, { 'Live Scene': [item()], 'Other Scene': [] },
    (c) => checkOverlayVisible(c, { inputName: OVERLAY }));
  ok('B1. a visible overlay reports VISIBLE',
    r.state === SCENE_STATE.VISIBLE && r.visible && r.checked, r.detail);

  // B2. HIDDEN — the eye ticked off.
  const h = await withMock(4471, { 'Live Scene': [item({ enabled: false })], 'Other Scene': [] },
    (c) => checkOverlayVisible(c, { inputName: OVERLAY }));
  ok('B2. a hidden overlay FLAGS',
    h.state === SCENE_STATE.HIDDEN && !h.visible && h.checked, h.detail);

  // B3. NO CONNECTION — must degrade, never throw, never accuse.
  let threw = null;
  let n;
  try { n = await checkOverlayVisible(null, { inputName: OVERLAY }); } catch (e) { threw = e; }
  ok('B3. no connection degrades gracefully — no throw, checked:false, NOT a flag',
    !threw && n.state === SCENE_STATE.NO_CONNECTION && n.checked === false,
    'a manual-setup streamer has no obs-websocket and must not be penalised for it');

  // B3b. a socket that dies MID-POLL is "we could not look", not "they hid it".
  const dead = await withMock(4472, { 'Live Scene': [item()], 'Other Scene': [] },
    async (c) => { c.close(); return checkOverlayVisible(c, { inputName: OVERLAY }); });
  ok('B3b. a socket that dies mid-poll reads as NO_CONNECTION, not as hidden',
    dead.state === SCENE_STATE.NO_CONNECTION && !dead.checked, dead.detail);

  // B4. NOT IN THE PROGRAM SCENE — configured perfectly, reaching nobody.
  const ns = await withMock(4473, { 'Live Scene': [], 'Other Scene': [item()] },
    (c) => checkOverlayVisible(c, { inputName: OVERLAY }));
  ok('B4. an overlay in a NON-ACTIVE scene reports NOT_IN_SCENE',
    ns.state === SCENE_STATE.NOT_IN_SCENE && !ns.visible && ns.checked, ns.detail);

  // B5. ZERO AREA — on screen, sized to nothing.
  const za = await withMock(4474, {
    'Live Scene': [item({ transform: { ...FULL, width: 1, height: 1, scaleX: 0.0005, scaleY: 0.0009 } })],
    'Other Scene': [],
  }, (c) => checkOverlayVisible(c, { inputName: OVERLAY }));
  ok('B5. an overlay scaled to nothing reports ZERO_AREA',
    za.state === SCENE_STATE.ZERO_AREA && !za.visible, za.detail);

  // B6. OFF CANVAS — full size, dragged out of frame.
  const oc = await withMock(4475, {
    'Live Scene': [item({ transform: { ...FULL, positionX: 9000, positionY: 9000 } })],
    'Other Scene': [],
  }, (c) => checkOverlayVisible(c, { inputName: OVERLAY }));
  ok('B6. an overlay dragged off the canvas reports OFF_CANVAS',
    oc.state === SCENE_STATE.OFF_CANVAS && !oc.visible, oc.detail);

  // B7. it must actually ASK OBS the two questions the design names.
  const asked = await withMock(4476, { 'Live Scene': [item()], 'Other Scene': [] },
    async (c, mock) => {
      await checkOverlayVisible(c, { inputName: OVERLAY });
      return mock.state.log.map((l) => l.requestType);
    });
  ok('B7. the check really polls GetSceneItemEnabled AND GetSceneItemTransform',
    asked.includes('GetSceneItemEnabled') && asked.includes('GetSceneItemTransform'),
    asked.join(' → '));
}

// ══ C. THE WHOLE THING OVER HTTP ══════════════════════════════════════════

// A stub live stream, sliding window, whose badge segments we swap per session.
let segments = [];
let published = 0;
const stub = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${HLS}`);
  if (url.pathname === '/live.m3u8') {
    const start = Math.max(0, published - 6);
    const listed = segments.slice(start, published);
    return res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end(
      ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEG_S}`,
        `#EXT-X-MEDIA-SEQUENCE:${start}`,
        ...listed.flatMap((s) => [`#EXTINF:${SEG_S}.0,`, s.name])].join('\n'));
  }
  const seg = segments.find((s) => `/${s.name}` === url.pathname);
  if (seg && existsSync(seg.file)) {
    return res.writeHead(200, { 'Content-Type': 'video/mp2t' }).end(readFileSync(seg.file));
  }
  res.statusCode = 404; res.end();
});
await new Promise((r) => stub.listen(HLS, r));

const plain = path.join(WORK, 'plain.ts');
ff(['-f', 'lavfi', '-i', `color=c=0x202024:s=1280x720:r=15:d=${SEG_S}`,
  '-c:v', 'libx264', '-b:v', '2500k', '-pix_fmt', 'yuv420p', '-f', 'mpegts', plain], 'plain seg');

let browser;
let srv;
try {
  const { startGateServer } = await import('./_gate-helpers.mjs');
  srv = await startGateServer({
    port: APP_PORT, label: 'hardening-app',
    bountyAuth: { handles: ['hardseen', 'hardhidden', 'hardmanual'] },
    env: {
      BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true', MODERATION_API_KEY: '',
      // No platform credentials AT ALL: if verification ever reaches a VOD it
      // fails outright, so a verdict proves the self-capture was the source.
      TWITCH_CLIENT_ID: '', TWITCH_CLIENT_SECRET: '',
      KICK_CLIENT_ID: '', KICK_CLIENT_SECRET: '',
      // THE SHIPPED CODE TIMINGS, deliberately. Calibration derives its probe
      // ladder from codeValidityMs, so parking validity at ten minutes (as an
      // earlier gate did) collapses the ladder to a couple of rungs and quietly
      // stops exercising the search this path depends on.
      BOUNTY_CODE_ROTATE_MS: '4000', BOUNTY_CODE_VALIDITY_MS: '5000',
      BOUNTY_CAPTURE_HLS_URL: `http://localhost:${HLS}/live.m3u8`,
      BOUNTY_CAPTURE_WINDOW_MS: '20000',
      BOUNTY_CAPTURE_POLL_MS: '250',
      // Warmup off: this gate is about the OBS/overlay signals, and a failing
      // stream context would route everything to review and mask them.
      BOUNTY_STREAM_WARMUP_MS: '0', BOUNTY_STREAM_TAIL_MS: '0',
    },
  });
  const APP = `http://localhost:${APP_PORT}`;
  const post = (p, body, as) => fetch(`${APP}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...srv.headers(as) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const ledgerRows = (dataDir) => {
    const f = path.join(dataDir, 'bounty-ledger.jsonl');
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8').split(String.fromCharCode(10)).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  };
  const evidenceRows = () => {
    const f = path.join(srv.dataDir, 'bounty-evidence.jsonl');
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  };

  browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  });

  /**
   * One full broadcast for `handle`: pledge → clip → claim → air session →
   * clip playback → REAL overlay badge rendered and cut into the stub stream
   * → whatever samples the caller wants → freeze → verify.
   *
   * `duringPlayback(airId, playbackWindowOpen)` runs while the clip is on
   * screen, which is the only time a sample can be attributed to it.
   */
  /** Publish n plain segments — flushes the rolling window between clips. */
  async function flush(handle, n = 8) {
    for (let i = 0; i < n; i++) {
      segments.push({ name: `${handle}-flush${segments.length}.ts`, file: plain });
      published = segments.length;
      await sleep(160);
    }
  }

  async function broadcast(handle, room, duringPlayback) {
    const pl = await post('/api/bounty/pledge', {
      targets: [{ platform: 'twitch', handle }],
      contributor: '0xhard', amount: '40', expiresInMs: 86_400_000,
    });
    await fetch(`${APP}${pl.body.uploadUrl}?durationS=8`, {
      method: 'POST', headers: { 'Content-Type': 'video/webm', ...srv.headers() },
      body: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2048, 5)]),
    });
    const claim = await post('/api/bounty/claim',
      { platform: 'twitch', handle, claimant: handle }, handle);
    const air = await post('/api/bounty/air-session',
      { claimId: claim.body.claim.id, platform: 'twitch', roomId: room }, handle);
    const airId = air.body.airSession.id;

    // THREE clips, not one. Timeline calibration probes several playback
    // windows spread across the session and requires agreement between them, so
    // a one-clip session cannot calibrate at all — which is exactly the shape of
    // the bug this gate found in the shipped verify path.
    const codes = [];
    let drawn = true;
    for (let n = 1; n <= 3; n++) {
      const clipId = `${handle}-${n}`;
      const play = await post('/api/bounty/admin/playback',
        { airSessionId: airId, clipId, durationS: 600 });
      const code = play.body.code?.code;
      if (!code) throw new Error(`no code issued for ${clipId}`);
      codes.push(code);

      // Render the REAL overlay and cut its badge into the stream.
      const page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });
      await page.goto(`${APP}/overlay?room=${room}&bounty=${encodeURIComponent(airId)}`,
        { waitUntil: 'domcontentloaded', timeout: 60000 });
      let thisDrawn = false;
      for (let i = 0; i < 25 && !thisDrawn; i++) {
        await sleep(200);
        thisDrawn = await page.evaluate(() =>
          !!document.getElementById('bounty-badge')?.classList.contains('show')
          && (document.getElementById('bounty-matrix')?.width || 0) > 0);
      }
      await page.evaluate(() => { document.body.style.background = '#101014'; });
      const badgePng = path.join(WORK, `${clipId}.png`);
      await page.screenshot({ path: badgePng });
      await page.close();
      drawn = drawn && thisDrawn;

      const badged = path.join(WORK, `${clipId}.ts`);
      ff(['-f', 'lavfi', '-i', `color=c=0x202024:s=1920x1080:r=15:d=${SEG_S}`, '-i', badgePng,
        '-filter_complex', '[0:v][1:v]overlay=0:0,scale=1280:720',
        '-c:v', 'libx264', '-b:v', '3000k', '-pix_fmt', 'yuv420p', '-f', 'mpegts', badged], 'badged seg');

      // APPEND, never reset: rewinding EXT-X-MEDIA-SEQUENCE would make the
      // capture ignore every segment that followed.
      for (let i = 0; i < 8; i++) {
        segments.push({ name: `${clipId}-seg${i}.ts`, file: i >= 2 && i <= 6 ? badged : plain });
        published = segments.length;
        await sleep(300);
      }
      await sleep(700);

      if (duringPlayback) await duringPlayback(airId, code, n);

      await post('/api/bounty/admin/playback/end', { airSessionId: airId, clipId });
      // Flush this clip's badge out of the rolling window so the NEXT clip's
      // capture carries only its own code — as real clips minutes apart would.
      if (n < 3) await flush(handle);
    }

    await post(`/api/bounty/air-session/${airId}/end`, {}, handle);
    const v = await post(`/api/bounty/air-session/${airId}/verify`, { mode: 'real' }, handle);
    return { airId, code: codes[0], codes, drawn, verify: v };
  }

  const sample = (airId, state, as, extra = {}) => post(
    `/api/bounty/air-session/${airId}/obs-scene`,
    {
      state, visible: state === 'VISIBLE', checked: true,
      sceneName: 'Live Scene', detail: `gate sample ${state}`, at: Date.now(), ...extra,
    }, as,
  );

  // ── C1. the OBS-confirmed streamer: tier 2, auto-verified ───────────────
  const seen = await broadcast('hardseen', 'hardroomA', async (airId, _code, n) => {
    await sample(airId, 'VISIBLE', 'hardseen');
    if (n !== 1) return; // the route assertions below only need running once
    // Anonymous first: this route accepts the streamer's own report, and only
    // theirs. It is not a capability the air-session UUID confers.
    const anon = await fetch(`${APP}/api/bounty/air-session/${airId}/obs-scene`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'VISIBLE', visible: true, checked: true, at: Date.now() }),
    });
    ok('C1. the obs-scene route refuses an anonymous caller',
      anon.status === 401 || anon.status === 403, `HTTP ${anon.status}`);
    const wrong = await sample(airId, 'VISIBLE', 'hardhidden');
    ok('C1. ...and refuses a DIFFERENT streamer reporting on this session',
      wrong.status === 401 || wrong.status === 403, `HTTP ${wrong.status}`);

    const r = await sample(airId, 'VISIBLE', 'hardseen');
    ok('C1. a sample during a clip is attributed to THAT playback, server-side',
      r.status === 200 && !!r.body.playbackId,
      `playbackId=${r.body.playbackId} — the client never names it, so it cannot claim coverage it lacks`);

    // A client cannot post into the future to cover playbacks not yet run.
    const future = await post(`/api/bounty/air-session/${airId}/obs-scene`, {
      state: 'VISIBLE', visible: true, checked: true, at: Date.now() + 86_400_000,
    }, 'hardseen');
    ok('C1. a future-dated sample is clamped to now rather than trusted',
      future.status === 200 && !!future.body.playbackId,
      'clamping lands it in the CURRENT window instead of a future one');

    // T2: the overlay's own environment report, over its real route.
    const env = await post(`/api/bounty/air-session/${airId}/overlay-env`, {
      width: 1920, height: 1080, visibilityState: 'visible', at: Date.now(),
    });
    ok('C1. the overlay-env route records a healthy canvas without flagging it',
      env.status === 200 && env.body.canvasAnomaly === false, env.body.detail);
  });
  ok('C1. the real overlay rendered a badge into the stub broadcast', seen.drawn, seen.code);
  const vSeen = seen.verify.body;
  ok('C1. the clip verified off the SELF-CAPTURE (no platform credentials exist)',
    seen.verify.status === 200 && (vSeen.verification?.verifiedClips || 0) > 0,
    `${vSeen.verification?.result}, ${vSeen.verification?.verifiedClips} clip(s)`);
  ok('C1. OBS-confirmed + self-capture lands in TIER 2',
    vSeen.confidence?.tier === TIER.OBS_CORROBORATED,
    `tier ${vSeen.confidence?.tier} — ${vSeen.confidence?.label}`);
  ok('C1. ...and auto-verifies with no review opened',
    vSeen.confidence?.autoVerify === true && !vSeen.review,
    vSeen.confidence?.summary);
  {
    const rows = evidenceRows().filter((r) => r.airSessionId === seen.airId);
    ok('C1. the scene sample is in the EVIDENCE chain',
      rows.some((r) => r.type === 'OBS_SCENE_SAMPLE' && r.state === 'VISIBLE'));
    ok('C1. ...and so is the overlay environment report',
      rows.some((r) => r.type === 'OVERLAY_ENV' && r.width === 1920));
    // T2 wiring: tier 2 AUTO-RELEASES, and the ledger row records the tier
    // that allowed it — the auto-release is auditable after the fact.
    ok('C1. tier 2 auto-releases real money against the pool',
      (vSeen.release?.released ?? 0) > 0, `released=${vSeen.release?.released}`);
    const rel = ledgerRows(srv.dataDir).find((r) => r.type === 'RELEASE'
      && r.airSessionId === seen.airId && r.bucket === 'contributor');
    ok('C1. ...and the RELEASE ledger row carries confidenceTier 2',
      rel?.meta?.confidenceTier === 2, `meta.confidenceTier=${rel?.meta?.confidenceTier}`);
  }

  // ── C2. OBS says hidden during the paying clip: tier 4, a person looks ──
  const hidden = await broadcast('hardhidden', 'hardroomB', async (airId, _code, n) => {
    await sample(airId, 'VISIBLE', 'hardhidden');
    await sample(airId, 'HIDDEN', 'hardhidden');
    if (n !== 1) return;
    const bad = await post(`/api/bounty/air-session/${airId}/overlay-env`, {
      width: 1, height: 1, visibilityState: 'visible', at: Date.now(),
    });
    ok('C2. a 1×1 overlay canvas is recorded as an anomaly',
      bad.status === 200 && bad.body.canvasAnomaly === true, bad.body.detail);
  });
  const vHid = hidden.verify.body;
  ok('C2. a clip that DID air still verifies — the signal never denies a payout',
    (vHid.verification?.verifiedClips || 0) > 0,
    'the badge reached the public stream, so it aired; the disagreement is about confidence, not about airing');
  ok('C2. a disagreeing OBS report lands in TIER 4',
    vHid.confidence?.tier === TIER.WARNED
    && vHid.confidence?.warnings.includes('OVERLAY_NOT_VISIBLE'),
    `tier ${vHid.confidence?.tier}, warnings ${vHid.confidence?.warnings?.join(',')}`);
  ok('C2. ...and the canvas anomaly is reported ALONGSIDE it, not instead of it',
    vHid.confidence?.warnings.includes('CANVAS_ANOMALY')
    && vHid.confidence?.warnings.length === 2,
    vHid.confidence?.warnings?.join(','));
  ok('C2. ...and a review is opened naming the cause a reviewer can act on',
    !!vHid.review && /not visible/i.test(vHid.review.reason),
    vHid.review?.reason);
  ok('C2. ...and the RELEASE IS BLOCKED while that review is open',
    vHid.release?.skipped === 'pending_review' && (vHid.release?.released ?? 0) === 0,
    `skipped=${vHid.release?.skipped} released=${vHid.release?.released} — tier 4 stops the money, not just the verdict`);

  // ── C3. NO OBS CONNECTION AT ALL: tier 3, treated the same ──────────────
  // The whole point. A manual-paste streamer sends nothing, and must not be
  // one inch worse off than the streamer who wired up obs-websocket.
  const manual = await broadcast('hardmanual', 'hardroomC', null);
  const vMan = manual.verify.body;
  ok('C3. a streamer who never connected OBS still verifies',
    (vMan.verification?.verifiedClips || 0) > 0,
    `${vMan.verification?.verifiedClips} clip(s)`);
  ok('C3. ...lands in TIER 3, not the warned tier',
    vMan.confidence?.tier === TIER.SELF_CAPTURE && vMan.confidence?.warnings.length === 0,
    `tier ${vMan.confidence?.tier}, warnings ${JSON.stringify(vMan.confidence?.warnings)}`);
  ok('C3. ...auto-verifies with no review',
    vMan.confidence?.autoVerify === true && !vMan.review, vMan.confidence?.summary);
  ok('C3. ...and is PAID THE SAME as the OBS-corroborated streamer',
    (vMan.release?.released ?? 0) > 0
    && vMan.release?.released === vSeen.release?.released
    && vMan.release?.match === vSeen.release?.match,
    `manual ${vMan.release?.released} vs corroborated ${vSeen.release?.released} `
    + '— tiers decide who LOOKS, never who is paid');
  {
    const rel = ledgerRows(srv.dataDir).find((r) => r.type === 'RELEASE'
      && r.airSessionId === manual.airId && r.bucket === 'contributor');
    ok('C3. ...and its RELEASE ledger row carries confidenceTier 3',
      rel?.meta?.confidenceTier === 3, `meta.confidenceTier=${rel?.meta?.confidenceTier}`);
  }

  // ── C4. the tier-3 FORCED-REVIEW knob actually stops the money ──────────
  // BOUNTY_TIER3_AUTO_VERIFY=0 makes the evaluator say needsReview with ZERO
  // warnings. Until this run, no review cause matched that shape, so the knob
  // flipped the verdict while the release went through anyway — a tier table
  // that talks but decides nothing. Proven on a second server because the
  // knob is read at boot.
  srv.kill();
  await sleep(800);
  srv = await startGateServer({
    port: APP_PORT, label: 'hardening-tier3-knob',
    bountyAuth: { handles: ['hardknob'] },
    env: {
      BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true', MODERATION_API_KEY: '',
      TWITCH_CLIENT_ID: '', TWITCH_CLIENT_SECRET: '',
      KICK_CLIENT_ID: '', KICK_CLIENT_SECRET: '',
      BOUNTY_CODE_ROTATE_MS: '4000', BOUNTY_CODE_VALIDITY_MS: '5000',
      BOUNTY_CAPTURE_HLS_URL: `http://localhost:${HLS}/live.m3u8`,
      BOUNTY_CAPTURE_WINDOW_MS: '20000', BOUNTY_CAPTURE_POLL_MS: '250',
      // Zero-delay stub: nothing to wait out, so freeze effectively at once.
      // The real delay is exercised in _gate-broadcast-delay.mjs.
      BOUNTY_CAPTURE_FREEZE_DELAY_MS: '400',
      BOUNTY_STREAM_WARMUP_MS: '0', BOUNTY_STREAM_TAIL_MS: '0',
      BOUNTY_TIER3_AUTO_VERIFY: '0',
    },
  });
  {
    const knob = await broadcast('hardknob', 'hardroomD', null);
    const vK = knob.verify.body;
    ok('C4. with the knob off, tier 3 still VERIFIES the clips',
      (vK.verification?.verifiedClips || 0) > 0, `${vK.verification?.verifiedClips} clip(s)`);
    ok('C4. ...but the tier verdict is needs-review with zero warnings',
      vK.confidence?.tier === TIER.SELF_CAPTURE && vK.confidence?.needsReview === true
      && (vK.confidence?.warnings || []).length === 0,
      vK.confidence?.summary);
    ok('C4. ...a review opens naming the confidence verdict as the cause',
      !!vK.review && /confidence:/i.test(vK.review.reason), vK.review?.reason);
    ok('C4. ...AND THE MONEY STOPS — release skipped pending_review',
      vK.release?.skipped === 'pending_review' && (vK.release?.released ?? 0) === 0,
      `skipped=${vK.release?.skipped} released=${vK.release?.released}`);
  }
} finally {
  if (browser) await browser.close();
  if (srv) srv.kill();
  await new Promise((r) => stub.close(r));
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
