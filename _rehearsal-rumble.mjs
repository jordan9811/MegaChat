/**
 * RUMBLE DRESS REHEARSAL — one command, one real broadcast, a real verdict.
 *
 * Sibling of _rehearsal-kick.mjs and _rehearsal-pumpfun.mjs.
 *
 * WHAT IS ALREADY PROVEN about Rumble, and what is not. The ingest works: an
 * earlier run pushed to the API-supplied credentials and the channel went
 * live. What has NEVER been exercised is everything after that — no clip has
 * been aired on Rumble, no frame captured, nothing verified.
 *
 * A WARNING THAT COST US ONCE ALREADY: rumble-api.js's live-status response
 * embeds the channel's INGEST CREDENTIALS (`server_url`, `stream_key`) in
 * plaintext. They are stripped before the value leaves that module and its
 * catch clause reports `e?.name` rather than `e.message`, because a fetch
 * failure can embed the URL — which IS the credential. Do not widen either.
 *
 * BOTH CAPTURE PATHS, like pump.fun: Rumble has a public watch page, so the
 * external source can seek it directly, and self-capture records the same
 * broadcast independently. They are reported side by side — a disagreement
 * between two captures of one broadcast is worth more than either number.
 *
 * Usage:
 *   node _rehearsal-rumble.mjs --preflight
 *   node _rehearsal-rumble.mjs [--minutes 12] [--clips 5]
 *   node _rehearsal-rumble.mjs --skip-push          # you go live yourself
 *
 * Needs, and says so plainly if missing:
 *   RUMBLE_RTMP_URL     ingest URL (rtmp://rtmp.rumble.com/live)
 *   RUMBLE_STREAM_KEY   the key for THIS scheduled stream
 *   RUMBLE_WATCH_URL    the public rumble.com/v… page for it
 */
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';

try { process.loadEnvFile('.env'); } catch { /* env may be injected */ }

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[rumble-rehearsal]', ...a);

const HANDLE = arg('handle', 'jordandotfun');
const WARMUP_S = Number(arg('warmup-s', 60));
const MINUTES = Math.min(15, Number(arg('minutes', 12)));
const CLIPS = Math.max(1, Number(arg('clips', 5)));
const PORT = 3310;
const APP = `http://localhost:${PORT}`;
const KEY = process.env.RUMBLE_STREAM_KEY;
const RTMP = process.env.RUMBLE_RTMP_URL;
const WATCH = process.env.RUMBLE_WATCH_URL;

/**
 * Plain RTMP, and the key simply appends. Unlike Kick — which rides AWS IVS
 * and needs :443/app/ filled in — Rumble hands out a complete application URL
 * (rtmp://rtmp.rumble.com/live), so nothing is inferred here. A URL that
 * already ends in the key is passed through, since some panels hand out one
 * combined string rather than two boxes.
 */
function ingestTarget(base, key) {
  const u = String(base || '').trim().replace(/\/+$/, '');
  if (!u) return null;
  return key && !u.endsWith(key) ? `${u}/${key}` : u;
}

