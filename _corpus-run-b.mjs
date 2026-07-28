/**
 * SYNTHETIC FRAME CORPUS — the offline test bed for Run B verification.
 *
 * Reproducible by script, never checked-in binaries. What it does:
 *
 *  1. Boots the real server, opens a real air session, opens a real playback
 *     window, and drives the REAL overlay page — the badge below is rendered
 *     by shipped code drawing a code the server actually issued. No
 *     re-implementation of the badge anywhere in this pipeline.
 *  2. Captures the overlay at 1920x1080 with a transparent stage, then uses
 *     ffmpeg to composite it over realistic moving video (mandelbrot zoom —
 *     worst-case motion for an encoder) and re-encode the way platforms
 *     mangle streams: H.264 yuv420p at Twitch-like bitrates, then 720p and
 *     480p downscales, then a high-motion starved-bitrate variant.
 *  3. Extracts labeled frames per condition:
 *       present-1080p / present-720p / present-480p / high-motion
 *       absent (no badge) / too-small (badge at 40%) / occluded (60% covered)
 *  4. Writes corpus/labels.json with {file, condition, code, expectFound}.
 *
 * Cost: zero external calls. Everything local: server, browser, ffmpeg.
 */
import { spawn, spawnSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync, readdirSync } from 'fs';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3304;
const APP = `http://localhost:${PORT}`;
const OUT = path.resolve('corpus');
const log = (...a) => console.log('[corpus]', ...a);

const post = (p, body) => fetch(`${APP}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

function ff(args, what) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${what} failed: ${r.stderr?.slice(0, 300)}`);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.join(OUT, 'frames'), { recursive: true });

const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: {
    ...process.env, PORT: String(PORT), DATA_DIR: mkdtempSync(path.join(tmpdir(), 'mc-corpus-')),
    BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true', MODERATION_API_KEY: '',
    // Long validity so ONE issued code stays live for the whole capture.
    BOUNTY_CODE_ROTATE_MS: '600000', BOUNTY_CODE_VALIDITY_MS: '600000',
  },
  stdio: 'ignore', cwd: process.cwd(),
});
await sleep(11000);

