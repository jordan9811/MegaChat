/**
 * GATE — echo: the booth plays the guests, the overlay stops playing them, and
 * a guest is never left silent on stream.
 *
 * Production, 2026-09-24: guests heard their own voice back. The overlay was
 * set to Monitor and Output in OBS, so a guest's voice came out of the
 * streamer's speakers, the booth mic picked it up, and it went straight back.
 * The browser's echo canceller (on by default) could not help: it subtracts
 * only what the SAME page played, and OBS is not the page. The streamer moved
 * the call to Discord and the echo vanished — because Discord plays and records
 * in one app. This is that shape: the booth plays the guests itself (the
 * canceller gets its reference), their voices reach the stream through OBS
 * Desktop Audio, and the overlay mutes them meanwhile so they are never on
 * stream twice.
 *
 * The one thing that must never happen is the overlay muting guests while the
 * booth is NOT actually playing them — a guest silent on stream. So the booth
 * claims `mc.guestAudio = 'booth'` only while a guest's audio element is really
 * playing, and this gate checks that claim against the element every time.
 *
 *   E1–E3  booth on air, guest live → the booth PLAYS the guest (an element,
 *          not paused, on a live track), claims 'booth', and the overlay's
 *          seat audio is muted.
 *   E4–E5  the setting off → no guest audio in the booth, claim 'overlay', the
 *          overlay plays the guest again; back on → muted again. (discrimination)
 *   E6     the booth tab closes → the overlay plays the guest again at once.
 *   E7     a booth re-armed after a reload, with NO user gesture (the
 *          autoplay-blocked case): whatever the browser allows, the claim
 *          never runs ahead of playback — and if playback is blocked the
 *          overlay keeps the guest and the booth offers one button.
 *
 * Echo cancellation itself needs a room and a speaker; it is Chrome's, and this
 * gate proves only the routing that lets it work.
 *
 * Spends nothing: local SFU (tools/livekit-server.exe --dev), free room.
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';
import { RoomServiceClient } from 'livekit-server-sdk';
import { assertFreshBuild, startGateServer } from './_gate-helpers.mjs';

const PORT = 3337;
const APP = `http://localhost:${PORT}`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

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

console.log('\n── echo: the booth carries the guests ───────────────────────────');
{
  const fresh = assertFreshBuild();
  ok('G0. the build under test is newer than the source it renders', fresh.ok, fresh.detail);
  if (!fresh.ok) { console.log(`\nRESULT: ${pass} pass, ${fail} fail`); process.exit(1); }
}
if ((await fetch('http://localhost:7880/').then((r) => r.text()).catch(() => null)) !== 'OK') {
  console.log('  refusing: local livekit-server not running — start tools/livekit-server.exe --dev');
  process.exit(1);
}
const svc = new RoomServiceClient('http://localhost:7880', 'devkey', 'secret');
const hostClaim = async (roomId) => {
  const ps = await svc.listParticipants(`mc-${roomId}`).catch(() => []);
  const h = ps.find((p) => p.identity === `host:${roomId}`);
  return h ? (h.attributes?.['mc.guestAudio'] ?? '(unset)') : '(no host)';
};

// A camera that moves (so the picture goes live) and a mic that hums.
const MEDIA = (label) => {
  navigator.mediaDevices.getUserMedia = async (c) => {
    const out = new MediaStream();
    if (c && c.video) {
      const cv = document.createElement('canvas');
      cv.width = 640; cv.height = 360;
      const ctx = cv.getContext('2d');
      let n = 0;
      setInterval(() => { n++; ctx.fillStyle = `hsl(${(n * 9) % 360},70%,50%)`; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = '#fff'; ctx.font = 'bold 40px sans-serif'; ctx.fillText(`${label} ${n}`, 230, 195); }, 50);
      cv.captureStream(20).getVideoTracks().forEach((t) => out.addTrack(t));
    }
    if (c && c.audio) {
      const ac = new AudioContext();
      const osc = ac.createOscillator();
      osc.frequency.value = label === 'GUEST' ? 440 : 660;
      const dst = ac.createMediaStreamDestination();
      osc.connect(dst); osc.start();
      dst.stream.getAudioTracks().forEach((t) => out.addTrack(t));
    }
    return out;
  };
};

// What the booth is really doing with guest audio, from its own DOM.
const boothAudio = (page) => page.evaluate(() => {
  const els = [...document.querySelectorAll('[data-guest-audio] audio')];
  return {
    count: els.length,
    playing: els.filter((a) => !a.paused && !a.ended && a.srcObject && a.srcObject.getAudioTracks().some((t) => t.readyState === 'live')).length,
    blockedButton: !!document.getElementById('boothHearGuests'),
    footer: [...document.querySelectorAll('p')].map((p) => p.textContent).find((t) => /Keep this tab open/.test(t || '')) || '',
  };
});
const overlayAudio = (page) => page.evaluate(() => {
  const els = [...document.querySelectorAll('audio[data-lk-seat]')];
  return { count: els.length, muted: els.filter((a) => a.muted).length };
});

const unlockAndArm = async (page, roomId, { arm = true } = {}) => {
  await page.evaluateOnNewDocument((id) => { try { localStorage.setItem('mc-last-room', JSON.stringify({ id })); } catch { /* */ } }, roomId);
  await page.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /unlock room/i.test(b.textContent)), { timeout: 30000 });
  await sleep(800);
  await page.evaluate(() => {
    const i = document.querySelector('input[type="password"][autocomplete="current-password"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'booth-audio');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('button')].find((b) => /unlock room/i.test(b.textContent)).click();
  });
  await page.waitForFunction(() => !!document.getElementById('cohost-booth'), { timeout: 30000 });
  if (arm) {
    await page.click('#cohost-booth');
    // A guest may already be live, in which case the status goes straight to ON AIR.
    await page.waitForFunction(() => /armed|on air/i.test(document.getElementById('boothStatus')?.textContent || ''), { timeout: 20000 });
  }
};

