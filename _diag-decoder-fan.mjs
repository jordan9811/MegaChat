/**
 * DIAGNOSTIC — is the decoder's alignment search window too small?
 *
 * The sweep showed roughly half of distinct issued codes are never read at
 * 720p, deterministically (a code reads on all frames or none). The shipped
 * jitter fan is dx,dy ∈ [-2,+2] and dp ∈ ±0.16, and its own comment records
 * that it was tuned on the 720p corpus "where dx=+2 was the truth" — the
 * optimum sat ON the boundary of the search window, measured against a single
 * code. When the answer lands on the edge of your search, the search is
 * probably too small for the cases you have not tried yet.
 *
 * This re-decodes the SAME frames with a much wider fan and reports whether
 * the correct read was simply outside the shipped window, and where.
 *
 * Zero external network, zero spend. Diagnostic, not a gate.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';
import { fileToGray, locateRing, decodeAt } from './bounty-ocr.js';
import { OcrCodeChecker } from './bounty-ocr.js';

const N = Number(process.argv[2] || 14);
const PORT = 3315;
const APP = `http://localhost:${PORT}`;
const WORK = mkdtempSync(path.join(tmpdir(), 'mc-fan-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const post = (p, body) => fetch(`${APP}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());
const vid = (n) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(n, 5)]);
const ff = (args, what) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${what}: ${r.stderr?.slice(0, 200)}`);
};

/**
 * Is the true ring simply not the candidate the locator picked?
 *
 * locateRing returns ONE winner: the highest ring-contrast hypothesis. If the
 * true matrix is the runner-up at a different pitch, no amount of x/y jitter
 * around the winner can reach it. So this re-runs the locator inside narrow
 * pitch bands, forcing a different winner in each band, and decodes around
 * each one.
 */
function wideSearch(gray, code) {
  const n = code.length;
  const base = locateRing(gray, n);
  if (!base) return { ring: false };
  const expected = code.toUpperCase();
  let hit = null;
  // Narrow bands across the whole plausible pitch range, so each band's
  // winner is a DIFFERENT hypothesis rather than the same global one.
  const bands = [];
  for (let lo = 1; lo < 10; lo += 1) bands.push([lo, lo + 1.5]);
  for (const [minPitch, maxPitch] of bands) {
    const ring = locateRing(gray, n, { minPitch, maxPitch });
    if (!ring) continue;
    for (let dp = -0.4; dp <= 0.4001; dp += 0.04) {
      for (let dx = -8; dx <= 8; dx++) {
        for (let dy = -8; dy <= 8; dy++) {
          const d = decodeAt(gray, { ...ring, pitch: ring.pitch + dp, x: ring.x + dx, y: ring.y + dy }, n);
          if (d.text === expected && (!hit || d.confidence > hit.confidence)) {
            hit = { dx, dy, dp: +dp.toFixed(2), pitch: +ring.pitch.toFixed(2),
              basePitch: +base.pitch.toFixed(2), confidence: d.confidence };
          }
        }
      }
    }
  }
  return { ring: true, hit };
}

const { startGateServer } = await import('./_gate-helpers.mjs');
const srv = await startGateServer({
  port: PORT,
  env: {
    BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true', MODERATION_API_KEY: '',
    TWITCH_CLIENT_ID: '', TWITCH_CLIENT_SECRET: '', KICK_CLIENT_ID: '', KICK_CLIENT_SECRET: '',
    BOUNTY_CODE_ROTATE_MS: '600000', BOUNTY_CODE_VALIDITY_MS: '600000',
  },
});

