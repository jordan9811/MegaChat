/**
 * GATE — the booth's howl guard (web/lib/howl-guard.ts) cuts a feedback loop
 * at the streamer's mic, and leaves speech and real room tones alone.
 *
 * 2026-09-26, live: "the deafening siren". The booth now keeps the overlay
 * silent wherever its mic cannot cancel it (_gate-booth-audio.mjs), but a loop
 * can still close through Chrome's ordinary canceller failing on real
 * speakers, or through a guest's leaky device — and every such loop leaves
 * this PC through the booth mic. The guard listens for a howl and disables the
 * track guests receive until it collapses.
 *
 * The booth's mic here is a shim that plays, on demand:
 *   speech    a pitch-gliding sawtooth (harmonics, like a voice) chopped into
 *             syllables, plus breath noise
 *   loop      a feedback emulation: a 1.2 kHz tone that GROWS while the sent
 *             track is enabled and DECAYS while it is disabled — a loop
 *   tone      a steady 900 Hz whistle that ignores the sent track — a real
 *             sound in the room
 *
 *   H0  the guard is on (mc.howlGuard=on) once the booth is on air
 *   H4  15s of speech: no cut
 *   H1  a loop: the mic guests receive is cut within 1.5s of it starting, and
 *       sent again within 1.5s — confirmed as feedback
 *   H2  the loop keeps re-forming: after two confirmed howls the card says
 *       "Feedback on your speakers"; the mode is not changed for the streamer
 *   H3  a steady whistle: at most one cut, sent again within 1.2s, not counted
 *       as feedback, and not cut again while it keeps sounding
 *
 * Spends nothing: local SFU (tools/livekit-server.exe --dev), free room.
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';
import { RoomServiceClient } from 'livekit-server-sdk';
import { assertFreshBuild, startGateServer } from './_gate-helpers.mjs';

const PORT = 3347;
const APP = `http://localhost:${PORT}`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, step = 100) => {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); }
  return v;
};
const sfuUp = async () => (await fetch('http://localhost:7880/').then((r) => r.text()).catch(() => null)) === 'OK';

console.log('\n── the howl guard: a feedback loop is cut at the mic; speech and room tones are not ──');
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

const HOST_MEDIA = () => {
  window.__mic = null;
  window.__speech = false;
  window.__loop = false;
  window.__tone = false;
  window.__cutLog = []; // [t, enabled] whenever the sent track's enabled flips
  navigator.mediaDevices.getUserMedia = async (c) => {
    const out = new MediaStream();
    if (c && c.video) {
      const cv = document.createElement('canvas');
      cv.width = 640; cv.height = 360;
      const ctx = cv.getContext('2d');
      let n = 0;
      setInterval(() => { n++; ctx.fillStyle = `hsl(${(n * 9) % 360},70%,50%)`; ctx.fillRect(0, 0, 640, 360); }, 50);
      cv.captureStream(20).getVideoTracks().forEach((t) => out.addTrack(t));
    }
    if (c && c.audio) {
      const ac = new AudioContext();
      const dst = ac.createMediaStreamDestination();
      // speech: a gliding sawtooth chopped into syllables, and breath
      const voice = ac.createOscillator(); voice.type = 'sawtooth'; voice.frequency.value = 140;
      const vGain = ac.createGain(); vGain.gain.value = 0;
      voice.connect(vGain).connect(dst); voice.start();
      const noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const noise = ac.createBufferSource(); noise.buffer = noiseBuf; noise.loop = true;
      const nGain = ac.createGain(); nGain.gain.value = 0;
      noise.connect(nGain).connect(dst); noise.start();
      // the loop and the whistle
      const loop = ac.createOscillator(); loop.frequency.value = 1200;
      const lGain = ac.createGain(); lGain.gain.value = 0;
      loop.connect(lGain).connect(dst); loop.start();
      const tone = ac.createOscillator(); tone.frequency.value = 900;
      const tGain = ac.createGain(); tGain.gain.value = 0;
      tone.connect(tGain).connect(dst); tone.start();
      const t = dst.stream.getAudioTracks()[0];
      const orig = t.getSettings.bind(t);
      t.getSettings = () => ({ ...orig(), echoCancellation: typeof c.audio === 'object' && c.audio.echoCancellation === 'all' ? 'all' : true });
      if (typeof c.audio === 'object') window.__mic = t; // the booth's real mic, not the arm-time check
      let g = 0, lastEnabled = true, syl = 0;
      const ring = new Array(50).fill(true); // the sent track's enabled, the last 1s
      let ri = 0;
      setInterval(() => {
        const mic = window.__mic;
        const enabled = mic ? mic.enabled : true;
        // Logged by the booth mic's own stream only (the arm-time check has one too).
        if (mic && mic === t && enabled !== lastEnabled) { window.__cutLog.push([Date.now(), enabled]); lastEnabled = enabled; }
        // the loop grows through a sender that was enabled one round trip (1s)
        // ago, and dies once the cut has come round
        ring[ri] = enabled; ri = (ri + 1) % ring.length;
        const then = ring[ri];
        g = window.__loop ? (then ? Math.min(0.5, g * 1.3 + 0.002) : g * 0.5) : 0;
        lGain.gain.value = g;
        tGain.gain.value = window.__tone ? 0.3 : 0;
        // syllables: ~200ms on, ~120ms off, pitch gliding
        syl = (syl + 20) % 320;
        const on = window.__speech && syl < 200;
        vGain.gain.value = on ? 0.25 : 0;
        nGain.gain.value = window.__speech ? (on ? 0.02 : 0.005) : 0;
        voice.frequency.value = 110 + 70 * Math.abs(Math.sin(Date.now() / 700));
      }, 20);
      out.addTrack(t);
    }
    return out;
  };
};
const GUEST_MEDIA = () => {
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
      const dst = ac.createMediaStreamDestination();
      dst.stream.getAudioTracks().forEach((t) => out.addTrack(t));
    }
    return out;
  };
};
const guard = (page) => page.evaluate(() => {
  const el = document.getElementById('boothHowlGuard');
  return {
    state: el?.dataset.state || null,
    ducks: Number(el?.dataset.ducks || 0),
    howls: Number(el?.dataset.howls || 0),
    last: el?.dataset.last || '',
    alert: !!document.getElementById('boothFeedback'),
    mode: document.getElementById('boothAecNote')?.dataset.mode || null,
    enabled: window.__mic ? window.__mic.enabled : null,
    cuts: (window.__cutLog || []).slice(),
  };
});

const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-howl-'));
const srv = await startGateServer({
  port: PORT, dataDir, label: 'howl-guard',
  env: { LIVEKIT_URL: 'ws://localhost:7880', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret' },
});
let browser = null, crashed = null;
try {
  const res = await fetch(`${APP}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Howl Guard', password: 'howl-guard', config: { transport: 'livekit', passkeyTickPrice: '0' } }),
  });
  const { room } = await res.json();
  if (!room?.id) throw new Error(`room create failed (${res.status})`);
  browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', protocolTimeout: 120000,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const ctx = async () => { const c = await browser.createBrowserContext(); await c.overridePermissions(APP, ['camera', 'microphone']); return c; };

  const host = await (await ctx()).newPage();
  host.on('dialog', (d) => void d.accept());
  await host.evaluateOnNewDocument(HOST_MEDIA);
  await host.evaluateOnNewDocument((id) => { try { localStorage.setItem('mc-last-room', JSON.stringify({ id })); } catch { /* */ } }, room.id);
  await host.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await host.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /unlock room/i.test(b.textContent)), { timeout: 30000 });
  await sleep(800);
  await host.evaluate(() => {
    const i = document.querySelector('input[type="password"][autocomplete="current-password"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'howl-guard');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('button')].find((b) => /unlock room/i.test(b.textContent)).click();
  });
  await host.waitForFunction(() => !!document.getElementById('cohost-booth'), { timeout: 30000 });
  await host.click('#cohost-booth');

  const g = await (await ctx()).newPage();
  g.on('dialog', (d) => void d.accept());
  await g.evaluateOnNewDocument(GUEST_MEDIA);
  await g.goto(`${APP}/join?room=${room.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await g.waitForSelector('#username', { timeout: 30000 });
  await sleep(1200);
  await g.evaluate(() => { const u = document.getElementById('username'); u.value = ''; u.dispatchEvent(new Event('input', { bubbles: true })); });
  await g.type('#username', 'howl-guest');
  await g.click('#joinBtn');
  await g.waitForFunction(() => /go live/i.test(document.getElementById('joinBtn')?.textContent || ''), { timeout: 30000 });
  await g.click('#joinBtn');
  await host.waitForFunction(() => /ON AIR/.test(document.getElementById('boothStatus')?.textContent || ''), { timeout: 30000 });

  // ── H0 ──
  const on = await until(async () => { const x = await guard(host); return x.state === 'on' ? x : null; }, 10000);
  const attrs = (await svc.listParticipants(`mc-${room.id}`)).find((p) => p.identity === `host:${room.id}`)?.attributes || {};
  ok('H0. the guard is listening once the booth is on air (mc.howlGuard=on)', !!on && attrs['mc.howlGuard'] === 'on', JSON.stringify({ state: on?.state, attr: attrs['mc.howlGuard'] }));

  // ── H4: speech ──
  await host.evaluate(() => { window.__speech = true; });
  const d0 = (await guard(host)).ducks;
  await sleep(15000);
  let x = await guard(host);
  ok('H4. 15s of speech-like audio → no cut', x.ducks === d0 && x.enabled === true, `${x.ducks - d0} cut(s)`);

  // ── H1: a loop ──
  const loopAt = await host.evaluate(() => { window.__loop = true; return Date.now(); });
  const cut = await until(async () => { const y = await guard(host); return y.cuts.find(([t, e]) => t >= loopAt && e === false) || null; }, 4000, 50);
  const back = cut ? await until(async () => { const y = await guard(host); return y.cuts.find(([t, e]) => t > cut[0] && e === true) || null; }, 4000, 50) : null;
  x = await guard(host);
  ok('H1. a feedback loop → the mic guests receive is cut within 1.5s', !!cut && cut[0] - loopAt <= 1500, cut ? `${cut[0] - loopAt}ms` : 'never');
  ok('H1. ...sent again within 2.5s, once the round trip has drained', !!back && back[0] - cut[0] <= 2500, back ? `${back[0] - cut[0]}ms` : 'never');

  // ── H2: it keeps re-forming ──
  const alerted = await until(async () => { const y = await guard(host); return y.alert ? y : null; }, 15000, 200);
  ok('H2. the loop builds again after each cut → counted, and after two the card says so', !!alerted && alerted.howls >= 2, JSON.stringify(alerted && { howls: alerted.howls, ducks: alerted.ducks }));
  ok('H2. ...and the streamer\'s mode is left alone', (alerted || x).mode === 'tab', (alerted || x).mode);
  await host.evaluate(() => { window.__loop = false; });
  await sleep(3000);
  await host.evaluate(() => [...document.querySelectorAll('#boothFeedback button')].find((b) => /Dismiss/.test(b.textContent))?.click());
  await sleep(3000);

  // ── H6: a loop while the streamer keeps talking over it ──
  {
    const loop2 = await host.evaluate(() => { window.__loop = true; return Date.now(); });
    const cut2 = await until(async () => { const y = await guard(host); return y.cuts.find(([t, e]) => t >= loop2 && e === false) || null; }, 5000, 50);
    ok('H6. a loop while the streamer keeps talking → still cut within 2.5s', !!cut2 && cut2[0] - loop2 <= 2500, cut2 ? `${cut2[0] - loop2}ms` : 'never');
    await host.evaluate(() => { window.__loop = false; window.__speech = false; });
    await sleep(4000);
    await host.evaluate(() => [...document.querySelectorAll('#boothFeedback button')].find((b) => /Dismiss/.test(b.textContent))?.click());
    await sleep(500);
  }

  // ── H5: short whistles that stop by themselves ──
  {
    const h0 = (await guard(host)).howls;
    for (let i = 0; i < 3; i++) {
      await host.evaluate(() => { window.__tone = true; });
      await sleep(900);
      await host.evaluate(() => { window.__tone = false; });
      await sleep(3500);
    }
    const y = await guard(host);
    ok('H5. three short whistles that stop by themselves → never counted as feedback, no alert', y.howls === h0 && !y.alert && y.enabled === true, JSON.stringify({ howls: y.howls - h0, alert: y.alert }));
    await sleep(6000); // the guard forgets that pitch before H3
  }

  // ── H3: a steady whistle ──
  const before = await guard(host);
  const toneAt = await host.evaluate(() => { window.__tone = true; return Date.now(); });
  await sleep(10000);
  x = await guard(host);
  const toneCuts = x.cuts.filter(([t, e]) => t >= toneAt && e === false);
  const toneBack = x.cuts.find(([t, e]) => toneCuts[0] && t > toneCuts[0][0] && e === true);
  // The guard's own audio clock is the measure (under load the headless audio
  // thread can run ~1.5x slow against the wall clock); the wall bound is loose.
  const held = Number((/after ([0-9.]+)s/.exec(x.last) || [])[1]);
  ok('H3. a steady whistle in the room → at most one cut, held ≤2.2s (guard clock) and judged a room tone', toneCuts.length <= 1 && (!toneCuts.length || (toneBack && toneBack[0] - toneCuts[0][0] <= 4000 && /room-tone/.test(x.last) && held <= 2.2)) && x.enabled === true,
    `${toneCuts.length} cut(s)${toneBack ? `, back after ${toneBack[0] - toneCuts[0][0]}ms` : ''}; cuts after the tone: ${JSON.stringify(x.cuts.filter(([t]) => t >= toneAt).map(([t, e]) => [t - toneAt, e]))}; guard: ${x.last}`);
  ok('H3. ...not counted as feedback, no alert', x.howls === before.howls && !x.alert, JSON.stringify({ howls: x.howls, alert: x.alert }));
  await host.evaluate(() => { window.__tone = false; });
} catch (e) {
  crashed = e;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fail || crashed) { console.log('--- server output (tail) ---'); console.log(srv.stderr().slice(-3000)); }
  srv.kill();
}
if (crashed) { console.log(`\nGATE CRASHED: ${crashed.stack || crashed}`); process.exit(1); }
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
await sleep(1000);
process.exit(fail === 0 ? 0 : 1);
