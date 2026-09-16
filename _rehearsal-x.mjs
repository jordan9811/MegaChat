/**
 * X (TWITTER) DRESS REHEARSAL — one command, one real X broadcast, a real
 * verdict, on the platform with the LEAST room for error.
 *
 * Every other platform degrades if self-capture fails: Twitch and pump.fun
 * fall back to reading the platform's own replay; Kick at least gets a live
 * spot-check. X gets NOTHING. frameSourceFor('x') returns an
 * UnavailableFrameSource UNCONDITIONALLY (frame-sources.js) — not "unless
 * capture also fails", always — so bounty-routes.js's own fallback logic
 * (preferCapture = captures.length > 0 && ...) only ever has one branch that
 * can succeed here. If self-capture freezes zero windows, verification cannot
 * fall back to anything; it reports SOURCE_UNAVAILABLE and nothing else is
 * possible. This is documented in bounty-claim.config.js's PLATFORM_PROFILES.x
 * notice: "X gives us no stream we can read, so verification runs entirely on
 * our own recording of your broadcast."
 *
 * WHAT IS DIFFERENT FROM EVERY OTHER HARNESS:
 *  - No live-status API. Kick has api.kick.com, pump.fun has
 *    livestream-api.pump.fun, Twitch has Helix. X has nothing exposed here, so
 *    "is it live" is answered the only honest way available: actually
 *    resolving the watch URL through yt-dlp and confirming real HLS media
 *    comes back. That is not a proxy for the truth — it IS the mechanism
 *    self-capture itself depends on, so if this fails, capture would have
 *    failed too.
 *  - The watch URL cannot be derived. captureSourceUrl only auto-derives a
 *    channel page for twitch/kick; every other platform falls through to
 *    `session.watchUrl`, and unlike YouTube (rejected by the route without
 *    one) X does not hard-require it at the API layer — so a missing watch
 *    URL fails SILENTLY (self-capture logs a warning and skips) rather than
 *    with a 400. This harness refuses to start without --watch-url for
 *    exactly that reason: a silent skip here means a guaranteed
 *    SOURCE_UNAVAILABLE forty minutes later with no clue why.
 *  - Ingest is a FIXED host (va.pscp.tv), like Twitch's live.twitch.tv and
 *    unlike Kick's per-account IVS endpoint — so it needs no derivation logic,
 *    only the operator's own stream key.
 *  - Only ONE verify path exists. This harness deliberately makes a SECOND
 *    verify call with sourceMode:'external' after the real one, not to get a
 *    cross-check (there is none), but to assert the "no fallback" property
 *    fails HONESTLY — SOURCE_UNAVAILABLE, never a crash, never a false PASS.
 *
 * Usage:
 *   node _rehearsal-x.mjs --handle <your-x-handle> --watch-url <broadcast-url> --preflight
 *   node _rehearsal-x.mjs --handle <your-x-handle> --watch-url <broadcast-url> [--minutes 12]
 *   node _rehearsal-x.mjs --handle <your-x-handle> --watch-url <broadcast-url> --skip-push
 *
 * The watch URL is the "Copy URL" link from your X broadcast dashboard —
 * something like https://x.com/i/broadcasts/<id>. It cannot be guessed or
 * enumerated, so it must be supplied even in --skip-push mode.
 *
 * Needs, and says so plainly if missing:
 *   X_STREAM_KEY   the key from your X broadcast dashboard
 *   X_RTMP_URL     defaults to rtmps://va.pscp.tv:443/x — override only if
 *                  your account is issued a different ingest host
 */
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import puppeteer from 'puppeteer-core';

try { process.loadEnvFile('.env'); } catch { /* env may be injected */ }

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[x-rehearsal]', ...a);

