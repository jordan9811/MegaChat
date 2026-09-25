/**
 * GATE — no screen ever shows a picture that is not the streamer, and the live
 * controls rise to the top of the manage page when someone joins.
 *
 * Production, 2026-09-24: the booth said "ON AIR to 1 guest — they see you in
 * real time" while the guest was looking at OBS's "virtual camera not started"
 * image (data/obs-plugins/win-dshow/placeholder.png — byte for byte the picture
 * in the operator's screenshot). OBS Virtual Camera emits that image as an
 * ordinary, healthy 30fps track, so nothing the booth checked could tell it
 * from a person. A first fix annotated the placeholder with a warning; the
 * owner's verdict was that it must not appear ANYWHERE. So the requirement
 * this gate enforces is that it is never rendered — not in the booth's
 * self-view, not on the guest's page — and the proof is instrumentation, not a
 * spot check: both pages are sampled every 100ms for the whole session.
 *
 * ONE on-air session, the host's camera switched between pictures:
 *   A. OBS's REAL placeholder from the first frame (read from the OBS install;
 *      the gate refuses to run without it) → both sides hold a designed state,
 *      the status claims nothing, and across the whole phase the guest page
 *      shows the host's picture ZERO times and the booth exposes it ZERO times.
 *   B. a moving picture → it appears on both sides by itself, no re-arm. The
 *      same instrumentation now counts real sightings: the discrimination.
 *   C. a still that is not OBS's → both sides hold it back again, named as a
 *      stopped camera, never as the OBS logo.
 *   D. back to OBS's placeholder mid-session (OBS Virtual Camera stopped) → held
 *      within the documented window (OBS_AFTER samples), not "never" — the one
 *      place a picture can already be showing when it turns into the logo.
 * And the layout: under the stream preview before anyone joins, above it once a
 * guest has a seat, and the booth is the SAME DOM node afterwards (a marker
 * survives) — the reorder did not remount it and hang up on the guest.
 *
 * Spends nothing: local SFU (tools/livekit-server.exe --dev), free room.
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
const SHOTS = process.env.BOOTH_SHOTS || null; // opt-in: a directory for screenshots

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, step = 250) => {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); }
  return v;
};

console.log('\n── no picture that is not the streamer, anywhere ────────────────');

{
  const fresh = assertFreshBuild();
  ok('G0. the build under test is newer than the source it renders', fresh.ok, fresh.detail);
  if (!fresh.ok) { console.log(`\nRESULT: ${pass} pass, ${fail} fail`); process.exit(1); }
}
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

// The HOST's camera, switchable live. Every mode is redrawn every frame, like a
// real device: a still picture is still a stream of frames.
const HOST_CAMERA = (placeholder) => {
  window.__picture = 'placeholder';
  window.__exposed = []; // booth self-view exposed while the placeholder was going out
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
  // Is the booth's self-view picture exposed (no held tile over it) while the
  // camera is sending OBS's placeholder?
  setInterval(() => {
    const v = document.querySelector('.mcc-booth-slot video');
    if (!v || !v.videoWidth || v.offsetParent === null) return;
    if (document.getElementById('boothPictureHeld')) return;
    if (window.__picture === 'placeholder') window.__exposed.push({ t: Date.now(), phase: window.__phase || '' });
  }, 100);
};

// The GUEST: its own camera, plus a probe on what it shows of the host.
const GUEST = (fingerprint) => {
  window.__seen = []; // every 100ms the host picture was VISIBLE: { t, phase, obs }
  window.__watching = {}; // phase → probe ticks with a mounted host feed (proves zero is not vacuous)
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
  const probe = document.createElement('canvas');
  probe.width = 64; probe.height = 36;
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  setInterval(() => {
    const wrap = document.getElementById('hostLiveFeed');
    const v = document.querySelector('#hostLiveMount video');
    if (!wrap || wrap.style.display === 'none' || !v || !v.videoWidth) return;
    const ph = window.__phase || '';
    if (document.visibilityState === 'visible') window.__watching[ph] = (window.__watching[ph] || 0) + 1;
    const held = document.getElementById('hostFeedHeld');
    const covered = held && held.style.display !== 'none';
    if (covered || getComputedStyle(v).visibility === 'hidden') return;
    pctx.drawImage(v, 0, 0, 64, 36);
    const px = pctx.getImageData(0, 0, 64, 36).data;
    const obs = fingerprint.every(([x, y, rgb]) => {
      const i = ((y * 4 + 2) * 64 + (x * 4 + 2)) * 4;
      return [px[i], px[i + 1], px[i + 2]].every((ch, k) => Math.abs(ch - rgb[k]) <= 24);
    });
    window.__seen.push({ t: Date.now(), phase: window.__phase || '', obs });
  }, 100);
};
// Same five flat regions the booth uses (web/components/host-cam-card.tsx).
const FINGERPRINT = [[14, 0, [33, 41, 84]], [15, 2, [33, 41, 84]], [2, 3, [35, 48, 108]], [0, 8, [24, 26, 48]], [13, 8, [24, 26, 48]]];

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
  const phased = []; // every page that records by phase
  const phase = async (name) => {
    for (const pg of phased) await pg.evaluate((n) => { window.__phase = n; }, name).catch(() => {});
  };

  // ── the host: unlock the room the way the dashboard does, then arm ────────
  const host = await browser.newPage();
  await host.setViewport({ width: 1440, height: 1000 });
  phased.push(host);
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

  // ── A. a guest goes live while the host's camera is OBS's placeholder ──────
  await phase('A');
  // Its OWN window: a background tab stops painting video, so a guest tab
  // behind the host tab would record "zero sightings" by not looking at all.
  const guestCtx = await browser.createBrowserContext();
  await guestCtx.overridePermissions(APP, ['camera', 'microphone']);
  const guest = await guestCtx.newPage();
  phased.push(guest);
  await guest.setViewport({ width: 1280, height: 900 });
  guest.on('dialog', (d) => void d.accept());
  await guest.evaluateOnNewDocument(GUEST, FINGERPRINT);
  await guest.evaluateOnNewDocument(() => { window.__phase = 'A'; });
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

  const tracks = await until(async () => ((await hostVideoTracks(room.id)) >= 1 ? 1 : 0), 25000, 1500);
  ok('the booth went on air with a VIDEO track (the SFU lists it)', tracks >= 1);

  await host.bringToFront(); // a hidden tab stops painting video — the watch skips it on purpose
  const after = await where();
  ok('L2. a guest is seated: the live block is now ABOVE the stream preview', after.live < after.preview, JSON.stringify(after));
  ok('L2. ...and the booth moved with it', after.booth < after.preview);
  ok('L3. the booth was NOT remounted by the reorder (same node, still armed)',
    await host.evaluate(() => document.getElementById('cohost-booth')?.__sameNode === true && document.getElementById('cohost-booth').checked));

  const booth = () => host.evaluate(() => ({
    held: document.getElementById('boothPictureHeld')?.dataset.state || null,
    text: document.getElementById('boothPictureHeld')?.innerText.replace(/\s+/g, ' ').trim() || '',
    status: document.getElementById('boothStatus')?.textContent || '',
  }));
  const seen = () => guest.evaluate(() => ({
    held: document.getElementById('hostFeedHeld')?.style.display !== 'none' ? document.getElementById('hostFeedHeld')?.dataset.state : null,
    title: document.getElementById('hostFeedHeldTitle')?.textContent || '',
  }));

  let b = await until(async () => { const x = await booth(); return x.held === 'obs' ? x : null; }, 15000);
  b = b || await booth();
  ok('A. the booth holds the placeholder back and names the cause', b.held === 'obs' && /OBS Virtual Camera isn’t started/.test(b.text), JSON.stringify(b));
  ok('A. ...and the status claims nothing about being seen', /voice only/.test(b.status) && !/see you/.test(b.status), b.status);
  let g = await until(async () => { const x = await seen(); return x.held === 'still' ? x : null; }, 10000);
  g = g || await seen();
  ok('A. the guest page holds the host\'s picture back with a designed state', g.held === 'still' && /Host camera is off/.test(g.title), JSON.stringify(g));
  await sleep(3000); // let the whole phase soak under instrumentation
  if (SHOTS) {
    await host.evaluate(() => document.querySelector('.mcc-booth-slot')?.scrollIntoView({ block: 'center' }));
    await sleep(300);
    await (await host.$('.mcc-booth-slot'))?.screenshot({ path: path.join(SHOTS, 'booth-held.png') });
    await guest.bringToFront();
    await (await guest.$('#hostLiveFeed'))?.screenshot({ path: path.join(SHOTS, 'guest-held.png') });
    await host.bringToFront();
  }
  const watchedA = await guest.evaluate(() => window.__watching.A || 0);
  ok('A. the guest probe was really watching a mounted host feed (so zero means zero)', watchedA > 20, `${watchedA} probe ticks`);
  const guestA = await guest.evaluate(() => window.__seen.filter((s) => s.phase === 'A'));
  const boothA = await host.evaluate(() => window.__exposed.filter((s) => s.phase === 'A'));
  ok('A. the guest page showed the host\'s picture ZERO times while it was OBS\'s placeholder', guestA.length === 0,
    `${guestA.length} visible sample(s), ${guestA.filter((s) => s.obs).length} of them the OBS logo`);
  ok('A. the booth\'s self-view exposed the placeholder ZERO times', boothA.length === 0, `${boothA.length} exposed sample(s)`);

  // ── B. the picture moves (Start Virtual Camera clicked in OBS) ────────────
  await phase('B');
  await host.evaluate(() => { window.__picture = 'moving'; });
  b = await until(async () => { const x = await booth(); return !x.held ? x : null; }, 10000);
  b = b || await booth();
  ok('B. picture moves → the booth shows it by itself, no re-arm', !b.held, JSON.stringify(b));
  ok('B. ...and only now says "they see you in real time"', /they see you in real time/.test(b.status), b.status);
  g = await until(async () => { const x = await seen(); return !x.held ? x : null; }, 10000);
  g = g || await seen();
  ok('B. the guest page shows the host by itself', !g.held, JSON.stringify(g));
  await guest.bringToFront(); await sleep(2500); await host.bringToFront();
  const guestB = await guest.evaluate(() => window.__seen.filter((s) => s.phase === 'B'));
  ok('B. the same probe that counted zero in A now counts real sightings (discriminates)', guestB.length > 5 && guestB.every((s) => !s.obs),
    `${guestB.length} visible sample(s), ${guestB.filter((s) => s.obs).length} OBS`);
  if (SHOTS) {
    await guest.bringToFront();
    await (await guest.$('#hostLiveFeed'))?.screenshot({ path: path.join(SHOTS, 'guest-live.png') });
    await host.bringToFront();
    await (await host.$('.mcc-booth-slot'))?.screenshot({ path: path.join(SHOTS, 'booth-live.png') });
  }

  // ── C. a still that is not OBS's ──────────────────────────────────────────
  await phase('C');
  await host.evaluate(() => { window.__picture = 'still'; });
  b = await until(async () => { const x = await booth(); return x.held === 'still' ? x : null; }, 10000);
  b = b || await booth();
  ok('C. a frozen non-OBS picture → held on the booth, named as a stopped camera', b.held === 'still' && /stopped sending a picture/.test(b.text) && !/OBS/.test(b.text), JSON.stringify(b));
  g = await until(async () => { const x = await seen(); return x.held === 'still' ? x : null; }, 10000);
  g = g || await seen();
  ok('C. ...and held on the guest page', g.held === 'still', JSON.stringify(g));

  // ── D. back to the placeholder mid-session (OBS Virtual Camera stopped) ────
  await phase('B2');
  await host.evaluate(() => { window.__picture = 'moving'; });
  await until(async () => !(await booth()).held, 10000);
  await until(async () => !(await seen()).held, 10000);
  await phase('D');
  const tD = Date.now();
  await host.evaluate(() => { window.__picture = 'placeholder'; });
  const heldAt = await until(async () => ((await booth()).held === 'obs' ? Date.now() : 0), 10000, 100);
  ok('D. placeholder mid-session → the booth holds it within ~1.5s (OBS_AFTER samples)', heldAt && heldAt - tD <= 1500, `${heldAt ? heldAt - tD : 'never'}ms`);
  const guestHeldAt = await until(async () => ((await seen()).held === 'still' ? Date.now() : 0), 10000, 100);
  ok('D. ...and the guest page within ~2.5s', guestHeldAt && guestHeldAt - tD <= 2500, `${guestHeldAt ? guestHeldAt - tD : 'never'}ms`);

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
