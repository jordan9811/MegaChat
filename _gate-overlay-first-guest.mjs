/**
 * GATE — the FIRST guest of a session is played once, not twice.
 *
 * The booth connects when the first guest goes live, and a guest has already
 * published by then (their camera preview is up at "hit GO LIVE"). So the
 * overlay receives the first guest's audio BEFORE it has a tile for them, and
 * before any booth has claimed them. The overlay live on 2026-09-24 (ab8a5f9)
 * attached that audio to a tile not yet in the page: an <audio> element that
 * played but that no mute could reach. With the booth in This-tab mode the
 * streamer then heard the guest twice — once from the booth tab, once from OBS
 * monitoring — two WebRTC receivers tens of milliseconds apart, which is the
 * comb-filtered "robotic" sound he reported that night. (Nothing recorded what
 * he heard, so this is the mechanism, not proof it was the cause.)
 *
 * Checks, for the first guest, with the booth in This tab:
 *   F1  the booth plays the guest (the precondition)
 *   F2  the overlay has exactly ONE audio element for them, inside the page
 *   F3  no overlay element is audibly playing them while the booth does
 *
 * Prove it discriminates: pass --overlay /<file>.html to serve an older overlay
 * from public/ (e.g. git show ab8a5f9:public/overlay.html) — it must FAIL F2/F3.
 *
 * Spends nothing: local SFU (tools/livekit-server.exe --dev), free room.
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';
import { assertFreshBuild, startGateServer } from './_gate-helpers.mjs';

const PORT = 3338;
const APP = `http://localhost:${PORT}`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const oi = process.argv.indexOf('--overlay');
const OVERLAY_PATH = oi > 0 ? process.argv[oi + 1] : '/overlay';

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

console.log(`\n── the first guest is played once (overlay: ${OVERLAY_PATH}) ──`);
{
  const fresh = assertFreshBuild();
  ok('G0. the build under test is newer than the source it renders', fresh.ok, fresh.detail);
  if (!fresh.ok) { console.log(`\nRESULT: ${pass} pass, ${fail} fail`); process.exit(1); }
}
if ((await fetch('http://localhost:7880/').then((r) => r.text()).catch(() => null)) !== 'OK') {
  console.log('  refusing: local livekit-server not running — start tools/livekit-server.exe --dev');
  process.exit(1);
}

const TONE = (hz) => {
  navigator.mediaDevices.getUserMedia = async (c) => {
    const out = new MediaStream();
    if (c && c.video) {
      const cv = document.createElement('canvas');
      cv.width = 320; cv.height = 180;
      const ctx = cv.getContext('2d');
      let n = 0;
      setInterval(() => { n++; ctx.fillStyle = `hsl(${(n * 9) % 360},70%,50%)`; ctx.fillRect(0, 0, 320, 180); }, 50);
      cv.captureStream(20).getVideoTracks().forEach((t) => out.addTrack(t));
    }
    if (c && c.audio) {
      const ac = new AudioContext();
      const osc = ac.createOscillator(); osc.frequency.value = hz;
      const dst = ac.createMediaStreamDestination();
      osc.connect(dst); osc.start();
      dst.stream.getAudioTracks().forEach((t) => out.addTrack(t));
    }
    return out;
  };
};

const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-first-guest-'));
const srv = await startGateServer({
  port: PORT, dataDir, label: 'first-guest',
  env: { LIVEKIT_URL: 'ws://localhost:7880', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret' },
});
let browser = null, crashed = null;
try {
  const res = await fetch(`${APP}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'First Guest', password: 'first-guest', config: { transport: 'livekit', passkeyTickPrice: '0' } }),
  });
  const { room } = await res.json();
  if (!room?.id) throw new Error(`room create failed (${res.status})`);
  console.log(`  [setup] free livekit room ${room.id}`);

  browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', protocolTimeout: 120000,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const ctx = async () => {
    const c = await browser.createBrowserContext();
    await c.overridePermissions(APP, ['camera', 'microphone']);
    return c;
  };

  // The booth, armed, in This tab — the mode that was live that night.
  const host = await (await ctx()).newPage();
  host.on('dialog', (d) => void d.accept());
  await host.evaluateOnNewDocument(TONE, 330);
  await host.evaluateOnNewDocument((id) => {
    try { localStorage.setItem('mc-last-room', JSON.stringify({ id })); localStorage.setItem('mc-booth-aec', 'tab'); } catch { /* */ }
  }, room.id);
  await host.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await host.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /unlock room/i.test(b.textContent)), { timeout: 30000 });
  await sleep(800);
  await host.evaluate(() => {
    const i = document.querySelector('input[type="password"][autocomplete="current-password"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'first-guest');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('button')].find((b) => /unlock room/i.test(b.textContent)).click();
  });
  await host.waitForFunction(() => !!document.getElementById('cohost-booth'), { timeout: 30000 });
  await host.click('#cohost-booth');
  await host.waitForFunction(() => /armed/i.test(document.getElementById('boothStatus')?.textContent || ''), { timeout: 20000 });
  await host.waitForSelector('#booth-aec-tab', { timeout: 10000 });
  await host.click('#booth-aec-tab');

  const ov = await (await ctx()).newPage();
  await ov.goto(`${APP}${OVERLAY_PATH}?room=${room.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000); // the overlay is up and connected before anyone arrives

  // The first guest: publishes at "hit GO LIVE", goes live 3s later.
  const g = await (await ctx()).newPage();
  g.on('dialog', (d) => void d.accept());
  await g.evaluateOnNewDocument(TONE, 440);
  await g.goto(`${APP}/join?room=${room.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await g.waitForSelector('#username', { timeout: 30000 });
  await sleep(1200);
  await g.evaluate(() => { const u = document.getElementById('username'); u.value = ''; u.dispatchEvent(new Event('input', { bubbles: true })); });
  await g.type('#username', 'first-guest');
  await g.click('#joinBtn');
  await g.waitForFunction(() => /go live/i.test(document.getElementById('joinBtn')?.textContent || ''), { timeout: 30000 });
  await sleep(3000);
  await g.click('#joinBtn');
  await g.waitForFunction(() => /you're live/i.test(document.getElementById('joinBtn')?.textContent || ''), { timeout: 30000 });
  console.log('  [guest] live (published 3s before going live)');

  const boothPlays = () => host.evaluate(() => [...document.querySelectorAll('[data-guest-audio] audio')]
    .filter((a) => !a.paused && !a.ended).map((a) => a.dataset.seat));
  const b = await until(async () => { const x = await boothPlays(); return x.length ? x : null; }, 30000);
  ok('F1. the booth (This tab) plays the first guest', !!b && b.length === 1, JSON.stringify(b));
  await sleep(5000); // let any claim land and settle

  // LiveKit's own list of every element the guest's audio is attached to —
  // it includes elements that were never put in the page.
  const att = await ov.evaluate(() => {
    // eslint-disable-next-line no-undef
    const room = typeof lkOverlayRoom !== 'undefined' ? lkOverlayRoom : null;
    if (!room) return null;
    for (const p of room.remoteParticipants.values()) {
      if (!p.identity.startsWith('seat:')) continue;
      for (const pub of p.audioTrackPublications.values()) {
        const els = (pub.track && pub.track.attachedElements) || [];
        return {
          attached: els.length,
          outsidePage: els.filter((e) => !e.isConnected).length,
          audible: els.filter((e) => !e.paused && !e.ended && !e.muted).length,
          audibleOutsidePage: els.filter((e) => !e.isConnected && !e.paused && !e.ended && !e.muted).length,
        };
      }
    }
    return { attached: 0, outsidePage: 0, audible: 0, audibleOutsidePage: 0 };
  });
  ok('F2. exactly ONE overlay audio element for the guest, inside the page', !!att && att.attached === 1 && att.outsidePage === 0, JSON.stringify(att));
  ok('F3. the overlay is NOT also playing the guest while the booth does (heard once, not twice)', !!att && att.audible === 0, JSON.stringify(att));
} catch (e) {
  crashed = e;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fail || crashed) { console.log('--- server output (tail) ---'); console.log(srv.stderr().slice(-2500)); }
  srv.kill();
}
if (crashed) { console.log(`\nGATE CRASHED: ${crashed.stack || crashed}`); process.exit(1); }
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
await sleep(1000);
process.exit(fail === 0 ? 0 : 1);
