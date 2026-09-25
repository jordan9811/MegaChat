/**
 * GATE — the booth tells the truth about its picture, and the live controls
 * rise to the top of the manage page when someone joins.
 *
 * Production, 2026-09-24: the booth said "ON AIR to 1 guest — they see you in
 * real time" while the guest was looking at OBS's "virtual camera not started"
 * image (data/obs-plugins/win-dshow/placeholder.png — byte for byte the picture
 * in the operator's screenshot, mirrored by the self-view). OBS Virtual Camera
 * emits that image as an ordinary, healthy 30fps track, so nothing the booth
 * checked could tell it from a person. The guest could hear the streamer and
 * never see him.
 *
 * ONE on-air session, the host's camera switched between three pictures:
 *   A. OBS's REAL placeholder, read from the OBS install and redrawn
 *      identically every frame, which is what OBS sends → the alert names the
 *      OBS logo and the status stops claiming "they see you".
 *   B. a moving picture → the alert CLEARS by itself. This is the
 *      discrimination: the same watch, in the same session, disagrees with A —
 *      and it is the recovery path (click Start Virtual Camera in OBS, no
 *      re-arm).
 *   C. a still picture that is NOT OBS's → a generic "still picture", never
 *      misnamed as the OBS logo.
 * And the layout: before anyone joins, the live block sits under the stream
 * preview; once a guest has a seat it sits above it — and the booth is the
 * SAME DOM node afterwards (a marker survives), so the reorder did not remount
 * it. A remount hangs the booth up, on a guest, the moment they arrive.
 *
 * Spends nothing: local SFU only (tools/livekit-server.exe --dev, no LiveKit
 * Cloud minutes) and a free room (no wallet, no payment).
 */
import { readFileSync, existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';
import { RoomServiceClient } from 'livekit-server-sdk';
import { assertFreshBuild, startGateServer } from './_gate-helpers.mjs';

const PORT = 3336;
const APP = `http://localhost:${PORT}`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PLACEHOLDER = process.env.OBS_PLACEHOLDER
  || 'C:/Program Files/obs-studio/data/obs-plugins/win-dshow/placeholder.png';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, step = 500) => {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); }
  return v;
};

console.log('\n── the booth picture, and the live block on top ─────────────────');

{
  const fresh = assertFreshBuild();
  ok('G0. the build under test is newer than the source it renders', fresh.ok, fresh.detail);
  if (!fresh.ok) { console.log(`\nRESULT: ${pass} pass, ${fail} fail`); process.exit(1); }
}
// The fingerprint is only proven against the REAL image. A synthetic lookalike
// would prove the code matches the code.
if (!existsSync(PLACEHOLDER)) {
  console.log(`  refusing: OBS's placeholder not found at ${PLACEHOLDER} (set OBS_PLACEHOLDER)`);
  process.exit(1);
}
const sfu = await fetch('http://localhost:7880/').then((r) => r.text()).catch(() => null);
if (sfu !== 'OK') {
  console.log('  refusing: local livekit-server not running — start tools/livekit-server.exe --dev');
  process.exit(1);
}
const placeholderUrl = `data:image/png;base64,${readFileSync(PLACEHOLDER).toString('base64')}`;

const svc = new RoomServiceClient('http://localhost:7880', 'devkey', 'secret');
const hostVideoTracks = async (roomId) => {
  const ps = await svc.listParticipants(`mc-${roomId}`).catch(() => []);
  const h = ps.find((p) => p.identity === `host:${roomId}`);
  return h ? (h.tracks || []).filter((t) => t.type === 1 || t.type === 'VIDEO' || t.source === 'CAMERA').length : -1;
};

