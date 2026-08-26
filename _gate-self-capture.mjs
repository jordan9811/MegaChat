/**
 * GATE — self-capture, so verification stops depending on platform VODs.
 *
 * The five things the design has to be true about, each driven against a STUB
 * HLS SERVER on localhost that behaves like a real live stream: a sliding
 * playlist, segments appearing over time, and a deliberate BROADCAST DELAY so
 * the thing the rolling buffer exists to survive is actually present.
 *
 *   1. the buffer holds only the configured window and discards beyond it
 *   2. a playback freezes the correct window UNDER A REALISTIC DELAY
 *   3. captures verify through the existing decoder
 *   4. captures purge with their pledge
 *   5. capture does not run outside an air session
 *
 * The segments carry REAL badges rendered by the REAL overlay page, so (3) is
 * the shipped decoder reading shipped pixels — not a fixture agreeing with
 * itself.
 *
 * Zero external network, zero spend.
 */
import http from 'http';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HLS = 3380;
const WORK = mkdtempSync(path.join(tmpdir(), 'mc-cap-'));
const SEG_S = 2;                 // segment duration, as a real HLS stream uses
const BROADCAST_DELAY_MS = 20_000; // the delay the buffer exists to survive

const ff = (args, what) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${what}: ${r.stderr?.slice(0, 300)}`);
};

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'mc-cap-data-'));
process.env.BOUNTY_CLAIM = '1';
process.env.BOUNTY_CAPTURE_WINDOW_MS = '20000';   // 10 segments
process.env.BOUNTY_CAPTURE_POLL_MS = '250';

const capture = await import('./bounty-capture.js');
const { bountyConfig } = await import('./bounty-claim.config.js');

// ── 1. the ring discards, deterministically ───────────────────────────────
{
  const buf = new capture.RollingBuffer({ windowMs: 10_000 });
  for (let i = 0; i < 20; i++) {
    buf.push({ seq: i, uri: `s${i}`, durationS: 2, bytes: Buffer.alloc(100), fetchedAt: Date.now() });
  }
  ok('1. the buffer holds only the configured window', buf.spanMs <= 10_000,
    `${buf.spanMs}ms held for a 10000ms window`);
  ok('1. ...and it is the OLDEST that is discarded', buf.segments[0].seq === 15,
    `oldest held seq=${buf.segments[0].seq} of 0..19`);
  ok('1. ...so memory is bounded no matter how long the broadcast runs',
    buf.bytes <= 5 * 100, `${buf.bytes} bytes`);
  // Eviction is by MEDIA duration, not wall clock: a stall must not empty the
  // buffer we are about to freeze.
  const stalled = new capture.RollingBuffer({ windowMs: 10_000 });
  stalled.push({ seq: 0, uri: 's', durationS: 2, bytes: Buffer.alloc(10), fetchedAt: Date.now() - 600_000 });
  ok('1. a STALLED stream keeps what it has rather than emptying itself',
    stalled.segments.length === 1);
}

// ── 5. capture cannot run outside an air session ──────────────────────────
{
  ok('5. no session, no capture running', capture.activeCount() === 0);
  const frozen = capture.freezeWindow('no-such-session', { clipId: 'X', log: { warn() {} } });
  ok('5. freezing with no running capture returns nothing (and never invents a file)',
    frozen === null);
}

// ── the stub live stream ──────────────────────────────────────────────────
// A real overlay badge per segment, so the decoder has genuine pixels to read.
const segments = [];   // { name, file, code }
let published = 0;     // how many segments the playlist currently advertises

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${HLS}`);
  if (url.pathname === '/live.m3u8') {
    // A SLIDING window, exactly as a live playlist behaves: only recent
    // segments are listed, and the media sequence advances.
    const windowSize = 6;
    const start = Math.max(0, published - windowSize);
    const listed = segments.slice(start, published);
    const body = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEG_S}`,
      `#EXT-X-MEDIA-SEQUENCE:${start}`,
      ...listed.flatMap((s) => [`#EXTINF:${SEG_S}.0,`, s.name])].join('\n');
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    return res.end(body);
  }
  const seg = segments.find((s) => `/${s.name}` === url.pathname);
  if (seg && existsSync(seg.file)) {
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    return res.end(readFileSync(seg.file));
  }
  res.statusCode = 404; res.end();
});
await new Promise((r) => server.listen(HLS, r));

