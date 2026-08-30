/**
 * PUMP.FUN DRESS REHEARSAL — one command, one real broadcast, a real verdict.
 *
 * The sibling of _rehearsal-kick.mjs, and the platform where we have the MOST
 * discovery and the LEAST ingest. What is already proven (pumpfun-api.js,
 * measured on the wire 2026-08-26):
 *
 *   GET https://livestream-api.pump.fun/livestream?mintId=<mint>
 *
 * returns live status, viewer count, start time, creator wallet AND — via the
 * thumbnail path — the HLS master playlist, with no auth of any kind. So from
 * a bare mint we can both WATCH the stream go live and VERIFY it externally.
 * That is more than Kick gives us, where there is no VOD listing at all.
 *
 * WHAT THE API DOES NOT CARRY, and why this harness needs two arguments
 * instead of one: the endpoint is READ-ONLY. It has no ingest fields — no
 * server URL, no stream key. Those live only on the creator's own livestream
 * page and must be supplied by the operator. They are NEVER guessed here: an
 * invented ingest URL streams silently into nowhere and every check below
 * would then be measuring an empty channel.
 *
 * BOTH CAPTURE PATHS ARE EXERCISED, which no other rehearsal can do:
 *   - self-capture, the rolling buffer frozen per clip (the Kick path)
 *   - external capture, the derived master playlist (the Twitch VOD path)
 * A disagreement between them on the same broadcast is worth more than either
 * number alone, so both are reported side by side.
 *
 * Usage:
 *   node _rehearsal-pumpfun.mjs --mint <mint-or-coin-url> --preflight
 *   node _rehearsal-pumpfun.mjs --mint <mint-or-coin-url> [--minutes 12] [--clips 5]
 *   node _rehearsal-pumpfun.mjs --mint <mint-or-coin-url> --skip-push  # you go live
 *
 * Needs, and says so plainly if missing:
 *   PUMPFUN_RTMP_URL    ingest URL from your own pump.fun livestream page
 *   PUMPFUN_STREAM_KEY  the key from that same page
 * (No client id or secret: live status needs no credential of ours.)
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
const log = (...a) => console.log('[pumpfun-rehearsal]', ...a);

const { extractPumpFunMint } = await import('./frame-sources.js');
const RAW_MINT = arg('mint', null);
const MINT = extractPumpFunMint(RAW_MINT);
const WARMUP_S = Number(arg('warmup-s', 60));
const MINUTES = Math.min(15, Number(arg('minutes', 12)));
const CLIPS = Math.max(1, Number(arg('clips', 5)));
const PORT = 3309;
const APP = `http://localhost:${PORT}`;
const KEY = process.env.PUMPFUN_STREAM_KEY;
const RTMP = process.env.PUMPFUN_RTMP_URL;

if (!MINT) {
  console.error('usage: node _rehearsal-pumpfun.mjs --mint <mint-or-coin-url> '
    + '[--minutes 12] [--clips 5] [--skip-push] [--warmup-s 60] [--preflight]');
  if (RAW_MINT) {
    console.error(`\n"${RAW_MINT}" carries no pump.fun mint. Accepted forms:`);
    console.error('  https://pump.fun/coin/<mint>');
    console.error('  https://pump.fun/live/<mint>');
    console.error('  <mint>            (base58, conventionally ending in "pump")');
  }
  process.exit(1);
}

/**
 * The ingest target, PASSED THROUGH UNTOUCHED.
 *
 * The Kick harness normalises its URL because Kick runs on AWS IVS, whose
 * rtmps://<host>:443/app/<key> shape is a documented invariant. pump.fun's
 * ingest topology is NOT known to this build, so nothing is inferred: whatever
 * the operator copied is what gets pushed to, and the resolved target is
 * logged with the key redacted so a malformed one is visible immediately
 * rather than surfacing later as an empty channel.
 */
