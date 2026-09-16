/**
 * DRESS REHEARSAL — the full Run B loop against a REAL Twitch broadcast,
 * one command, unattended:
 *
 *   node _rehearsal-run-b.mjs
 *
 * Requires TWITCH_STREAM_KEY in env (plus the TWITCH_CLIENT_ID/SECRET that
 * are already there). What it does:
 *
 *  1. Boots the local server (BOUNTY_CLAIM on), seeds a pledge + clip, claims
 *     the handle given by --handle (default: the channel being streamed to),
 *     opens a real air session.
 *  2. Captures the REAL overlay page continuously (headless screencast) and
 *     pushes it composited over a test pattern to Twitch via ffmpeg RTMP —
 *     a genuine live broadcast. Keep it short; ~12 minutes, then ends the
 *     stream cleanly. SET THE STREAM TITLE TO A TEST TITLE MANUALLY first:
 *     title changes need a user token this harness deliberately doesn't have.
 *  3. Drives real clip playbacks through the admin route — codes issue and
 *     rotate exactly as they would for real clips.
 *  4. LIVE SPOT-CHECK mid-broadcast: verify with sourceMode 'live' — frames
 *     grabbed from the public HLS while the code is on air.
 *  5. After the stream ends, polls for the VOD (processing lag is real) and
 *     runs the primary VOD verification at the logged timestamps.
 *  6. Prints the verdicts, the viewer samples in the evidence chain, and the
 *     release rows. End state: verified clip playbacks with viewer counts,
 *     produced entirely from public broadcast data.
 *
 * Flags:
 *   --handle <login>   channel login being broadcast to (default from key owner: REQUIRED)
 *   --minutes <n>      broadcast length (default 12, keep it short)
 *   --skip-push        assume the channel is ALREADY live with the overlay
 *                      (real-usage rehearsal): only seeds, plays, verifies.
 *   --preflight        check every precondition and EXIT without broadcasting.
 *                      Run this before committing to a live stream.
 *
 * Cost: Twitch API reads only (no spend); zero LiveKit; one short broadcast
 * on your own channel.
 */
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';

// LOAD .env IN THIS PROCESS. The harness spawns server.js (which loads .env
// itself), but the harness ALSO calls the Twitch API directly — the live
// confirm loop and the preflight. Without this it runs credential-less and
// every Helix call returns null, which the pipeline correctly reports as
// API_UNAVAILABLE... during a live broadcast, when it is too late to fix.
// Caught by the preflight on its first run.
try { process.loadEnvFile('.env'); } catch { /* no .env — env may be injected */ }

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[rehearsal]', ...a);

const HANDLE = arg('handle', null);
/** Rehearsal-only warmup, in seconds. The harness waits past this before the
 *  first playback so stream context can actually pass. */
const WARMUP_S = Number(arg('warmup-s', 60));
const MINUTES = Math.min(15, Number(arg('minutes', 12)));
/**
 * How many distinct clips to air. THE DEFAULT IS NOT ARBITRARY: timeline
 * calibration needs `calibrationMinPoints` (3) AGREEING points and gets at
 * most ONE probe target per playback window, so three clips is exactly the
 * minimum with zero margin — and the calibration module's own notes record
 * roughly one junk probe in four on a real VOD. Three means a single bad
 * decode fails the run; five leaves room to lose two. On a one-shot broadcast
 * budget that margin is the difference between a verdict and a wasted attempt.
 */
const CLIPS = Math.max(1, Number(arg('clips', 5)));
const PORT = 3306;
const APP = `http://localhost:${PORT}`;
const KEY = process.env.TWITCH_STREAM_KEY;

if (!HANDLE) {
  console.error('usage: node _rehearsal-run-b.mjs --handle <your-twitch-login> '
    + '[--minutes 12] [--skip-push] [--warmup-s 60]');
  process.exit(1);
}
if (!KEY && !has('skip-push') && !has('preflight')) {
  console.error('TWITCH_STREAM_KEY is not set. Either set it, or go live yourself (overlay in OBS) and pass --skip-push.');
  process.exit(1);
}

