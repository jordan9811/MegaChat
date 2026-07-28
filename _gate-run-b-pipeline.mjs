/**
 * GATE — the WHOLE verification distance, over HTTP, with the REAL decoder.
 *
 * pledge → upload → claim → air session → real playback window with a real
 * issued code → the REAL overlay page renders it → ffmpeg re-encodes it the
 * way platforms mangle streams (720p 3Mbps) → the verify route runs the REAL
 * matrix decoder over those frames → verified playbacks → release computed
 * (stub) → evidence chain carries the verification.
 *
 * Plus the two honesty paths:
 *  - SOURCE_UNAVAILABLE: verification that cannot reach its source lands in
 *    the review queue as its own state — never FAIL, never a silent zero.
 *  - WRONG-BROADCAST frames (a different session's code) verify NOTHING:
 *    replaying someone else's footage cannot pay this session.
 *
 * Zero network beyond localhost. Zero spend.
 */
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3305;
const APP = `http://localhost:${PORT}`;
const WORK = mkdtempSync(path.join(tmpdir(), 'mc-pipe-'));

const post = (p, body) => fetch(`${APP}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (p) => fetch(`${APP}${p}`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const vid = (n) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(n, 5)]);
const ff = (args, what) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${what}: ${r.stderr?.slice(0, 200)}`);
};

const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: {
    ...process.env, PORT: String(PORT), DATA_DIR: mkdtempSync(path.join(tmpdir(), 'mc-pipe-d-')),
    BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true', MODERATION_API_KEY: '',
    // The gate must never reach a real platform API.
    TWITCH_CLIENT_ID: '', TWITCH_CLIENT_SECRET: '', KICK_CLIENT_ID: '', KICK_CLIENT_SECRET: '',
    BOUNTY_CODE_ROTATE_MS: '600000', BOUNTY_CODE_VALIDITY_MS: '600000',
  },
  stdio: 'ignore', cwd: process.cwd(),
});
await sleep(11000);

