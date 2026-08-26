/**
 * KICK DRESS REHEARSAL — one command, one real Kick broadcast, a real verdict.
 *
 * The Twitch equivalent (_rehearsal-run-b.mjs) proved that pipeline on a real
 * broadcast. Kick has never faced one: it is inferred, not proven, and it is
 * the platform where being wrong costs most, because Kick publishes NO VOD
 * listing. Until self-capture (T1) landed, a Kick verification had exactly one
 * chance — a live grab racing a 12-25s delay — and one miss meant an honest
 * streamer went unpaid with no retry.
 *
 * WHAT IS DIFFERENT FROM THE TWITCH RUN, and why this harness exists at all:
 *  - Verification uses SELF-CAPTURE, not a platform archive. The air session
 *    holds a rolling window of the live stream and freezes the part covering
 *    each clip. That is the whole reason Kick can now be verified like Twitch.
 *  - Live status comes from api.kick.com (channels?slug=), and auth from
 *    id.kick.com — different hosts, the classic Kick mistake.
 *  - Kick ingests over RTMPS via its IVS edge, not plain RTMP.
 *
 * Usage:
 *   node _rehearsal-kick.mjs --slug <your-kick-slug> --preflight
 *   node _rehearsal-kick.mjs --slug <your-kick-slug> [--minutes 12] [--warmup-s 60]
 *   node _rehearsal-kick.mjs --slug <your-kick-slug> --skip-push   # you go live yourself
 *
 * Needs, and says so plainly if missing:
 *   KICK_STREAM_KEY   the key from Kick → Creator Dashboard → Stream Settings
 *   KICK_RTMP_URL     that page's ingest URL (per-account; do NOT guess it)
 *   KICK_CLIENT_ID / KICK_CLIENT_SECRET   to read live status back
 */
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';

// The harness calls the Kick API directly (preflight + live confirm), so it
// needs the credentials in ITS process, not just the server's.
try { process.loadEnvFile('.env'); } catch { /* env may be injected */ }

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[kick-rehearsal]', ...a);

const SLUG = arg('slug', null);
const WARMUP_S = Number(arg('warmup-s', 60));
const MINUTES = Math.min(15, Number(arg('minutes', 12)));
/**
 * See the note in _rehearsal-run-b.mjs: timeline calibration needs 3 AGREEING
 * points and gets one probe per playback, so 3 clips is the minimum with zero
 * margin and a real broadcast loses roughly one probe in four. Five leaves
 * room to lose two.
 */
const CLIPS = Math.max(1, Number(arg('clips', 5)));
const PORT = 3308;
const APP = `http://localhost:${PORT}`;
const KEY = process.env.KICK_STREAM_KEY;
const RTMP = process.env.KICK_RTMP_URL;

if (!SLUG) {
  console.error('usage: node _rehearsal-kick.mjs --slug <your-kick-slug> '
    + '[--minutes 12] [--skip-push] [--warmup-s 60] [--preflight]');
  process.exit(1);
}

