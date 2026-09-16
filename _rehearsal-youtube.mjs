/**
 * YOUTUBE DRESS REHEARSAL — one command, one real YouTube broadcast, a real
 * verdict. The platform with the LONGEST list of open blockers before this
 * ran, none of them proven true or false against a real stream until now.
 *
 * THREE THINGS THIS HARNESS EXISTS TO SETTLE, EACH FROM READING THE CODE, NONE
 * YET TESTED:
 *  1. Capture never retries if the session opens before the broadcast is
 *     live: the offline-retry classifier in bounty-routes.js matches
 *     /not currently live|CHANNEL_OFFLINE|offline/i, which is Twitch/Kick's
 *     wording. YouTube's yt-dlp error is "This live event will begin in N
 *     hours" — no match, so a premature session's capture throws once and
 *     never retries. WORKAROUND, no code change: do not open the air session
 *     until yt-dlp actually resolves media, exactly like X's approach below.
 *  2. captureFreezeDelayMs (30s) and captureWindowMs (60s) were sized against
 *     Kick's measured 12-25s delay. YouTube's default "Normal" latency runs
 *     30-60s+, wide enough that a 30s clip could sit entirely outside the
 *     frozen window while the freeze COUNT still reports success — the same
 *     shape of lie that made pump.fun's stall invisible. Set the broadcast to
 *     ULTRA-LOW LATENCY in YouTube Studio before running this; that is a
 *     streamer-side setting this harness cannot reach or verify from here.
 *  3. extractVideoId REJECTS youtube.com/@handle/live — the shape a streamer
 *     would most naturally copy from their own channel page. This harness
 *     resolves the video ID itself and constructs an accepted watch?v=<id>
 *     shape, so that trap never gets a chance to fire.
 *
 * Usage:
 *   node _rehearsal-youtube.mjs --channel <@handle-or-channel-url> --preflight
 *   node _rehearsal-youtube.mjs --channel <@handle-or-channel-url> [--minutes 12]
 *   node _rehearsal-youtube.mjs --watch-url <youtube.com/watch?v=...>   # skip discovery
 *   node _rehearsal-youtube.mjs --watch-url <url> --skip-push           # you go live yourself
 *
 * Needs, and says so plainly if missing:
 *   YOUTUBE_STREAM_KEY   the key from YouTube Studio → Go Live
 *   YOUTUBE_RTMP_URL     defaults to rtmp://a.rtmp.youtube.com/live2
 * YOUTUBE_API_KEY is NOT needed here — self-capture is the only path this
 * harness exercises, and only the archive/VOD path needs the Data API.
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
const log = (...a) => console.log('[youtube-rehearsal]', ...a);

const CHANNEL = arg('channel', null);
let WATCH_URL = arg('watch-url', null);
const WARMUP_S = Number(arg('warmup-s', 60));
const MINUTES = Math.min(15, Number(arg('minutes', 12)));
const CLIPS = Math.max(1, Number(arg('clips', 5)));
const PORT = 3313;
const APP = `http://localhost:${PORT}`;
const KEY = process.env.YOUTUBE_STREAM_KEY;
const RTMP = process.env.YOUTUBE_RTMP_URL || 'rtmp://a.rtmp.youtube.com/live2';
// DERIVED BEFORE THE SERVER BOOTS, deliberately. mintBountyAuth mints a
// session token for the EXACT strings in bountyAuth.handles at startup — an
// empty array here (because the real watch URL isn't known until the video
// resolves later) would 401 every authenticated call this harness makes.
// Only the video id is discovered later; the handle used for auth/claim/pool
// never changes, so it can and must be fixed now.
const HANDLE = (CHANNEL || WATCH_URL || '').replace(/^https?:\/\/(www\.)?youtube\.com\//, '')
  .replace(/^@/, '').replace(/[^a-z0-9_.-]/gi, '_').slice(0, 40).toLowerCase() || 'ytrehearsal';

function ingestTarget(base, key) {
  const u = String(base || '').trim().replace(/\/+$/, '');
  if (!u || !key) return null;
  return u.endsWith(key) ? u : `${u}/${key}`;
}

if (!CHANNEL && !WATCH_URL) {
  console.error('usage: node _rehearsal-youtube.mjs --channel <@handle-or-url> '
    + '[--minutes 12] [--skip-push] [--warmup-s 60] [--preflight]');
  console.error('  or:  node _rehearsal-youtube.mjs --watch-url <youtube.com/watch?v=...> ...');
  console.error('\nAt least one is required. --channel triggers auto-discovery of the live '
    + 'video id via yt-dlp once you are actually live (channel/live is a yt-dlp-supported '
    + 'shape for "whatever is live now", but extractVideoId REJECTS it as a stored watchUrl — '
    + 'so this harness resolves the id and hands the route a watch?v=<id> shape instead).');
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
  check('YOUTUBE_STREAM_KEY present (unattended broadcast)', !!KEY,
    KEY ? 'set' : 'MISSING — from YouTube Studio → Go Live');
  check('ingest target', !!RTMP, RTMP);
  check('ffmpeg present with RTMP output', /(^|\s)rtmp(\s|$)/.test(ffOut(['-protocols'])));
  check('libx264 encoder available', /libx264/.test(ffOut(['-encoders'])));
  check('Chrome available for the overlay screencast',
    existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe'));
  check('extractor (yt-dlp) available — the ONLY frame path exercised here',
    spawnSync('yt-dlp', ['--version'], { encoding: 'utf8' }).status === 0);

  console.log('\n── YOUTUBE REHEARSAL PREFLIGHT ──');
  for (const r of rows) console.log(` ${r.ok ? 'OK  ' : 'MISS'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log('\nNOT CHECKED HERE, and it matters more than anything above: is the broadcast '
    + 'set to ULTRA-LOW LATENCY in YouTube Studio? Normal latency (30-60s+) may sit outside '
    + 'this project\'s 60s capture window. That setting lives in the streamer\'s dashboard, '
    + 'not anywhere this script can reach.');
  const missing = rows.filter((r) => !r.ok);
  process.exit(missing.length === 0 ? 0 : 1);
}

if (!KEY && !has('skip-push')) {
  console.error('YOUTUBE_STREAM_KEY is not set. Either set it (YouTube Studio → Go Live) '
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
const dataDir = process.env.REHEARSAL_DATA_DIR || mkdtempSync(path.join(tmpdir(), 'mc-yt-'));
const srv = await startGateServer({
  port: PORT, dataDir, label: 'youtube-rehearsal',
  bountyAuth: { handles: [`youtube:${HANDLE}`] },
  env: {
    BOUNTY_CLAIM: '1', BOUNTY_IDENTITY_REAL: '0', KEEP_ORPHAN_ROOMS: 'true',
    BOUNTY_STREAM_WARMUP_MS: String(WARMUP_S * 1000),
  },
});
log(`stream-context warmup OVERRIDDEN to ${WARMUP_S}s for this rehearsal `
  + '(production is 10 minutes — do not read this pass as the production rule)');

let browser; let pusher; let screencast;
// Declared here, not inside the try block, so BOTH cleanup() (defined next,
// outside the try) and startPusher() (defined inside it) share one flag. A
// version with this scoped to the try block left cleanup() unable to see it
// at all — its pusher.kill() on a real shutdown (SIGINT, or the discovery
// timeout below) looked identical to an unexpected crash to the exit
// handler, which then scheduled a NEW push 3 seconds into a process that was
// already calling process.exit(). See cleanup() for the actual fix.
let pusherAutoRestart = false;
let pusherRestarts = 0;
const MAX_PUSHER_RESTARTS = 20;
const cleanup = async () => {
  // MUST be set before pusher.kill() below. kill() sends a signal and
  // returns immediately — the child's 'exit' event fires later, on a
  // subsequent tick — so without this the exit handler still sees
  // pusherAutoRestart=true and schedules a fresh ffmpeg 3 seconds into a
  // process that is in the middle of shutting down.
  pusherAutoRestart = false;
  if (screencast) clearInterval(screencast);
  if (pusher) { try { pusher.stdin.end(); } catch { /* */ } pusher.kill(); }
  if (browser) await browser.close().catch(() => {});
  srv.kill();
};
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

