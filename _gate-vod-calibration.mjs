/**
 * GATE — per-broadcast timeline calibration, over real HTTP routes.
 *
 * The shipped seek constant was measured on ONE VOD. This gate proves the
 * replacement: that the offset is RECOVERED from each broadcast's own content,
 * across a SPREAD of injected offsets, including ones the constant misses
 * outright. A single accuracy figure would be the same mistake as the one-code
 * corpus and the one-timeline constant, so nothing here reports one.
 *
 * HOW THE OFFSET IS INJECTED, exactly. Badge i is rendered by the REAL overlay
 * page and placed in a stub VOD at video position
 *     p_i = (issuedAt_i - firstIssued)/1000 + pad
 * so video position p corresponds to wall-clock firstIssued + (p - pad)*1000.
 * Verification seeks to o = (ts - vodStart + s)/1000, so the s that lands on ts
 * is
 *     Δ = (vodStart - firstIssued) + pad*1000
 *
 * The offset is injected through `pad` — leading content before the first badge
 * — and NOT by moving the reported `created_at`. That matters: created_at must
 * stay slightly BEFORE the playbacks, as it does on real Twitch, because
 * vodCovering requires each playback timestamp to fall inside
 * [created_at, created_at+duration]. Injecting via created_at pushed the
 * playbacks outside their own VOD and failed discovery instead of testing
 * calibration — which is what the first version of this gate actually did.
 *
 * Zero external network and zero spend: stub Helix, stub VOD served from
 * localhost with byte-range support (ffmpeg seeks via Range requests), and the
 * REAL TwitchFrameSource, real extractor, real decoder, real verify route.
 */
import http from 'http';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, statSync, createReadStream, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3320;
const STUB = 3321;
const APP = `http://localhost:${PORT}`;
const WORK = mkdtempSync(path.join(tmpdir(), 'mc-cal-'));
const VOD_LEAD_S = 5;     // created_at this far before the first badge, as Twitch does
const CLIPS = 6;          // >= calibrationMinPoints, one probe target each

const post = (p, body) => fetch(`${APP}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (p) => fetch(`${APP}${p}`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const vid = (n) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(n, 5)]);
const ff = (args, what) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${what}: ${r.stderr?.slice(0, 300)}`);
};

// ── stub platform: Helix + a byte-range-serving VOD ───────────────────────
const stub = {
  createdAt: null,        // drives the INJECTED offset
  durationS: 600,
  mediaFile: null,        // which video to serve
  streamStartedAt: null,  // so stream-context passes cleanly
  helixCalls: 0,
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${STUB}`);
  if (url.pathname === '/vod.mp4') {
    // Byte ranges are not optional: ffmpeg seeks an HTTP mp4 with Range, and
    // without 206 support every calibration probe would stream from zero.
    const st = statSync(stub.mediaFile);
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : st.size - 1;
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
      });
      return createReadStream(stub.mediaFile, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
    return createReadStream(stub.mediaFile).pipe(res);
  }
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/oauth2/token') return res.end(JSON.stringify({ access_token: 't', expires_in: 3600 }));
  if (url.pathname === '/helix/users') return res.end(JSON.stringify({ data: [{ id: '42', login: 'calstreamer' }] }));
  if (url.pathname === '/helix/streams') {
    return res.end(JSON.stringify({
      data: stub.streamStartedAt
        ? [{ user_login: 'calstreamer', viewer_count: 77, started_at: new Date(stub.streamStartedAt).toISOString(), type: 'live' }]
        : [],
    }));
  }
  if (url.pathname === '/helix/videos') {
    stub.helixCalls++;
    return res.end(JSON.stringify({
      data: [{
        id: 'stubvod', type: 'archive', url: `http://localhost:${STUB}/vod.mp4`,
        created_at: new Date(stub.createdAt).toISOString(),
        duration: `${Math.floor(stub.durationS / 60)}m${stub.durationS % 60}s`,
      }],
    }));
  }
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => server.listen(STUB, r));

