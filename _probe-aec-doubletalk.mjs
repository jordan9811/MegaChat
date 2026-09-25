/**
 * PROBE — with whole-PC echo cancellation, does the streamer's VOICE survive
 * while the PC keeps playing (the game, OBS monitoring)?
 *
 * _probe-aec-loopback.mjs proves echoCancellation:'all' removes another app's
 * playback from the mic. It cannot say what happens to the person talking at
 * the same time — and with 'all' the canceller's reference is everything the PC
 * plays, which during a Rocket League stream is never silent. If the canceller
 * suppressed the streamer's voice whenever the game was loud, guests would hear
 * him chopped: worse than the echo it replaced. This measures it.
 *
 * How: Chrome's fake microphone carries a real SPEECH recording (Windows TTS)
 * plus a game-like noise bed — the "echo". A separate, non-Chrome process
 * (scripts/play-endpoint.ps1) plays that same noise bed into a real playback
 * endpoint, as OBS/the game would. The processed mic output is captured raw,
 * aligned with the known speech in 50 ms slices, and split into:
 *   voice     — the median gain the speech came through with (dB; 0 = untouched)
 *   dropouts  — the share of speech slices knocked >10 dB under that median:
 *               a gated syllable, heard as chopping
 *   left      — the level of everything that is not the speech (the echo that
 *               survived, plus processing noise), dBFS
 * in three rooms — the game as loud as the voice in the mic, 20 dB under it,
 * and not in the mic at all (headphones) — for Whole PC ('all') against This
 * tab (`true`), with the booth's real processing. Row A (no processing) must
 * read ~0 dB with no dropouts, or the run says so and exits 2.
 *
 * Measured 2026-09-25 on the operator's machine: Whole PC 24% / 2% / 10%
 * dropouts (loud / quiet / headphones), This tab 1% / 0% / 0%.
 *
 * Windows only (TTS + WASAPI player); needs ffmpeg on PATH. Pick headphones:
 *   node _probe-aec-doubletalk.mjs "{0.0.0.00000000}.{<render endpoint key>}"
 */
