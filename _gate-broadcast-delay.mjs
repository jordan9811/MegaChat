/**
 * GATE — self-capture against a stub that LAGS, the way a real broadcast does.
 *
 * THIS IS THE TEST THE SUITE WAS MISSING. Every other stub publishes a segment
 * milliseconds after writing it, so the broadcast delay D is ~0, rung 0 of the
 * calibration ladder is correct, and freezing at playback end happens to keep
 * the right media. Real encoders run D = 12-25s behind wall clock. Two
 * separate, deterministic, production-fatal bugs lived entirely inside that
 * gap and every gate in the repo was green over both:
 *
 *   1. CAPTURE NEVER STARTED. The real order is claim -> open air session ->
 *      go live. At session open the channel is offline, the extractor says
 *      "not currently live", and the single-shot resolve gave up for good.
 *   2. THE FREEZE KEPT THE WRONG 60 SECONDS. Freezing when a clip ENDS keeps
 *      media published up to (end - D), so a clip of length L retained only
 *      L-D seconds of itself and a clip shorter than the delay retained
 *      nothing. Unrecoverable by seeking, too: reaching the missing tail needs
 *      a NEGATIVE skew and the ladder is non-negative by construction, so the
 *      right hypothesis was not in the search space.
 *
 * The stub here models the delay honestly: a segment's content is stamped when
 * it is CREATED and only appears in the playlist D later. Nothing else about
 * the pipeline is faked — real overlay, real badge, real decoder, real routes.
 *
 * Zero external network, zero spend.
 */
import http from 'http';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';
import { startGateServer } from './_gate-helpers.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORK = mkdtempSync(path.join(tmpdir(), 'mc-delay-'));
const HLS = 3410;
const APP_PORT = 3411;
const SEG_S = 2;
/** The delay the whole gate exists to model. Real is 12-25s. */
const DELAY_MS = 8_000;
const ff = (args, what) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${what}: ${r.stderr?.slice(0, 300)}`);
};

// ── the LAGGING stub stream ───────────────────────────────────────────────
// `liveAt` is when the channel starts existing at all; before that the
// playlist 404s exactly as an offline channel does. Each segment carries the
// wall clock at which its CONTENT was produced, and becomes visible only
// DELAY_MS later — which is the entire point.
const state = { liveAt: null, segments: [], playlistHits: 0 };
const visible = () => (state.liveAt === null || Date.now() < state.liveAt)
  ? [] : state.segments.filter((s) => Date.now() >= s.contentAt + DELAY_MS);

const stub = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${HLS}`);
  if (url.pathname === '/live.m3u8') {
    state.playlistHits += 1;
    if (state.liveAt === null || Date.now() < state.liveAt) {
      res.statusCode = 404; return res.end('offline');
    }
    const listed = visible();
    return res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end(
      ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEG_S}`,
        `#EXT-X-MEDIA-SEQUENCE:${Math.max(0, listed.length - 8)}`,
        ...listed.slice(-8).flatMap((s) => [`#EXTINF:${SEG_S}.0,`, s.name])].join('\n'));
  }
  const seg = state.segments.find((s) => `/${s.name}` === url.pathname);
  if (seg && existsSync(seg.file)) {
    return res.writeHead(200, { 'Content-Type': 'video/mp2t' }).end(readFileSync(seg.file));
  }
  res.statusCode = 404; res.end();
});
await new Promise((r) => stub.listen(HLS, r));

const plain = path.join(WORK, 'plain.ts');
ff(['-f', 'lavfi', '-i', `color=c=0x202024:s=1280x720:r=15:d=${SEG_S}`,
  '-c:v', 'libx264', '-b:v', '2500k', '-pix_fmt', 'yuv420p', '-f', 'mpegts', plain], 'plain');

