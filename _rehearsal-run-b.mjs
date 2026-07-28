/**
 * DRESS REHEARSAL — the full Run B loop against a REAL Twitch broadcast,
 * one command, unattended:
 *
 *   node _rehearsal-run-b.mjs
 *
 * Requires TWITCH_STREAM_KEY in env (plus the TWITCH_CLIENT_ID/SECRET that
 * are already there). What it does:
 *
 *  1. Boots the local server (BOUNTY_CLAIM on), seeds a pledge + clip, claims
 *     the handle given by --handle (default: the channel being streamed to),
 *     opens a real air session.
 *  2. Captures the REAL overlay page continuously (headless screencast) and
 *     pushes it composited over a test pattern to Twitch via ffmpeg RTMP —
 *     a genuine live broadcast. Keep it short; ~12 minutes, then ends the
 *     stream cleanly. SET THE STREAM TITLE TO A TEST TITLE MANUALLY first:
 *     title changes need a user token this harness deliberately doesn't have.
 *  3. Drives real clip playbacks through the admin route — codes issue and
 *     rotate exactly as they would for real clips.
 *  4. LIVE SPOT-CHECK mid-broadcast: verify with sourceMode 'live' — frames
 *     grabbed from the public HLS while the code is on air.
 *  5. After the stream ends, polls for the VOD (processing lag is real) and
 *     runs the primary VOD verification at the logged timestamps.
 *  6. Prints the verdicts, the viewer samples in the evidence chain, and the
 *     release rows. End state: verified clip playbacks with viewer counts,
 *     produced entirely from public broadcast data.
 *
 * Flags:
 *   --handle <login>   channel login being broadcast to (default from key owner: REQUIRED)
 *   --minutes <n>      broadcast length (default 12, keep it short)
 *   --skip-push        assume the channel is ALREADY live with the overlay
 *                      (real-usage rehearsal): only seeds, plays, verifies.
 *
 * Cost: Twitch API reads only (no spend); zero LiveKit; one short broadcast
 * on your own channel.
 */
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[rehearsal]', ...a);

const HANDLE = arg('handle', null);
const MINUTES = Math.min(15, Number(arg('minutes', 12)));
const PORT = 3306;
const APP = `http://localhost:${PORT}`;
const KEY = process.env.TWITCH_STREAM_KEY;

if (!HANDLE) {
  console.error('usage: node _rehearsal-run-b.mjs --handle <your-twitch-login> [--minutes 12] [--skip-push]');
  process.exit(1);
}
if (!KEY && !has('skip-push')) {
  console.error('TWITCH_STREAM_KEY is not set. Either set it, or go live yourself (overlay in OBS) and pass --skip-push.');
  process.exit(1);
}