import http from 'http';
import { spawn, execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';

const DEVICE = process.argv[2];
if (!DEVICE) { console.log('usage: node _probe-aec-doubletalk.mjs "<playback endpoint id>"'); process.exit(2); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLAY = path.join(HERE, 'scripts', 'play-endpoint.ps1');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TMP = mkdtempSync(path.join(tmpdir(), 'mc-aec-dt-'));
const RATE = 48000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the voice: Windows TTS, resampled to 48 kHz mono ────────────────────────
const TEXT = 'Welcome back to the stream everybody. Tonight we are testing the new co-host booth, and I want to hear from all of you in the chat. If you want to come on camera, grab a seat and say hello. We are going to play a few rounds, talk about the season, and answer questions. Remember the booth is live with a short delay, so be patient if you do not hear me right away. Thanks for hanging out, it really means a lot. Let me know what you think about the new overlay, and whether the audio sounds better on your end.';
const ttsWav = path.join(TMP, 'tts.wav');
execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${ttsWav}'); $s.Speak('${TEXT.replace(/'/g, "''")}'); $s.Dispose()`]);
const voiceWav = path.join(TMP, 'voice48.wav');
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', ttsWav, '-ar', String(RATE), '-ac', '1', '-sample_fmt', 's16', voiceWav]);
const readPcm = (f) => { const b = readFileSync(f); const i = b.indexOf('data') + 8; const n = (b.length - i) >> 1; const o = new Float32Array(n); for (let k = 0; k < n; k++) o[k] = b.readInt16LE(i + k * 2) / 32768; return o; };
let S = readPcm(voiceWav);
{ let pk = 0; for (const v of S) pk = Math.max(pk, Math.abs(v)); for (let k = 0; k < S.length; k++) S[k] *= 0.5 / pk; }
const N = S.length;

// ── the "game": a continuous noise bed, periodic (0.5 s) so the unrelated
// start times of the two sides stay inside the canceller's delay range ───────
const period = RATE / 2;
const bed = new Float32Array(period);
{ let seed = 777, lp = 0; for (let k = 0; k < period; k++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; lp = lp * 0.6 + (seed / 0x7fffffff * 2 - 1) * 0.4; bed[k] = lp * 0.35; } }
const writeWav = (f, x) => {
  const pcm = Buffer.alloc(x.length * 2);
  for (let k = 0; k < x.length; k++) pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(x[k] * 32767))), k * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  writeFileSync(f, Buffer.concat([h, pcm]));
};
// Three rooms, one fake mic file each (Chrome takes the file at launch):
//   loud   — the game as loud in the mic as the voice (speakers up, mic far):
//            the stress case
//   quiet  — the game 20 dB under the voice (speakers, a close dynamic mic
//            like the MV7)
//   phones — the game in the canceller's reference but NOT in the mic
//            (headphones): does it chop a voice with nothing to cancel?
const micFile = (name, bedGain) => {
  const f = path.join(TMP, `mic-${name}.wav`);
  const mic = new Float32Array(N);
  for (let k = 0; k < N; k++) mic[k] = S[k] + bedGain * bed[k % period];
  writeWav(f, mic);
  return f;
};
const MIC = { loud: micFile('loud', 1), quiet: micFile('quiet', 0.1), phones: micFile('phones', 0) };
const bedWav = path.join(TMP, 'bed.wav');
{ const b = new Float32Array(RATE * 40); for (let k = 0; k < b.length; k++) b[k] = bed[k % period]; writeWav(bedWav, b); }

const PAGE = `<!doctype html><meta charset=utf-8><script>
window.run = async (constraints, seconds) => {
  const s = await navigator.mediaDevices.getUserMedia({ audio: constraints });
  const t = s.getAudioTracks()[0];
  const got = t.getSettings().echoCancellation;
  const ac = new AudioContext({ sampleRate: 48000 });
  const src = ac.createMediaStreamSource(s);
  const sp = ac.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  sp.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  const mute = ac.createGain(); mute.gain.value = 0;
  src.connect(sp); sp.connect(mute); mute.connect(ac.destination);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  t.stop(); await ac.close();
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const all = new Float32Array(n); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  const bytes = new Uint8Array(all.buffer); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { got: String(got), b64: btoa(bin) };
};
</script>`;
const srv = http.createServer((_, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); });
await new Promise((r) => srv.listen(3392, r));
let browser = null, page = null;
const room = async (name) => {
  if (browser) await browser.close();
  browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${MIC[name]}`, '--autoplay-policy=no-user-gesture-required'],
  });
  page = await browser.newPage();
  await page.goto('http://localhost:3392/');
};

const player = (seconds) => {
  const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PLAY,
    '-Wav', bedWav, '-DeviceId', DEVICE, '-Seconds', String(seconds)], { stdio: 'ignore' });
  return new Promise((r) => p.on('exit', r));
};

