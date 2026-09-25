/**
 * GATE — echo cancellation: the streamer hears guests as before, guests never
 * hear themselves, and no guest is ever silent or doubled on stream.
 *
 * History. Guests heard their own voice back: OBS monitored the overlay to the
 * streamer's speakers, the booth mic heard it, and `echoCancellation: true`
 * could not cancel it — that mode only subtracts what Chrome itself played.
 * The first fix (ab8a5f9) had the booth play the guests, which cured the echo,
 * but the streamer heard them "robotic": that overlay also played the FIRST
 * guest from an element no mute could reach, so he heard every first guest
 * twice (_gate-overlay-first-guest.mjs). Three ways to hear guests now:
 *   This tab (default)  the booth plays them, the mic cancels them (Discord's way)
 *   OBS · headphones    the overlay plays them to OBS as before; nothing to cancel
 *   OBS · speakers      the overlay plays them; the mic asks Chrome 154 for
 *                       'all', which cancels everything the PC plays (and, under
 *                       loud playback, gates the streamer's voice for guests —
 *                       _probe-aec-doubletalk.mjs). Falls back to This tab
 *                       whenever Chrome will not grant 'all'.
 *
 * Getting that wrong has two faces on a live stream: a guest silent (the
 * overlay muted, the booth not playing them) or doubled (both playing). So
 * alongside the scenario checks, this gate samples ONE invariant every 250ms —
 * for each guest, exactly one of {booth, overlay} is playing them — allows a
 * violation to last only as long as a handover, and proves with a negative
 * control that the sampler can see one.
 *
 * The host's getUserMedia is a shim that behaves like Chrome would: it records
 * the echoCancellation each request asked for, reports 'all' in getSettings()
 * only when 'all' was asked for and "Chrome" grants it, and can refuse 'all',
 * throw on it, or be slow to open the mic or the camera.
 *
 *   S1   default This tab → the booth plays the guest with the ordinary
 *        canceller (never 'all'), receives their audio only, claims exactly
 *        that seat; the overlay mutes that seat
 *   S2   "OBS · speakers" → 'all'; the booth plays nobody and receives nothing
 *        of the guest's; the overlay plays them
 *   S2b  "OBS · headphones" → the mic restarts WITHOUT 'all'; still the overlay
 *   S3   back to "This tab" → played here again, with no mic restart
 *   S3b  "OBS · headphones" from This tab → handed to the overlay, no restart
 *   S4   Chrome REFUSES 'all' at the start, with a SLOW camera → automatic
 *        This-tab, and the claim goes out with the playback, not after the
 *        camera (the invariant would see the guest doubled otherwise)
 *   S5   'all' THROWS at the start → still on air, This-tab, one host only
 *   S5b  a mic RESTART that throws (LiveKit stops the old mic first) → the
 *        booth brings a plain mic back instead of leaving it dead
 *   S6   the mic drops out and LiveKit restarts it WITHOUT 'all' → 'all' is put
 *        back; if it cannot be, the guests are handed to this tab
 *   S12  disarmed while the start is still opening the mic → no host left
 *   S7   two guests, one whose track reached the overlay before their tile:
 *        exactly ONE audio element per guest, none outside the page; a booth
 *        element that stops hands only THAT guest back to the overlay
 *   S13  a guest at "Camera ready — hit GO LIVE" is not played by the booth
 *   S8   the booth tab closes → the overlay plays every guest again
 *   S9   a second dashboard tab takes the host seat → the first stands down
 *   S11  the booth tab CRASHES (no goodbye) in This-tab → the overlay stops
 *        trusting its claim once the SFU reports the link lost
 *   S10  the SFU itself restarts mid-call (a full reconnect) → a Whole-PC booth
 *        comes back Whole PC, not wrongly downgraded to This tab
 *
 * Spends nothing: local SFU (tools/livekit-server.exe --dev), free room.
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawn, execSync } from 'child_process';
import puppeteer from 'puppeteer-core';
import { RoomServiceClient } from 'livekit-server-sdk';
import { assertFreshBuild, startGateServer } from './_gate-helpers.mjs';

const PORT = 3337;
const APP = `http://localhost:${PORT}`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SFU_BIN = path.join(process.cwd(), 'tools', 'livekit-server.exe');

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
const sfuUp = async () => (await fetch('http://localhost:7880/').then((r) => r.text()).catch(() => null)) === 'OK';

console.log('\n── where the streamer hears guests: This tab by default, OBS one click away ──');
{
  const fresh = assertFreshBuild();
  ok('G0. the build under test is newer than the source it renders', fresh.ok, fresh.detail);
  if (!fresh.ok) { console.log(`\nRESULT: ${pass} pass, ${fail} fail`); process.exit(1); }
}
if (!(await sfuUp())) {
  console.log('  refusing: local livekit-server not running — start tools/livekit-server.exe --dev');
  process.exit(1);
}
const svc = new RoomServiceClient('http://localhost:7880', 'devkey', 'secret');
const hosts = async (roomId) => (await svc.listParticipants(`mc-${roomId}`).catch(() => []))
  .filter((p) => p.identity === `host:${roomId}`);
const hostAttrs = async (roomId) => (await hosts(roomId))[0]?.attributes || null;

// ── the host's media: a moving camera, and a mic whose echo cancellation
// behaves like Chrome's (recorded; granted, refused, thrown or slow on demand)
const HOST_MEDIA = () => {
  window.__ecAsked = [];
  window.__grantAll = true;
  window.__rejectAll = false;
  window.__audioDelay = 0;
  window.__videoDelay = 0;
  window.__micTracks = [];
  const Orig = window.RTCPeerConnection;
  window.__pcs = [];
  window.RTCPeerConnection = function (...a) { const pc = new Orig(...a); window.__pcs.push(pc); return pc; };
  window.RTCPeerConnection.prototype = Orig.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, Orig);
  navigator.mediaDevices.getUserMedia = async (c) => {
    const out = new MediaStream();
    if (c && c.video) {
      if (window.__videoDelay) await new Promise((r) => setTimeout(r, window.__videoDelay));
      const cv = document.createElement('canvas');
      cv.width = 640; cv.height = 360;
      const ctx = cv.getContext('2d');
      let n = 0;
      setInterval(() => { n++; ctx.fillStyle = `hsl(${(n * 9) % 360},70%,50%)`; ctx.fillRect(0, 0, 640, 360); }, 50);
      cv.captureStream(20).getVideoTracks().forEach((t) => out.addTrack(t));
    }
    if (c && c.audio) {
      // Only the booth's real mic request (an options object) is slowed — not the
      // arm-time permission check (audio: true), which keeps the checkbox busy.
      if (window.__audioDelay && typeof c.audio === 'object') await new Promise((r) => setTimeout(r, window.__audioDelay));
      const asked = typeof c.audio === 'object' ? c.audio.echoCancellation : undefined;
      window.__ecAsked.push(asked === undefined ? '(unset)' : String(asked));
      if (asked === 'all' && window.__rejectAll) throw new DOMException('Could not start audio source', 'NotReadableError');
      const ec = asked === 'all' ? (window.__grantAll ? 'all' : true) : asked === false ? false : true;
      const ac = new AudioContext();
      const osc = ac.createOscillator(); osc.frequency.value = 660;
      const dst = ac.createMediaStreamDestination();
      osc.connect(dst); osc.start();
      const t = dst.stream.getAudioTracks()[0];
      const orig = t.getSettings.bind(t);
      t.getSettings = () => ({ ...orig(), echoCancellation: ec });
      window.__micTracks.push(t);
      out.addTrack(t);
    }
    return out;
  };
};
const GUEST_MEDIA = (hz) => {
  navigator.mediaDevices.getUserMedia = async (c) => {
    const out = new MediaStream();
    if (c && c.video) {
      const cv = document.createElement('canvas');
      cv.width = 320; cv.height = 180;
      const ctx = cv.getContext('2d');
      setInterval(() => { ctx.fillStyle = `hsl(${Date.now() / 15 % 360},80%,50%)`; ctx.fillRect(0, 0, 320, 180); }, 66);
      cv.captureStream(15).getVideoTracks().forEach((t) => out.addTrack(t));
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

// What the booth is really doing, from its own DOM.
const booth = (page) => page.evaluate(() => {
  const els = [...document.querySelectorAll('[data-guest-audio] audio')];
  const playing = els.filter((a) => !a.paused && !a.ended && a.srcObject
    && a.srcObject.getAudioTracks().some((t) => t.readyState === 'live')).map((a) => a.dataset.seat);
  const mics = window.__micTracks || [];
  return {
    elements: els.length,
    playing: playing.sort(),
    mode: document.getElementById('boothAecNote')?.dataset.mode || null,
    pref: ['tab', 'phones', 'system'].find((v) => document.getElementById(`booth-aec-${v}`)?.getAttribute('aria-checked') === 'true') || null,
    note: document.getElementById('boothNote')?.textContent || '',
    error: document.getElementById('boothError')?.textContent || '',
    aecNote: document.getElementById('boothAecNote')?.textContent || '',
    armed: document.getElementById('cohost-booth')?.checked ?? null,
    status: document.getElementById('boothStatus')?.textContent || '',
    asked: (window.__ecAsked || []).slice(),
    micLive: mics.length ? mics[mics.length - 1].readyState === 'live' : null,
  };
});
// Inbound media the booth is actually RECEIVING right now (packets flowing).
const inbound = (page) => page.evaluate(async () => {
  const snap = async () => {
    const m = new Map();
    for (const pc of window.__pcs) {
      if (pc.connectionState === 'closed') continue;
      (await pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp') m.set(r.id, { kind: r.kind, n: r.packetsReceived || 0 }); });
    }
    return m;
  };
  const a = await snap(); await new Promise((r) => setTimeout(r, 1500)); const b = await snap();
  let audio = 0, video = 0;
  for (const [id, x] of b) { if (x.n > (a.get(id)?.n || 0)) { if (x.kind === 'audio') audio++; else video++; } }
  return { audio, video };
});
const overlay = (page) => page.evaluate(() => Object.fromEntries(
  [...document.querySelectorAll('audio[data-lk-seat]')].map((a) => [a.dataset.lkSeat, a.muted ? 'muted' : 'playing'])));
// LiveKit's own view inside the overlay: every element each guest's audio is
// attached to, and how many of them are outside the page (unreachable by mute).
const overlayAttach = (page) => page.evaluate(() => {
  // eslint-disable-next-line no-undef
  const room = typeof lkOverlayRoom !== 'undefined' ? lkOverlayRoom : null;
  if (!room) return null;
  const out = {};
  for (const p of room.remoteParticipants.values()) {
    if (!p.identity.startsWith('seat:')) continue;
    for (const pub of p.audioTrackPublications.values()) {
      const els = (pub.track && pub.track.attachedElements) || [];
      out[p.identity] = { attached: els.length, outsidePage: els.filter((e) => !e.isConnected).length };
    }
  }
  return out;
});

const unlock = async (page, roomId) => {
  await page.evaluateOnNewDocument((id) => { try { localStorage.setItem('mc-last-room', JSON.stringify({ id })); } catch { /* */ } }, roomId);
  await page.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /unlock room/i.test(b.textContent)), { timeout: 30000 });
  await sleep(800);
  await page.evaluate(() => {
    const i = document.querySelector('input[type="password"][autocomplete="current-password"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'booth-aec');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('button')].find((b) => /unlock room/i.test(b.textContent)).click();
  });
  await page.waitForFunction(() => !!document.getElementById('cohost-booth'), { timeout: 30000 });
};
const onAir = (page, ms = 30000) => page.waitForFunction(() => /ON AIR/.test(document.getElementById('boothStatus')?.textContent || ''), { timeout: ms });