// ── preflight ─────────────────────────────────────────────────────────────
if (has('preflight')) {
  const rows = [];
  const check = (name, okv, detail = '') => rows.push({ name, ok: !!okv, detail });
  // Judge ffmpeg on OUTPUT, not exit code: some builds print capability
  // listings to stderr and exit non-zero with no input file.
  const ffOut = (args) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', ...args], { encoding: 'utf8' });
    return r.error ? '' : `${r.stdout || ''}${r.stderr || ''}`;
  };
  check('KICK_STREAM_KEY present (unattended broadcast)', !!KEY,
    KEY ? 'set' : 'MISSING — Kick → Creator Dashboard → Stream Settings');
  check('KICK_RTMP_URL present (per-account ingest, never guessed)', !!RTMP,
    RTMP ? RTMP.replace(/\/[^/]*$/, '/…') : 'MISSING — copy from the same page');
  check('ffmpeg present with RTMPS output', /rtmps/.test(ffOut(['-protocols'])));
  check('libx264 encoder available', /libx264/.test(ffOut(['-encoders'])));
  check('Chrome available for the overlay screencast',
    existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe'));
  check('extractor (yt-dlp) available — self-capture reads the live HLS',
    spawnSync('yt-dlp', ['--version'], { encoding: 'utf8' }).status === 0);

  const { kickApiConfigured, getChannelBySlug } = await import('./kick-api.js');
  check('Kick API credentials configured', kickApiConfigured(),
    kickApiConfigured() ? 'id.kick.com + api.kick.com' : 'MISSING KICK_CLIENT_ID / KICK_CLIENT_SECRET');
  if (kickApiConfigured()) {
    const ch = await getChannelBySlug(SLUG, { log: console }).catch(() => null);
    check('Kick API reachable + slug resolvable', !!ch,
      ch ? `${SLUG} is ${ch.live ? 'LIVE' : 'offline'}` : `could not resolve ${SLUG}`);
  }

  console.log('\n── KICK REHEARSAL PREFLIGHT ──');
  for (const r of rows) console.log(` ${r.ok ? 'OK  ' : 'MISS'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  const missing = rows.filter((r) => !r.ok);
  console.log(missing.length === 0
    ? '\nREADY: run without --preflight to broadcast unattended.'
    : `\nNOT READY: ${missing.length} item(s) above. With a stream key absent you can still `
      + 'go live yourself and re-run with --skip-push.');
  process.exit(missing.length === 0 ? 0 : 1);
}

if (!KEY && !has('skip-push')) {
  console.error('KICK_STREAM_KEY is not set. Either set it (Kick → Creator Dashboard → '
    + 'Stream Settings) or go live yourself and re-run with --skip-push.');
  process.exit(2);
}
if (KEY && !RTMP && !has('skip-push')) {
  console.error('KICK_RTMP_URL is not set. Kick ingest URLs are PER ACCOUNT and must be '
    + 'copied from your own Stream Settings page — guessing one silently streams nowhere.');
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
const dataDir = process.env.REHEARSAL_DATA_DIR || mkdtempSync(path.join(tmpdir(), 'mc-kick-'));
const srv = await startGateServer({
  port: PORT, dataDir, label: 'kick-rehearsal',
  bountyAuth: { handles: [`kick:${SLUG}`] },
  env: {
    BOUNTY_CLAIM: '1', BOUNTY_IDENTITY_REAL: '0', KEEP_ORPHAN_ROOMS: 'true',
    KICK_CLIENT_ID: process.env.KICK_CLIENT_ID || '',
    KICK_CLIENT_SECRET: process.env.KICK_CLIENT_SECRET || '',
    // Rehearsal-only: the production rule is 10 minutes. Printed loudly below
    // so a passing context check here is never mistaken for the real one.
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

try {
  const { getChannelBySlug } = await import('./kick-api.js');

  // ── fan half: a pledge with a clip, so there is something to air ────────
  const pl = await post('/api/bounty/pledge', {
    targets: [{ platform: 'kick', handle: SLUG }],
    contributor: '0xkickfan', amount: '25', expiresInMs: 86_400_000,
  }, `kick:${SLUG}`);
  await fetch(`${APP}${pl.body.uploadUrl}?durationS=8`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm', ...srv.headers(`kick:${SLUG}`) },
    body: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 5)]),
  });
  const claim = await post('/api/bounty/claim',
    { platform: 'kick', handle: SLUG, claimant: SLUG }, `kick:${SLUG}`);
  const air = await post('/api/bounty/air-session',
    { claimId: claim.body.claim.id, platform: 'kick', roomId: 'kickrehearsal' }, `kick:${SLUG}`);
  const airId = air.body.airSession.id;
  log(`air session ${airId} for kick:${SLUG} — self-capture starts with it`);

  // ── the broadcast ───────────────────────────────────────────────────────
  browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto(`${APP}/overlay?room=kickrehearsal&bounty=${encodeURIComponent(airId)}`,
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate(() => { document.body.style.background = '#00ff00'; });

  if (!has('skip-push')) {
    // RTMPS to the account's own ingest. Same encode profile as the Twitch
    // rehearsal so the two runs are comparable at the same resolution.
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
      '-f', 'flv', `${RTMP.replace(/\/$/, '')}/${KEY}`,
    ], { stdio: ['pipe', 'ignore', 'inherit'] });
    screencast = setInterval(async () => {
      try {
        const png = await page.screenshot({ type: 'png' });
        if (pusher.stdin.writable) pusher.stdin.write(png);
      } catch { /* frame dropped */ }
    }, 500);
    pusher.on('exit', () => clearInterval(screencast));
    log('RTMPS push started — waiting for Kick to report the channel live…');
  } else {
    log('--skip-push: go live yourself now with the overlay in your scene.');
  }

  let live = null;
  for (let i = 0; i < 24 && !live?.live; i++) {
    await sleep(10_000);
    live = await getChannelBySlug(SLUG, { log: console }).catch(() => null);
    if (live?.live) log(`LIVE confirmed by Kick — ${live.viewerCount} viewer(s), started ${live.startedAt}`);
  }
  if (!live?.live) {
    log('Kick never reported the channel live. Nothing below would mean anything, so stopping.');
    await cleanup();
    process.exit(3);
  }

  // Wait past the warmup so stream context can actually pass.
  log(`holding ${WARMUP_S}s to clear the stream-context warmup…`);
  await sleep((WARMUP_S + 5) * 1000);

  // ── air three clips ─────────────────────────────────────────────────────
  for (let i = 1; i <= CLIPS; i++) {
    const play = await post('/api/bounty/admin/playback',
      { airSessionId: airId, clipId: `KICK${i}`, durationS: 30 });
    log(`playback ${i} open, code ${play.body.code?.code}`);
    await sleep(30_000);
    const end = await post('/api/bounty/admin/playback/end',
      { airSessionId: airId, clipId: `KICK${i}` });
    log(`playback ${i} ended — capture ${end.body.capture
      ? `${(end.body.capture.bytes / 1e6).toFixed(1)}MB / ${end.body.capture.spanMs}ms`
      : 'NOT FROZEN (self-capture did not run)'}`);
    await sleep(5_000);
  }

  // Keep streaming past the last playback so the tail check passes.
  // Clip time is CLIPS * ~35s, not a hardcoded 2 minutes. With 5 clips the old
  // constant under-counted by ~55s and the broadcast overran its budget.
  const holdMs = Math.max(0, MINUTES * 60_000 - (WARMUP_S + CLIPS * 35 + 20) * 1000);
  if (holdMs > 0) { log(`holding the broadcast ${Math.round(holdMs / 60_000)} more minute(s)…`); await sleep(holdMs); }

  await post(`/api/bounty/air-session/${airId}/end`, {}, `kick:${SLUG}`);
  if (pusher) { clearInterval(screencast); try { pusher.stdin.end(); } catch { /* */ } pusher.kill(); }
  log('stream ended.');

  // ── verify FROM THE SELF-CAPTURE (Kick has no VOD) ──────────────────────
  const v = await post(`/api/bounty/air-session/${airId}/verify`, { mode: 'real' }, `kick:${SLUG}`);
  const ver = v.body.verification || {};
  console.log('\n════ KICK REHEARSAL RESULT ════');
  console.log('verification :', JSON.stringify({
    result: ver.result, verifiedClips: ver.verifiedClips, confidence: ver.confidence,
    sourceState: ver.sourceState ?? null,
    pixelHeights: (ver.checks || []).map((c) => c.pixelHeight),
    timeline: ver.timelineState, skewMs: ver.timelineSkewMs,
  }, null, 2));
  console.log('stream ctx   :', JSON.stringify(v.body.streamContext?.summary ?? null));
  const pool = await get(`/api/bounty/pool-view?platform=kick&handle=${SLUG}`);
  console.log('release(stub):', pool.body.view?.releasedContributor, 'of', pool.body.view?.totalContributed);
  console.log('\nCompare against the Twitch run and the synthetic corpus at the same '
    + 'resolution: corpus 720p is 100%, Twitch real-encoder 720p verified 4/4.');
} catch (e) {
  console.error('[kick-rehearsal] FAILED:', e?.stack || e?.message || e);
  process.exitCode = 1;
} finally {
  await cleanup();
}
