/**
 * CODE SWEEP — does detection depend on WHICH code was issued?
 *
 * The whole corpus was built from a single issued code (97-TXFV), so every
 * headline number — 1080p 100%, 720p 100%, 480p 92% — describes one glyph
 * sequence. Meanwhile the end-to-end pipeline gate, which issues a FRESH
 * random code every run, passes and fails intermittently on the same 720p
 * encode. One of those two facts is wrong, and "we measured 100%" is the one
 * making a promise to streamers.
 *
 * So: the same shipped path (real overlay page → real re-encode → real
 * decoder), swept across N distinct issued codes at 720p. Reports per-code
 * outcome and, on failure, which characters were misread.
 *
 * THIS IS A GATE, not a diagnostic, precisely because the one-code corpus
 * could not have caught what it caught. A corpus fixes its sample at
 * generation time; this re-draws codes every run, so the next glyph sequence
 * that breaks the decoder fails CI instead of a streamer's payout.
 *
 * Zero external network, zero spend.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';

const N = Number(process.argv[2] || 8);
const PORT = 3314;
const APP = `http://localhost:${PORT}`;
const WORK = mkdtempSync(path.join(tmpdir(), 'mc-sweep-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const post = (p, body) => fetch(`${APP}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());
const vid = (n) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(n, 5)]);
const ff = (args, what) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${what}: ${r.stderr?.slice(0, 200)}`);
};

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
const rows = [];
try {
  const pl = await post('/api/bounty/pledge', {
    targets: [{ platform: 'twitch', handle: 'sweeper' }],
    contributor: '0xs', amount: '500', expiresInMs: 86_400_000,
  });
  await fetch(`${APP}${pl.uploadUrl}?durationS=8`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: vid(2048),
  });
  const claim = await post('/api/bounty/claim', { platform: 'twitch', handle: 'sweeper', claimant: 's' });

  browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  });

  // One motion bed, reused: the variable under test is the CODE, so the
  // background must not also change between trials.
  const bed = path.join(WORK, 'bed.mp4');
  ff(['-f', 'lavfi', '-i', 'mandelbrot=size=1920x1080:rate=30', '-t', '2',
    '-c:v', 'libx264', '-b:v', '12M', '-pix_fmt', 'yuv420p', bed], 'bed');

  const { OcrFrameChecker } = await import('./ocr-frame-checker.js');
  const checker = new OcrFrameChecker({ log: { warn() {}, log() {} } });

  for (let i = 0; i < N; i++) {
    // A fresh air session per trial = a freshly issued code.
    const air = await post('/api/bounty/air-session', {
      claimId: claim.claim.id, platform: 'twitch', roomId: `sweep${i}`,
    });
    const airId = air.airSession.id;
    const play = await post('/api/bounty/admin/playback', {
      airSessionId: airId, clipId: `S${i}`, durationS: 600,
    });
    const code = play.code?.code;
    if (!code) { log(`trial ${i}: no code issued, skipping`); continue; }

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(`${APP}/overlay?room=sweep${i}&bounty=${encodeURIComponent(airId)}`,
      { waitUntil: 'domcontentloaded', timeout: 60000 });
    let shown = false;
    for (let k = 0; k < 20 && !shown; k++) {
      await sleep(400);
      shown = await page.evaluate(() =>
        document.getElementById('bounty-badge')?.classList.contains('show')
        && (document.getElementById('bounty-matrix')?.width || 0) > 0);
    }
    if (!shown) { await page.close(); log(`trial ${i}: badge never rendered`); continue; }
    await page.evaluate(() => {
      document.body.style.background = '#00ff00';
      const stage = document.getElementById('stage');
      if (stage) stage.style.background = 'transparent';
    });
    // What the PAGE actually rendered, so a decoder miss can be told apart
    // from a badge that never drew at full size.
    const drawn = await page.evaluate(() => {
      const c = document.getElementById('bounty-matrix');
      const r = c.getBoundingClientRect();
      return { w: c.width, h: c.height, cssW: Math.round(r.width), cssH: Math.round(r.height) };
    });
    const png = path.join(WORK, `ov-${i}.png`);
    await page.screenshot({ path: png });
    await page.close();

    // Identical 720p/3Mbps mangling to the corpus's present-720p condition.
    const out = path.join(WORK, `enc-${i}.mp4`);
    ff(['-i', bed, '-i', png, '-filter_complex',
      '[1:v]colorkey=0x00ff00:0.28:0.06[ov];[0:v][ov]overlay=0:0,scale=1280:720',
      '-c:v', 'libx264', '-b:v', '3000k', '-maxrate', '3000k', '-bufsize', '2M',
      '-pix_fmt', 'yuv420p', '-t', '2', out], 'encode');
    const fdir = path.join(WORK, `f-${i}`);
    mkdirSync(fdir, { recursive: true });
    ff(['-i', out, '-vf', 'fps=1.5', path.join(fdir, 'f-%02d.png')], 'frames');

    const frames = readdirSync(fdir).map((f) => path.join(fdir, f));
    let hits = 0;
    let sawPx = 0;
    let readBack = null;
    for (const f of frames) {
      // findCode reads frame.ref, NOT frame.file. Passing {file} makes every
      // frame come back "unreadable" — a silent all-zeros result that looks
      // exactly like a decoder that cannot see anything.
      const r = await checker.findCode({ ref: f }, [code]);
      if (r.error) throw new Error(`checker could not read ${f}: ${r.error}`);
      if (r.found) hits++;
      if (r.pixelHeight) sawPx = Math.max(sawPx, r.pixelHeight);
      if (!r.found && r.decoded && !readBack) readBack = r.decoded;
    }
    const rate = hits / frames.length;
    rows.push({ code, hits, of: frames.length, rate, px: sawPx, readBack, drawn, dir: fdir });
    log(`  ${code}  ${hits}/${frames.length} frames  px=${sawPx}`
      + `  canvas=${drawn.cssW}x${drawn.cssH}`
      + `${rate < 1 ? `   MISS${readBack ? ` (read "${readBack}")` : ''}` : ''}`);
  }
} finally {
  if (browser) await browser.close();
  srv.child.kill();
}

// ── report ────────────────────────────────────────────────────────────────
const perfect = rows.filter((r) => r.rate === 1).length;
const partial = rows.filter((r) => r.rate > 0 && r.rate < 1).length;
const zero = rows.filter((r) => r.rate === 0).length;
const totalHits = rows.reduce((a, r) => a + r.hits, 0);
const totalFrames = rows.reduce((a, r) => a + r.of, 0);
console.log(`\n── 720p sweep over ${rows.length} distinct issued codes ──`);
console.log(`frame-level detection: ${totalHits}/${totalFrames} `
  + `(${((totalHits / totalFrames) * 100).toFixed(1)}%)`);
console.log(`codes read on every frame: ${perfect}`);
console.log(`codes read on some frames: ${partial}`);
console.log(`codes never read at all:   ${zero}`);
if (zero || partial) {
  console.log('\ncodes that failed at least one frame:');
  for (const r of rows.filter((x) => x.rate < 1)) {
    console.log(`  ${r.code}  ${r.hits}/${r.of}  px=${r.px}  canvas=${r.drawn.cssW}x${r.drawn.cssH}`
      + `  frames=${r.dir}${r.readBack ? `  read as "${r.readBack}"` : ''}`);
  }
  // Which characters show up disproportionately in failing codes?
  const freq = (list) => {
    const m = {};
    for (const r of list) for (const ch of r.code.replace('-', '')) m[ch] = (m[ch] || 0) + 1;
    return m;
  };
  const bad = freq(rows.filter((x) => x.rate < 1));
  const all = freq(rows);
  const lift = Object.entries(bad)
    .map(([ch, n]) => [ch, n, all[ch], n / all[ch]])
    .sort((a, b) => b[3] - a[3]);
  console.log('\ncharacter appearance in failing vs all codes:');
  for (const [ch, n, tot, r] of lift) console.log(`  ${ch}  ${n}/${tot}  ${(r * 100).toFixed(0)}%`);
}

// ── assertions ────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
ok('every trial actually issued a code and rendered a badge', rows.length === N,
  `${rows.length}/${N}`);
// Not "on average": a code that is never readable is a streamer who is never
// paid, and averaging hides it behind the codes that work.
ok('EVERY distinct issued code is read at 720p', zero === 0,
  `${zero} unreadable of ${rows.length}`);
ok('...on every sampled frame, not just some', partial === 0, `${partial} partial`);
ok('frame-level detection at 720p is total',
  totalHits === totalFrames, `${totalHits}/${totalFrames}`);
console.log(`
RESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