const { startGateServer } = await import('./_gate-helpers.mjs');
const srv = await startGateServer({
  port: PORT,
  env: {
    BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true', MODERATION_API_KEY: '',
    TWITCH_CLIENT_ID: 'stub', TWITCH_CLIENT_SECRET: 'stub',
    TWITCH_ID_BASE: `http://localhost:${STUB}`, TWITCH_API_BASE: `http://localhost:${STUB}`,
    KICK_CLIENT_ID: '', KICK_CLIENT_SECRET: '',
    // Long validity so each clip carries one stable code across its window.
    BOUNTY_CODE_ROTATE_MS: '600000', BOUNTY_CODE_VALIDITY_MS: '5000',
  },
});

let browser;
try {
  // ── a session whose clips are spaced in time ────────────────────────────
  const pl = await post('/api/bounty/pledge', {
    targets: [{ platform: 'twitch', handle: 'calstreamer' }],
    contributor: '0xcal', amount: '90', expiresInMs: 86_400_000,
  });
  await fetch(`${APP}${pl.body.uploadUrl}?durationS=8`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: vid(2048),
  });
  const claim = await post('/api/bounty/claim', { platform: 'twitch', handle: 'calstreamer', claimant: 'cal' });
  // Broadcast started well before the clips, so stream-context passes cleanly
  // and the only thing under test here is the timeline.
  stub.streamStartedAt = Date.now() - 30 * 60_000;

  const mkSession = async (room) => {
    const air = await post('/api/bounty/air-session', {
      claimId: claim.body.claim.id, platform: 'twitch', roomId: room,
    });
    return air.body.airSession.id;
  };
  const airId = await mkSession('calroom');

  browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`      [page error] ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) console.log(`      [page ${r.status()}] ${r.url()}`); });
  page.on('requestfailed', (r) => console.log(`      [page failed] ${r.url()} ${r.failure()?.errorText}`));
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type())) console.log(`      [page ${m.type()}] ${m.text().slice(0, 160)}`);
  });
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto(`${APP}/overlay?room=calroom&bounty=${encodeURIComponent(airId)}`,
    { waitUntil: 'domcontentloaded', timeout: 60000 });

  const { OcrFrameChecker } = await import('./ocr-frame-checker.js');
  const shotChecker = new OcrFrameChecker({ log: { warn() {}, log() {} } });

  /**
   * Open a clip, capture the REAL overlay badge for its code, close it.
   *
   * The screenshot is DECODED before being accepted. The overlay polls for its
   * code, so a screenshot taken too early still shows the previous clip's
   * badge — which would silently map the wrong badge to the wrong timestamp and
   * make every calibration assertion below meaningless while looking fine.
   */
  async function captureClip(id, sessionId) {
    const play = await post('/api/bounty/admin/playback', {
      airSessionId: sessionId, clipId: id, durationS: 8,
    });
    const code = play.body.code?.code;
    if (!code) throw new Error(`no code for ${id}`);
    // RELOAD so the overlay polls NOW. It schedules its next poll at rotateMs,
    // which this gate deliberately sets long so each clip carries exactly one
    // stable code — meaning a page loaded before the clip existed would sit
    // with a hidden badge for ten minutes.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    const png = path.join(WORK, `badge-${id}.png`);
    const check = path.join(WORK, `check-${id}.png`);
    let confirmed = false;
    for (let attempt = 0; attempt < 12 && !confirmed; attempt++) {
      await sleep(400);
      const drawn = await page.evaluate(() =>
        !!document.getElementById('bounty-badge')?.classList.contains('show')
        && (document.getElementById('bounty-matrix')?.width || 0) > 0);
      if (!drawn) continue;
      // Validate on the UN-MATTED page. A full-frame green matte is exactly the
      // "flat field scores as a ring" trap the decoder's locator warns about,
      // so the matte shot is only ever composited, never decoded directly.
      await page.evaluate(() => { document.body.style.background = '#101014'; });
      await page.screenshot({ path: check });
      const r = await shotChecker.findCode({ ref: check }, [code]);
      confirmed = !!r.found;

      if (!confirmed) continue;
      await page.evaluate(() => {
        document.body.style.background = '#00ff00';
        const stage = document.getElementById('stage');
        if (stage) stage.style.background = 'transparent';
      });
      await page.screenshot({ path: png });
    }
    if (!confirmed) throw new Error(`overlay never rendered ${code} for ${id}`);
    await post('/api/bounty/admin/playback/end', { airSessionId: sessionId, clipId: id });
    return { code, png };
  }

  const shots = [];
  for (let i = 0; i < CLIPS; i++) {
    shots.push(await captureClip(`CAL${i}`, airId));
    // Space clips FURTHER APART THAN codeValidityMs. At 5s validity and ~2s
    // spacing the badge windows overlapped, so later overlays painted over
    // earlier ones and the fixture's own timing map stopped meaning what it
    // said — a deliberately inconsistent timeline then looked consistent.
    await sleep(5_600);
  }
  await page.close();
  ok('the real overlay produced a distinct badge per clip', shots.length === CLIPS,
    shots.map((s) => s.code).join(','));

  // ── the true code timings, straight from the session record ─────────────
  const sess = (await get('/api/bounty/admin/sessions')).body.sessions.find((s) => s.id === airId);
  const wins = (sess.playbackWindows || []).filter((w) => (w.codes || []).length);
  const timings = wins.map((w) => {
    const c = w.codes[0];
    return { clipId: w.clipId, code: c.code, issuedAt: c.issuedAt, expiresAt: c.expiresAt };
  }).sort((a, b) => a.issuedAt - b.issuedAt);
  const firstIssued = timings[0].issuedAt;
  const lastExpires = Math.max(...timings.map((t) => t.expiresAt));

  /**
   * Build a stub VOD placing each badge at its wall-clock position + `padS`.
   * `padS` is the knob that injects the timeline offset.
   */
  function buildVod(file, { perClipShiftMs = () => 0, padS = VOD_LEAD_S } = {}) {
    const totalS = padS + (lastExpires - firstIssued) / 1000 + 6;
    const inputs = [];
    const filters = [];
    let last = '[base]';
    timings.forEach((t, i) => {
      const shot = shots.find((s) => s.code === t.code);
      inputs.push('-i', shot.png);
      const shift = perClipShiftMs(i) / 1000;
      const a = padS + (t.issuedAt - firstIssued) / 1000 + shift;
      const b = padS + (t.expiresAt - firstIssued) / 1000 + shift;
      filters.push(`[${i + 1}:v]colorkey=0x00ff00:0.28:0.06[ov${i}]`);
      filters.push(`${last}[ov${i}]overlay=0:0:enable='between(t,${a.toFixed(2)},${b.toFixed(2)})'[st${i}]`);
      last = `[st${i}]`;
    });
    ff([
      '-f', 'lavfi', '-i', `color=c=0x202024:s=1920x1080:r=10:d=${totalS.toFixed(1)}`,
      ...inputs,
      '-filter_complex', `[0:v]null[base];${filters.join(';')}`,
      '-map', last, '-c:v', 'libx264', '-b:v', '4000k', '-pix_fmt', 'yuv420p',
      '-t', totalS.toFixed(1), file,
    ], 'stub vod');
    return file;
  }
  // created_at sits before the playbacks, exactly as a real archive does.
  stub.createdAt = firstIssued - VOD_LEAD_S * 1000;

  /**
   * Inject offset Δ by burying the badges Δ deeper into the VOD.
   * Δ = (vodStart - firstIssued) + pad*1000, and vodStart is fixed, so
   * pad = (Δ + VOD_LEAD_S*1000)/1000.
   */
  const vodCache = new Map();
  function injectOffset(deltaMs, { perClipShiftMs } = {}) {
    const key = `${deltaMs}:${perClipShiftMs ? 'skew' : 'flat'}`;
    if (!vodCache.has(key)) {
      const padS = (deltaMs + VOD_LEAD_S * 1000) / 1000;
      const f = path.join(WORK, `vod-${key.replace(':', '-')}.mp4`);
      buildVod(f, { padS, ...(perClipShiftMs ? { perClipShiftMs } : {}) });
      vodCache.set(key, f);
    }
    stub.mediaFile = vodCache.get(key);
  }
  injectOffset(16_000);
  ok('a stub VOD was built from real overlay badges at known positions',
    statSync(stub.mediaFile).size > 10_000, `${Math.round(statSync(stub.mediaFile).size / 1024)}KB`);
  const verify = (sessionId = airId) => post(`/api/bounty/air-session/${sessionId}/verify`,
    { mode: 'real', sourceMode: 'vod' });

  // ── 1. ACCURACY ACROSS A SPREAD, never a single figure ──────────────────
  // 30s and 40s are past the shipped 16s constant by far more than a clip
  // length, so they are exactly the cases a constant cannot reach.
  const spread = [4_000, 16_000, 24_000, 30_000, 40_000];
  const results = [];
  for (const injected of spread) {
    injectOffset(injected);
    const v = await verify();
    const cal = v.body.verification?.calibration;
    const err = cal?.skewMs != null ? cal.skewMs - injected : null;
    results.push({ injected, measured: cal?.skewMs, err, state: cal?.state,
      points: cal?.points?.length, spreadMs: cal?.spreadMs, residual: cal?.residualMs,
      clips: v.body.verification?.verifiedClips, result: v.body.verification?.result });
    console.log(`    injected ${(injected / 1000).toFixed(0)}s -> measured `
      + `${cal?.skewMs != null ? (cal.skewMs / 1000).toFixed(1) + 's' : 'n/a'}`
      + ` err ${err != null ? (err / 1000).toFixed(1) + 's' : 'n/a'}`
      + ` [${cal?.state}, ${cal?.points?.length} pts, spread ${cal?.spreadMs}ms]`
      + ` verified ${v.body.verification?.verifiedClips}/${timings.length}`
      + `${cal?.detail ? `
        detail: ${String(cal.detail).slice(0, 160)}` : ''}`);
  }
  // Tolerance is the honest one: a point can only place the offset within
  // ±codeValidityMs/2 because any instant inside a code's window looks the
  // same. 3s allows that quantization and nothing more.
  const TOL = 3_000;
  ok('calibration recovers EVERY injected offset across the spread',
    results.every((r) => r.state === 'MEASURED' && Math.abs(r.err) <= TOL),
    results.map((r) => `${r.injected / 1000}s:${r.err != null ? (r.err / 1000).toFixed(1) : 'n/a'}s`).join('  '));
  ok('...including offsets a fixed 16s constant could never reach',
    results.filter((r) => r.injected >= 30_000).every((r) => r.state === 'MEASURED' && Math.abs(r.err) <= TOL));
  ok('...and every one of them verifies the clips it should',
    results.every((r) => r.clips === timings.length),
    results.map((r) => `${r.injected / 1000}s:${r.clips}/${timings.length}`).join(' '));
  const worst = Math.max(...results.map((r) => Math.abs(r.err ?? Infinity)));
  console.log(`    worst error across the spread: ${(worst / 1000).toFixed(1)}s `
    + `(quantization alone is ±2.5s)`);

  // ── 2. what the fixed constant would have done ──────────────────────────
  // Same VOD, offset far from 16s: with calibration it verifies; the constant
  // would seek ~14s off and read the wrong code on every frame.
  injectOffset(30_000);
  const withCal = await verify();
  ok('a session the fixed constant would MISS verifies cleanly once measured',
    ['PASS', 'PARTIAL'].includes(withCal.body.verification?.result)
    && withCal.body.verification?.verifiedClips === timings.length,
    `${withCal.body.verification?.result} ${withCal.body.verification?.verifiedClips}/${timings.length}`);
  ok('...and the residual window is DERIVED, far tighter than the old flat 20s',
    withCal.body.verification?.calibration?.residualMs < 20_000,
    `residual ±${withCal.body.verification?.calibration?.residualMs}ms`);

  // ── 3. disagreement is a finding, not an average ────────────────────────
  // Later badges shifted by +12s: no single offset explains the whole VOD.
  injectOffset(16_000, {
    perClipShiftMs: (i) => (i >= Math.floor(timings.length / 2) ? 12_000 : 0),
  });
  const disagree = await verify();
  const dcal = disagree.body.verification?.calibration;
  ok('an inconsistent timeline is reported as DISAGREEMENT, not averaged away',
    dcal?.state === 'DISAGREEMENT', `${dcal?.state} spread=${dcal?.spreadMs}ms`);
  ok('...it routes to a human with the timeline named as the cause',
    /timeline not consistent/i.test(disagree.body.review?.reason || '')
    || disagree.body.verification?.timelineNeedsReview === true,
    disagree.body.review?.reason?.slice(0, 120) || `flag=${disagree.body.verification?.timelineNeedsReview}`);
  ok('...and the reason says how far apart the measurements were',
    /disagree by/i.test(dcal?.detail || ''), dcal?.detail?.slice(0, 120));

  // ── 4. cannot measure at all = could-not-look, never a silent zero ──────
  const blankVod = path.join(WORK, 'blank.mp4');
  ff(['-f', 'lavfi', '-i', 'color=c=0x202024:s=1920x1080:r=10:d=40',
    '-c:v', 'libx264', '-b:v', '2000k', '-pix_fmt', 'yuv420p', blankVod], 'blank vod');
  stub.mediaFile = blankVod;   // created_at unchanged: discovery works, content does not
  const air2 = await mkSession('calroom2');
  // A session with real windows but a VOD containing no badge at all.
  for (let i = 0; i < 4; i++) {
    await post('/api/bounty/admin/playback', { airSessionId: air2, clipId: `B${i}`, durationS: 8 });
    await post('/api/bounty/admin/playback/end', { airSessionId: air2, clipId: `B${i}` });
    await sleep(300);
  }
  injectOffset(16_000);
  const blank = await verify(air2);
  ok('an unmeasurable timeline is SOURCE_UNAVAILABLE, not a FAIL that costs money',
    blank.body.verification?.result === 'SOURCE_UNAVAILABLE'
    && blank.body.verification?.sourceState === 'TIMELINE_UNCALIBRATED',
    `${blank.body.verification?.result}/${blank.body.verification?.sourceState}`);
  ok('...and it pays nothing while unresolved',
    !blank.body.release?.released || blank.body.release.released === 0,
    JSON.stringify(blank.body.release).slice(0, 90));

  // ── 5. the false-positive guarantee survives the wider search ───────────
  // Session 2's codes were never in session 1's VOD. A calibration pass that
  // decodes against many codes must not manufacture a match across sessions.
  injectOffset(16_000);
  const replay = await verify(air2);
  ok('REPLAYED footage from another session still verifies ZERO clips',
    (replay.body.verification?.verifiedClips || 0) === 0,
    `${replay.body.verification?.result} clips=${replay.body.verification?.verifiedClips}`);
  ok('...and never fabricates a calibration from a foreign VOD',
    replay.body.verification?.calibration?.state !== 'MEASURED',
    replay.body.verification?.calibration?.state);

  // ── 6. zero external spend ─────────────────────────────────────────────
  ok('the platform was only ever asked on localhost', stub.helixCalls > 0,
    `${stub.helixCalls} stub Helix video lookups, 0 real`);
} finally {
  if (browser) await browser.close();
  srv.kill();
  server.close();
}
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