// player_client=android — see the matching comment in frame-sources.js's
// resolveMediaUrl. Without it every call here returned an opaque "We're
// experiencing technical difficulties" against a REAL, currently-live
// broadcast: this host has no JS-challenge-solver component installed for
// yt-dlp's default YouTube extraction path, and android skips that
// requirement entirely. Confirmed against a live stream before landing here.
const YT_ARGS = ['--extractor-args', 'youtube:player_client=android'];
async function resolveMediaUrlFor(watchUrl) {
  const r = spawnSync('yt-dlp', ['--no-warnings', '-g', '-f', 'best[height<=1080]/best', ...YT_ARGS, watchUrl],
    { encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}
async function resolveLiveVideoId(channel) {
  const liveUrl = /\/live\/?$/.test(channel) ? channel : `${channel.replace(/\/+$/, '')}/live`;
  const r = spawnSync('yt-dlp', ['--no-warnings', '--print', 'id', ...YT_ARGS, liveUrl],
    { encoding: 'utf8', timeout: 30_000 });
  const id = r.status === 0 ? r.stdout.trim().split('\n')[0] : null;
  return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
}

try {
  /**
   * ── ROOM-MODE OVERLAY, PUSH FIRST — the fix for a real dependency cycle ──
   *
   * The route hard-requires watchUrl to create a youtube air session, but
   * discovering the video id needs the broadcast to already be going out —
   * and an earlier version of this file ran discovery BEFORE ever starting a
   * push, so nothing was ever live for it to find. Chasing its own tail: the
   * push never started because discovery never finished, and discovery never
   * finished because the push never started.
   *
   * The fix borrows _rehearsal-pumpfun.mjs's room-mode pattern: the overlay
   * page (`?room=ytrehearsal`, no `bounty=` id yet) renders nothing until a
   * session is OPEN in that room, so it can be pointed at and pushed to the
   * platform BEFORE any air session exists. Once discovery resolves the video
   * id and the air session opens in the SAME room, the badge starts appearing
   * without the encoder ever restarting.
   */
  browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  // bountyRoom, NOT room — `room` is an unrelated overlay.html param (line
  // ~488, chat-room styling) that this could easily be confused with. Without
  // `bounty=<airId>` or `bountyRoom=<roomId>` the page's own early-return
  // (overlay.html:953, `if (!airSessionId && !bountyRoom) return;`) makes it
  // render nothing FOREVER, silently — an earlier draft of this line used
  // `room=` and would have failed exactly that way, caught before running by
  // rereading overlay.html rather than trusting the copy from the Kick/X
  // harnesses (which use `bounty=<airId>`, a param known at page-load time
  // there — not applicable here since the id does not exist yet).
  await page.goto(`${APP}/overlay?bountyRoom=ytrehearsal`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate(() => { document.body.style.background = '#00ff00'; });

  /**
   * AUTO-RECONNECTING PUSH, during discovery only.
   *
   * The first live attempt against this channel connected fine, YouTube
   * created a video id, and then the connection died on its own after ~5
   * minutes with no ffmpeg error — consistent with an UNCONFIRMED PREVIEW
   * that YouTube times out until the streamer presses Go Live in Studio. That
   * is a human action this script cannot perform, and widening the discovery
   * retry loop alone does not help if the encoder feeding it is already dead.
   * So: while still waiting to discover the video, an unexpected exit
   * restarts the push rather than ending the attempt. Capped, and turned off
   * once a real air session exists — after that point an exit is a genuine
   * problem to surface, not something to paper over.
   */
  pusherAutoRestart = !has('skip-push'); // declared outer-scope; see the note there
  function startPusher() {
    const target = ingestTarget(RTMP, KEY);
    // -re: pace at native frame rate. Skipping this on the X harness's first
    // attempt encoded 7x realtime and produced a confusing early result —
    // included from the start here.
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
    pusher.on('exit', (code) => {
      clearInterval(screencast);
      if (pusherAutoRestart && pusherRestarts < MAX_PUSHER_RESTARTS) {
        pusherRestarts += 1;
        log(`push exited unexpectedly (code ${code}) while still waiting to be discovered — `
          + `reconnecting (${pusherRestarts}/${MAX_PUSHER_RESTARTS}). If you see a live `
          + 'preview in YouTube Studio, this is the moment to press Go Live.');
        setTimeout(startPusher, 3000);
      }
    });
    log('pushing to', String(target).replace(KEY, '<key>'));
  }

  if (!has('skip-push')) {
    startPusher();
    log('RTMP push started — waiting for YouTube to make the broadcast discoverable…');
    log('If YouTube Studio shows a live preview of color bars, PRESS GO LIVE now — the '
      + 'push will keep reconnecting on its own if it drops before you do.');
  } else {
    log('--skip-push: go live yourself now with the overlay in your scene.');
  }

  if (!WATCH_URL) {
    log(`no --watch-url given — discovering the live video id from ${CHANNEL}/live …`);
    log('(this only succeeds once the broadcast is ACTUALLY live and YouTube has indexed '
      + 'it — the push above has to be running for this to ever resolve)');
    let id = null;
    // 90 attempts x 10s = 15 minutes, not 5. Unlike X (goes live the instant
    // it sees a real signal, no click required), YouTube stream-key ingest
    // typically shows a PREVIEW and needs the streamer to press Go Live in
    // Studio — a human action this script cannot perform, so the retry
    // budget has to tolerate however long that takes to notice and click.
    for (let i = 0; i < 90 && !id; i++) {
      id = await resolveLiveVideoId(CHANNEL);
      if (!id) await sleep(10_000);
    }
    if (!id) {
      log('never resolved a live video id from that channel. Stopping rather than waiting '
        + 'past this run\'s budget. Re-run once you confirm you are live, or pass '
        + '--watch-url directly if you already know it.');
      await cleanup();
      process.exit(3);
    }
    WATCH_URL = `https://www.youtube.com/watch?v=${id}`;
    log(`RESOLVED: ${WATCH_URL}`);
  }
  // Discovery is done — the broadcast is confirmed live. From here a dropped
  // push is a real fault during real clips, not a preview timeout to paper
  // over silently.
  pusherAutoRestart = false;

  // ── fan half: a pledge with a clip, so there is something to air ────────
  const pl = await post('/api/bounty/pledge', {
    targets: [{ platform: 'youtube', handle: HANDLE }],
    contributor: '0xytfan', amount: '25', expiresInMs: 86_400_000,
  }, `youtube:${HANDLE}`);
  await fetch(`${APP}${pl.body.uploadUrl}?durationS=8`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm', ...srv.headers(`youtube:${HANDLE}`) },
    body: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 5)]),
  });
  const claim = await post('/api/bounty/claim',
    { platform: 'youtube', handle: HANDLE, claimant: HANDLE }, `youtube:${HANDLE}`);
  if (!claim.body.claim) {
    console.error('[youtube-rehearsal] claim failed:', JSON.stringify(claim.body));
    await cleanup();
    process.exit(1);
  }
  // roomId MUST match the room the overlay page above already opened
  // (?room=ytrehearsal), so the running page picks up this session without
  // ever navigating again.
  const air = await post('/api/bounty/air-session',
    { claimId: claim.body.claim.id, platform: 'youtube', roomId: 'ytrehearsal', watchUrl: WATCH_URL },
    `youtube:${HANDLE}`);
  const airId = air.body.airSession?.id;
  if (!airId) {
    console.error('[youtube-rehearsal] air-session failed:', JSON.stringify(air.body));
    await cleanup();
    process.exit(1);
  }
  log(`air session ${airId} for youtube:${HANDLE} — watchUrl=${WATCH_URL} — self-capture starts with it`);
  log('waiting for the watch URL to resolve to readable media…');

  let readable = false;
  for (let i = 0; i < 24 && !readable; i++) {
    await sleep(10_000);
    readable = !!(await resolveMediaUrlFor(WATCH_URL));
    if (readable) log('MEDIA CONFIRMED — the watch URL resolves to real HLS');
  }
  if (!readable) {
    log('the watch URL never resolved to readable media. Nothing below would mean '
      + 'anything, so stopping.');
    await cleanup();
    process.exit(3);
  }

  log(`holding ${WARMUP_S}s to clear the stream-context warmup…`);
  await sleep((WARMUP_S + 5) * 1000);

  // ── air the clips ───────────────────────────────────────────────────────
  for (let i = 1; i <= CLIPS; i++) {
    const play = await post('/api/bounty/admin/playback',
      { airSessionId: airId, clipId: `YT${i}`, durationS: 30 });
    log(`playback ${i} open, code ${play.body.code?.code}`);
    await sleep(30_000);
    const end = await post('/api/bounty/admin/playback/end',
      { airSessionId: airId, clipId: `YT${i}` });
    const fz = end.body.freeze;
    log(`playback ${i} ended — ${fz?.scheduled
      ? `freeze scheduled in ${(fz.inMs / 1000).toFixed(0)}s (${fz.playbackId})`
      : 'NOT FROZEN (self-capture did not run)'}`);
    await sleep(5_000);
  }

  const holdMs = Math.max(0, MINUTES * 60_000 - (WARMUP_S + CLIPS * 35 + 20) * 1000);
  if (holdMs > 0) { log(`holding the broadcast ${Math.round(holdMs / 60_000)} more minute(s)…`); await sleep(holdMs); }

  await post(`/api/bounty/air-session/${airId}/end`, {}, `youtube:${HANDLE}`);
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
    + '(if 0, YouTube does not stamp PDT on live HLS and capture falls back to the '
    + 'frozenAt-minus-liveBroadcastDelayMs estimate — worth knowing either way)');
  const stale = frozen.filter((r) => r.stale);
  if (stale.length) log(`WARNING: ${stale.length} window(s) marked STALE by the recorder itself`);
  if (frozen.length < CLIPS) {
    log(`WARNING: ${CLIPS - frozen.length} window(s) never froze`);
  }

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

  // ── verify FROM SELF-CAPTURE ─────────────────────────────────────────────
  const v = await post(`/api/bounty/air-session/${airId}/verify`, { mode: 'real' }, `youtube:${HANDLE}`);
  const ver = v.body.verification || {};
  console.log('\n════ YOUTUBE REHEARSAL RESULT ════');
  console.log('self-capture  :', JSON.stringify({
    frameOrigin: v.body.frameOrigin ?? 'unknown',
    result: ver.result, verifiedClips: ver.verifiedClips, confidence: ver.confidence,
    detectionRate: ver.detectionRate,
    readableSamples: ver.readableSamples, unreadableSamples: ver.unreadableSamples,
    unreadableStates: ver.unreadableStates ?? null,
    sourceState: ver.sourceState ?? null,
    pixelHeights: (ver.checks || []).map((c) => c.pixelHeight),
    timeline: ver.timelineState, skewMs: ver.timelineSkewMs,
  }, null, 2));
  console.log('stream ctx   :', JSON.stringify(v.body.streamContext?.summary ?? null));
  const pool = await get(`/api/bounty/pool-view?platform=youtube&handle=${HANDLE}`);
  console.log('release(stub):', pool.body.view?.releasedContributor, 'of', pool.body.view?.totalContributed);
  console.log(`\n${distinctNote}.`);
  console.log('If verifiedClips is short of CLIPS with real pixelHeights present but codes '
    + 'outside the accepted window, re-read the note at the top of this file about latency: '
    + 'that pattern, not an absent badge, is what a too-tight capture window looks like.');
} catch (e) {
  console.error('[youtube-rehearsal] FAILED:', e?.stack || e?.message || e);
  process.exitCode = 1;
} finally {
  await cleanup();
}