function ingestTarget(base, key) {
  const u = String(base || '').trim().replace(/\/+$/, '');
  if (!u) return null;
  // A URL that already ends in the key is used as-is: some panels hand out a
  // single combined string rather than two boxes.
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
  check('mint parsed from the argument', !!MINT, MINT);
  check('PUMPFUN_STREAM_KEY present (unattended broadcast)', !!KEY,
    KEY ? 'set' : 'MISSING — from your pump.fun livestream page');
  check('PUMPFUN_RTMP_URL present (never guessed)', !!RTMP,
    RTMP ? RTMP.replace(/\/[^/]*$/, '/…') : 'MISSING — from the same page');
  check('ffmpeg present with RTMP output', /rtmp/.test(ffOut(['-protocols'])));
  check('libx264 encoder available', /libx264/.test(ffOut(['-encoders'])));
  check('Chrome available for the overlay screencast',
    existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe'));
  check('extractor (yt-dlp) available — self-capture reads the live HLS',
    spawnSync('yt-dlp', ['--version'], { encoding: 'utf8' }).status === 0);

  const { getStreamByMint } = await import('./pumpfun-api.js');
  const info = await getStreamByMint(MINT, { log: console }).catch(() => null);
  check('livestream api reachable + mint resolvable', !!info,
    info ? `${info.live ? 'LIVE' : 'offline'}, creator ${String(info.creatorAddress).slice(0, 8)}…`
      : 'could not ask — a shape change here means "could not ask", never "not live"');
  check('playlist derivable from the thumbnail path', !!info?.playlistUrl,
    info?.playlistUrl ? 'external capture available' : 'no media directory published yet (normal when offline)');

  console.log('\n── PUMP.FUN REHEARSAL PREFLIGHT ──');
  for (const r of rows) console.log(` ${r.ok ? 'OK  ' : 'MISS'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  const missing = rows.filter((r) => !r.ok);
  console.log(missing.length === 0
    ? '\nREADY: run without --preflight to broadcast unattended.'
    : `\nNOT READY: ${missing.length} item(s) above. With a stream key absent you can still `
      + 'go live yourself and re-run with --skip-push.');
  // The playlist check is expected to miss while offline, so it alone is not fatal.
  const fatal = missing.filter((r) => !/playlist derivable/.test(r.name));
  process.exit(fatal.length === 0 ? 0 : 1);
}

if (!KEY && !has('skip-push')) {
  console.error('PUMPFUN_STREAM_KEY is not set. Either set it (your pump.fun livestream '
    + 'page) or go live yourself and re-run with --skip-push.');
  process.exit(2);
}
if (KEY && !RTMP && !has('skip-push')) {
  console.error('PUMPFUN_RTMP_URL is not set. The livestream API is READ-ONLY and carries '
    + 'no ingest fields, so this cannot be derived — copy it from your own page. '
    + 'Guessing one silently streams nowhere.');
  process.exit(2);
}

// ── the run ───────────────────────────────────────────────────────────────
const post = (p, body, as) => fetch(`${APP}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...srv.headers(as) },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (p, as) => fetch(`${APP}${p}`, { headers: srv.headers(as) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

/**
 * FAIL WHERE IT BREAKS, NOT THREE CALLS LATER. Without this a rejected pledge
 * returns 400, `body.uploadUrl` is undefined, and the run dies on
 * "Failed to parse URL from http://localhost:3309undefined?durationS=8" —
 * which says nothing about the actual cause (a 44-char base58 mint failing a
 * 40-char lowercase handle rule). The Twitch harness learned this the same way.
 */
const must = async (label, p) => {
  const r = await p;
  if (r.status >= 400) {
    throw new Error(`${label} failed ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  }
  return r;
};

const { startGateServer } = await import('./_gate-helpers.mjs');
const dataDir = process.env.REHEARSAL_DATA_DIR || mkdtempSync(path.join(tmpdir(), 'mc-pumpfun-'));
const srv = await startGateServer({
  port: PORT, dataDir, label: 'pumpfun-rehearsal',
  bountyAuth: { handles: [`pumpfun:${MINT}`] },
  // NEXT'S COLD PREPARE OUTLASTS THE DEFAULT 45s PROBE ON THIS MACHINE.
  // The server mounts every route and then sits in Next's prepare() while the
  // harness gives up and kills it — the failure reads as "never became ready"
  // with a fully healthy server log above it, which is maximally confusing.
  // A rehearsal is not a gate: the operator is LIVE and waiting while this
  // boots, so paying an extra two minutes once beats losing their broadcast.
  readyTimeoutMs: 180_000,
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

try {
  const { getStreamByMint } = await import('./pumpfun-api.js');

  // ── fan half: a pledge with a clip, so there is something to air ────────
  const pl = await must('pledge', post('/api/bounty/pledge', {
    targets: [{ platform: 'pumpfun', handle: MINT }],
    contributor: '0xpumpfan', amount: '25', expiresInMs: 86_400_000,
  }, `pumpfun:${MINT}`));
  await fetch(`${APP}${pl.body.uploadUrl}?durationS=8`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm', ...srv.headers(`pumpfun:${MINT}`) },
    body: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 5)]),
  });
  const claim = await must('claim', post('/api/bounty/claim',
    { platform: 'pumpfun', handle: MINT, claimant: MINT }, `pumpfun:${MINT}`));
  // watchUrl carries the mint so the server's live-status looker and the
  // external frame source can both resolve the stream without another argument.
  const air = await must('air-session', post('/api/bounty/air-session', {
    claimId: claim.body.claim.id, platform: 'pumpfun', roomId: 'pfrehearsal',
    watchUrl: `https://pump.fun/coin/${MINT}`,
  }, `pumpfun:${MINT}`));
  const airId = air.body.airSession.id;
  log(`air session ${airId} for pumpfun:${MINT.slice(0, 8)}… — self-capture starts with it`);

  // ── the broadcast ───────────────────────────────────────────────────────
  browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto(`${APP}/overlay?room=pfrehearsal&bounty=${encodeURIComponent(airId)}`,
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate(() => { document.body.style.background = '#00ff00'; });

  if (!has('skip-push')) {
    // Same encode profile as the Twitch and Kick rehearsals, so all three runs
    // are comparable at the same resolution.
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
    log('push started — waiting for pump.fun to report the stream live…');
  } else {
    // THE OPERATOR CANNOT ADD AN OVERLAY THEY WERE NEVER GIVEN. This said
    // "go live with the overlay in your scene" and then never printed the
    // URL, which lives on a localhost port this harness picked. --skip-push
    // is the ONLY path on a platform whose ingest key dies with the session,
    // so it has to be genuinely usable rather than nominally supported.
    // THE STABLE FORM, deliberately. ?bountyRoom follows whatever session is
    // open in the room, so this URL is pasted into OBS once and works for
    // every future run. The by-id form rots the moment a run restarts, which
    // wasted three real broadcasts and looked like a capture bug each time.
    const overlayUrl = `${APP}/overlay?bountyRoom=pfrehearsal`;
    console.log(''); console.log('='.repeat(72));
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

  /**
   * LIVE IS NOT THE SAME AS PUBLISHING, and on pump.fun the gap is real.
   *
   * MEASURED 2026-08-27: an ffmpeg push that was aborted at the TLS layer
   * ("IO error: -10053", "The specified session has been invalidated") and
   * never delivered a single frame STILL flipped isLive true within seconds,
   * with no media directory published. pump.fun's isLive tracks ingress state,
   * not content. Twitch's and Kick's do not behave this way.
   *
   * This loop used to accept `live` alone, print "playlist derived: NOT YET",
   * and carry on — a check that logged a warning instead of acting on it. It
   * then aired five clips into a stream that was publishing nothing and
   * verified 0/5, which reads exactly like a capture bug and is not one.
   *
   * A playlist is the first moment there is genuinely something to capture, so
   * that is what is waited for.
   */
  let live = null;
  let sawLiveFlag = false;
  for (let i = 0; i < 24 && !live?.playlistUrl; i++) {
    await sleep(10_000);
    live = await getStreamByMint(MINT, { log: console }).catch(() => null);
    if (live?.live && !sawLiveFlag) {
      sawLiveFlag = true;
      log(`pump.fun reports LIVE — ${live.viewerCount} viewer(s), started ${live.startedAt}`);
      log('waiting for a PUBLISHED playlist: the live flag alone does not mean media is flowing');
    }
    if (live?.playlistUrl) {
      log(`MEDIA CONFIRMED — playlist published, external capture available`);
    }
  }
  if (!live?.playlistUrl) {
    log(sawLiveFlag
      ? 'pump.fun reported the stream LIVE but published NO media within 4 minutes. The '
        + 'encoder never actually delivered frames — check the ffmpeg errors above. Airing '
        + 'clips into this would verify 0/5 and mean nothing, so stopping.'
      : 'pump.fun never reported the stream live. Nothing below would mean anything, so stopping.');
    await cleanup();
    process.exit(3);
  }

  /**
   * THE WARMUP HOLDS A BADGE ON SCREEN, and that is not decoration.
   *
   * An OBS browser source loses its JavaScript context when its server goes
   * away, and does NOT recover on its own — it stays blank until a human hits
   * Refresh. Every relaunch of this harness starts a fresh server, so every
   * relaunch silently broke the operator's overlay and the next canary
   * reported "the badge is not on your broadcast" about a scene that had been
   * correct minutes earlier. Six runs went that way.
   *
   * Airing a clip through the warmup means the badge is visible from the
   * moment this server is up, on the SAME server that will run the test. The
   * operator gets one refresh point, early, with minutes of slack — and the
   * server never restarts under them again.
   */
  /**
   * HOLD UNTIL THE OPERATOR IS ACTUALLY READY, not until a timer expires.
   *
   * Every launch of this harness starts a NEW server, which kills the OBS
   * browser source that was pointed at the old one -- and an OBS browser
   * source does not recover on its own (measured: server restored and left
   * serving for 90s, badge never returned). So the operator refreshes,
   * then the next run restarts the server and silently breaks it again.
   * That race ate six real broadcasts, and asking them to time the refresh
   * against a 4-minute warmup was never going to be reliable.
   *
   * With --wait-for-go the badge is held indefinitely on THIS server while
   * the operator refreshes and confirms it is visible. The run starts only
   * when the go-file appears, so the server never restarts underneath them.
   */
  if (has('wait-for-go')) {
    const goFile = arg('go-file', '_GO');
    log(`WAITING FOR GO: holding a badge on screen until ${goFile} exists.`);
    log('  Refresh your OBS browser source now and confirm the badge appears.');
    let n = 0;
    while (!existsSync(goFile)) {
      n += 1;
      const id = `PF_HOLD${n}`;
      await post('/api/bounty/admin/playback',
        { airSessionId: airId, clipId: id, durationS: 110 });
      const until = Date.now() + 110_000;
      while (Date.now() < until && !existsSync(goFile)) await sleep(3_000);
      await post('/api/bounty/admin/playback/end', { airSessionId: airId, clipId: id });
    }
    log('GO received — starting the run on this same server.');
  }
  log(`holding ${WARMUP_S}s to clear the stream-context warmup…`);
  log('  a badge is on screen for this whole warmup — if it is NOT in your OBS,');
  log('  hit Refresh on the browser source NOW; there is time.');
  {
    const setupDeadline = Date.now() + WARMUP_S * 1000;
    let n = 0;
    while (Date.now() < setupDeadline) {
      n += 1;
      const id = `PF_SETUP${n}`;
      await post('/api/bounty/admin/playback',
        { airSessionId: airId, clipId: id, durationS: 110 });
      const until = Math.min(setupDeadline, Date.now() + 110_000);
      while (Date.now() < until) await sleep(5_000);
      await post('/api/bounty/admin/playback/end', { airSessionId: airId, clipId: id });
    }
  }
  await sleep(5_000);

  /**
   * ── CANARY CLIP: PROVE THE OVERLAY IS ON THE REAL STREAM ────────────────
   *
   * Air ONE throwaway clip and go look for its badge in the actual broadcast
   * before committing to the full run. Costs ~40s; the run it replaces costs
   * 14 minutes of the operator's live broadcast and returns a guaranteed
   * zero.
   *
   * WHY THIS EXISTS. A pump.fun run verified 0/5 with SOURCE_UNAVAILABLE on
   * both paths, and the frames turned out to be COMPLETELY BLACK — the
   * operator's browser source was still pointed at a PREVIOUS session whose
   * server had been killed, so the overlay had nothing to poll and rendered
   * nothing at all. Every server-side signal looked perfect: codes issued and
   * rotating, playlist published, media confirmed. Nothing in the pipeline
   * can tell "the overlay is not in the scene" apart from "capture is
   * broken" — except looking at the picture.
   *
   * THE CANARY MUST BE ITS OWN CLIP, not a peek at a real one: a real clip
   * consumed by a failed check is a clip that cannot be re-aired for the
   * actual run, and its codes are already burned.
   */
  {
    log('canary: airing one throwaway clip to prove the overlay is really on the stream…');
    const canary = await must('canary playback', post('/api/bounty/admin/playback',
      { airSessionId: airId, clipId: 'PF_CANARY', durationS: 20 }));
    const canaryCode = canary.body.code?.code;
    log(`canary: code ${canaryCode} on air — waiting for it to reach the public stream`);
    await sleep(20_000);
    await post('/api/bounty/admin/playback/end', { airSessionId: airId, clipId: 'PF_CANARY' });
    // Let the segment carrying it get packaged and published.
    await sleep(25_000);

    const { PumpFunFrameSource } = await import('./frame-sources.js');
    const { OcrFrameChecker } = await import('./ocr-frame-checker.js');
    const probeSrc = new PumpFunFrameSource({ log: { warn() {}, log() {} }, mint: MINT });
    const probeChecker = new OcrFrameChecker({ log: { warn() {}, log() {} } });
    // Read the store on disk: there is no GET route for a whole air session
    // (only /code), and the harness owns dataDir anyway.
    const storeNow = JSON.parse(readFileSync(`${dataDir}/bounty.json`, 'utf8'));
    const sess = Object.values(storeNow.airSessions || {}).find((x) => x.id === airId);
    const cwin = (sess?.playbackWindows || []).find((w) => w.clipId === 'PF_CANARY');
    let seen = false; let sawAnything = false;
    if (cwin?.codes?.length) {
      /**
       * SWEEP THE BROADCAST DELAY — DO NOT ASSUME IT IS ZERO.
       *
       * The first version of this sampled each code at its own issue time and
       * declared the overlay missing. It was wrong, and it was wrong in the
       * project's most expensive way: it told an operator whose setup was
       * PERFECT that their stream had no badge on it.
       *
       * PROGRAM-DATE-TIME marks when a segment was PACKAGED; the overlay
       * rendered the code one broadcast delay earlier. Sampling at issue time
       * therefore lands D seconds BEFORE the clip started — on black. Measured
       * on this stream: the badge is present at D = 10-20s and invisible at
       * D = 0-5s. That is the same mistake as the PDT-anchor bug that cost
       * three Kick broadcasts, reproduced in the very check written to stop
       * broadcasts being wasted.
       *
       * Verification proper MEASURES this delay through calibration. A canary
       * cannot: it has one clip and no budget for a probe ladder. So it sweeps
       * a generous range and asks only the binary question it exists to
       * answer — is the badge on the stream AT ALL?
       */
      const SWEEP_MS = [0, 5_000, 10_000, 15_000, 20_000, 25_000, 30_000, 40_000];
      outer:
      for (const c of cwin.codes) {
        for (const d of SWEEP_MS) {
          const ts = Math.floor((c.issuedAt + c.expiresAt) / 2) + d;
          try {
            const fr = await probeSrc.getFrames('pumpfun', MINT, [{ ts, clipId: 'PF_CANARY', playbackId: cwin.playbackId }]);
            if (!fr?.[0]) continue;
            const res = await probeChecker.findCode(fr[0], cwin.codes.map((x) => x.code));
            if (Number(res.pixelHeight) > 0) sawAnything = true;
            if (res.found) {
              seen = true;
              log(`canary: FOUND ${res.text || res.code} on the live stream at ${res.pixelHeight}px `
                + `(broadcast delay ~${d / 1000}s)`);
              break outer;
            }
          } catch { /* try the next offset */ }
        }
      }
    }
    if (!seen) {
      log('');
      log('CANARY FAILED — the badge is NOT visible on your broadcast.');
      log(sawAnything
        ? '  Something was decoded but it was not this session\'s code, so the overlay is'
        + ' probably pointed at an OLD session. Update the browser source URL to:'
        : '  Nothing was on screen at all. The overlay is not rendering — check the browser'
        + ' source URL, that it is not hidden, and that it is above your other sources:');
      log(`  ${APP}/overlay?bountyRoom=pfrehearsal`);
      log('');
      log('Stopping rather than burning your broadcast on a run that cannot pass.');
      await cleanup();
      process.exit(4);
    }
    log('canary: PASSED — the overlay is live on the real stream. Starting the real clips.');
  }

  // ── air the clips ───────────────────────────────────────────────────────
  for (let i = 1; i <= CLIPS; i++) {
    const play = await post('/api/bounty/admin/playback',
      { airSessionId: airId, clipId: `PF${i}`, durationS: 30 });
    log(`playback ${i} open, code ${play.body.code?.code}`);
    await sleep(30_000);
    const end = await post('/api/bounty/admin/playback/end',
      { airSessionId: airId, clipId: `PF${i}` });
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

  await post(`/api/bounty/air-session/${airId}/end`, {}, `pumpfun:${MINT}`);
  if (pusher) { clearInterval(screencast); try { pusher.stdin.end(); } catch { /* */ } pusher.kill(); }
  log('stream ended.');

  // Session end awaits every pending freeze, so the CAPTURE_FROZEN rows are
  // final here and a count short of CLIPS is a real fault, not a race.
  const frozen = readFileSync(`${dataDir}/bounty-evidence.jsonl`, 'utf8')
    .split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.type === 'CAPTURE_FROZEN' && r.airSessionId === airId);
  log(`self-capture froze ${frozen.length}/${CLIPS} window(s)`
    + (frozen.length ? ` — ${(frozen.reduce((a, r) => a + (r.bytes || 0), 0) / 1e6).toFixed(1)}MB total` : ''));
  const pdt = frozen.filter((r) => Number.isFinite(r.firstPdtMs)).length;
  log(`PROGRAM-DATE-TIME present on ${pdt}/${frozen.length} frozen window(s)`
    + ' — the anchor, not a calibration bypass');
  if (frozen.length < CLIPS) {
    log(`WARNING: ${CLIPS - frozen.length} window(s) never froze — verification below is `
      + 'running on less evidence than the broadcast produced');
  }

  // ── verify BOTH WAYS: the whole point of running this on pump.fun ───────
  const show = (label, ver, origin) => {
    console.log(`${label} :`, JSON.stringify({
      frameOrigin: origin ?? 'unknown',
      result: ver.result, verifiedClips: ver.verifiedClips,
      confidence: ver.confidence, detectionRate: ver.detectionRate,
      sourceState: ver.sourceState ?? null,
      pixelHeights: (ver.checks || []).map((c) => c.pixelHeight),
      timeline: ver.timelineState, skewMs: ver.timelineSkewMs,
    }, null, 2));
  };

  // The second opinion MUST name a sourceMode. `preferCapture: false` reads as
  // "use the other source" and does nothing at all: the route decides from
  // `req.body.sourceMode` alone (bounty-routes.js), so this asked the same
  // question twice and printed the identical answer in two columns under the
  // caption "two independent captures". `sourceMode: 'vod'` is what actually
  // forces the archive read — the same thing the Rumble harness does.
  const vSelf = await post(`/api/bounty/air-session/${airId}/verify`,
    { mode: 'real' }, `pumpfun:${MINT}`);
  const vExt = await post(`/api/bounty/air-session/${airId}/verify`,
    { mode: 'real', sourceMode: 'vod' }, `pumpfun:${MINT}`);

  console.log('\n════ PUMP.FUN REHEARSAL RESULT ════');
  show('self-capture ', vSelf.body.verification || {}, vSelf.body.frameOrigin);
  show('external     ', vExt.body.verification || {}, vExt.body.frameOrigin);
  console.log('stream ctx   :', JSON.stringify(vSelf.body.streamContext?.summary ?? null));
  const pool = await get(`/api/bounty/pool-view?platform=pumpfun&handle=${MINT}`);
  console.log('release(stub):', pool.body.view?.releasedContributor, 'of', pool.body.view?.totalContributed);
  // Only claim a cross-check if the two columns genuinely came from different
  // frames. Printing this unconditionally is how a duplicated verification got
  // reported as corroborating evidence.
  const oSelf = vSelf.body.frameOrigin;
  const oExt = vExt.body.frameOrigin;
  if (oSelf && oExt && oSelf !== oExt) {
    console.log(`\nTwo independent reads of ONE broadcast (${oSelf} vs ${oExt}). A disagreement `
      + 'between them is worth more than either number alone — report it before the totals.');
  } else {
    console.log(`\nNOT a cross-check: both columns read ${oSelf || 'unknown'} frames`
      + `${oSelf === 'external' ? ' (self-capture froze nothing to read)' : ''}. `
      + 'These two numbers corroborate nothing — they are one result printed twice.');
  }
  console.log('Compare against the corpus and the other real encoders: corpus 720p 100%, '
    + 'Twitch 4/5, Kick 5/5 (after the PDT-anchor fix).');
} catch (e) {
  console.error('[pumpfun-rehearsal] FAILED:', e?.stack || e?.message || e);
  process.exitCode = 1;
} finally {
  await cleanup();
}