let browser;
try {
  // ── a real air session with a real issued code ───────────────────────────
  await post('/api/bounty/pledge', {
    targets: [{ platform: 'twitch', handle: 'corpusstreamer' }],
    contributor: '0xcorpus', amount: '10', expiresInMs: 86_400_000,
  });
  const claimed = await post('/api/bounty/claim', { platform: 'twitch', handle: 'corpusstreamer', claimant: 'corpus' });
  const claimId = claimed.claim?.id;
  if (!claimId) throw new Error(`claim failed: ${JSON.stringify(claimed).slice(0, 200)}`);
  const air = await post('/api/bounty/air-session', { claimId, platform: 'twitch', roomId: 'corpusroom' });
  const airId = air.airSession.id;
  const play = await post('/api/bounty/admin/playback', { airSessionId: airId, clipId: 'CORPUS', durationS: 600 });
  const code = play.code?.code;
  if (!code) throw new Error(`no code issued: ${JSON.stringify(play)}`);
  log('real issued code:', code);

  // ── capture the REAL overlay page at 1080p ───────────────────────────────
  browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto(`${APP}/overlay?room=corpusroom&bounty=${encodeURIComponent(airId)}`,
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Wait for the badge to render the issued code (polls the code route).
  let shown = false;
  for (let i = 0; i < 20 && !shown; i++) {
    await sleep(500);
    shown = await page.evaluate(() =>
      document.getElementById('bounty-badge')?.classList.contains('show')
      && (document.getElementById('bounty-matrix')?.width || 0) > 0);
  }
  if (!shown) throw new Error('badge never rendered the code');
  // Neutralize the page background so ffmpeg can key the overlay cleanly:
  // stage transparent, badge on top — screenshot with a green matte.
  await page.evaluate(() => {
    document.body.style.background = '#00ff00';
    const stage = document.getElementById('stage');
    if (stage) stage.style.background = 'transparent';
  });
  const overlayPng = path.join(OUT, 'overlay-1080.png');
  await page.screenshot({ path: overlayPng });

  // Variants of the OVERLAY LAYER, still shipped-page pixels:
  // too-small = badge scaled to 40% (a streamer shrinking the source);
  // occluded = 60% of the matrix hidden behind another element.
  await page.evaluate(() => {
    const b = document.getElementById('bounty-badge');
    b.style.transform = 'scale(0.4)'; b.style.transformOrigin = 'bottom left';
  });
  const overlaySmall = path.join(OUT, 'overlay-small.png');
  await page.screenshot({ path: overlaySmall });
  await page.evaluate(() => {
    const b = document.getElementById('bounty-badge');
    b.style.transform = '';
    const cover = document.createElement('div');
    cover.id = 'cover';
    const r = document.getElementById('bounty-matrix').getBoundingClientRect();
    Object.assign(cover.style, {
      position: 'fixed', left: `${r.left + r.width * 0.4}px`, top: `${r.top - 4}px`,
      width: `${r.width * 0.6 + 8}px`, height: `${r.height + 8}px`,
      background: '#7a4dff', zIndex: 99,
    });
    document.body.appendChild(cover);
  });
  const overlayOccl = path.join(OUT, 'overlay-occluded.png');
  await page.screenshot({ path: overlayOccl });
  await page.close();

  // ── composite + platform-grade mangling ──────────────────────────────────
  // Base motion bed: mandelbrot zoom = continuous high-entropy motion.
  const bed = path.join(OUT, 'bed.mp4');
  ff(['-f', 'lavfi', '-i', 'mandelbrot=size=1920x1080:rate=30', '-t', '8',
    '-c:v', 'libx264', '-b:v', '12M', '-pix_fmt', 'yuv420p', bed], 'motion bed');

  const composite = (overlay, out, extra, what) => ff([
    '-i', bed, '-i', overlay,
    '-filter_complex',
    `[1:v]colorkey=0x00ff00:0.28:0.06[ov];[0:v][ov]overlay=0:0${extra.scale ? `,scale=${extra.scale}` : ''}`,
    '-c:v', 'libx264', '-b:v', extra.bitrate, '-maxrate', extra.bitrate, '-bufsize', '2M',
    '-pix_fmt', 'yuv420p', '-t', '8', out,
  ], what);

  const encodes = [
    { name: 'present-1080p', overlay: overlayPng, bitrate: '4500k', scale: null, expectFound: true },
    { name: 'present-720p', overlay: overlayPng, bitrate: '3000k', scale: '1280:720', expectFound: true },
    { name: 'present-480p', overlay: overlayPng, bitrate: '1500k', scale: '854:480', expectFound: true },
    { name: 'high-motion', overlay: overlayPng, bitrate: '2000k', scale: null, expectFound: true },
    { name: 'too-small', overlay: overlaySmall, bitrate: '4500k', scale: null, expectFound: true, belowFloor: true },
    { name: 'occluded', overlay: overlayOccl, bitrate: '4500k', scale: null, expectFound: false },
  ];

  const labels = [];
  for (const e of encodes) {
    const vid = path.join(OUT, `${e.name}.mp4`);
    composite(e.overlay, vid, e, e.name);
    // 12 frames spread across the clip (1.5 fps over 8s).
    const pattern = path.join(OUT, 'frames', `${e.name}-%02d.png`);
    ff(['-i', vid, '-vf', 'fps=1.5', pattern], `${e.name} frames`);
    for (const f of readdirSync(path.join(OUT, 'frames')).filter((x) => x.startsWith(e.name))) {
      labels.push({
        file: `frames/${f}`, condition: e.name, code,
        expectFound: e.expectFound, belowFloor: !!e.belowFloor,
      });
    }
    log(`${e.name}: encoded + frames extracted`);
  }

  // Absent condition: the bare motion bed, no overlay at all.
  ff(['-i', bed, '-vf', 'fps=1.5', path.join(OUT, 'frames', 'absent-%02d.png')], 'absent frames');
  for (const f of readdirSync(path.join(OUT, 'frames')).filter((x) => x.startsWith('absent'))) {
    labels.push({ file: `frames/${f}`, condition: 'absent', code, expectFound: false, belowFloor: false });
  }

  writeFileSync(path.join(OUT, 'labels.json'), JSON.stringify({ code, labels }, null, 2));
  log(`corpus complete: ${labels.length} labeled frames in ${OUT}`);
} finally {
  if (browser) await browser.close();
  app.kill();
}