// ── preflight ───────────────────────────────────────────────────────────────
// Everything that can be proven WITHOUT broadcasting, so a live attempt is
// never the thing that discovers a missing tool. Exits non-zero if the
// rehearsal would fail for a reason other than "not live yet".
if (has('preflight')) {
  const rows = [];
  const check = (name, okv, detail = '') => { rows.push({ name, ok: !!okv, detail }); };
  // Some ffmpeg builds print capability listings to stderr and/or exit
  // non-zero with no input file — judge on the OUTPUT, not the exit code.
  const ffOut = (args) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', ...args], { encoding: 'utf8' });
    return r.error ? '' : `${r.stdout || ''}${r.stderr || ''}`;
  };

  check('TWITCH_STREAM_KEY present (unattended broadcast)', !!KEY,
    KEY ? 'set' : 'ABSENT — use --skip-push and go live yourself');
  check('ffmpeg present with RTMP output', /rtmp/.test(ffOut(['-protocols'])));
  check('libx264 encoder available', /libx264/.test(ffOut(['-encoders'])));
  check('Chrome available for the overlay screencast',
    existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe'));
  const ytOk = spawnSync('yt-dlp', ['--version'], { encoding: 'utf8' });
  const ytOkay = !ytOk.error && ytOk.status === 0;
  check('extractor (yt-dlp) available for VOD/live frame grabs', ytOkay,
    ytOkay ? String(ytOk.stdout).trim() : 'install yt-dlp or streamlink');
  check('Twitch API credentials configured',
    !!(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET));
  try {
    const { getStreamByLogin } = await import('./twitch-api.js');
    const probe = await getStreamByLogin(HANDLE);
    check('Twitch Helix reachable + channel resolvable', probe !== null,
      probe ? (probe.live ? `${HANDLE} is LIVE now (${probe.viewerCount} viewers)` : `${HANDLE} is offline`) : 'API unreachable');
  } catch (e) { check('Twitch Helix reachable', false, e.message); }

  console.log('\n── REHEARSAL PREFLIGHT ──');
  for (const r of rows) console.log(`${r.ok ? ' OK ' : 'MISS'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  const blocking = rows.filter((r) => !r.ok && !/STREAM_KEY/.test(r.name));
  console.log(blocking.length
    ? `\n${blocking.length} blocking gap(s) — fix before going live.`
    : KEY
      ? '\nREADY: run without --preflight to broadcast unattended.'
      : '\nREADY except the stream key: go live yourself with the overlay and re-run with --skip-push.');
  process.exit(blocking.length ? 1 : 0);
}

const AS = () => `twitch:${HANDLE}`;
const post = (p, body, as = AS()) => fetch(`${APP}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...srv.headers(as) },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (p, as = AS()) => fetch(`${APP}${p}`, { headers: srv.headers(as) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

/**
 * A rejected call must STOP the run, not flow onward as undefined. Without
 * this the 401 above produced `http://localhost:3306undefined?durationS=10`
 * several statements later, so the error named a malformed URL instead of the
 * authorization that actually failed — and had the URL been well-formed, the
 * run would have broadcast for twelve minutes issuing zero codes.
 */
const must = (label, r) => {
  if (r.status >= 400) {
    throw new Error(`${label} -> HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  return r;
};

// ── 1. server + session ─────────────────────────────────────────────────────
// Spawned through the gate harness: occupied-port refusal, early-exit stderr,
// readiness polling instead of a blind sleep, and a nonce proving the server
// answering is the one WE started. This harness drives a real broadcast — it is
// the last place that should be guessing whether its server came up.
const { startGateServer } = await import('./_gate-helpers.mjs');
const dataDir = process.env.REHEARSAL_DATA_DIR || mkdtempSync(path.join(tmpdir(), 'mc-rehearsal-'));
const srv = await startGateServer({
  // args is the COMPLETE argv, not extra flags appended to a hardcoded
  // script: this said ['--prod'] and so spawned `node --prod` with no script,
  // which Node rejects outright ("bad option: --prod", exit 9). The harness
  // has been unable to boot since startGateServer's args parameter was
  // generalised, and nothing caught it because rehearsals need a real
  // broadcast and so are not in the gate suite.
  port: PORT, dataDir, args: ['server.js', '--prod'], label: 'rehearsal',
  // EVERY bounty route this harness drives authorizes server-side since the
  // 2026-08-24 lockdown: pledge is FAN, air-session/verify are STREAMER,
  // admin/playback is ADMIN and answers 503 unconditionally when no admin key
  // is configured. The harness sent no cookie and no admin key, so its first
  // real HTTP call 401'd and the undefined uploadUrl became the literal URL
  // "http://localhost:3306undefined" — which is exactly how this failed.
  bountyAuth: { handles: [`twitch:${HANDLE}`] },
  env: {
    BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true',
    // REHEARSAL-ONLY WARMUP OVERRIDE. The shipped rule ignores playbacks in the
    // first 10 minutes of a broadcast, so a harness that plays clips right after
    // going live can never demonstrate a clean context pass — every rehearsal
    // ended with four INSIDE_WARMUP rejections that looked like a failure and
    // were in fact the rule working. Shortened here, and the harness waits past
    // it, so the run exercises the pass path end to end. Printed loudly below
    // so nobody reads a rehearsal pass as the production threshold.
    BOUNTY_STREAM_WARMUP_MS: String(WARMUP_S * 1000),
  },
  readyTimeoutMs: 45_000,
});
const app = srv.child;

let browser, pusher;
const cleanup = async () => {
  try { pusher?.stdin?.end(); } catch { /* */ }
  try { pusher?.kill(); } catch { /* */ }
  try { await browser?.close(); } catch { /* */ }
  try { app.kill(); } catch { /* */ }
};
process.on('SIGINT', async () => { await cleanup(); process.exit(1); });

try {
  const vid = (n) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(n, 7)]);
  const pl = must('pledge', await post('/api/bounty/pledge', {
    targets: [{ platform: 'twitch', handle: HANDLE }],
    contributor: '0xrehearsal', amount: '25', expiresInMs: 86_400_000,
  }));
  const up = await fetch(`${APP}${pl.body.uploadUrl}?durationS=10`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm', ...srv.headers(AS()) }, body: vid(4096),
  });
  if (!up.ok) throw new Error(`clip upload -> HTTP ${up.status}`);
  const claim = must('claim', await post('/api/bounty/claim', { platform: 'twitch', handle: HANDLE, claimant: HANDLE }));
  const air = must('air-session', await post('/api/bounty/air-session', { claimId: claim.body.claim.id, platform: 'twitch', roomId: 'rehearsalroom' }));
  const airId = air.body.airSession.id;
  log('air session', airId, 'for', HANDLE);

  // ── 2. broadcast ──────────────────────────────────────────────────────────
  if (!has('skip-push')) {
    browser = await puppeteer.launch({
      executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(`${APP}/overlay?room=rehearsalroom&bounty=${encodeURIComponent(airId)}`,
      { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.evaluate(() => { document.body.style.background = '#00ff00'; });

    // Screencast → ffmpeg: PNGs down stdin at 2 fps, keyed over a test
    // pattern, encoded to Twitch-recommended settings, pushed via RTMP.
    pusher = spawn('ffmpeg', [
      '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100',
      '-f', 'image2pipe', '-framerate', '2', '-i', 'pipe:0',
      '-filter_complex', '[2:v]colorkey=0x00ff00:0.28:0.06[ov];[0:v][ov]overlay=0:0[out]',
      '-map', '[out]', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '3000k', '-maxrate', '3000k',
      '-bufsize', '6000k', '-pix_fmt', 'yuv420p', '-g', '60',
      '-c:a', 'aac', '-b:a', '128k',
      '-f', 'flv', `rtmp://live.twitch.tv/app/${KEY}`,
    ], { stdio: ['pipe', 'ignore', 'inherit'] });
    const screencast = setInterval(async () => {
      try {
        const png = await page.screenshot({ type: 'png' });
        if (pusher.stdin.writable) pusher.stdin.write(png);
      } catch { /* frame dropped */ }
    }, 500);
    pusher.on('exit', () => clearInterval(screencast));
    log('RTMP push started — waiting for Twitch to see the stream…');
    // Confirm we are actually live before proceeding.
    let liveConfirmed = false;
    for (let i = 0; i < 24; i++) {
      await sleep(10_000);
      const { getStreamByLogin } = await import('./twitch-api.js');
      const s = await getStreamByLogin(HANDLE);
      if (s?.live) { liveConfirmed = true; break; }
    }
    if (!liveConfirmed) throw new Error('Twitch never reported the channel live — check the stream key.');
    log('LIVE confirmed by Helix.');
  } else {
    log('--skip-push: assuming the channel is already live with the overlay open at:');
    log(`  ${APP}/overlay?room=rehearsalroom&bounty=${encodeURIComponent(airId)}`);
  }

  // ── 3. real clip playbacks with rotating codes ────────────────────────────
  // SIT OUT THE WARMUP FIRST. Playing immediately is what a farmer does, and
  // the stream-context gate rejects it correctly — so the rehearsal has to wait
  // like a real streamer would, or it can only ever demonstrate the failure.
  const warmupWaitMs = WARMUP_S * 1000 + 10_000;
  log(`WARMUP OVERRIDE: ${WARMUP_S}s for this rehearsal (production is `
    + `${Math.round(10 * 60)}s). Waiting ${Math.round(warmupWaitMs / 1000)}s before the first clip `
    + 'so stream context can pass.');
  await sleep(warmupWaitMs);

  const playbacks = [];
  for (let i = 0; i < CLIPS; i++) {
    const p = await post('/api/bounty/admin/playback', { airSessionId: airId, clipId: `REHEARSAL${i + 1}`, durationS: 30 });
    log(`playback ${i + 1} open, first code ${p.body.code?.code}`);
    playbacks.push(p.body);

    // ── 4. live spot-check during the SECOND playback ─────────────────────
    // LIVE SPOT-CHECK — opt-in via --live-check, OFF by default.
    // It runs the FULL verify+release route, not a read-only probe. A
    // SOURCE_UNAVAILABLE here (routine on a live edge) opens a review that
    // blocks every later release with pending_review; a SUCCESS here consumes
    // the session's single `release:<id>` idempotency key on 1 clip, making
    // the final 5-clip release a dedupe no-op. Either way the run ends
    // reporting PASS beside a zero payout, and the spot-check is the cause.
    if (i === 1 && has('live-check')) {
      await sleep(8000); // let the code render + reach the CDN edge
      const live = await post(`/api/bounty/air-session/${airId}/verify`, { mode: 'real', sourceMode: 'live' });
      log('LIVE SPOT-CHECK:', JSON.stringify({
        result: live.body.verification?.result,
        clips: live.body.verification?.verifiedClips,
        state: live.body.verification?.sourceState,
        review: live.body.review?.reason || null,
        releaseSkipped: live.body.release?.skipped || null,
      }));
    }
    await sleep(30_000);
    const end = await post('/api/bounty/admin/playback/end',
      { airSessionId: airId, clipId: `REHEARSAL${i + 1}` });
    // REPORT WHETHER SELF-CAPTURE ACTUALLY RAN. This harness discarded the
    // playback/end response entirely, so a run could not say whether the
    // rolling buffer had frozen anything — and because every verification
    // below names a sourceMode (which forces the external path), nothing
    // downstream would reveal it either. A Twitch "self-capture PASS 0.886"
    // was reported to the operator on that silence; it was an external read.
    // Freezing is SCHEDULED, not synchronous — see the same note in
    // _rehearsal-kick.mjs — so `freeze.scheduled` is what to print here.
    const fz = end.body.freeze;
    log(`playback ${i + 1} ended — ${fz?.scheduled
      ? `capture freeze scheduled in ${(fz.inMs / 1000).toFixed(0)}s (${fz.playbackId})`
      : 'capture NOT FROZEN (self-capture did not run)'}`);
  }

  // Keep the broadcast up to the requested length so the VOD is substantial.
  const remaining = MINUTES * 60_000 - CLIPS * 38_000 - warmupWaitMs;
  if (!has('skip-push') && remaining > 0) {
    log(`holding the broadcast ${Math.round(remaining / 60000)} more minute(s)…`);
    await sleep(remaining);
  }

  // ── 5. end stream, wait for the VOD, verify ───────────────────────────────
  if (pusher) { try { pusher.stdin.end(); } catch { /* */ } pusher.kill(); log('stream ended.'); }
  log('waiting for the VOD to appear (processing lag is normal)…');
  let vodResult = null;
  for (let i = 0; i < 20; i++) {
    await sleep(30_000);
    const v = await post(`/api/bounty/air-session/${airId}/verify`, { mode: 'real', sourceMode: 'vod' });
    vodResult = v.body.verification;
    if (vodResult?.result && vodResult.result !== 'SOURCE_UNAVAILABLE') break;
    log(`  not yet (${vodResult?.sourceState || vodResult?.result}) — retrying`);
  }

  // ── 6. the receipts ───────────────────────────────────────────────────────
  // ── 5b. THE SELF-CAPTURE READ, which this harness never made ────────────
  // Omitting sourceMode is the ONLY way to reach the capture path:
  // bounty-routes.js:1341 sets preferCapture only when sourceMode is absent,
  // so 'live' and 'vod' both read external frames. Every Twitch number this
  // harness had ever produced was therefore external, including one reported
  // as "self-capture". frameOrigin is printed rather than assumed.
  const selfV = await post(`/api/bounty/air-session/${airId}/verify`, { mode: 'real' });
  const selfResult = selfV.body.verification;

  console.log('\n════ REHEARSAL RESULT ════');
  console.log('self-capture     :', JSON.stringify({
    frameOrigin: selfV.body.frameOrigin ?? 'unknown',
    result: selfResult?.result, verifiedClips: selfResult?.verifiedClips,
    confidence: selfResult?.confidence, detectionRate: selfResult?.detectionRate,
    pixelHeights: (selfResult?.checks || []).map((c) => c.pixelHeight),
  }, null, 2));
  console.log('VOD verification :', JSON.stringify({
    frameOrigin: vodResult ? 'external' : null,
    result: vodResult?.result, verifiedClips: vodResult?.verifiedClips,
    confidence: vodResult?.confidence,
    pixelHeights: (vodResult?.checks || []).map((c) => c.pixelHeight),
  }, null, 2));
  if (selfV.body.frameOrigin !== 'capture') {
    console.log('\nNOT a self-capture result: the verifier read '
      + `${selfV.body.frameOrigin || 'unknown'} frames because the rolling buffer `
      + 'held nothing for these windows. Twitch self-capture remains unproven.');
  }
  const pool = await get(`/api/bounty/pool-view?platform=twitch&handle=${HANDLE}`);
  console.log('release (stub)   :', pool.body.view?.releasedContributor, 'of', pool.body.view?.totalContributed);
  const sess = await get('/api/bounty/admin/sessions');
  console.log('settlement intents (recorded, never sent):', JSON.stringify(sess.body.settlementIntents || []));
  console.log('\nviewer samples land in the evidence chain (VIEWER_SAMPLE rows in bounty-evidence.jsonl under DATA_DIR).');
} finally {
  await cleanup();
}