// Decimate 48k → 8k by averaging 6 (voice band fits under 4 kHz).
const dec = (x, f = 6) => { const o = new Float32Array(Math.floor(x.length / f)); for (let i = 0; i < o.length; i++) { let a = 0; for (let j = 0; j < f; j++) a += x[i * f + j]; o[i] = a / f; } return o; };
const Sd = dec(S);
const S1k = dec(Sd, 8);
// Where in the speech file does this output window sit, and at what gain?
const analyse = (y48) => {
  // Coarse global position of the output window in the speech (1 kHz).
  const y = dec(y48);
  const w0 = 5 * 8000, wLen = 12 * 8000; // judge 5–17 s, after convergence
  const yw1 = dec(y.subarray(w0, w0 + wLen), 8);
  let best = -1, coarse = 0;
  for (let o = 0; o + yw1.length <= S1k.length; o++) {
    let xy = 0, xx = 0;
    for (let k = 0; k < yw1.length; k++) { xy += yw1[k] * S1k[o + k]; xx += S1k[o + k] * S1k[o + k]; }
    const c = xx > 0 ? Math.abs(xy) / Math.sqrt(xx) : 0;
    if (c > best) { best = c; coarse = o; }
  }
  // Then block by block at 48 kHz: the fake capture can drop or repeat a 10 ms
  // buffer, so one alignment for 12 s drifts. Each 50 ms block is realigned
  // near the last one — short, so few blocks straddle a drop (a straddling
  // block is half-aligned and reads ~6 dB low; with 0.25 s blocks that moved
  // the no-processing median between -0.7 and -2.4 dB run to run). The voice
  // gain is the median over blocks that carry speech, and "left" is
  // everything the aligned speech does not explain.
  const B = 2400, W0 = w0 * 6, nb = Math.floor((wLen * 6) / B);
  let pos = coarse * 48;
  const gains = [];
  let resid = 0, count = 0, sEnergyAll = 0;
  for (let i = 0; i < S.length; i++) sEnergyAll += S[i] * S[i];
  const sMean = sEnergyAll / S.length;
  for (let bi = 0; bi < nb; bi++) {
    const yb = y48.subarray(W0 + bi * B, W0 + (bi + 1) * B);
    let bo = pos, bc = -1;
    for (let o = Math.max(0, pos - 960); o <= Math.min(S.length - B, pos + 960); o += 2) {
      let xy = 0, xx = 0;
      for (let k = 0; k < B; k += 3) { xy += yb[k] * S[o + k]; xx += S[o + k] * S[o + k]; }
      const c = xx > 0 ? Math.abs(xy) / Math.sqrt(xx) : 0;
      if (c > bc) { bc = c; bo = o; }
    }
    for (let o = Math.max(0, bo - 2); o <= Math.min(S.length - B, bo + 2); o++) {
      let xy = 0, xx = 0;
      for (let k = 0; k < B; k++) { xy += yb[k] * S[o + k]; xx += S[o + k] * S[o + k]; }
      const c = xx > 0 ? Math.abs(xy) / Math.sqrt(xx) : 0;
      if (c > bc) { bc = c; bo = o; }
    }
    let xy = 0, xx = 0;
    for (let k = 0; k < B; k++) { xy += yb[k] * S[bo + k]; xx += S[bo + k] * S[bo + k]; }
    const g = xx > 0 ? xy / xx : 0;
    for (let k = 0; k < B; k++) { const r = yb[k] - g * S[bo + k]; resid += r * r; }
    count += B;
    const speech = xx / B > sMean * 0.5; // a block with real speech in it
    if (speech) gains.push(Math.abs(g));
    // Only a block with speech in it can say where the speech is; a quiet
    // block's best lag is chance, so it just advances the running position.
    pos = speech ? bo + B : pos + B;
  }
  gains.sort((a, b) => a - b);
  const pick = (q) => (gains.length ? gains[Math.min(gains.length - 1, Math.floor(gains.length * q))] : 0);
  const db = (g) => 20 * Math.log10(g);
  // Median = how loud the voice comes through; the 10th percentile = the worst
  // blocks, which is where a canceller CHOPPING the voice would show.
  // A DROPOUT is a 50 ms slice of speech knocked more than 10 dB under the
  // row's own median — a gated syllable, what a listener hears as chopping.
  const med = pick(0.5);
  const drops = gains.filter((g) => g < med * 10 ** (-10 / 20)).length;
  return {
    voiceDb: db(med), p10Db: db(pick(0.1)), leftDb: 10 * Math.log10(resid / count),
    blocks: gains.length, dropPct: gains.length ? (100 * drops) / gains.length : 0,
  };
};

const rows = {};
const run = async (id, label, constraints, withBed) => {
  const pl = withBed ? player(26) : null;
  if (pl) await sleep(1500);
  const r = await page.evaluate((c, s) => window.run(c, s), constraints, 20);
  if (pl) await pl;
  const buf = Buffer.from(r.b64, 'base64');
  const y = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const a = analyse(y);
  rows[id] = { label, got: r.got, bed: withBed, ...a };
  console.log(`${id.padEnd(3)} ${label.padEnd(40)} got=${r.got.padEnd(5)} game=${withBed ? 'on ' : 'off'}  voice ${a.voiceDb.toFixed(1).padStart(6)} dB   dropouts ${a.dropPct.toFixed(0).padStart(3)}%   worst 10% ${a.p10Db.toFixed(1).padStart(6)}   left ${a.leftDb.toFixed(1).padStart(6)} dBFS   (${a.blocks} blocks)`);
};
const RAW = { noiseSuppression: false, autoGainControl: false, voiceIsolation: false };
const PROD = { noiseSuppression: true, autoGainControl: true, voiceIsolation: true };
const ALL = { ...PROD, echoCancellation: 'all' };
const TAB = { ...PROD, echoCancellation: true };