// getUserMedia for the HOST: a camera whose picture the gate can switch live.
// Every mode is redrawn every frame, like a real device — a still picture is
// still a stream of frames, which is exactly why "a track is publishing"
// proved nothing.
const HOST_CAMERA = (placeholder) => {
  window.__picture = 'placeholder';
  const img = new Image();
  img.src = placeholder;
  navigator.mediaDevices.getUserMedia = async (c) => {
    const out = new MediaStream();
    if (c && c.video) {
      await img.decode().catch(() => {});
      const cv = document.createElement('canvas');
      cv.width = 1280; cv.height = 720;
      const ctx = cv.getContext('2d');
      let n = 0;
      setInterval(() => {
        n++;
        if (window.__picture === 'placeholder') {
          ctx.drawImage(img, 0, 0, 1280, 720);
        } else if (window.__picture === 'moving') {
          ctx.fillStyle = `hsl(${(n * 7) % 360},70%,50%)`;
          ctx.fillRect(0, 0, 1280, 720);
          ctx.fillStyle = '#fff'; ctx.font = 'bold 60px sans-serif';
          ctx.fillText(`HOST ${n}`, 480, 380);
        } else {
          ctx.fillStyle = '#3a3a3a'; ctx.fillRect(0, 0, 1280, 720);
          ctx.fillStyle = '#fff'; ctx.font = 'bold 80px sans-serif';
          ctx.fillText('BRB', 560, 390);
        }
      }, 33);
      cv.captureStream(30).getVideoTracks().forEach((t) => out.addTrack(t));
    }
    if (c && c.audio) {
      const ac = new AudioContext();
      const osc = ac.createOscillator();
      const dst = ac.createMediaStreamDestination();
      osc.connect(dst); osc.start();
      dst.stream.getAudioTracks().forEach((t) => out.addTrack(t));
    }
    return out;
  };
};
const GUEST_CAMERA = () => {
  navigator.mediaDevices.getUserMedia = async (c) => {
    const out = new MediaStream();
    if (c && c.video) {
      const cv = document.createElement('canvas');
      cv.width = 640; cv.height = 360;
      const ctx = cv.getContext('2d');
      setInterval(() => { ctx.fillStyle = `hsl(${Date.now() / 15 % 360},80%,50%)`; ctx.fillRect(0, 0, 640, 360); }, 66);
      cv.captureStream(15).getVideoTracks().forEach((t) => out.addTrack(t));
    }
    if (c && c.audio) {
      const ac = new AudioContext();
      const dst = ac.createMediaStreamDestination();
      const osc = ac.createOscillator(); osc.connect(dst); osc.start();
      dst.stream.getAudioTracks().forEach((t) => out.addTrack(t));
    }
    return out;
  };
};