const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-booth-aec-'));
const srv = await startGateServer({
  port: PORT, dataDir, label: 'booth-aec',
  env: { LIVEKIT_URL: 'ws://localhost:7880', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret' },
});
let browser = null, crashed = null;
const violations = new Map(); // seat → { run, worst, total, kinds }
let sampling = true;
let samplerPaused = false; // for scenarios that break a booth on purpose
let sampler = null;
try {
  const res = await fetch(`${APP}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Booth AEC', password: 'booth-aec', config: { transport: 'livekit', passkeyTickPrice: '0' } }),
  });
  const { room } = await res.json();
  if (!room?.id) throw new Error(`room create failed (${res.status})`);
  console.log(`  [setup] free livekit room ${room.id}`);

  browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', protocolTimeout: 120000,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  await browser.defaultBrowserContext().overridePermissions(APP, ['camera', 'microphone']);
  const ctx = async () => {
    const c = await browser.createBrowserContext();
    await c.overridePermissions(APP, ['camera', 'microphone']);
    return c;
  };
  const newHost = async () => {
    const h = await browser.newPage();
    h.on('dialog', (d) => void d.accept());
    await h.evaluateOnNewDocument(HOST_MEDIA);
    return h;
  };

  // Every page gets its own window: a background tab stops painting and throttles.
  let host = await newHost();
  await unlock(host, room.id);
  await host.click('#cohost-booth');
  await host.waitForFunction(() => /armed|on air/i.test(document.getElementById('boothStatus')?.textContent || ''), { timeout: 20000 });
  ok('the setting is there, and "This tab" is the default', (await booth(host)).pref === 'tab');

  const ov = await (await ctx()).newPage();
  await ov.goto(`${APP}/overlay?room=${room.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const joinGuest = async (name, hz, { goLive = true, pauseBeforeGoLive = 0 } = {}) => {
    const g = await (await ctx()).newPage();
    g.on('dialog', (d) => void d.accept());
    await g.evaluateOnNewDocument(GUEST_MEDIA, hz);
    await g.goto(`${APP}/join?room=${room.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await g.waitForSelector('#username', { timeout: 30000 });
    await sleep(1200);
    await g.evaluate(() => { const u = document.getElementById('username'); u.value = ''; u.dispatchEvent(new Event('input', { bubbles: true })); });
    await g.type('#username', name);
    await g.click('#joinBtn');
    await g.waitForFunction(() => /go live/i.test(document.getElementById('joinBtn')?.textContent || ''), { timeout: 30000 });
    if (!goLive) return g;
    if (pauseBeforeGoLive) await sleep(pauseBeforeGoLive);
    await g.click('#joinBtn');
    await g.waitForFunction(() => /you're live/i.test(document.getElementById('joinBtn')?.textContent || ''), { timeout: 30000 });
    return g;
  };
  const g1 = await joinGuest('aec-guest-one', 440);
  console.log('  [guest one] live');
  await onAir(host);

  // ── the invariant, sampled for the rest of the run ─────────────────────────
  sampler = (async () => {
    while (sampling) {
      if (!samplerPaused) {
        try {
          const [b, o] = await Promise.all([booth(host), overlay(ov)]);
          for (const [seat, state] of Object.entries(o)) {
            const boothPlays = b.playing.includes(seat);
            const overlayPlays = state === 'playing';
            const bad = boothPlays === overlayPlays; // both = doubled, neither = silent
            const v = violations.get(seat) || { run: 0, worst: 0, total: 0, kinds: new Set() };
            if (bad) { v.run++; v.total++; v.kinds.add(boothPlays ? 'doubled' : 'silent'); v.worst = Math.max(v.worst, v.run); } else v.run = 0;
            violations.set(seat, v);
          }
        } catch { /* a page mid-navigation or closed; next tick */ }
      } else {
        for (const v of violations.values()) v.run = 0;
      }
      await sleep(250);
    }
  })();

  // ── S1: This tab by default ────────────────────────────────────────────────
  let b = await until(async () => { const x = await booth(host); return x.mode === 'tab' && x.playing.length === 1 ? x : null; }, 20000);
  b = b || await booth(host);
  ok('S1. default "This tab" → the booth plays the guest, with the ordinary canceller (never "all")',
    b.mode === 'tab' && b.playing.length === 1 && b.asked.length > 0 && !b.asked.includes('all'), JSON.stringify({ mode: b.mode, playing: b.playing, asked: b.asked }));
  const seat1 = b.playing[0];
  let inb = await inbound(host);
  ok('S1. the booth receives the guest\'s AUDIO only — no video decoded', inb.audio >= 1 && inb.video === 0, JSON.stringify(inb));
  let a = await until(async () => { const x = await hostAttrs(room.id); return x && x['mc.guestAudioSeats'] === seat1 ? x : null; }, 8000);
  a = a || await hostAttrs(room.id);
  ok('S1. the booth claims exactly that seat (mc.aec=tab)', a && a['mc.guestAudioSeats'] === seat1 && a['mc.aec'] === 'tab', JSON.stringify(a));
  let o = await until(async () => { const x = await overlay(ov); return x[seat1] === 'muted' ? x : null; }, 20000);
  o = o || await overlay(ov);
  ok('S1. the overlay mutes that seat (never on stream twice)', Object.keys(o).length === 1 && o[seat1] === 'muted', JSON.stringify(o));
  ok('S1. the card says so', /like Discord/.test(b.aecNote), b.aecNote);

  // ── S2: OBS · speakers (Whole PC) ──────────────────────────────────────────
  await host.click('#booth-aec-system');
  b = await until(async () => { const x = await booth(host); return x.mode === 'system' && x.elements === 0 ? x : null; }, 15000);
  b = b || await booth(host);
  ok('S2. "OBS · speakers" → the mic asks for "all" and gets it; the booth plays nobody',
    b.mode === 'system' && b.elements === 0 && b.asked[b.asked.length - 1] === 'all', JSON.stringify({ mode: b.mode, asked: b.asked }));
  inb = await inbound(host);
  ok('S2. the booth RECEIVES none of the guest\'s media (no video decoded, no audio)', inb.audio === 0 && inb.video === 0, JSON.stringify(inb));
  a = await until(async () => { const x = await hostAttrs(room.id); return x && x['mc.aec'] === 'system' && x['mc.guestAudioSeats'] === '-' ? x : null; }, 8000);
  a = a || await hostAttrs(room.id);
  ok('S2. the booth tells the room: mc.aec=system, claims no seat', a && a['mc.aec'] === 'system' && a['mc.guestAudioSeats'] === '-', JSON.stringify(a));
  o = await until(async () => { const x = await overlay(ov); return x[seat1] === 'playing' ? x : null; }, 8000);
  o = o || await overlay(ov);
  ok('S2. the overlay plays the guest (the streamer hears them through OBS)', o[seat1] === 'playing', JSON.stringify(o));
  ok('S2. the card is honest about the cost (voice can cut out; OBS 32)', /cut out/.test(b.aecNote) && /OBS 32/.test(b.aecNote), b.aecNote);

  // ── S2b: OBS · headphones, from Whole PC ───────────────────────────────────
  await host.click('#booth-aec-phones');
  b = await until(async () => { const x = await booth(host); return x.mode === 'phones' ? x : null; }, 15000);
  b = b || await booth(host);
  ok('S2b. "OBS · headphones" → the mic restarts WITHOUT "all" (no gating, no 170ms)', b.mode === 'phones' && b.asked[b.asked.length - 1] === 'true' && b.micLive === true, JSON.stringify({ mode: b.mode, asked: b.asked.slice(-3) }));
  ok('S2b. ...and the booth still plays nobody and receives nothing', b.elements === 0 && (await inbound(host)).audio === 0, JSON.stringify(b.playing));
  a = await until(async () => { const x = await hostAttrs(room.id); return x && x['mc.aec'] === 'phones' ? x : null; }, 8000);
  a = a || await hostAttrs(room.id);
  ok('S2b. the room hears mc.aec=phones, no seat claimed', a && a['mc.aec'] === 'phones' && a['mc.guestAudioSeats'] === '-', JSON.stringify(a));
  o = await overlay(ov);
  ok('S2b. the overlay still plays the guest', o[seat1] === 'playing', JSON.stringify(o));
  ok('S2b. the card says headphones only', /Headphones only/.test(b.aecNote), b.aecNote);

  // ── S3: back to This tab, from Headphones ──────────────────────────────────
  let askedN = (await booth(host)).asked.length;
  await host.click('#booth-aec-tab');
  b = await until(async () => { const x = await booth(host); return x.playing.includes(seat1) ? x : null; }, 15000);
  b = b || await booth(host);
  ok('S3. "This tab" → the booth plays the guest again', b.mode === 'tab' && b.playing.includes(seat1), JSON.stringify(b.playing));
  ok('S3. ...without restarting the mic (it already had the ordinary canceller — no blip)', b.asked.length === askedN, JSON.stringify(b.asked.slice(askedN)));
  o = await until(async () => { const x = await overlay(ov); return x[seat1] === 'muted' ? x : null; }, 8000);
  o = o || await overlay(ov);
  ok('S3. ...and the overlay mutes that seat', o[seat1] === 'muted', JSON.stringify(o));

  // ── S3b: Headphones, from This tab ─────────────────────────────────────────
  askedN = (await booth(host)).asked.length;
  await host.click('#booth-aec-phones');
  b = await until(async () => { const x = await booth(host); return x.mode === 'phones' && x.elements === 0 ? x : null; }, 15000);
  b = b || await booth(host);
  ok('S3b. "OBS · headphones" from This tab → handed to the overlay, no mic restart', b.mode === 'phones' && b.elements === 0 && b.asked.length === askedN, JSON.stringify({ mode: b.mode, asked: b.asked.slice(askedN) }));
  o = await until(async () => { const x = await overlay(ov); return x[seat1] === 'playing' ? x : null; }, 8000);
  o = o || await overlay(ov);
  ok('S3b. ...and the overlay plays the guest', o[seat1] === 'playing', JSON.stringify(o));
  await host.click('#booth-aec-system'); // S4-S6 start from Whole PC
  await until(async () => (await booth(host)).mode === 'system', 15000);

  // A fresh start of the booth: disarm, set the shim, arm again (a guest is live).
  const restart = async (setup) => {
    await host.click('#cohost-booth'); // disarm
    await host.waitForFunction(() => document.getElementById('cohost-booth')?.checked === false, { timeout: 10000 });
    await host.evaluate(setup);
    await sleep(1500);
    await host.click('#cohost-booth'); // arm
    await onAir(host);
  };

  // ── S4: Chrome refuses 'all', and the camera is slow ───────────────────────
  await restart(() => { window.__grantAll = false; window.__rejectAll = false; window.__videoDelay = 2500; });
  b = await until(async () => { const x = await booth(host); return x.mode === 'tab' && x.playing.includes(seat1) ? x : null; }, 20000);
  b = b || await booth(host);
  ok('S4. Chrome refuses "all" → automatically This-tab, and the booth plays the guest', b.mode === 'tab' && b.playing.includes(seat1), JSON.stringify({ mode: b.mode, playing: b.playing }));
  ok('S4. ...the preference stays Whole PC and the card says why', b.pref === 'system' && /didn’t allow/.test(b.aecNote), b.aecNote);
  o = await until(async () => { const x = await overlay(ov); return x[seat1] === 'muted' ? x : null; }, 8000);
  o = o || await overlay(ov);
  ok('S4. ...and the overlay mutes that guest', o[seat1] === 'muted', JSON.stringify(o));
  await host.evaluate(() => { window.__videoDelay = 0; });

  // ── S5: 'all' throws outright ──────────────────────────────────────────────
  await restart(() => { window.__grantAll = true; window.__rejectAll = true; });
  b = await until(async () => { const x = await booth(host); return x.mode === 'tab' && x.playing.includes(seat1) ? x : null; }, 20000);
  b = b || await booth(host);
  ok('S5. "all" throws → still ON AIR with a plain mic, This-tab', /ON AIR/.test(b.status) && b.mode === 'tab' && b.playing.includes(seat1), JSON.stringify({ status: b.status, mode: b.mode }));
  await sleep(2000);
  ok('S5. ...exactly ONE host in the room (no stray connection from the failed attempt)', (await hosts(room.id)).length === 1, `${(await hosts(room.id)).length} host(s)`);

  // ── S5b: a mic RESTART that throws ─────────────────────────────────────────
  await host.click('#booth-aec-tab');
  await until(async () => (await booth(host)).pref === 'tab', 5000);
  await sleep(1500);
  await host.click('#booth-aec-system'); // 'all' still throws in the shim
  b = await until(async () => { const x = await booth(host); return x.pref === 'system' && x.asked[x.asked.length - 1] === 'true' ? x : null; }, 15000);
  b = b || await booth(host);
  ok('S5b. the restart asking for "all" throws → a plain mic is brought back, not left dead', b.micLive === true && b.mode === 'tab' && !b.error, JSON.stringify({ micLive: b.micLive, mode: b.mode, asked: b.asked.slice(-3), error: b.error }));
  ok('S5b. ...still ON AIR and still playing the guest here', /ON AIR/.test(b.status) && b.playing.includes(seat1), b.status);
  await host.evaluate(() => { window.__rejectAll = false; });

  // ── S6: the mic drops out mid-call ─────────────────────────────────────────
  await restart(() => { window.__grantAll = true; window.__rejectAll = false; });
  await until(async () => (await booth(host)).mode === 'system', 15000);
  const askedBefore = (await booth(host)).asked.length;
  await host.evaluate(() => { const t = window.__micTracks[window.__micTracks.length - 1]; t.dispatchEvent(new Event('ended')); });
  b = await until(async () => { const x = await booth(host); return x.asked.length >= askedBefore + 2 && x.mode === 'system' ? x : null; }, 15000);
  b = b || await booth(host);
  const tail = b.asked.slice(askedBefore);
  ok('S6. LiveKit restarts the dropped mic WITHOUT "all"…', tail[0] === '(unset)', JSON.stringify(tail));
  ok('S6. …and the booth puts "all" back, staying Whole PC', tail.includes('all') && b.mode === 'system' && b.elements === 0, JSON.stringify({ tail, mode: b.mode }));
  await host.evaluate(() => { window.__grantAll = false; });
  const askedBefore2 = (await booth(host)).asked.length;
  await host.evaluate(() => { const t = window.__micTracks[window.__micTracks.length - 1]; t.dispatchEvent(new Event('ended')); });
  b = await until(async () => { const x = await booth(host); return x.asked.length > askedBefore2 && x.mode === 'tab' && x.playing.includes(seat1) ? x : null; }, 15000);
  b = b || await booth(host);
  ok('S6. if "all" cannot come back → the booth hands the guest to this tab and says so', b.mode === 'tab' && b.playing.includes(seat1) && /restarted/.test(b.note), JSON.stringify({ mode: b.mode, note: b.note }));
  o = await until(async () => { const x = await overlay(ov); return x[seat1] === 'muted' ? x : null; }, 8000);
  o = o || await overlay(ov);
  ok('S6. ...and the overlay mutes them (not doubled)', o[seat1] === 'muted', JSON.stringify(o));

  // ── S12: disarmed while the start is still opening the mic ────────────────
  samplerPaused = true; // the booth is being thrown away mid-start on purpose
  await host.click('#cohost-booth'); // disarm
  await host.waitForFunction(() => document.getElementById('cohost-booth')?.checked === false, { timeout: 10000 });
  await until(async () => (await hosts(room.id)).length === 0, 10000);
  await host.evaluate(() => { window.__audioDelay = 3000; });
  await host.click('#cohost-booth'); // arm → a start begins, the mic takes 3s
  await host.waitForFunction(() => /going on air/i.test(document.getElementById('boothStatus')?.textContent || ''), { timeout: 10000 });
  await sleep(800);
  await host.click('#cohost-booth'); // disarm mid-start
  await sleep(5000);
  b = await booth(host);
  ok('S12. disarmed during the start → no host left in the room, and not on air', (await hosts(room.id)).length === 0 && !/ON AIR/.test(b.status), `${(await hosts(room.id)).length} host(s); ${b.status}`);
  await host.evaluate(() => { window.__audioDelay = 0; });
  await host.click('#cohost-booth'); // arm again for the rest of the run
  await onAir(host);
  await until(async () => (await booth(host)).playing.includes(seat1), 15000);
  await until(async () => (await overlay(ov))[seat1] === 'muted', 8000);
  samplerPaused = false;

  // ── S7: two guests; the second's track reaches the overlay before its tile ─
  const g2 = await joinGuest('aec-guest-two', 550, { pauseBeforeGoLive: 3000 });
  console.log('  [guest two] live (published 3s before going live)');
  b = await until(async () => { const x = await booth(host); return x.playing.length === 2 ? x : null; }, 20000);
  b = b || await booth(host);
  ok('S7. This-tab with two guests → the booth plays both', b.playing.length === 2, JSON.stringify(b.playing));
  const seat2 = b.playing.find((s) => s !== seat1);
  o = await until(async () => { const x = await overlay(ov); return x[seat1] === 'muted' && x[seat2] === 'muted' ? x : null; }, 10000);
  o = o || await overlay(ov);
  ok('S7. ...and the overlay mutes both', o[seat1] === 'muted' && o[seat2] === 'muted', JSON.stringify(o));
  const att = await overlayAttach(ov);
  ok('S7. exactly ONE overlay audio element per guest, and none outside the page (unreachable by mute)',
    !!att && Object.keys(att).length === 2 && Object.values(att).every((x) => x.attached === 1 && x.outsidePage === 0), JSON.stringify(att));
  await host.evaluate((s) => document.querySelector(`[data-guest-audio] audio[data-seat="${s}"]`)?.pause(), seat2);
  o = await until(async () => { const x = await overlay(ov); return x[seat2] === 'playing' && x[seat1] === 'muted' ? x : null; }, 10000);
  o = o || await overlay(ov);
  ok('S7. one of the booth\'s elements stops → only THAT guest goes back to the overlay; the other stays muted', o[seat2] === 'playing' && o[seat1] === 'muted', JSON.stringify(o));
  await host.evaluate((s) => document.querySelector(`[data-guest-audio] audio[data-seat="${s}"]`)?.play(), seat2);
  await until(async () => (await overlay(ov))[seat2] === 'muted', 8000);

  // ── S13: a guest who has not gone live yet ─────────────────────────────────
  const g3 = await joinGuest('aec-guest-three', 660, { goLive: false });
  console.log('  [guest three] at "Camera ready — hit GO LIVE"');
  await sleep(5000);
  b = await booth(host);
  ok('S13. a guest who has not gone live is NOT played by the booth (their mic test stays off stream)', b.playing.length === 2 && b.elements === 2, JSON.stringify(b.playing));
  await g3.close();

  // ── S8: the booth tab closes ───────────────────────────────────────────────
  await host.close({ runBeforeUnload: false });
  o = await until(async () => { const x = await overlay(ov); return Object.values(x).every((v) => v === 'playing') && Object.keys(x).length === 2 ? x : null; }, 15000);
  o = o || await overlay(ov);
  ok('S8. the booth tab closes → the overlay plays every guest again', Object.keys(o).length === 2 && Object.values(o).every((v) => v === 'playing'), JSON.stringify(o));

  // ── S9: a second tab takes the host seat ───────────────────────────────────
  const tabA = await newHost();
  await unlock(tabA, room.id);
  await onAir(tabA);
  host = tabA;
  const tabB = await newHost();
  await unlock(tabB, room.id);
  await onAir(tabB);
  const stoodDown = await until(async () => { const x = await booth(tabA); return /another tab/.test(x.note) ? x : null; }, 15000);
  host = tabB;
  ok('S9. the replaced tab stands down and says where the booth went', !!stoodDown && stoodDown.armed === false, JSON.stringify(stoodDown && { note: stoodDown.note, armed: stoodDown.armed }));
  await sleep(8000);
  const bNow = await booth(tabB);
  ok('S9. no ping-pong: 8s later there is one host and it is the new tab, still on air',
    (await hosts(room.id)).length === 1 && /ON AIR/.test(bNow.status), `${(await hosts(room.id)).length} host(s); ${bNow.status}`);
  await tabA.close();

  // ── S11: the booth tab crashes, in This-tab with both guests claimed ───────
  await tabB.click('#booth-aec-tab');
  await until(async () => (await booth(tabB)).playing.length === 2, 15000);
  o = await until(async () => { const x = await overlay(ov); return Object.values(x).every((v) => v === 'muted') ? x : null; }, 10000);
  ok('S11. (setup) This-tab: the booth plays both guests and the overlay has muted both', !!o, JSON.stringify(o || await overlay(ov)));
  samplerPaused = true;
  const crashAt = Date.now();
  // Fire and forget: a crashed page never answers, and awaiting the call would
  // only time the protocol timeout, not the overlay.
  try { const cdp = await tabB.createCDPSession(); cdp.send('Page.crash').catch(() => {}); } catch { /* already gone */ }
  o = await until(async () => { const x = await overlay(ov); return Object.keys(x).length === 2 && Object.values(x).every((v) => v === 'playing') ? x : null; }, 40000, 500);
  const took = ((Date.now() - crashAt) / 1000).toFixed(1);
  ok('S11. the booth tab CRASHES (no goodbye) → the overlay plays both guests again', !!o, `${o ? took + 's' : 'never'} ${JSON.stringify(o || await overlay(ov))}`);

  // ── S10: the SFU restarts mid-call (a full reconnect) ──────────────────────
  const tabC = await newHost();
  await unlock(tabC, room.id);
  await tabC.click('#booth-aec-system');
  await onAir(tabC);
  host = tabC;
  b = await until(async () => { const x = await booth(tabC); return x.mode === 'system' ? x : null; }, 20000);
  ok('S10. (setup) a fresh booth is on air in Whole PC', !!b, JSON.stringify(b && { mode: b.mode }));
  execSync('taskkill /IM livekit-server.exe /F', { stdio: 'ignore' });
  await until(async () => !(await sfuUp()), 10000, 300);
  await sleep(1500);
  const sfu = spawn(SFU_BIN, ['--dev'], { detached: true, stdio: 'ignore' });
  sfu.unref();
  await until(sfuUp, 30000, 500);
  b = await until(async () => {
    const x = await booth(tabC);
    const at = await hostAttrs(room.id);
    return /ON AIR/.test(x.status) && at && at['mc.aec'] ? { x, at } : null;
  }, 90000, 1000);
  ok('S10. after the SFU restart the booth is back on air', !!b, b ? b.x.status : (await booth(tabC)).status);
  ok('S10. ...still Whole PC — not downgraded to This tab by the reconnect', !!b && b.x.mode === 'system' && b.x.elements === 0 && !/restarted/.test(b.x.note),
    JSON.stringify(b && { mode: b.x.mode, elements: b.x.elements, note: b.x.note }));
  ok('S10. ...and the room hears it again: mc.aec=system', !!b && b.at['mc.aec'] === 'system', JSON.stringify(b && b.at));
  samplerPaused = false;

  // ── the invariant over the whole run ──────────────────────────────────────
  sampling = false;
  await sampler;
  ok('INV. the invariant sampler actually ran over both guests', violations.size >= 2, `${violations.size} seat(s) sampled`);
  for (const [seat, v] of violations) {
    ok(`INV. ${seat.slice(0, 18)}…: never doubled or silent beyond a handover (≤2s)`, v.worst <= 8,
      `longest ${v.worst} samples (${(v.worst * 0.25).toFixed(2)}s), ${v.total} total, kinds: ${[...v.kinds].join('/') || 'none'}`);
  }
  // NEGATIVE CONTROL: the sampler must be able to SEE a violation, or its zero
  // means nothing. Force one guest silent (overlay muted while the booth, in
  // Whole PC, plays nobody) for 3s and count it with the same rule.
  {
    const probe = { run: 0, worst: 0 };
    const seat = Object.keys(await overlay(ov))[0];
    // Held for the whole 3s: the overlay now re-asserts the right state on every
    // booth quality update, which would undo a single forced mute.
    const hold = setInterval(() => { ov.evaluate((s) => { const el = document.querySelector(`audio[data-lk-seat="${s}"]`); if (el) el.muted = true; }, seat).catch(() => {}); }, 100);
    await sleep(150);
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      const [bb, oo] = await Promise.all([booth(host), overlay(ov)]);
      const bad = bb.playing.includes(seat) === (oo[seat] === 'playing');
      probe.run = bad ? probe.run + 1 : 0;
      probe.worst = Math.max(probe.worst, probe.run);
      await sleep(250);
    }
    clearInterval(hold);
    ok('NEG. the same rule DOES catch a guest forced silent for 3s (so the zero above is real)', probe.worst >= 8, `longest run ${probe.worst} samples`);
    await ov.evaluate((s) => { const el = document.querySelector(`audio[data-lk-seat="${s}"]`); if (el) el.muted = false; }, seat);
  }
  await g1.evaluate(() => document.getElementById('joinBtn')?.click()).catch(() => {});
  await g2.evaluate(() => document.getElementById('joinBtn')?.click()).catch(() => {});
} catch (e) {
  crashed = e;
} finally {
  sampling = false;
  if (sampler) await sampler.catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (fail || crashed) { console.log('--- server output (tail) ---'); console.log(srv.stderr().slice(-4000)); }
  srv.kill();
}
if (crashed) { console.log(`\nGATE CRASHED: ${crashed.stack || crashed}`); process.exit(1); }
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
await sleep(1500);
process.exit(fail === 0 ? 0 : 1);