let browser;
const results = [];
try {
  const pl = await post('/api/bounty/pledge', {
    targets: [{ platform: 'twitch', handle: 'fanner' }],
    contributor: '0xf', amount: '500', expiresInMs: 86_400_000,
  });
  await fetch(`${APP}${pl.uploadUrl}?durationS=8`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: vid(2048),
  });
  const claim = await post('/api/bounty/claim', { platform: 'twitch', handle: 'fanner', claimant: 'f' });

  browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  });
  const bed = path.join(WORK, 'bed.mp4');
  ff(['-f', 'lavfi', '-i', 'mandelbrot=size=1920x1080:rate=30', '-t', '1',
    '-c:v', 'libx264', '-b:v', '12M', '-pix_fmt', 'yuv420p', bed], 'bed');

  const shipped = new OcrCodeChecker({ log: { warn() {}, log() {} } });

  for (let i = 0; i < N; i++) {
    const air = await post('/api/bounty/air-session', {
      claimId: claim.claim.id, platform: 'twitch', roomId: `fan${i}`,
    });
    const airId = air.airSession.id;
    const play = await post('/api/bounty/admin/playback', {
      airSessionId: airId, clipId: `F${i}`, durationS: 600,
    });
    const code = play.code?.code;
    if (!code) continue;

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(`${APP}/overlay?room=fan${i}&bounty=${encodeURIComponent(airId)}`,
      { waitUntil: 'domcontentloaded', timeout: 60000 });
    let shown = false;
    for (let k = 0; k < 20 && !shown; k++) {
      await sleep(400);
      shown = await page.evaluate(() =>
        document.getElementById('bounty-badge')?.classList.contains('show')
        && (document.getElementById('bounty-matrix')?.width || 0) > 0);
    }
    if (!shown) { await page.close(); continue; }
    await page.evaluate(() => {
      document.body.style.background = '#00ff00';
      const stage = document.getElementById('stage');
      if (stage) stage.style.background = 'transparent';
    });
    const png = path.join(WORK, `ov-${i}.png`);
    await page.screenshot({ path: png });
    await page.close();

    const out = path.join(WORK, `enc-${i}.mp4`);
    ff(['-i', bed, '-i', png, '-filter_complex',
      '[1:v]colorkey=0x00ff00:0.28:0.06[ov];[0:v][ov]overlay=0:0,scale=1280:720',
      '-c:v', 'libx264', '-b:v', '3000k', '-maxrate', '3000k', '-bufsize', '2M',
      '-pix_fmt', 'yuv420p', '-t', '1', out], 'encode');
    const fdir = path.join(WORK, `f-${i}`);
    mkdirSync(fdir, { recursive: true });
    ff(['-i', out, '-vf', 'fps=1', path.join(fdir, 'f-%02d.png')], 'frames');
    const frame = path.join(fdir, readdirSync(fdir)[0]);

    const gray = fileToGray(frame);
    const ship = await shipped.check(gray, code);
    const wide = ship.found ? null : wideSearch(gray, code);
    results.push({ code, shipped: ship.found, read: ship.text, wide });
    console.log(`  ${code}  shipped=${ship.found ? 'READ' : `miss (saw "${ship.text}")`}`
      + (wide ? (wide.hit
        ? `  → READS at pitch=${wide.hit.pitch} (locator picked ${wide.hit.basePitch}) dx=${wide.hit.dx} dy=${wide.hit.dy}`
        : (wide.ring ? '  → wide fan also fails (ring found)' : '  → NO RING FOUND'))
        : ''));
  }
} finally {
  if (browser) await browser.close();
  srv.child.kill();
}

const missed = results.filter((r) => !r.shipped);
const recovered = missed.filter((r) => r.wide?.hit);
const noRing = missed.filter((r) => r.wide && !r.wide.ring);
console.log(`\n── ${results.length} codes at 720p ──`);
console.log(`shipped decoder read:      ${results.length - missed.length}`);
console.log(`shipped decoder missed:    ${missed.length}`);
console.log(`  ...recovered by wide fan: ${recovered.length}`);
console.log(`  ...ring never located:    ${noRing.length}`);
console.log(`  ...genuinely unreadable:  ${missed.length - recovered.length - noRing.length}`);
if (recovered.length) {
  const dxs = recovered.map((r) => r.wide.hit.dx);
  const dys = recovered.map((r) => r.wide.hit.dy);
  const dps = recovered.map((r) => r.wide.hit.dp);
  const wrongPitch = recovered.filter((r) => r.wide.hit.pitch !== r.wide.hit.basePitch).length;
  console.log(`
recovered by using a DIFFERENT ring candidate (pitch): ${wrongPitch}/${recovered.length}`);
  const rng = (a) => `${Math.min(...a)}..${Math.max(...a)}`;
  console.log(`\nwhere the correct read actually was:`);
  console.log(`  dx ${rng(dxs)}   dy ${rng(dys)}   dp ${rng(dps)}`);
  console.log(`  shipped window: dx -2..2, dy -2..2, dp -0.16..0.16`);
  const outside = recovered.filter((r) => Math.abs(r.wide.hit.dx) > 2
    || Math.abs(r.wide.hit.dy) > 2 || Math.abs(r.wide.hit.dp) > 0.16).length;
  console.log(`  reads lying OUTSIDE the shipped window: ${outside}/${recovered.length}`);
}