const HANDLE = String(arg('handle', '') || '').replace(/^@/, '');
const WATCH_URL = arg('watch-url', null);
const WARMUP_S = Number(arg('warmup-s', 60));
const MINUTES = Math.min(15, Number(arg('minutes', 12)));
// See the note in _rehearsal-run-b.mjs: timeline calibration needs 3
// agreeing points, one probe per playback — 5 leaves room to lose two.
// MOOT ON X (self-capture uses PDT anchoring, not probe calibration, per the
// #EXT-X-PROGRAM-DATE-TIME confirmed on every segment of a real broadcast)
// but kept for parity and because a short run proves less either way.
const CLIPS = Math.max(1, Number(arg('clips', 5)));
const PORT = 3312;
const APP = `http://localhost:${PORT}`;
const KEY = process.env.X_STREAM_KEY;
const RTMP = process.env.X_RTMP_URL || 'rtmps://va.pscp.tv:443/x';

function ingestTarget(base, key) {
  const u = String(base || '').trim().replace(/\/+$/, '');
  if (!u || !key) return null;
  return u.endsWith(key) ? u : `${u}/${key}`;
}

if (!HANDLE || !WATCH_URL) {
  console.error('usage: node _rehearsal-x.mjs --handle <your-x-handle> '
    + '--watch-url <broadcast-url> [--minutes 12] [--skip-push] [--warmup-s 60] [--preflight]');
  if (!WATCH_URL) {
    console.error('\n--watch-url is REQUIRED, even with --skip-push. It cannot be derived: '
      + 'captureSourceUrl has no channel-page rule for X, so self-capture silently skips '
      + '(a warning, not an error) without it — and that surfaces 40 minutes later as an '
      + 'unexplained SOURCE_UNAVAILABLE. Copy it from your broadcast dashboard\'s "Copy URL" '
      + 'button, e.g. https://x.com/i/broadcasts/<id>');
  }
  process.exit(1);
}