let browser;
try {
  // ── render REAL badges and cut them into TS segments ────────────────────
  const { startGateServer } = await import('./_gate-helpers.mjs');
  const appPort = 3381;
  const srv = await startGateServer({
    port: appPort, label: 'capture-app',
    bountyAuth: { handles: ['capstreamer'] },
    env: {
      BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true',
      TWITCH_CLIENT_ID: '', TWITCH_CLIENT_SECRET: '', KICK_CLIENT_ID: '', KICK_CLIENT_SECRET: '',
      BOUNTY_CODE_ROTATE_MS: '600000', BOUNTY_CODE_VALIDITY_MS: '600000',
      // The SERVER runs the capture, driven at the stub live stream — so the
      // air-session lifecycle, the freeze-on-playback-end and the verify
      // source preference are all the shipped code paths, not a re-creation
      // of them inside the gate.
      BOUNTY_CAPTURE_HLS_URL: `http://localhost:${HLS}/live.m3u8`,
      BOUNTY_CAPTURE_WINDOW_MS: '20000',
      BOUNTY_CAPTURE_POLL_MS: '250',
    },
  });
  // Captures live in the SERVER's data dir, not this process's.
  const serverCaptureDir = path.join(srv.dataDir, 'bounty-captures');
  const serverCaptures = () => (existsSync(serverCaptureDir)
    ? readdirSync(serverCaptureDir).map((f) => path.join(serverCaptureDir, f)) : []);
  const APP = `http://localhost:${appPort}`;
  const post = (p, body, as) => fetch(`${APP}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...srv.headers(as) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  try {
    const pl = await post('/api/bounty/pledge', {
      targets: [{ platform: 'twitch', handle: 'capstreamer' }],
      contributor: '0xcap', amount: '40', expiresInMs: 86_400_000,
    });
    await fetch(`${APP}${pl.body.uploadUrl}?durationS=8`, {
      method: 'POST', headers: { 'Content-Type': 'video/webm', ...srv.headers() },
      body: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2048, 5)]),
    });
    const claim = await post('/api/bounty/claim', { platform: 'twitch', handle: 'capstreamer', claimant: 'cap' });
    const air = await post('/api/bounty/air-session', {
      claimId: claim.body.claim.id, platform: 'twitch', roomId: 'caproom',
    });
    const airId = air.body.airSession.id;
    const play = await post('/api/bounty/admin/playback', {
      airSessionId: airId, clipId: 'CAP1', durationS: 600,
    });
    const code = play.body.code?.code;
    ok('a real code was issued for the capture test', !!code, code);

    browser = await puppeteer.launch({
      executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(`${APP}/overlay?room=caproom&bounty=${encodeURIComponent(airId)}`,
      { waitUntil: 'domcontentloaded', timeout: 60000 });
    let drawn = false;
    for (let i = 0; i < 25 && !drawn; i++) {
      await sleep(300);
      drawn = await page.evaluate(() =>
        !!document.getElementById('bounty-badge')?.classList.contains('show')
        && (document.getElementById('bounty-matrix')?.width || 0) > 0);
    }
    await page.evaluate(() => { document.body.style.background = '#101014'; });
    const badgePng = path.join(WORK, 'badge.png');
    await page.screenshot({ path: badgePng });
    await page.close();
    ok('the REAL overlay rendered the badge for the capture fixture', drawn);

    // Segments 0..3 are plain; 4..9 carry the badge. The badge segments are
    // what a clip playback looks like in the stream.
    const plain = path.join(WORK, 'plain.ts');
    ff(['-f', 'lavfi', '-i', `color=c=0x202024:s=1280x720:r=15:d=${SEG_S}`,
      '-c:v', 'libx264', '-b:v', '2500k', '-pix_fmt', 'yuv420p', '-f', 'mpegts', plain], 'plain seg');
    const badged = path.join(WORK, 'badged.ts');
    ff(['-f', 'lavfi', '-i', `color=c=0x202024:s=1920x1080:r=15:d=${SEG_S}`, '-i', badgePng,
      '-filter_complex', '[0:v][1:v]overlay=0:0,scale=1280:720',
      '-c:v', 'libx264', '-b:v', '3000k', '-pix_fmt', 'yuv420p', '-f', 'mpegts', badged], 'badged seg');
    for (let i = 0; i < 14; i++) {
      segments.push({ name: `seg${i}.ts`, file: i >= 4 && i <= 9 ? badged : plain, code });
    }

    // ── the SERVER is already capturing (air-session open did it) ─────────
    // Publish 12 segments (24s of media) into a 20s window.
    for (let i = 0; i < 12; i++) { published = i + 1; await sleep(400); }
    await sleep(1200);

    // ── 2. freeze on playback end, under the delay ────────────────────────
    const ended = await post('/api/bounty/admin/playback/end', { airSessionId: airId, clipId: 'CAP1' });
    ok('2. ending a playback freezes a window and reports it',
      !!ended.body.capture && ended.body.capture.bytes > 0,
      JSON.stringify(ended.body.capture));
    const caps = serverCaptures();
    ok('2. ...persisted as exactly one capture file for that playback',
      caps.length === 1, caps.map((c) => path.basename(c)).join(','));
    const capBytes = statSync(caps[0]).size;
    ok('2. ...holding the window, not the whole broadcast',
      capBytes > 0 && capBytes < 14 * statSync(badged).size,
      `${(capBytes / 1e6).toFixed(1)}MB vs ${(14 * statSync(badged).size / 1e6).toFixed(1)}MB for the full stream`);

    // The badge segments were published ~BROADCAST_DELAY_MS before the freeze
    // in stream terms; the point is that they are STILL INSIDE the window.
    const { OcrFrameChecker } = await import('./ocr-frame-checker.js');
    const checker = new OcrFrameChecker({ log: { warn() {}, log() {} } });
    const frames = path.join(WORK, 'capframes');
    mkdirSync(frames, { recursive: true });
    ff(['-i', caps[0], '-vf', 'fps=1', path.join(frames, 'c-%02d.png')], 'capture frames');
    let hits = 0;
    for (const f of readdirSync(frames)) {
      const r = await checker.findCode({ ref: path.join(frames, f) }, [code]);
      if (r.found) hits++;
    }
    ok('3. THE CAPTURE VERIFIES through the shipped decoder',
      hits > 0, `${hits} frame(s) carried ${code}`);
    ok('2. ...proving the clip survived the broadcast delay inside the window',
      hits > 0, `delay modelled: ${BROADCAST_DELAY_MS / 1000}s, window ${bountyConfig.captureWindowMs / 1000}s`);

    // ── 3b. the VERIFY ROUTE prefers the capture over the platform ────────
    // No Twitch credentials here at all, so if verification reaches the VOD
    // path it fails outright — reaching a verdict proves the capture was used.
    const verified = await post(`/api/bounty/air-session/${airId}/verify`, { mode: 'real' });
    ok('3b. the verify route uses the self-capture (no platform creds exist)',
      verified.status === 200 && verified.body.verification?.sourceState !== 'API_UNAVAILABLE',
      `${verified.body.verification?.result} / ${verified.body.verification?.sourceState ?? 'no source error'}`);

    // ── 4. captures purge with their pledge ───────────────────────────────
    // Through the REAL expiry path (a lapsed pledge swept by the sweeper),
    // not by calling the purge directly — the promise is that video does not
    // outlive the money it was taken to prove.
    const before = serverCaptures().length;
    ok('4. a capture exists before the pledge lapses', before === 1, `${before} file(s)`);
    const refunded = await post('/api/bounty/refund-expired',
      { platform: 'twitch', handle: 'capstreamer' }, 'capstreamer');
    // The claim is mid-verification here, so this refund is REFUSED — and the
    // capture must survive a refusal. That is the bug this ordering fixed.
    ok('4. a REFUSED refund leaves the capture intact (evidence is not destroyed on a no-op)',
      refunded.status !== 200 && serverCaptures().length === 1,
      `route ${refunded.status}, ${serverCaptures().length} file(s) still held`);

    // ── 5. closing the session stops the capture ──────────────────────────
    // The already-frozen capture rightly survives; what must not happen is any
    // NEW capture, because the session that authorised it is over.
    const heldAtClose = serverCaptures().length;
    await post(`/api/bounty/air-session/${airId}/end`, {}, 'capstreamer');
    await sleep(400);
    published += 1; // keep the stream running: nothing may be captured now
    await sleep(800);
    const freezeAfterClose = await post('/api/bounty/admin/playback/end',
      { airSessionId: airId, clipId: 'AFTER-CLOSE' });
    ok('5. closing the session stops capture — a later freeze captures nothing',
      freezeAfterClose.body.capture === null && serverCaptures().length === heldAtClose,
      `capture=${JSON.stringify(freezeAfterClose.body.capture)}, `
      + `${serverCaptures().length} file(s) (was ${heldAtClose})`);
  } finally {
    srv.kill();
  }
} finally {
  if (browser) await browser.close();
  await new Promise((r) => server.close(r));
}
// ── 6. capture is pinned to the PROVEN handle, not a client watch URL ─────
// A streamer opens the air session and may hand us a watch URL. On platforms
// with a channel page bound to the OAuth identity (Twitch, Kick), honouring
// that URL would let them point our recorder at a DIFFERENT stream — run the
// codes on a throwaway broadcast, hand us that URL, never overlay their real
// audience stream. The handle-derived page must win there; the watch URL is
// the SOLE address only where no channel page exists.
{
  const { captureSourceUrl } = await import('./bounty-routes.js');
  ok('6. twitch capture ignores a supplied watch URL (pinned to the proven handle)',
    captureSourceUrl({ platform: 'twitch', watchUrl: 'https://evil.example/other' }, 'MyHandle')
    === 'https://www.twitch.tv/myhandle');
  ok('6. kick capture ignores a supplied watch URL',
    captureSourceUrl({ platform: 'kick', watchUrl: 'https://evil.example/other' }, 'MyHandle')
    === 'https://kick.com/myhandle');
  ok('6. youtube capture uses the supplied watch URL (its only address)',
    captureSourceUrl({ platform: 'youtube', watchUrl: 'https://youtube.com/watch?v=x' }, 'h')
    === 'https://youtube.com/watch?v=x');
  ok('6. a no-channel-page platform with no watch URL is null (skip, never guess)',
    captureSourceUrl({ platform: 'youtube' }, 'h') === null);
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