let browser;
try {
  // ── the fan's half, over HTTP ────────────────────────────────────────────
  const pl = await post('/api/bounty/pledge', {
    targets: [{ platform: 'twitch', handle: 'pipestreamer' }],
    contributor: '0xpipe', amount: '50', expiresInMs: 86_400_000,
  });
  await fetch(`${APP}${pl.body.uploadUrl}?durationS=8`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: vid(4096),
  });
  const claim = await post('/api/bounty/claim', { platform: 'twitch', handle: 'pipestreamer', claimant: 'pipe' });
  const air = await post('/api/bounty/air-session', { claimId: claim.body.claim.id, platform: 'twitch', roomId: 'piperoom' });
  const airId = air.body.airSession.id;
  const play = await post('/api/bounty/admin/playback', { airSessionId: airId, clipId: 'PIPE1', durationS: 600 });
  const code = play.body.code?.code;
  ok('a real playback window issues a real code over HTTP', !!code, code);

  // ── the broadcast: real overlay page → platform-grade re-encode ──────────
  browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto(`${APP}/overlay?room=piperoom&bounty=${encodeURIComponent(airId)}`,
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  let shown = false;
  for (let i = 0; i < 20 && !shown; i++) {
    await sleep(500);
    shown = await page.evaluate(() =>
      document.getElementById('bounty-badge')?.classList.contains('show')
      && (document.getElementById('bounty-matrix')?.width || 0) > 0);
  }
  ok('the REAL overlay page renders the issued code (shipped writer)', shown);
  await page.evaluate(() => { document.body.style.background = '#00ff00'; });
  const shot = path.join(WORK, 'pipe-overlay.png');
  await page.screenshot({ path: shot });
  await page.close();

  const enc = path.join(WORK, 'pipe-720.mp4');
  ff(['-f', 'lavfi', '-i', 'mandelbrot=size=1920x1080:rate=30', '-i', shot,
    '-filter_complex', '[1:v]colorkey=0x00ff00:0.28:0.06[ov];[0:v][ov]overlay=0:0,scale=1280:720',
    '-c:v', 'libx264', '-b:v', '3000k', '-pix_fmt', 'yuv420p', '-t', '4', enc], 'encode');
  mkdirSync(path.join(WORK, 'frames'), { recursive: true });
  ff(['-i', enc, '-vf', 'fps=1', path.join(WORK, 'frames', 'p-%02d.png')], 'frames');
  const frames = readdirSync(path.join(WORK, 'frames')).map((f) => ({ file: path.join(WORK, 'frames', f) }));
  ok('the broadcast was mangled to 720p/3Mbps and frames extracted', frames.length >= 3, `${frames.length} frames`);

  await post('/api/bounty/admin/playback/end', { airSessionId: airId, clipId: 'PIPE1' });

  // ── verification, the whole distance over HTTP ───────────────────────────
  const v1 = await post(`/api/bounty/air-session/${airId}/verify`, {
    mode: 'real', sourceMode: 'files', frames,
  });
  ok('the verify route runs the REAL decoder over the re-encoded frames',
    v1.status === 200, JSON.stringify(v1.body).slice(0, 120));
  ok('the clip playback VERIFIES from broadcast pixels alone',
    v1.body.verification?.verifiedClips === 1
    && ['PASS', 'PARTIAL'].includes(v1.body.verification?.result),
    `result=${v1.body.verification?.result} clips=${v1.body.verification?.verifiedClips}`);
  ok('...with the measured pixel height on every check (anti-shrink data present)',
    (v1.body.verification?.checks || []).every((c) => Number.isFinite(c.pixelHeight) && c.pixelHeight > 0),
    JSON.stringify((v1.body.verification?.checks || []).map((c) => c.pixelHeight)));
  const pool1 = await get('/api/bounty/pool-view?platform=twitch&handle=pipestreamer');
  ok('the release is COMPUTED from verified playbacks (and stays stubbed)',
    pool1.body.view.releasedContributor > 0, `released=${pool1.body.view.releasedContributor}`);

  // ── SOURCE_UNAVAILABLE: could-not-look is not a FAIL ─────────────────────
  const air2 = await post('/api/bounty/air-session', { claimId: claim.body.claim.id, platform: 'twitch', roomId: 'piperoom' });
  const air2Id = air2.body.airSession.id;
  await post('/api/bounty/admin/playback', { airSessionId: air2Id, clipId: 'PIPE2', durationS: 600 });
  await post('/api/bounty/admin/playback/end', { airSessionId: air2Id, clipId: 'PIPE2' });
  const v2 = await post(`/api/bounty/air-session/${air2Id}/verify`, { mode: 'real', sourceMode: 'vod' });
  ok('an unreachable source is SOURCE_UNAVAILABLE, not FAIL',
    v2.body.verification?.result === 'SOURCE_UNAVAILABLE'
    && v2.body.verification?.sourceState === 'API_UNAVAILABLE',
    `${v2.body.verification?.result}/${v2.body.verification?.sourceState}`);
  const reviews = await get('/api/bounty/admin/reviews');
  ok('...and it lands in the REVIEW QUEUE for a human',
    (reviews.body.reviews || []).some((r) => r.airSessionId === air2Id && /source unavailable/i.test(r.reason || '')),
    `${reviews.body.openCount} open review(s)`);
  const pool2 = await get('/api/bounty/pool-view?platform=twitch&handle=pipestreamer');
  ok('...and it pays NOTHING while unresolved',
    pool2.body.view.releasedContributor === pool1.body.view.releasedContributor);

  // ── WRONG-BROADCAST frames verify nothing ────────────────────────────────
  // Frames from the corpus carry a DIFFERENT session's code. Replaying
  // someone else's (or an old) broadcast must not pay this session.
  const air3 = await post('/api/bounty/air-session', { claimId: claim.body.claim.id, platform: 'twitch', roomId: 'piperoom' });
  const air3Id = air3.body.airSession.id;
  await post('/api/bounty/admin/playback', { airSessionId: air3Id, clipId: 'PIPE3', durationS: 600 });
  await post('/api/bounty/admin/playback/end', { airSessionId: air3Id, clipId: 'PIPE3' });
  const corpusFrames = readdirSync(path.resolve('corpus/frames'))
    .filter((f) => f.startsWith('present-1080p')).slice(0, 3)
    .map((f) => ({ file: path.resolve('corpus/frames', f) }));
  const v3 = await post(`/api/bounty/air-session/${air3Id}/verify`, {
    mode: 'real', sourceMode: 'files', frames: corpusFrames,
  });
  ok('REPLAYED footage (another session\'s code) verifies ZERO clips',
    v3.body.verification?.verifiedClips === 0
    && ['FAIL', 'AMBIGUOUS'].includes(v3.body.verification?.result),
    `result=${v3.body.verification?.result}`);
  const pool3 = await get('/api/bounty/pool-view?platform=twitch&handle=pipestreamer');
  ok('...and pays nothing', pool3.body.view.releasedContributor === pool1.body.view.releasedContributor);
} finally {
  if (browser) await browser.close();
  app.kill();
}
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