const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-booth-picture-'));
const srv = await startGateServer({
  port: PORT, dataDir, label: 'booth-picture',
  env: { LIVEKIT_URL: 'ws://localhost:7880', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret' },
});
let browser = null;
let crashed = null;
try {
  const res = await fetch(`${APP}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Booth Picture', password: 'booth-pic', config: { transport: 'livekit', passkeyTickPrice: '0' } }),
  });
  const { room } = await res.json();
  if (!room?.id) throw new Error(`room create failed (${res.status})`);
  console.log(`  [setup] free livekit room ${room.id}`);

  browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', protocolTimeout: 90000,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  await browser.defaultBrowserContext().overridePermissions(APP, ['camera', 'microphone']);

  // ── the host: unlock the room the way the dashboard does, then arm ────────
  const host = await browser.newPage();
  await host.setViewport({ width: 1440, height: 1000 });
  host.on('dialog', (d) => void d.accept());
  await host.evaluateOnNewDocument(HOST_CAMERA, placeholderUrl);
  await host.evaluateOnNewDocument((id) => { try { localStorage.setItem('mc-last-room', JSON.stringify({ id })); } catch { /* */ } }, room.id);
  await host.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await host.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /unlock room/i.test(b.textContent)), { timeout: 30000 });
  await sleep(800);
  await host.evaluate(() => {
    const i = document.querySelector('input[type="password"][autocomplete="current-password"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'booth-pic');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('button')].find((b) => /unlock room/i.test(b.textContent)).click();
  });
  await host.waitForFunction(() => !!document.getElementById('cohost-booth'), { timeout: 30000 });
  await host.click('#cohost-booth');
  await host.waitForFunction(() => /armed/i.test(document.getElementById('boothStatus')?.textContent || ''), { timeout: 20000 });

  const where = () => host.evaluate(() => {
    const top = (sel) => document.querySelector(sel)?.getBoundingClientRect().top ?? null;
    return { live: top('.mcc-live'), booth: top('.mcc-booth-slot'), preview: top('.mcc-stream-card') };
  });
  const before = await where();
  ok('L1. nobody seated: the live block sits UNDER the stream preview', before.live > before.preview, JSON.stringify(before));
  await host.evaluate(() => { document.getElementById('cohost-booth').__sameNode = true; });

  // ── a guest goes live through the real join page ──────────────────────────
  const guest = await browser.newPage();
  guest.on('dialog', (d) => void d.accept());
  await guest.evaluateOnNewDocument(GUEST_CAMERA);
  await guest.goto(`${APP}/join?room=${room.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await guest.waitForSelector('#username', { timeout: 30000 });
  await sleep(1200);
  // The join page pre-fills a suggested guest name; clear it rather than append.
  await guest.evaluate(() => { const u = document.getElementById('username'); u.value = ''; u.dispatchEvent(new Event('input', { bubbles: true })); });
  await guest.type('#username', 'picture-guest');
  await guest.click('#joinBtn');
  await guest.waitForFunction(() => /go live/i.test(document.getElementById('joinBtn')?.textContent || ''), { timeout: 30000 });
  await guest.click('#joinBtn');
  await guest.waitForFunction(() => /you're live/i.test(document.getElementById('joinBtn')?.textContent || ''), { timeout: 30000 });
  console.log('  [guest] live');

  const tracks = await until(async () => ((await hostVideoTracks(room.id)) >= 1 ? await hostVideoTracks(room.id) : 0), 25000, 1500);
  ok('the booth went on air with a VIDEO track (the SFU lists it)', tracks >= 1, `videoTracks=${tracks}`);

  await host.bringToFront(); // a hidden tab stops painting video — the watch skips it on purpose
  const after = await where();
  ok('L2. a guest is seated: the live block is now ABOVE the stream preview', after.live < after.preview, JSON.stringify(after));
  ok('L2. ...and the booth moved with it', after.booth < after.preview);
  const same = await host.evaluate(() => document.getElementById('cohost-booth')?.__sameNode === true && document.getElementById('cohost-booth').checked);
  ok('L3. the booth was NOT remounted by the reorder (same node, still armed)', same);

  const verdict = () => host.evaluate(() => ({
    still: document.getElementById('boothStillPicture')?.dataset.still || null,
    title: document.querySelector('#boothStillPicture strong')?.textContent || '',
    status: document.getElementById('boothStatus')?.textContent || '',
  }));

  // ── A. OBS's placeholder ──────────────────────────────────────────────────
  let v = await until(async () => { const x = await verdict(); return x.still ? x : null; }, 20000);
  v = v || await verdict();
  ok('A. OBS placeholder going out → the booth names it', v.still === 'obs-placeholder', JSON.stringify(v));
  if (process.env.BOOTH_SHOT) { // opt-in: a picture of what the operator sees
    await host.evaluate(() => document.querySelector('.mcc-booth-slot')?.scrollIntoView({ block: 'center' }));
    await sleep(400);
    await (await host.$('.mcc-booth-slot'))?.screenshot({ path: process.env.BOOTH_SHOT });
  }
  ok('A. ...the alert says what the guest sees', /OBS logo, not you/.test(v.title), v.title);
  ok('A. ...and the status no longer claims "they see you in real time"',
    !/they see you in real time/.test(v.status) && /still picture/.test(v.status), v.status);

  // ── B. the picture moves (Start Virtual Camera clicked) ───────────────────
  await host.evaluate(() => { window.__picture = 'moving'; });
  v = await until(async () => { const x = await verdict(); return !x.still ? x : null; }, 10000);
  v = v || await verdict();
  ok('B. picture moves → the alert CLEARS by itself, no re-arm (disagrees with A)', !v.still, JSON.stringify(v));
  ok('B. ...and only now does it say "they see you in real time"', /they see you in real time/.test(v.status), v.status);

  // ── C. a still that is not OBS's ──────────────────────────────────────────
  await host.evaluate(() => { window.__picture = 'still'; });
  v = await until(async () => { const x = await verdict(); return x.still ? x : null; }, 20000);
  v = v || await verdict();
  ok('C. a still picture that is NOT OBS\'s → generic "still picture"', v.still === 'frozen', JSON.stringify(v));
  ok('C. ...never misnamed as the OBS logo', !/OBS logo/.test(v.title), v.title);

  await guest.evaluate(() => document.getElementById('joinBtn')?.click()).catch(() => {});
} catch (e) {
  crashed = e;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fail || crashed) { console.log('--- server output (tail) ---'); console.log(srv.stderr().slice(-4000)); }
  srv.kill();
}
if (crashed) { console.log(`\nGATE CRASHED: ${crashed.stack || crashed}`); process.exit(1); }
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
await sleep(1500);
process.exit(fail === 0 ? 0 : 1);