// ── preflight ─────────────────────────────────────────────────────────────
if (has('preflight')) {
  const rows = [];
  const check = (name, okv, detail = '') => rows.push({ name, ok: !!okv, detail });
  const ffOut = (args) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', ...args], { encoding: 'utf8' });
    return r.error ? '' : `${r.stdout || ''}${r.stderr || ''}`;
  };
  check('RUMBLE_STREAM_KEY present', !!KEY, KEY ? 'set' : 'MISSING — from your Rumble studio');
  check('RUMBLE_RTMP_URL present', !!RTMP, RTMP || 'MISSING');
  check('RUMBLE_WATCH_URL present (external capture needs the public page)', !!WATCH,
    WATCH || 'MISSING — the rumble.com/v… link from your address bar');
  check('ffmpeg present with RTMP output', /rtmp/.test(ffOut(['-protocols'])));
  check('libx264 encoder available', /libx264/.test(ffOut(['-encoders'])));
  check('Chrome available for the overlay screencast',
    existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe'));
  check('extractor (yt-dlp) available — self-capture reads the live HLS',
    spawnSync('yt-dlp', ['--version'], { encoding: 'utf8' }).status === 0);

  const { rumbleApiConfigured, getRumbleLiveStatus } = await import('./rumble-api.js');
  check('Rumble live-status API configured', rumbleApiConfigured(),
    rumbleApiConfigured() ? 'RUMBLE_LIVESTREAM_API_URL set' : 'MISSING RUMBLE_LIVESTREAM_API_URL');
  if (rumbleApiConfigured()) {
    const st = await getRumbleLiveStatus({ log: console }).catch(() => null);
    check('Rumble API reachable', !!st,
      st ? `${st.live ? 'LIVE' : 'offline'}${st.title ? ` — ${st.title}` : ''}`
        : 'could not ask — a shape change means "could not ask", never "not live"');
  }

  console.log('\n── RUMBLE REHEARSAL PREFLIGHT ──');
  for (const r of rows) console.log(` ${r.ok ? 'OK  ' : 'MISS'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  const missing = rows.filter((r) => !r.ok);
  console.log(missing.length === 0
    ? '\nREADY: run without --preflight to broadcast unattended.'
    : `\nNOT READY: ${missing.length} item(s) above.`);
  process.exit(missing.length === 0 ? 0 : 1);
}

if (!KEY && !has('skip-push')) {
  console.error('RUMBLE_STREAM_KEY is not set. Set it from your Rumble studio, or go live '
    + 'yourself and re-run with --skip-push.');
  process.exit(2);
}
if (!WATCH) {
  console.error('RUMBLE_WATCH_URL is not set. Rumble has no API to discover the public watch '
    + 'page, so it must be copied from the address bar while the stream is live. Without it '
    + 'external verification has no address to seek and only self-capture can run.');
  process.exit(2);
}

// ── the run ───────────────────────────────────────────────────────────────
const post = (p, body, as) => fetch(`${APP}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...srv.headers(as) },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (p, as) => fetch(`${APP}${p}`, { headers: srv.headers(as) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

/** Fail where it breaks, not three calls later. See _rehearsal-pumpfun.mjs. */
const must = async (label, p) => {
  const r = await p;
  if (r.status >= 400) {
    throw new Error(`${label} failed ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  }
  return r;
};

const { startGateServer } = await import('./_gate-helpers.mjs');
const dataDir = process.env.REHEARSAL_DATA_DIR || mkdtempSync(path.join(tmpdir(), 'mc-rumble-'));
const srv = await startGateServer({
  port: PORT, dataDir, label: 'rumble-rehearsal',
  bountyAuth: { handles: [`rumble:${HANDLE}`] },
  env: {
    BOUNTY_CLAIM: '1', BOUNTY_IDENTITY_REAL: '0', KEEP_ORPHAN_ROOMS: 'true',
    RUMBLE_LIVESTREAM_API_URL: process.env.RUMBLE_LIVESTREAM_API_URL || '',
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
  const { getRumbleLiveStatus } = await import('./rumble-api.js');

  // ── fan half: a pledge with a clip, so there is something to air ────────
  const AS = `rumble:${HANDLE}`;
  const pl = await must('pledge', post('/api/bounty/pledge', {
    targets: [{ platform: 'rumble', handle: HANDLE }],
    contributor: '0xrumblefan', amount: '25', expiresInMs: 86_400_000,
  }, AS));
  await fetch(`${APP}${pl.body.uploadUrl}?durationS=8`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm', ...srv.headers(AS) },
    body: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 5)]),
  });
  const claim = await must('claim', post('/api/bounty/claim',
    { platform: 'rumble', handle: HANDLE, claimant: HANDLE }, AS));
  const air = await must('air-session', post('/api/bounty/air-session', {
    claimId: claim.body.claim.id, roomId: 'rumblerehearsal', watchUrl: WATCH,
  }, AS));
  const airId = air.body.airSession.id;
  log(`air session ${airId} for rumble:${HANDLE} — self-capture starts with it`);

  // ── the broadcast ───────────────────────────────────────────────────────
  browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto(`${APP}/overlay?room=rumblerehearsal&bounty=${encodeURIComponent(airId)}`,
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate(() => { document.body.style.background = '#00ff00'; });

  if (!has('skip-push')) {
    // Same encode profile as the Twitch, Kick and pump.fun rehearsals, so all
    // four runs are comparable at the same resolution.
    const target = ingestTarget(RTMP, KEY);
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
      '-f', 'flv', target,
    ], { stdio: ['pipe', 'ignore', 'inherit'] });
    screencast = setInterval(async () => {
      try {
        const png = await page.screenshot({ type: 'png' });
        if (pusher.stdin.writable) pusher.stdin.write(png);
      } catch { /* frame dropped */ }
    }, 500);
    pusher.on('exit', () => clearInterval(screencast));
    log('pushing to', KEY ? String(target).replace(KEY, '<key>') : String(target));
    log('RTMP push started — waiting for Rumble to report the channel live…');
  } else {
    // THE OPERATOR CANNOT ADD AN OVERLAY THEY WERE NEVER GIVEN. This said
    // "go live with the overlay in your scene" and then never printed the
    // URL, which lives on a localhost port this harness picked. --skip-push
    // is the ONLY path on a platform whose ingest key dies with the session,
    // so it has to be genuinely usable rather than nominally supported.
    const overlayUrl = `${APP}/overlay?room=rumblerehearsal&bounty=${encodeURIComponent(airId)}`;
    BROKEN1
    console.log('  ADD THIS AS A BROWSER SOURCE IN OBS, THEN GO LIVE:');
    console.log('');
    console.log('    ' + overlayUrl);
    console.log('');
    console.log('    Width 1280,  Height 720');
    console.log('    Put it ON TOP of your other sources so the badge is not covered.');
    console.log('    The badge must stay fully visible — it is what proves the clip aired.');
    console.log('='.repeat(72) + String.fromCharCode(10));
    log('waiting for you to go live…');
  }

  let live = null;
  for (let i = 0; i < 24 && !live?.live; i++) {
    await sleep(10_000);
    live = await getRumbleLiveStatus({ log: console }).catch(() => null);
    if (live?.live) {
      log(`LIVE confirmed by Rumble — ${live.viewerCount} viewer(s)`
        + `${live.title ? `, "${live.title}"` : ''}`);
    }
  }
  if (!live?.live) {
    log('Rumble never reported the channel live. Nothing below would mean anything, so stopping.');
    await cleanup();
    process.exit(3);
  }

  log(`holding ${WARMUP_S}s to clear the stream-context warmup…`);
  await sleep((WARMUP_S + 5) * 1000);

  // ── air the clips ───────────────────────────────────────────────────────
  for (let i = 1; i <= CLIPS; i++) {
    const play = await post('/api/bounty/admin/playback',
      { airSessionId: airId, clipId: `RUM${i}`, durationS: 30 });
    log(`playback ${i} open, code ${play.body.code?.code}`);
    await sleep(30_000);
    const end = await post('/api/bounty/admin/playback/end',
      { airSessionId: airId, clipId: `RUM${i}` });
    const fz = end.body.freeze;
    log(`playback ${i} ended — capture ${end.body.capture
      ? `${(end.body.capture.bytes / 1e6).toFixed(1)}MB / ${end.body.capture.spanMs}ms`
      : fz?.scheduled
        ? `freeze scheduled in ${(fz.inMs / 1000).toFixed(0)}s (${fz.playbackId})`
        : 'NOT FROZEN (self-capture did not run)'}`);
    await sleep(5_000);
  }

  const holdMs = Math.max(0, MINUTES * 60_000 - (WARMUP_S + CLIPS * 35 + 20) * 1000);
  if (holdMs > 0) { log(`holding the broadcast ${Math.round(holdMs / 60_000)} more minute(s)…`); await sleep(holdMs); }

  await post(`/api/bounty/air-session/${airId}/end`, {}, AS);
  if (pusher) { clearInterval(screencast); try { pusher.stdin.end(); } catch { /* */ } pusher.kill(); }
  log('stream ended.');

  // Session end awaits every pending freeze, so a count short of CLIPS here is
  // a real fault rather than a race.
  const frozen = readFileSync(`${dataDir}/bounty-evidence.jsonl`, 'utf8')
    .split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.type === 'CAPTURE_FROZEN' && r.airSessionId === airId);
  log(`self-capture froze ${frozen.length}/${CLIPS} window(s)`
    + (frozen.length ? ` — ${(frozen.reduce((a, r) => a + (r.bytes || 0), 0) / 1e6).toFixed(1)}MB total` : ''));
  const pdt = frozen.filter((r) => Number.isFinite(r.firstPdtMs)).length;
  log(`PROGRAM-DATE-TIME present on ${pdt}/${frozen.length} frozen window(s)`
    + ' — reported, never assumed: Kick was believed to stamp none and stamps every segment');
  if (frozen.length < CLIPS) {
    log(`WARNING: ${CLIPS - frozen.length} window(s) never froze — verification below is `
      + 'running on less evidence than the broadcast produced');
  }

  // ── verify BOTH WAYS ────────────────────────────────────────────────────
  const show = (label, ver) => {
    console.log(`${label} :`, JSON.stringify({
      result: ver.result, verifiedClips: ver.verifiedClips,
      confidence: ver.confidence, detectionRate: ver.detectionRate,
      sourceState: ver.sourceState ?? null,
      pixelHeights: (ver.checks || []).map((c) => c.pixelHeight),
      timeline: ver.timelineState, skewMs: ver.timelineSkewMs,
    }, null, 2));
  };

  const vSelf = await post(`/api/bounty/air-session/${airId}/verify`, { mode: 'real' }, AS);
  const vExt = await post(`/api/bounty/air-session/${airId}/verify`,
    { mode: 'real', sourceMode: 'vod' }, AS);

  console.log('\n════ RUMBLE REHEARSAL RESULT ════');
  show('self-capture ', vSelf.body.verification || {});
  show('external     ', vExt.body.verification || {});
  console.log('stream ctx   :', JSON.stringify(vSelf.body.streamContext?.summary ?? null));
  const pool = await get(`/api/bounty/pool-view?platform=rumble&handle=${HANDLE}`);
  console.log('release(stub):', pool.body.view?.releasedContributor, 'of', pool.body.view?.totalContributed);
  console.log('\nCompare against the other real encoders at 720p: corpus 100%, '
    + 'Twitch 4/5, Kick 5/5 (after the PDT-anchor fix).');
} catch (e) {
  console.error('[rumble-rehearsal] FAILED:', e?.stack || e?.message || e);
  process.exitCode = 1;
} finally {
  await cleanup();
}