const post = (p, body) => fetch(`${APP}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (p) => fetch(`${APP}${p}`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

// ── 1. server + session ─────────────────────────────────────────────────────
const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: {
    ...process.env, PORT: String(PORT),
    DATA_DIR: process.env.REHEARSAL_DATA_DIR || mkdtempSync(path.join(tmpdir(), 'mc-rehearsal-')),
    BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true',
  },
  stdio: 'ignore', cwd: process.cwd(),
});
await sleep(11000);

let browser, pusher;
const cleanup = async () => {
  try { pusher?.stdin?.end(); } catch { /* */ }
  try { pusher?.kill(); } catch { /* */ }
  try { await browser?.close(); } catch { /* */ }
  try { app.kill(); } catch { /* */ }
};
process.on('SIGINT', async () => { await cleanup(); process.exit(1); });

try {
  const vid = (n) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(n, 7)]);
  const pl = await post('/api/bounty/pledge', {
    targets: [{ platform: 'twitch', handle: HANDLE }],
    contributor: '0xrehearsal', amount: '25', expiresInMs: 86_400_000,
  });
  await fetch(`${APP}${pl.body.uploadUrl}?durationS=10`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: vid(4096),
  });
  const claim = await post('/api/bounty/claim', { platform: 'twitch', handle: HANDLE, claimant: HANDLE });
  const air = await post('/api/bounty/air-session', { claimId: claim.body.claim.id, platform: 'twitch', roomId: 'rehearsalroom' });
  const airId = air.body.airSession.id;
  log('air session', airId, 'for', HANDLE);

  // ── 2. broadcast ──────────────────────────────────────────────────────────
  if (!has('skip-push')) {
    browser = await puppeteer.launch({
      executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(`${APP}/overlay?room=rehearsalroom&bounty=${encodeURIComponent(airId)}`,
      { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.evaluate(() => { document.body.style.background = '#00ff00'; });

    // Screencast → ffmpeg: PNGs down stdin at 2 fps, keyed over a test
    // pattern, encoded to Twitch-recommended settings, pushed via RTMP.
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
      '-f', 'flv', `rtmp://live.twitch.tv/app/${KEY}`,
    ], { stdio: ['pipe', 'ignore', 'inherit'] });
    const screencast = setInterval(async () => {
      try {
        const png = await page.screenshot({ type: 'png' });
        if (pusher.stdin.writable) pusher.stdin.write(png);
      } catch { /* frame dropped */ }
    }, 500);
    pusher.on('exit', () => clearInterval(screencast));
    log('RTMP push started — waiting for Twitch to see the stream…');
    // Confirm we are actually live before proceeding.
    let liveConfirmed = false;
    for (let i = 0; i < 24; i++) {
      await sleep(10_000);
      const { getStreamByLogin } = await import('./twitch-api.js');
      const s = await getStreamByLogin(HANDLE);
      if (s?.live) { liveConfirmed = true; break; }
    }
    if (!liveConfirmed) throw new Error('Twitch never reported the channel live — check the stream key.');
    log('LIVE confirmed by Helix.');
  } else {
    log('--skip-push: assuming the channel is already live with the overlay open at:');
    log(`  ${APP}/overlay?room=rehearsalroom&bounty=${encodeURIComponent(airId)}`);
  }

  // ── 3. real clip playbacks with rotating codes ────────────────────────────
  const playbacks = [];
  for (let i = 0; i < 3; i++) {
    const p = await post('/api/bounty/admin/playback', { airSessionId: airId, clipId: `REHEARSAL${i + 1}`, durationS: 30 });
    log(`playback ${i + 1} open, first code ${p.body.code?.code}`);
    playbacks.push(p.body);

    // ── 4. live spot-check during the SECOND playback ─────────────────────
    if (i === 1) {
      await sleep(8000); // let the code render + reach the CDN edge (~5-10s latency)
      const live = await post(`/api/bounty/air-session/${airId}/verify`, { mode: 'real', sourceMode: 'live' });
      log('LIVE SPOT-CHECK:', JSON.stringify({
        result: live.body.verification?.result,
        clips: live.body.verification?.verifiedClips,
        state: live.body.verification?.sourceState,
      }));
    }
    await sleep(30_000);
    await post('/api/bounty/admin/playback/end', { airSessionId: airId, clipId: `REHEARSAL${i + 1}` });
  }

  // Keep the broadcast up to the requested length so the VOD is substantial.
  const remaining = MINUTES * 60_000 - 3 * 38_000;
  if (!has('skip-push') && remaining > 0) {
    log(`holding the broadcast ${Math.round(remaining / 60000)} more minute(s)…`);
    await sleep(remaining);
  }

  // ── 5. end stream, wait for the VOD, verify ───────────────────────────────
  if (pusher) { try { pusher.stdin.end(); } catch { /* */ } pusher.kill(); log('stream ended.'); }
  log('waiting for the VOD to appear (processing lag is normal)…');
  let vodResult = null;
  for (let i = 0; i < 20; i++) {
    await sleep(30_000);
    const v = await post(`/api/bounty/air-session/${airId}/verify`, { mode: 'real', sourceMode: 'vod' });
    vodResult = v.body.verification;
    if (vodResult?.result && vodResult.result !== 'SOURCE_UNAVAILABLE') break;
    log(`  not yet (${vodResult?.sourceState || vodResult?.result}) — retrying`);
  }

  // ── 6. the receipts ───────────────────────────────────────────────────────
  console.log('\n════ REHEARSAL RESULT ════');
  console.log('VOD verification :', JSON.stringify({
    result: vodResult?.result, verifiedClips: vodResult?.verifiedClips,
    confidence: vodResult?.confidence,
    pixelHeights: (vodResult?.checks || []).map((c) => c.pixelHeight),
  }, null, 2));
  const pool = await get(`/api/bounty/pool-view?platform=twitch&handle=${HANDLE}`);
  console.log('release (stub)   :', pool.body.view?.releasedContributor, 'of', pool.body.view?.totalContributed);
  const sess = await get('/api/bounty/admin/sessions');
  console.log('settlement intents (recorded, never sent):', JSON.stringify(sess.body.settlementIntents || []));
  console.log('\nviewer samples land in the evidence chain (VIEWER_SAMPLE rows in bounty-evidence.jsonl under DATA_DIR).');
} finally {
  await cleanup();
}