await room('loud');
console.log('── loud: the game as loud in the mic as the voice (stress case) ──');
console.log('   processing off — the canceller alone:');
await run('A', 'no cancellation', { ...RAW, echoCancellation: false }, true);
await run('B', 'echoCancellation:true', { ...RAW, echoCancellation: true }, true);
await run('C', "echoCancellation:'all'", { ...RAW, echoCancellation: 'all' }, true);
await run('D', "echoCancellation:'all', nothing playing", { ...RAW, echoCancellation: 'all' }, false);
console.log('   the booth\'s real settings (noise suppression, AGC, voice isolation):');
await run('L1', "booth Whole PC ('all')", ALL, true);
await run('L2', 'booth This tab (true)', TAB, true);

await room('quiet');
console.log('── quiet: the game 20 dB under the voice (speakers, close dynamic mic) ──');
await run('Q1', "booth Whole PC ('all')", ALL, true);
await run('Q2', 'booth This tab (true)', TAB, true);

await room('phones');
console.log('── phones: the game in the reference, not in the mic (headphones) ──');
await run('P0', "booth Whole PC ('all'), nothing playing", ALL, false);
await run('P1', "booth Whole PC ('all')", ALL, true);
await run('P2', 'booth This tab (true)', TAB, true);
await browser.close(); srv.close();

// Is the measurement sound? With no processing the speech must come back
// whole: ~0 dB and no dropouts.
const A = rows.A;
const valid = Math.abs(A.voiceDb) <= 1.5 && A.dropPct <= 3;
console.log('');
console.log(`measurement valid (no processing: ~0 dB, no dropouts): ${valid ? 'yes' : 'NO'} (${A.voiceDb.toFixed(1)} dB, ${A.dropPct.toFixed(0)}% dropouts)`);
console.log(`echo removed by 'all' beyond true while talking over it (loud, raw): ${(rows.B.leftDb - rows.C.leftDb).toFixed(1)} dB`);
// Per room: does Whole PC treat the voice at least as well as This tab? Level
// within 1 dB (or better) and no more than 3 points more dropouts.
const verdicts = [
  ['loud', rows.L1, rows.L2],
  ['quiet', rows.Q1, rows.Q2],
  ['phones', rows.P1, rows.P2],
].map(([name, pc, tab]) => {
  const ok = pc.voiceDb >= tab.voiceDb - 1 && pc.dropPct <= tab.dropPct + 3;
  console.log(`${name.padEnd(7)} Whole PC vs This tab: voice ${(pc.voiceDb - tab.voiceDb >= 0 ? '+' : '')}${(pc.voiceDb - tab.voiceDb).toFixed(1)} dB, dropouts ${pc.dropPct.toFixed(0)}% vs ${tab.dropPct.toFixed(0)}%  → ${ok ? 'Whole PC is no worse' : 'Whole PC CHOPS or dims the voice here'}`);
  return [name, ok];
});
const phonesClean = rows.P1.dropPct <= rows.P0.dropPct + 3;
console.log(`phones  game in the reference vs silent: dropouts ${rows.P1.dropPct.toFixed(0)}% vs ${rows.P0.dropPct.toFixed(0)}%  → ${phonesClean ? 'a game the mic cannot hear does not chop the voice' : 'the game CHOPS the voice even though the mic cannot hear it'}`);
if (!valid) { console.log('\nVERDICT: the measurement is not sound this run — trust nothing above; re-run.'); process.exit(2); }
const bad = verdicts.filter(([, ok]) => !ok).map(([n]) => n);
if (!phonesClean && !bad.includes('phones')) bad.push('phones');
console.log(bad.length
  ? `\nVERDICT: Whole PC is worse for the guests than This tab in: ${bad.join(', ')}.`
  : '\nVERDICT: in every room, Whole PC keeps the voice at least as whole as This tab.');
process.exit(bad.length ? 1 : 0);
