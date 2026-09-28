/**
 * GATE — echo is found and named, on both sides, and OBS's audio setup is
 * checked, so "This tab" just works for a streamer who configures nothing.
 *
 * The owner, 2026-09-28: "we gonna need this to work for our users … it needs
 * to just work". After the siren fix, two echoes were still silent: a guest
 * whose device sends the streamer's own voice back (speakers, or the stream
 * playing in another tab — the "echoing to myself" of 2026-09-26), and a
 * streamer whose speakers leak the guests into their mic. And one setup gap:
 * an OBS that does not record Desktop Audio leaves guests off the stream.
 *
 *   U1-U3  lib/echo-detector.ts, the shipped code, on phrase-and-pause speech:
 *          a delayed copy is found at its delay; 45 min of unrelated talk
 *          searching 30s of delays reports nothing (the logic first shipped
 *          reports some); a steady echo is reported once and never flickers
 *   O1-O8  lib/obs-audio-check.mjs against a fake OBS: says something only on
 *          positive evidence that nothing records Chrome, and offers a fix only
 *          where it cannot double the audio; Through OBS: the overlay found by
 *          URL, monitored, on stream, once
 *   N      a booth and a guest simply talking over each other for 25s: nobody
 *          is told anything
 *   G      the guest's mic plays the streamer back 3s late (a stream tab): the
 *          guest is told to use headphones, and the booth names the guest
 *   GC     ...and it clears once it stops
 *   B      the booth's mic picks the guest up from its speakers: the booth says
 *          so, names the guest, and offers the one-click cure
 *   M      the mode picker is tucked away (This tab needs no choice)
 *
 * Spends nothing: local SFU (tools/livekit-server.exe --dev), free room.
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import puppeteer from 'puppeteer-core';
import { assertFreshBuild, startGateServer } from './_gate-helpers.mjs';

const PORT = 3357;
const APP = `http://localhost:${PORT}`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

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
const sfuUp = async () => (await fetch('http://localhost:7880/').then((r) => r.text()).catch(() => null)) === 'OK';

console.log('\n── echo found and named; OBS audio checked; This tab needs no choice ──');
{
  const fresh = assertFreshBuild();
  ok('G0. the build under test is newer than the source it renders', fresh.ok, fresh.detail);
  if (!fresh.ok) { console.log(`\nRESULT: ${pass} pass, ${fail} fail`); process.exit(1); }
}

// ── U: the detector's maths and its decision, the shipped code ───────────
{
  const { bestLag, judgeFor } = await import(pathToFileURL(path.resolve('web/lib/echo-detector.ts')).href);
  const FRAME_S = 0.02;
  let seed = 1;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const between = (a, b) => a + (b - a) * rnd();
  // Phrase-and-pause speech (the review's model): talk in 1-4s phrases of
  // syllables, pauses of 0.4-3s. A dense on/off model hid the false alarms.
  const speech = (n, share) => {
    const lin = new Float64Array(n); let i = 0;
    while (i < n) {
      const talking = rnd() < share;
      const dur = Math.round((talking ? between(1, 4) : between(0.4, 3)) / FRAME_S);
      if (talking) {
        let j = i;
        while (j < i + dur && j < n) {
          const syl = Math.round(between(7, 13)); const pk = Math.pow(10, between(-30, -20) / 10);
          for (let k = 0; k < syl && j + k < n; k++) lin[j + k] += pk * Math.pow(Math.sin(Math.PI * (k + 0.5) / syl), 2);
          j += syl + Math.round(between(0, 3));
        }
      }
      i += dur;
    }
    return lin;
  };
  const toDb = (lin) => Float32Array.from(lin, (v) => 10 * Math.log10(v + Math.pow(10, (-65 + between(-1.5, 1.5)) / 10)));
  // Every scan a second, fed to the shipped judge AND to the logic first
  // shipped (3 winning windows running, r ≥ 0.4) — the discrimination.
  const scanAll = (ref, mic, maxLagS) => {
    const maxLag = Math.round(maxLagS / FRAME_S), win = 400, keep = win + maxLag + 10;
    const judge = judgeFor(maxLag);
    let oldStreak = 0, oldLast = -1, oldRep = false, oldQuiet = 0;
    const out = { reports: 0, clears: 0, first: null, oldReports: 0 };
    for (let s = 50; s <= ref.length; s += 50) {
      const lo = Math.max(0, s - keep);
      const scan = bestLag(ref.subarray(lo, s), mic.subarray(lo, s), win, maxLag, judge.reportedLag);
      const v = judge.step(scan);
      if (v === 'echo') { out.reports++; out.first ??= s * FRAME_S; }
      if (v === 'clear') out.clears++;
      const hit = scan.active >= 0.15 && scan.r >= 0.4;
      oldStreak = hit ? (oldLast >= 0 && Math.abs(scan.lag - oldLast) <= 3 ? oldStreak + 1 : 1) : 0;
      oldLast = hit ? scan.lag : -1;
      if (hit) oldQuiet = 0; else if (scan.active >= 0.15) oldQuiet++;
      if (!oldRep && oldStreak >= 3) { oldRep = true; out.oldReports++; } else if (oldRep && oldQuiet >= 10) oldRep = false;
    }
    return out;
  };
  const MIN = 3000; // frames in a minute
  seed = 7; const h1 = speech(4 * MIN, 0.6);
  const lagged = new Float64Array(h1.length);
  seed = 99; const own = speech(4 * MIN, 0.2);
  for (let i = 0; i < h1.length; i++) lagged[i] = own[i] + (i >= 150 ? h1[i - 150] * Math.pow(10, -1) : 0);
  const f1 = bestLag(toDb(h1), toDb(lagged), 400, 200);
  ok('U1. a copy of the reference 3s late, 10dB down, under the mic\'s own talk, is found at 3s', Math.abs(f1.lagS - 3) < 0.05 && f1.r > 0.4, JSON.stringify(f1));
  let fp = 0, oldFp = 0;
  for (const [sd, hs, gs] of [[11, 0.6, 0.3], [222, 0.7, 0.1], [3333, 0.5, 0.5]]) {
    seed = sd; const N = 15 * MIN;
    const r = scanAll(toDb(speech(N, hs)), toDb(speech(N, gs)), 30);
    fp += r.reports; oldFp += r.oldReports;
  }
  ok('U2. 45 min of unrelated talk, searching delays up to 30s → NO echo reported', fp === 0, `${fp} report(s)`);
  ok('U2. ...where the logic first shipped (3 windows running) reports some — so this discriminates', oldFp > 0, `${oldFp} false report(s) from the old logic`);
  const echoes = [];
  for (const [D, rel, lagMax] of [[10, -15, 30], [0.15, -20, 0.8]]) {
    seed = 4242; const N = 8 * MIN; const hs = speech(N, 0.6), gs = speech(N, 0.25); const Df = Math.round(D / FRAME_S);
    for (let i = Df; i < N; i++) gs[i] += hs[i - Df] * Math.pow(10, rel / 10);
    echoes.push({ D, rel, ...scanAll(toDb(hs), toDb(gs), lagMax) });
  }
  ok('U3. a steady echo (10s behind at -15dB; 0.15s at -20dB) is reported within 2.5 min, once, and never flickers off in 8 min',
    echoes.every((e) => e.first !== null && e.first <= 150 && e.reports === 1 && e.clears === 0), JSON.stringify(echoes));
}

// ── O: the OBS audio check against a fake OBS ─────────────────────────────
{
  const { checkObsAudio, isRoomOverlay, MONITOR_AND_OUTPUT } = await import('./web/lib/obs-audio-check.mjs');
  const fake = (state) => async (type, data = {}) => {
    const input = state.inputs.find((i) => i.inputName === (data.inputName || data.sourceName));
    switch (type) {
      case 'GetSpecialInputs': return { desktop1: state.desktop || null, mic1: state.mic || null };
      case 'GetInputList': return { inputs: state.inputs.map((i) => ({ inputName: i.inputName, inputKind: i.kind, unversionedInputKind: i.kind })) };
      case 'GetInputMute': return { inputMuted: !!input?.muted };
      case 'GetInputVolume': return { inputVolumeMul: input?.vol ?? 1 };
      case 'GetInputAudioMonitorType': return { monitorType: input?.monitor || 'OBS_MONITORING_TYPE_NONE' };
      case 'GetInputSettings': return { inputSettings: input?.settings || {} };
      case 'GetSourceActive': return { videoActive: input?.active !== false };
      case 'GetInputPropertiesListPropertyItems': return { propertyItems: (input?.devices || []).map(([itemValue, itemName]) => ({ itemValue, itemName })) };
      default: throw new Error('unexpected ' + type);
    }
  };
  const desk = (o = {}) => ({ inputName: 'Desktop Audio', kind: 'wasapi_output_capture', ...o });
  const tab = (inputs, extra = {}) => checkObsAudio(fake({ desktop: 'Desktop Audio', inputs, ...extra }), { mode: 'tab', roomId: 'r1', handle: 'streamer' });
  const codes = (p) => p.map((x) => x.code).join(',') || 'none';
  let p = await tab([desk({ muted: true })]);
  ok('O1. This tab, Desktop Audio muted and nothing else records Chrome → named, with the one-request fix (unmute)', codes(p) === 'desktop-muted' && p[0].fix?.requestType === 'SetInputMute' && p[0].fix.requestData.inputMuted === false, JSON.stringify(p));
  p = await tab([desk({ vol: 0 })]);
  const pLow = await tab([desk({ vol: 0.0447 })]);
  const pMon = await tab([desk({ monitor: 'OBS_MONITORING_TYPE_MONITOR_ONLY' })]);
  ok('O2. ...turned all the way down → fix turns it up; merely low → named with NO volume fix; "Monitor Only" → fix sends it to the stream (not back to the speakers)',
    codes(p) === 'desktop-silent' && p[0].fix?.requestType === 'SetInputVolume' && codes(pLow) === 'desktop-low' && pLow[0].fix === null
      && codes(pMon) === 'desktop-monitor-only' && pMon[0].fix?.requestData.monitorType === 'OBS_MONITORING_TYPE_NONE',
    JSON.stringify({ p, pLow, pMon }));
  p = await tab([desk()]);
  ok('O3. ...recording normally → nothing to say', p.length === 0, JSON.stringify(p));
  const routes = {
    'per-app capture of Edge': [desk({ muted: true }), { inputName: 'Browser', kind: 'wasapi_process_output_capture', settings: { window: 'x:Chrome_WidgetWin_1:msedge.exe' } }],
    'a scene Audio Output Capture': [desk({ muted: true }), { inputName: 'Speakers', kind: 'wasapi_output_capture' }],
    'a window capture with its audio': [desk({ muted: true }), { inputName: 'Game', kind: 'window_capture', settings: { capture_audio: true } }],
    'a virtual cable as an input': [desk({ muted: true }), { inputName: 'Mix', kind: 'wasapi_input_capture', settings: { device_id: 'x1' }, devices: [['x1', 'CABLE Output (VB-Audio Virtual Cable)']] }],
  };
  const quiet = {};
  for (const [name, inputs] of Object.entries(routes)) quiet[name] = codes(await tab(inputs));
  ok('O4. any other route that can carry Chrome → nothing to say (per-app capture of another browser, a scene output capture, a window capture with audio, a virtual cable)', Object.values(quiet).every((c) => c === 'none'), JSON.stringify(quiet));
  const pPerApp = await tab([desk({ muted: true }), { inputName: 'Spotify', kind: 'wasapi_process_output_capture', settings: { window: 'x:y:Spotify.exe' } }]);
  const pOff = await tab([desk({ muted: true }), { inputName: 'Chrome', kind: 'wasapi_process_output_capture', active: false, settings: { window: 'x:y:chrome.exe' } }]);
  const pMic = await tab([desk({ muted: true }), { inputName: 'Audio Input Capture', kind: 'wasapi_input_capture', settings: { device_id: 'm1' }, devices: [['m1', 'Microphone (Shure MV7)']] }]);
  ok('O5. per-app setup without Chrome → named with NO "unmute Desktop Audio" (that would double every app); a Chrome capture not in the live scene → named; a real mic is not a route',
    codes(pPerApp) === 'no-browser-capture' && pPerApp[0].fix === null && codes(pOff) === 'app-capture-off' && codes(pMic) === 'desktop-muted',
    JSON.stringify({ pPerApp: codes(pPerApp), pOff: codes(pOff), pMic: codes(pMic) }));
  p = await tab([], { desktop: null });
  ok('O6. nothing records Chrome at all → named, with where to turn it on', codes(p) === 'desktop-missing' && /Settings → Audio/.test(p[0].text), JSON.stringify(p));
  const ov = (name, o = {}) => ({ inputName: name, kind: 'browser_source', ...o, settings: { reroute_audio: true, url: 'https://megachat.fun/streamer/overlay', ...(o.settings || {}) } });
  const sys = (inputs) => checkObsAudio(fake({ desktop: 'Desktop Audio', inputs }), { mode: 'system', roomId: 'r1', handle: 'streamer' });
  const s1 = await sys([ov('MegaChat Overlay')]);
  const s2 = await sys([ov('Browser', { muted: true, monitor: MONITOR_AND_OUTPUT, settings: { url: 'https://megachat.fun/overlay?room=r1' } })]);
  const s3 = await sys([ov('Other', { settings: { url: 'https://example.com/' } })]);
  const s4 = await sys([ov('A', { monitor: MONITOR_AND_OUTPUT }), ov('B', { monitor: MONITOR_AND_OUTPUT })]);
  const s5 = await sys([ov('C', { monitor: 'OBS_MONITORING_TYPE_MONITOR_ONLY' })]);
  const s6 = await sys([ov('D', { settings: { reroute_audio: false } })]);
  ok('O7. Through OBS: unmonitored → "Let me hear it"; muted → unmute; "Monitor Only" → put on stream; two live → named; none → add it; not controlled by OBS → nothing',
    codes(s1) === 'overlay-monitor' && s1[0].fix?.requestData.monitorType === MONITOR_AND_OUTPUT && codes(s2) === 'overlay-muted'
      && codes(s3) === 'overlay-missing' && codes(s4) === 'overlay-doubled' && codes(s5) === 'overlay-monitor-only' && codes(s6) === 'none'
      && new Set([...s1, ...s4].map((x) => x.id)).size === s1.length + s4.length,
    JSON.stringify({ s1: codes(s1), s2: codes(s2), s3: codes(s3), s4: codes(s4), s5: codes(s5), s6: codes(s6) }));
  ok('O8. the overlay is found by URL: /<handle>/overlay and the retired /r/<handle>/overlay, not /r/<room id>/overlay',
    isRoomOverlay('https://megachat.fun/Streamer/overlay', { handle: 'streamer' }) && isRoomOverlay('https://megachat.fun/r/Streamer/overlay', { roomId: 'r1', handle: 'streamer' })
      && !isRoomOverlay('https://megachat.fun/r/r1/overlay', { roomId: 'r1', handle: 'streamer' }) && !isRoomOverlay('https://megachat.fun/streamerx/overlay', { handle: 'streamer' }));
}

if (!(await sfuUp())) {
  console.log('  refusing the browser part: local livekit-server not running — start tools/livekit-server.exe --dev');
  console.log(`\nRESULT: ${pass} pass, ${fail + 1} fail`);
  process.exit(1);
}

// A speech-like mic (syllables, a gliding voice, breath), and — on demand —
// what this page PLAYS, mixed back in after `__leak.delay` seconds: an echo.
const MEDIA = (seed) => {
  window.__leak = null;
  const played = [];
  const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(v) { if (v && v.getAudioTracks && v.getAudioTracks().length && this.tagName === 'AUDIO') played.push(v); desc.set.call(this, v); },
  });
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  navigator.mediaDevices.getUserMedia = async (c) => {
    const out = new MediaStream();
    if (c && c.video) {
      const cv = document.createElement('canvas'); cv.width = 320; cv.height = 180;
      const ctx = cv.getContext('2d'); let n = 0;
      setInterval(() => { n++; ctx.fillStyle = `hsl(${(n * 9) % 360},70%,50%)`; ctx.fillRect(0, 0, 320, 180); }, 50);
      cv.captureStream(20).getVideoTracks().forEach((t) => out.addTrack(t));
    }
    if (c && c.audio) {
      const ac = new AudioContext();
      const dst = ac.createMediaStreamDestination();
      const voice = ac.createOscillator(); voice.type = 'sawtooth';
      const vg = ac.createGain(); vg.gain.value = 0;
      voice.connect(vg).connect(dst); voice.start();
      const buf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const noise = ac.createBufferSource(); noise.buffer = buf; noise.loop = true;
      const ng = ac.createGain(); ng.gain.value = 0;
      noise.connect(ng).connect(dst); noise.start();
      const leakGain = ac.createGain(); leakGain.gain.value = 0;
      const leakDelay = ac.createDelay(20);
      leakDelay.connect(leakGain).connect(dst);
      const hooked = new Set();
      let on = false, left = 0;
      setInterval(() => {
        if (left-- <= 0) { on = !on; left = on ? 8 + Math.floor(rnd() * 12) : 4 + Math.floor(rnd() * 20); }
        vg.gain.value = on ? 0.2 : 0;
        ng.gain.value = on ? 0.02 : 0.002;
        voice.frequency.value = 100 + 80 * Math.abs(Math.sin(Date.now() / 600 + seed));
        const L = window.__leak;
        for (const st of played) {
          if (hooked.has(st)) continue;
          try { ac.createMediaStreamSource(st).connect(leakDelay); hooked.add(st); } catch { /* not ready */ }
        }
        leakGain.gain.value = L ? L.gain : 0;
        if (L) leakDelay.delayTime.value = L.delay;
      }, 20);
      if (typeof c.audio === 'object') window.__mic = dst.stream.getAudioTracks()[0];
      dst.stream.getAudioTracks().forEach((t) => out.addTrack(t));
    }
    return out;
  };
};