// ── preflight ─────────────────────────────────────────────────────────────
if (has('preflight')) {
  const rows = [];
  const check = (name, okv, detail = '') => rows.push({ name, ok: !!okv, detail });
  const ffOut = (args) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', ...args], { encoding: 'utf8' });
    return r.error ? '' : `${r.stdout || ''}${r.stderr || ''}`;
  };
  check('X_STREAM_KEY present (unattended broadcast)', !!KEY,
    KEY ? 'set' : 'MISSING — from your X broadcast dashboard');
  check('ingest target', !!RTMP, RTMP);
  check('ffmpeg present with RTMPS output', /rtmps/.test(ffOut(['-protocols'])));
  check('libx264 encoder available', /libx264/.test(ffOut(['-encoders'])));
  check('Chrome available for the overlay screencast',
    existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe'));
  const ytdlp = spawnSync('yt-dlp', ['--version'], { encoding: 'utf8' });
  check('extractor (yt-dlp) available — the ONLY frame path on X', ytdlp.status === 0);
  const extractors = spawnSync('yt-dlp', ['--list-extractors'], { encoding: 'utf8' });
  check('yt-dlp has a twitter:broadcast extractor',
    /twitter:broadcast/i.test(extractors.stdout || ''));

  console.log('\n── X REHEARSAL PREFLIGHT ──');
  for (const r of rows) console.log(` ${r.ok ? 'OK  ' : 'MISS'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  const missing = rows.filter((r) => !r.ok);
  console.log(missing.length === 0
    ? '\nREADY: run without --preflight to broadcast unattended.'
    : `\nNOT READY: ${missing.length} item(s) above. With a stream key absent you can still `
      + 'go live yourself and re-run with --skip-push (still needs --watch-url).');
  process.exit(missing.length === 0 ? 0 : 1);
}

if (!KEY && !has('skip-push')) {
  console.error('X_STREAM_KEY is not set. Either set it (from your X broadcast dashboard) '
    + 'or go live yourself and re-run with --skip-push --watch-url <url>.');
  process.exit(2);
}

// ── the run ───────────────────────────────────────────────────────────────
const post = (p, body, as) => fetch(`${APP}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...srv.headers(as) },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (p, as) => fetch(`${APP}${p}`, { headers: srv.headers(as) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const { startGateServer } = await import('./_gate-helpers.mjs');
const dataDir = process.env.REHEARSAL_DATA_DIR || mkdtempSync(path.join(tmpdir(), 'mc-x-'));
const srv = await startGateServer({
  port: PORT, dataDir, label: 'x-rehearsal',
  bountyAuth: { handles: [`x:${HANDLE}`] },
  env: {
    BOUNTY_CLAIM: '1', BOUNTY_IDENTITY_REAL: '0', KEEP_ORPHAN_ROOMS: 'true',
    BOUNTY_STREAM_WARMUP_MS: String(WARMUP_S * 1000),
  },
});
log(`stream-context warmup OVERRIDDEN to ${WARMUP_S}s for this rehearsal `
  + '(production is 10 minutes — do not read this pass as the production rule)');

let browser; let pusher; let screencast;
const cleanup = async () => {
  if (screencast) clearInterval(screencast);
  if (pusher) { try { pusher.stdin.end(); } catch { /* */ } pusher.kill(); }
  if (browser) await browser.close().catch(() => {});
  srv.kill();
};
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

// A real yt-dlp resolve, not a guess. This IS what self-capture does every
// poll, so a failure here means capture would fail identically — it is the
// correct proxy for "is the broadcast readable", not an approximation of it.
async function mediaIsReadable() {
  const r = spawnSync('yt-dlp', ['--no-warnings', '-g', '-f', 'best[height<=1080]/best', WATCH_URL],
    { encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 && !!r.stdout.trim();
}

try {
  // ── fan half: a pledge with a clip, so there is something to air ────────
  const pl = await post('/api/bounty/pledge', {
    targets: [{ platform: 'x', handle: HANDLE }],
    contributor: '0xxfan', amount: '25', expiresInMs: 86_400_000,
  }, `x:${HANDLE}`);
  await fetch(`${APP}${pl.body.uploadUrl}?durationS=8`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm', ...srv.headers(`x:${HANDLE}`) },
    body: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 5)]),
  });
  const claim = await post('/api/bounty/claim',
    { platform: 'x', handle: HANDLE, claimant: HANDLE }, `x:${HANDLE}`);
  if (!claim.body.claim) {
    console.error('[x-rehearsal] claim failed:', JSON.stringify(claim.body));
    await cleanup();
    process.exit(1);
  }
  // watchUrl HERE is what makes captureSourceUrl resolvable at all for a
  // platform with no channel-page derivation — see the file header.
  const air = await post('/api/bounty/air-session',
    { claimId: claim.body.claim.id, platform: 'x', roomId: 'xrehearsal', watchUrl: WATCH_URL },
    `x:${HANDLE}`);
  const airId = air.body.airSession?.id;
  if (!airId) {
    console.error('[x-rehearsal] air-session failed:', JSON.stringify(air.body));
    await cleanup();
    process.exit(1);
  }
  log(`air session ${airId} for x:${HANDLE} — watchUrl=${WATCH_URL} — self-capture starts with it`);

  // ── the broadcast ───────────────────────────────────────────────────────
  browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto(`${APP}/overlay?room=xrehearsal&bounty=${encodeURIComponent(airId)}`,
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate(() => { document.body.style.background = '#00ff00'; });

  if (!has('skip-push')) {
    const target = ingestTarget(RTMP, KEY);
    // -re: PACE THE INPUT AT NATIVE FRAME RATE. Without it a synthetic lavfi
    // source encodes as fast as the CPU allows — measured 7x realtime — which
    // floods the ingest with a temporally compressed stream instead of a live
    // broadcast. Every other harness's source (an OBS operator, a headless
    // Chrome screencast pacing itself) is naturally real-time; this one had
    // to be told.
    pusher = spawn('ffmpeg', [
      '-v', 'error', '-re',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100',
      '-f', 'image2pipe', '-framerate', '2', '-i', 'pipe:0',
      '-filter_complex', '[2:v]colorkey=0x00ff00:0.28:0.06[ov];[0:v][ov]overlay=0:0[out]',
      '-map', '[out]', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '2500k', '-maxrate', '2500k',
      '-bufsize', '5000k', '-pix_fmt', 'yuv420p', '-g', '60',
      '-c:a', 'aac', '-b:a', '128k',
      '-f', 'flv', target,
    ], { stdio: ['pipe', 'ignore', 'inherit'] });
    screencast = setInterval(async () => {
      try {
        const png = await page.screenshot({ type: 'png' });
        if (pusher.stdin.writable) pusher.stdin.write(png);
      } catch { /* frame dropped */ }
    }, 500);
    pusher.on('exit', () => clearInterval(screencast));
    log('pushing to', String(target).replace(KEY, '<key>'));
    log('RTMPS push started — waiting for the broadcast to become readable…');
  } else {
    log('--skip-push: go live yourself now with the overlay in your scene.');
  }

  let readable = false;
  for (let i = 0; i < 24 && !readable; i++) {
    await sleep(10_000);
    readable = await mediaIsReadable();
    if (readable) log('MEDIA CONFIRMED — the watch URL resolves to real HLS');
  }
  if (!readable) {
    log('the watch URL never resolved to readable media. Nothing below would mean '
      + 'anything, so stopping. (Confirm the broadcast is really live and the URL is right.)');
    await cleanup();
    process.exit(3);
  }

  log(`holding ${WARMUP_S}s to clear the stream-context warmup…`);
  await sleep((WARMUP_S + 5) * 1000);

  // ── air the clips ───────────────────────────────────────────────────────
  for (let i = 1; i <= CLIPS; i++) {
    const play = await post('/api/bounty/admin/playback',
      { airSessionId: airId, clipId: `X${i}`, durationS: 30 });
    log(`playback ${i} open, code ${play.body.code?.code}`);
    await sleep(30_000);
    const end = await post('/api/bounty/admin/playback/end',
      { airSessionId: airId, clipId: `X${i}` });
    const fz = end.body.freeze;
    log(`playback ${i} ended — ${fz?.scheduled
      ? `freeze scheduled in ${(fz.inMs / 1000).toFixed(0)}s (${fz.playbackId})`
      : 'NOT FROZEN (self-capture did not run — on X this means verification WILL fail, there is no fallback)'}`);
    await sleep(5_000);
  }

  const holdMs = Math.max(0, MINUTES * 60_000 - (WARMUP_S + CLIPS * 35 + 20) * 1000);
  if (holdMs > 0) { log(`holding the broadcast ${Math.round(holdMs / 60_000)} more minute(s)…`); await sleep(holdMs); }

  await post(`/api/bounty/air-session/${airId}/end`, {}, `x:${HANDLE}`);
  if (pusher) { clearInterval(screencast); try { pusher.stdin.end(); } catch { /* */ } pusher.kill(); }
  log('stream ended.');

  const frozen = readFileSync(`${dataDir}/bounty-evidence.jsonl`, 'utf8')
    .split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.type === 'CAPTURE_FROZEN' && r.airSessionId === airId);
  log(`self-capture froze ${frozen.length}/${CLIPS} window(s)`
    + (frozen.length ? ` — ${(frozen.reduce((a, r) => a + (r.bytes || 0), 0) / 1e6).toFixed(1)}MB total` : ''));
  const withPdt = frozen.filter((r) => Number.isFinite(r.firstPdtMs));
  log(`PROGRAM-DATE-TIME present on ${withPdt.length}/${frozen.length} frozen window(s) `
    + '— the anchor, not a calibration bypass');
  const stale = frozen.filter((r) => r.stale);
  if (stale.length) log(`WARNING: ${stale.length} window(s) marked STALE by the recorder itself`);
  if (frozen.length < CLIPS) {
    log(`WARNING: ${CLIPS - frozen.length} window(s) never froze — on X there is no fallback, `
      + 'so those clips cannot be verified by any means');
  }

  // FRESHNESS, PROVEN NOT ASSUMED. A frozen-window COUNT cannot distinguish a
  // healthy recorder from one that stalled and kept re-freezing the same
  // stale minute under new names — that exact failure produced eight
  // byte-identical files on a real pump.fun broadcast while every printed
  // counter said "23/23, healthy". Hash the actual files.
  let distinctNote = 'no capture files found';
  try {
    const capDir = path.join(dataDir, 'bounty-captures');
    const files = readdirSync(capDir).filter((f) => f.startsWith(airId) && f.endsWith('.ts'));
    const hashes = files.map((f) => createHash('md5').update(readFileSync(path.join(capDir, f))).digest('hex'));
    const distinct = new Set(hashes).size;
    distinctNote = `${files.length} file(s), ${distinct} distinct md5`
      + (distinct < files.length ? ' — STALE RECORDER: some windows are duplicate media' : ' — no duplicates');
    log(`capture freshness: ${distinctNote}`);
  } catch (e) { log(`capture freshness check failed: ${e.message}`); }

  // ── verify FROM SELF-CAPTURE — the only path that exists on X ───────────
  const v = await post(`/api/bounty/air-session/${airId}/verify`, { mode: 'real' }, `x:${HANDLE}`);
  const ver = v.body.verification || {};
  console.log('\n════ X REHEARSAL RESULT ════');
  console.log('self-capture  :', JSON.stringify({
    frameOrigin: v.body.frameOrigin ?? 'unknown',
    result: ver.result, verifiedClips: ver.verifiedClips, confidence: ver.confidence,
    detectionRate: ver.detectionRate,
    readableSamples: ver.readableSamples, unreadableSamples: ver.unreadableSamples,
    sourceState: ver.sourceState ?? null,
    pixelHeights: (ver.checks || []).map((c) => c.pixelHeight),
    timeline: ver.timelineState, skewMs: ver.timelineSkewMs,
  }, null, 2));

  // ── THE NEGATIVE ASSERTION: the missing fallback must fail HONESTLY ─────
  // Not a cross-check — there is nothing to cross-check against. This proves
  // the "X has no external path" design decision behaves as documented
  // (SOURCE_UNAVAILABLE, review queue, zero payout while unresolved) rather
  // than crashing, hanging, or — worse — silently returning a false PASS on
  // whatever frameSourceFor('x') happens to do when asked the wrong way.
  // 'vod' IS THE CORRECT VALUE, NOT 'external'. The route recognizes exactly
  // three sourceMode strings that force the external path — 'vod', 'live',
  // 'files' (bounty-routes.js:1352-1353) — and 'external' is not one of them,
  // so an earlier version of this line fell through to preferCapture=true and
  // returned a PASS from self-capture while claiming to test the fallback.
  // That was this harness's own bug, caught by rereading the exact condition
  // this file's header already quotes, not a defect in the route.
  const vExt = await post(`/api/bounty/air-session/${airId}/verify`,
    { mode: 'real', sourceMode: 'vod' }, `x:${HANDLE}`);
  const verExt = vExt.body.verification || {};
  console.log('forced-external (expected to fail HONESTLY, not silently) :', JSON.stringify({
    frameOrigin: vExt.body.frameOrigin ?? 'unknown',
    result: verExt.result, sourceState: verExt.sourceState ?? null,
  }));
  if (verExt.result === 'SOURCE_UNAVAILABLE') {
    console.log('  -> CONFIRMED: the missing fallback fails honestly (review queue, not a false verdict).');
  } else {
    console.log(`  -> UNEXPECTED: forced-external returned ${verExt.result}, not SOURCE_UNAVAILABLE. `
      + 'X is documented as having no readable stream at all; this needs investigating before trusting it.');
  }

  console.log('\nstream ctx   :', JSON.stringify(v.body.streamContext?.summary ?? null));
  const pool = await get(`/api/bounty/pool-view?platform=x&handle=${HANDLE}`);
  console.log('release(stub):', pool.body.view?.releasedContributor, 'of', pool.body.view?.totalContributed);
  console.log(`\nOn X, self-capture is not the preferred path or the primary evidence — it is `
    + `the ONLY evidence. ${distinctNote}.`);
  console.log('Compare against Twitch (own-recording PASS 5/5, det 1.000) and pump.fun '
    + '(own-recording PARTIAL 6, det 0.857) at the same resolution.');
} catch (e) {
  console.error('[x-rehearsal] FAILED:', e?.stack || e?.message || e);
  process.exitCode = 1;
} finally {
  await cleanup();
}