const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-booth-audio-'));
const srv = await startGateServer({
  port: PORT, dataDir, label: 'booth-audio',
  env: { LIVEKIT_URL: 'ws://localhost:7880', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret' },
});
let browser = null, strict = null, crashed = null;
try {
  const res = await fetch(`${APP}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Booth Audio', password: 'booth-audio', config: { transport: 'livekit', passkeyTickPrice: '0' } }),
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

  // Each page its own window: a background tab stops painting and throttles.
  const host = await browser.newPage();
  host.on('dialog', (d) => void d.accept());
  await host.evaluateOnNewDocument(MEDIA, 'HOST');
  await unlockAndArm(host, room.id);
  ok('the Echo cancellation setting is there and ON by default',
    await host.evaluate(() => document.getElementById('booth-hear')?.checked === true));

  const overlayCtx = await browser.createBrowserContext();
  const overlay = await overlayCtx.newPage();
  await overlay.setViewport({ width: 1920, height: 1080 });
  await overlay.goto(`${APP}/overlay?room=${room.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const guestCtx = await browser.createBrowserContext();
  await guestCtx.overridePermissions(APP, ['camera', 'microphone']);
  const guest = await guestCtx.newPage();
  guest.on('dialog', (d) => void d.accept());
  await guest.evaluateOnNewDocument(MEDIA, 'GUEST');
  await guest.goto(`${APP}/join?room=${room.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await guest.waitForSelector('#username', { timeout: 30000 });
  await sleep(1200);
  await guest.evaluate(() => { const u = document.getElementById('username'); u.value = ''; u.dispatchEvent(new Event('input', { bubbles: true })); });
  await guest.type('#username', 'echo-guest');
  await guest.click('#joinBtn');
  await guest.waitForFunction(() => /go live/i.test(document.getElementById('joinBtn')?.textContent || ''), { timeout: 30000 });
  await guest.click('#joinBtn');
  await guest.waitForFunction(() => /you're live/i.test(document.getElementById('joinBtn')?.textContent || ''), { timeout: 30000 });
  console.log('  [guest] live');

  // ── E1–E3 ──────────────────────────────────────────────────────────────────
  let b = await until(async () => { const x = await boothAudio(host); return x.playing >= 1 ? x : null; }, 25000);
  b = b || await boothAudio(host);
  ok('E1. the booth PLAYS the guest (an element, not paused, on a live track)', b.playing >= 1, JSON.stringify(b));
  let claim = await until(async () => ((await hostClaim(room.id)) === 'booth' ? 'booth' : null), 10000);
  claim = claim || await hostClaim(room.id);
  ok('E2. ...and only then claims it: mc.guestAudio = booth', claim === 'booth', claim);
  let o = await until(async () => { const x = await overlayAudio(overlay); return x.count >= 1 && x.muted === x.count ? x : null; }, 20000);
  o = o || await overlayAudio(overlay);
  ok('E3. the overlay has the guest\'s audio and has muted it (never on stream twice)', o.count >= 1 && o.muted === o.count, JSON.stringify(o));
  ok('E3. ...exactly ONE audio element for the one guest (it used to be two, stacked)', o.count === 1, JSON.stringify(o));
  ok('E3. the booth says it carries the guests\' voices', /guests’ voices/.test(b.footer), b.footer);

  // ── E4–E5: the setting off, then on ────────────────────────────────────────
  await host.click('#booth-hear');
  b = await until(async () => { const x = await boothAudio(host); return x.count === 0 ? x : null; }, 8000);
  b = b || await boothAudio(host);
  ok('E4. setting off → no guest audio left in the booth', b.count === 0, JSON.stringify(b));
  claim = await until(async () => ((await hostClaim(room.id)) === 'overlay' ? 'overlay' : null), 8000);
  claim = claim || await hostClaim(room.id);
  ok('E4. ...the claim goes back to overlay', claim === 'overlay', claim);
  o = await until(async () => { const x = await overlayAudio(overlay); return x.count >= 1 && x.muted === 0 ? x : null; }, 8000);
  o = o || await overlayAudio(overlay);
  ok('E4. ...and the overlay plays the guest again (disagrees with E3)', o.count >= 1 && o.muted === 0, JSON.stringify(o));
  await host.click('#booth-hear');
  o = await until(async () => { const x = await overlayAudio(overlay); return x.count >= 1 && x.muted === x.count ? x : null; }, 10000);
  o = o || await overlayAudio(overlay);
  ok('E5. setting back on → the overlay mutes the guest again', o.count >= 1 && o.muted === o.count, JSON.stringify(o));

  // ── E6: the booth tab closes ───────────────────────────────────────────────
  await host.close({ runBeforeUnload: false });
  o = await until(async () => { const x = await overlayAudio(overlay); return x.count >= 1 && x.muted === 0 ? x : null; }, 15000);
  o = o || await overlayAudio(overlay);
  ok('E6. the booth tab closes → the overlay plays the guest again (never silent on stream)', o.count >= 1 && o.muted === 0, JSON.stringify(o));

  // ── E7: re-armed after a reload, no gesture, default autoplay policy ───────
  strict = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', protocolTimeout: 90000,
    // The strictest policy Chrome has: no sound without a user gesture. The
    // default one let a capturing page autoplay, so the blocked branch never ran.
    args: ['--autoplay-policy=user-gesture-required', '--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  await strict.defaultBrowserContext().overridePermissions(APP, ['camera', 'microphone']);
  const host2 = await strict.newPage();
  host2.on('dialog', (d) => void d.accept());
  await host2.evaluateOnNewDocument(MEDIA, 'HOST');
  await unlockAndArm(host2, room.id);           // the arm click is a gesture...
  await host2.reload({ waitUntil: 'domcontentloaded' }); // ...a reload throws it away
  await host2.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /unlock room/i.test(b.textContent)), { timeout: 30000 });
  await sleep(800);
  await host2.evaluate(() => {
    const i = document.querySelector('input[type="password"][autocomplete="current-password"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'booth-audio');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('button')].find((b) => /unlock room/i.test(b.textContent)).click();
  });
  await host2.waitForFunction(() => document.getElementById('cohost-booth')?.checked === true, { timeout: 30000 });
  await until(async () => (await boothAudio(host2)).count >= 1, 25000);
  await sleep(2500);
  // The invariant, sampled: the claim never runs ahead of real playback.
  let lies = 0, samples = 0, sawBlocked = false, sawPlaying = false;
  for (let i = 0; i < 12; i++) {
    const [ba, c, oa] = await Promise.all([boothAudio(host2), hostClaim(room.id), overlayAudio(overlay)]);
    samples++;
    if (ba.blockedButton) sawBlocked = true;
    if (ba.playing > 0) sawPlaying = true;
    if (oa.muted > 0 && ba.playing === 0) lies++; // guest muted on stream with nothing playing them
    if (c === 'booth' && ba.playing === 0) lies++;
    await sleep(250);
  }
  ok('E7. no reload/autoplay state ever mutes the guest on stream while the booth is not playing them', lies === 0,
    `${lies} violation(s) in ${samples} samples; ${sawBlocked ? 'autoplay BLOCKED' : 'autoplay allowed'}; booth ${sawPlaying ? 'playing' : 'not playing'}`);
  if (sawBlocked) {
    o = await overlayAudio(overlay);
    ok('E7. blocked → the overlay keeps playing the guest', o.count >= 1 && o.muted === 0, JSON.stringify(o));
    await host2.click('#boothHearGuests');
    o = await until(async () => { const x = await overlayAudio(overlay); return x.count >= 1 && x.muted === x.count ? x : null; }, 10000);
    o = o || await overlayAudio(overlay);
    ok('E7. one click → the booth plays them and the overlay mutes', o.count >= 1 && o.muted === o.count && (await boothAudio(host2)).playing >= 1, JSON.stringify(o));
  } else {
    // Measured: even under --autoplay-policy=user-gesture-required, Chrome lets
    // this page play. An on-air booth is capturing the mic, and a capturing page
    // may always play audio — so the blocked branch cannot arise while the booth
    // is live. The button stays as a defence; this gate cannot reach it.
    console.log('  NOTE  E7. playback allowed with no gesture under the strictest policy (the page is capturing) — the blocked branch is defensive and was not reachable');
  }
  await guest.evaluate(() => document.getElementById('joinBtn')?.click()).catch(() => {});
} catch (e) {
  crashed = e;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (strict) await strict.close().catch(() => {});
  if (fail || crashed) { console.log('--- server output (tail) ---'); console.log(srv.stderr().slice(-4000)); }
  srv.kill();
}
if (crashed) { console.log(`\nGATE CRASHED: ${crashed.stack || crashed}`); process.exit(1); }
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
await sleep(1500);
process.exit(fail === 0 ? 0 : 1);