const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-echo-'));
const srv = await startGateServer({
  port: PORT, dataDir, label: 'echo',
  env: { LIVEKIT_URL: 'ws://localhost:7880', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret' },
});
let browser = null, crashed = null;
try {
  const res = await fetch(`${APP}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Echo Room', password: 'echo-pass', config: { transport: 'livekit', passkeyTickPrice: '0' } }),
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
  await host.evaluateOnNewDocument(MEDIA, 4242);
  await host.evaluateOnNewDocument((id) => { try { localStorage.setItem('mc-last-room', JSON.stringify({ id })); } catch { /* */ } }, room.id);
  await host.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await host.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /unlock room/i.test(b.textContent)), { timeout: 30000 });
  await sleep(800);
  await host.evaluate(() => {
    const i = document.querySelector('input[type="password"][autocomplete="current-password"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'echo-pass');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('button')].find((b) => /unlock room/i.test(b.textContent)).click();
  });
  await host.waitForFunction(() => !!document.getElementById('cohost-booth'), { timeout: 30000 });
  await host.click('#cohost-booth');

  // ── M ──
  await host.waitForFunction(() => !!document.getElementById('boothAecNote'), { timeout: 20000 });
  const m = await host.evaluate(() => ({
    details: !!document.getElementById('boothAecAdvanced'),
    open: document.getElementById('boothAecAdvanced')?.open ?? null,
    visibleRadios: [...document.querySelectorAll('[role="radio"]')].filter((b) => b.checkVisibility()).length,
  }));
  ok('M. the mode picker is tucked away for OBS power users; nothing to choose in view', m.details && m.open === false && m.visibleRadios === 0, JSON.stringify(m));

  const g = await (await ctx()).newPage();
  g.on('dialog', (d) => void d.accept());
  await g.evaluateOnNewDocument(MEDIA, 777);
  await g.goto(`${APP}/join?room=${room.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await g.waitForSelector('#username', { timeout: 30000 });
  await sleep(1200);
  await g.evaluate(() => { const u = document.getElementById('username'); u.value = ''; u.dispatchEvent(new Event('input', { bubbles: true })); });
  await g.type('#username', 'echo-guest');
  await g.click('#joinBtn');
  await g.waitForFunction(() => /go live/i.test(document.getElementById('joinBtn')?.textContent || ''), { timeout: 30000 });
  await g.click('#joinBtn');
  await host.waitForFunction(() => /ON AIR/.test(document.getElementById('boothStatus')?.textContent || ''), { timeout: 30000 });
  await until(() => host.evaluate(() => [...document.querySelectorAll('[data-guest-audio] audio')].some((a) => !a.paused)), 20000);

  const guestWarn = () => g.evaluate(() => { const w = document.getElementById('guestEchoWarn'); return !!w && !w.hidden; });
  const boothSays = () => host.evaluate(() => ({
    leak: document.getElementById('boothLeak')?.innerText || '',
    guestEcho: document.getElementById('boothGuestEcho')?.innerText || '',
  }));
  const seatEcho = async () => (await (await fetch(`${APP}/api/dashboard/rooms/${room.id}`, { headers: { 'X-Room-Password': 'echo-pass' } })).json()).seats?.[0]?.echo || null;

  // ── N: both simply talking ──
  let falseAlarm = false;
  for (let i = 0; i < 25; i++) {
    const [w, b] = await Promise.all([guestWarn(), boothSays()]);
    if (w || b.leak || b.guestEcho) falseAlarm = true;
    await sleep(1000);
  }
  ok('N. a booth and a guest talking over each other for 25s → nobody is told anything', !falseAlarm && !(await seatEcho()), `falseAlarm=${falseAlarm}`);

  // ── G: the guest's mic plays the streamer back 3s late ──
  const gAt = Date.now();
  await g.evaluate(() => { window.__leak = { delay: 3, gain: 0.8 }; });
  const warned = await until(guestWarn, 180000, 1000);
  ok('G. the guest\'s mic sends the streamer back 3s late → the guest is told to use headphones', !!warned, warned ? `${((Date.now() - gAt) / 1000).toFixed(0)}s` : 'never');
  const se = await until(seatEcho, 10000, 500);
  const named = await until(async () => { const b = await boothSays(); return /echo-guest/.test(b.guestEcho) ? b : null; }, 15000, 500);
  ok('G. ...the server has it, with the delay (~3s)', !!se && Math.abs(Number(se.lagS) - 3) <= 0.3, JSON.stringify(se));
  ok('G. ...and the booth names the guest', !!named, JSON.stringify(named || await boothSays()));

  // ── GC: it clears ──
  await g.evaluate(() => { window.__leak = null; });
  const cleared = await until(async () => !(await guestWarn()) && !(await seatEcho()), 150000, 1000);
  ok('GC. once it stops → the warning and the booth\'s line go', !!cleared && !(await boothSays()).guestEcho, `${cleared ? 'cleared' : 'still on'}`);

  // ── B: the booth's mic picks the guest up from its speakers ──
  const bAt = Date.now();
  await host.evaluate(() => { window.__leak = { delay: 0.15, gain: 0.8 }; });
  const leak = await until(async () => { const b = await boothSays(); return /echo-guest/.test(b.leak) ? b : null; }, 180000, 1000);
  ok('B. the booth\'s mic picks the guest up from the speakers → the booth says so and names them', !!leak, leak ? `${((Date.now() - bAt) / 1000).toFixed(0)}s: ${leak.leak.split('\n')[0]}` : JSON.stringify(await boothSays()));
  const cure = await host.evaluate(() => [...(document.getElementById('boothLeak')?.querySelectorAll('button') || [])].map((b) => b.textContent));
  ok('B. ...with the one-click cure', cure.some((t) => /through OBS/i.test(t)), JSON.stringify(cure));
  await host.evaluate(() => { window.__leak = null; });
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