let browser; let srv;
try {
  srv = await startGateServer({
    port: APP_PORT, label: 'broadcast-delay',
    bountyAuth: { handles: ['delaystreamer'] },
    env: {
      BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true', MODERATION_API_KEY: '',
      TWITCH_CLIENT_ID: '', TWITCH_CLIENT_SECRET: '', KICK_CLIENT_ID: '', KICK_CLIENT_SECRET: '',
      BOUNTY_CODE_ROTATE_MS: '600000', BOUNTY_CODE_VALIDITY_MS: '600000',
      BOUNTY_CAPTURE_HLS_URL: `http://localhost:${HLS}/live.m3u8`,
      BOUNTY_CAPTURE_WINDOW_MS: '40000', BOUNTY_CAPTURE_POLL_MS: '500',
      // Sized to the modelled delay, as production sizes it to the real one.
      BOUNTY_CAPTURE_FREEZE_DELAY_MS: String(DELAY_MS + 4_000),
      BOUNTY_CAPTURE_START_RETRY_MS: '120000',
      BOUNTY_CAPTURE_START_RETRY_EVERY_MS: '2000',
      BOUNTY_STREAM_WARMUP_MS: '0', BOUNTY_STREAM_TAIL_MS: '0',
    },
  });
  const APP = `http://localhost:${APP_PORT}`;
  const post = (p, body, as) => fetch(`${APP}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...srv.headers(as) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  const capDir = () => {
    const d = path.join(srv.dataDir, 'bounty-captures');
    return existsSync(d) ? readdirSync(d) : [];
  };

  // ── setup: pledge, clip, claim, air session — all while OFFLINE ─────────
  const pl = await post('/api/bounty/pledge', {
    targets: [{ platform: 'twitch', handle: 'delaystreamer' }],
    contributor: '0xdelay', amount: '40', expiresInMs: 86_400_000,
  });
  await fetch(`${APP}${pl.body.uploadUrl}?durationS=8`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm', ...srv.headers() },
    body: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2048, 5)]),
  });
  const claim = await post('/api/bounty/claim',
    { platform: 'twitch', handle: 'delaystreamer', claimant: 'd' }, 'delaystreamer');

  // THE REAL ORDER: the session opens BEFORE the channel is live.
  const hitsBefore = state.playlistHits;
  const air = await post('/api/bounty/air-session', {
    claimId: claim.body.claim.id, platform: 'twitch', roomId: 'delayroom',
  }, 'delaystreamer');
  const airId = air.body.airSession.id;
  ok('A. the air session opens while the channel is still OFFLINE (the real order)',
    air.status === 200 && !!airId);
  await sleep(4_000);
  ok('A. ...and capture KEEPS TRYING instead of giving up on the first miss',
    state.playlistHits > hitsBefore + 1,
    `${state.playlistHits - hitsBefore} resolve attempts while offline `
    + '(the single-shot version tried once and never recorded anything)');

  // ── the channel goes live ───────────────────────────────────────────────
  state.liveAt = Date.now();
  const play = await post('/api/bounty/admin/playback',
    { airSessionId: airId, clipId: 'DELAY1', durationS: 600 });
  const code = play.body.code?.code;
  ok('B. a code issued for the playback', !!code, code);

  // Render the real overlay badge.
  browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto(`${APP}/overlay?room=delayroom&bounty=${encodeURIComponent(airId)}`,
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  let drawn = false;
  for (let i = 0; i < 25 && !drawn; i++) {
    await sleep(250);
    drawn = await page.evaluate(() =>
      !!document.getElementById('bounty-badge')?.classList.contains('show')
      && (document.getElementById('bounty-matrix')?.width || 0) > 0);
  }
  await page.evaluate(() => { document.body.style.background = '#101014'; });
  const badgePng = path.join(WORK, 'badge.png');
  await page.screenshot({ path: badgePng });
  await page.close();
  ok('B. the real overlay rendered the badge', drawn);

  const badged = path.join(WORK, 'badged.ts');
  ff(['-f', 'lavfi', '-i', `color=c=0x202024:s=1920x1080:r=15:d=${SEG_S}`, '-i', badgePng,
    '-filter_complex', '[0:v][1:v]overlay=0:0,scale=1280:720',
    '-c:v', 'libx264', '-b:v', '3000k', '-pix_fmt', 'yuv420p', '-f', 'mpegts', badged], 'badged');

  // ── the clip airs: content produced NOW, visible to us DELAY_MS later ───
  const clipStart = Date.now();
  for (let i = 0; i < 8; i++) {
    state.segments.push({ name: `s${state.segments.length}.ts`, file: badged, contentAt: Date.now() });
    await sleep(400);
  }
  const clipEnd = Date.now();
  ok('C. at the moment the clip ENDS, its own tail has not been published yet',
    visible().filter((s) => s.file === badged).length < 8,
    `${visible().filter((s) => s.file === badged).length} of 8 badge segments visible at clip end `
    + `(D=${DELAY_MS}ms) — freezing here is what kept the wrong window`);

  // Keep the channel alive past the clip, as a broadcast does.
  const keepAlive = setInterval(() => {
    state.segments.push({ name: `s${state.segments.length}.ts`, file: plain, contentAt: Date.now() });
  }, 400);

  const ended = await post('/api/bounty/admin/playback/end', { airSessionId: airId, clipId: 'DELAY1' });
  ok('C. the freeze is SCHEDULED, not taken immediately',
    ended.body.freeze?.scheduled === true && ended.body.capture === null
    && ended.body.freeze.inMs >= DELAY_MS,
    `scheduled in ${ended.body.freeze?.inMs}ms — ${ended.body.freeze?.why}`);
  ok('C. ...and nothing is on disk yet, because the media has not arrived',
    capDir().length === 0, `${capDir().length} capture file(s)`);

  // ── the session closes: pending freezes must settle first ───────────────
  const t0 = Date.now();
  await post(`/api/bounty/air-session/${airId}/end`, {}, 'delaystreamer');
  clearInterval(keepAlive);
  const waited = Date.now() - t0;
  ok('D. closing the session WAITS for the scheduled freeze',
    waited >= DELAY_MS, `blocked ${Math.round(waited / 1000)}s for the delayed media`);
  const files = capDir();
  ok('D. ...and the capture landed', files.length === 1, files.join(','));

  // ── THE ASSERTION THAT MATTERS: the clip is actually IN the file ────────
  const capFile = path.join(srv.dataDir, 'bounty-captures', files[0]);
  const frames = path.join(WORK, 'frames');
  spawnSync('mkdir', ['-p', frames]);
  ff(['-fflags', '+genpts', '-i', capFile, '-vf', 'fps=1', path.join(WORK, 'f-%02d.png')], 'frames');
  const { OcrFrameChecker } = await import('./ocr-frame-checker.js');
  const checker = new OcrFrameChecker({ log: { warn() {}, log() {} } });
  let hits = 0;
  for (const f of readdirSync(WORK).filter((x) => x.startsWith('f-') && x.endsWith('.png'))) {
    const r = await checker.findCode({ ref: path.join(WORK, f) }, [code]);
    if (r.found) hits += 1;
  }
  ok('D. THE CLIP IS IN THE FROZEN CAPTURE — the badge reads back',
    hits > 0,
    `${hits} frame(s) carried ${code}. Freezing at playback end kept media up to `
    + `(end - ${DELAY_MS}ms) and read back ZERO.`);
} finally {
  if (browser) await browser.close();
  if (srv) srv.kill();
  await new Promise((r) => stub.close(r));
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
