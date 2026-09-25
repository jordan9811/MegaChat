/**
 * PROBE — does this machine's Chrome cancel audio played by ANOTHER app?
 *
 * The booth's "Whole PC" echo cancellation rests on one fact: Chrome's
 * echoCancellation:'all' uses a system-wide loopback of everything the PC
 * plays as its reference, so it cancels OBS monitoring — which the ordinary
 * echoCancellation:true cannot, because that only subtracts what Chrome itself
 * played. This probe measures it on the machine it runs on.
 *
 * How: Chrome's microphone is a FAKE device fed from a generated test pattern.
 * A separate, non-Chrome process (scripts/play-endpoint.ps1 — the stand-in for
 * OBS) plays the same pattern into a real playback endpoint. To the echo
 * canceller that is an echo of something the PC is playing. The level that
 * survives processing is measured per mode; the pattern is periodic (0.5s), so
 * the unrelated start times of the two sides stay within the canceller's delay
 * range.
 *
 * Result on the operator's machine, 2026-09-25 (Windows 11 25H2, Chrome
 * 154.0.8037.57, played into "Headphones (Shure MV7)", a NON-default device):
 *   A  no cancellation, player on      -17.0 dBFS
 *   B  echoCancellation:true, on       -17.9 dBFS   ← cannot touch another app
 *   C  echoCancellation:'all', on      -67.9 dBFS   ← 50 dB cancelled
 *   D  echoCancellation:'all', OFF     -17.9 dBFS   ← so the drop IS cancellation
 *   E  'all' again, on                 -67.7 dBFS   ← reproducible
 *
 * Windows only (the player uses WASAPI). It plays a noise pattern out loud on
 * the chosen endpoint for about a minute, so pick headphones. Find endpoint ids:
 *   Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render'
 * and pass '{0.0.0.00000000}.{<key name>}'.
 *
 *   node _probe-aec-loopback.mjs "{0.0.0.00000000}.{454bef10-e322-4790-b805-65f5742b04c8}"
 */
import http from 'http';
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';

const DEVICE = process.argv[2];
if (!DEVICE) { console.log('usage: node _probe-aec-loopback.mjs "<playback endpoint id>" (see header)'); process.exit(2); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLAY = path.join(HERE, 'scripts', 'play-endpoint.ps1');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the pattern: 300ms of seeded, lightly low-passed noise, 200ms silence ────
const WAV = path.join(mkdtempSync(path.join(tmpdir(), 'mc-aec-probe-')), 'pattern.wav');
{
  const RATE = 48000, SECONDS = 40, period = RATE / 2, on = RATE * 0.3;
  let seed = 12345, lp = 0;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  const one = new Float32Array(period);
  for (let i = 0; i < period; i++) { lp = lp * 0.6 + rand() * 0.4; one[i] = i < on ? lp * 0.5 : 0; }
  const pcm = Buffer.alloc(RATE * SECONDS * 2);
  for (let i = 0; i < RATE * SECONDS; i++) pcm.writeInt16LE(Math.round(one[i % period] * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  writeFileSync(WAV, Buffer.concat([h, pcm]));
}

const PAGE = `<!doctype html><meta charset=utf-8><script>
window.run = async (mode, seconds) => {
  const s = await navigator.mediaDevices.getUserMedia({ audio: {
    echoCancellation: mode, noiseSuppression: false, autoGainControl: false, voiceIsolation: false } });
  const t = s.getAudioTracks()[0];
  const got = t.getSettings().echoCancellation;
  const ac = new AudioContext();
  const an = ac.createAnalyser(); an.fftSize = 2048;
  ac.createMediaStreamSource(s).connect(an);
  const buf = new Float32Array(an.fftSize), series = [];
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    an.getFloatTimeDomainData(buf);
    let sum = 0; for (const v of buf) sum += v * v;
    series.push(Math.sqrt(sum / buf.length));
  }
  t.stop(); await ac.close();
  return { asked: String(mode), got: String(got), series };
};
</script>`;
const srv = http.createServer((_, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); });
await new Promise((r) => srv.listen(3391, r));
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${WAV}`, '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.goto('http://localhost:3391/');

// The pattern's peaks over the last 4s (after the canceller converges), in dB.
const level = (series) => {
  const tail = series.slice(-40).sort((a, b) => b - a).slice(0, 13);
  const m = tail.reduce((a, b) => a + b, 0) / tail.length;
  return m > 0 ? 20 * Math.log10(m) : -120;
};
const player = (seconds) => {
  const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PLAY,
    '-Wav', WAV, '-DeviceId', DEVICE, '-Seconds', String(seconds)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  return new Promise((r) => p.on('exit', (code) => r({ code, out: out.trim() })));
};
const L = {};
const run = async (key, label, mode, withPlayer) => {
  const pl = withPlayer ? player(14) : null;
  if (pl) await sleep(1500);
  const r = await page.evaluate((m, s) => window.run(m, s), mode, 10);
  const pr = pl ? await pl : null;
  L[key] = +level(r.series).toFixed(1);
  console.log(`${key}  ${label.padEnd(32)} asked=${r.asked.padEnd(5)} got=${r.got.padEnd(5)} ${L[key]} dBFS${pr && pr.code !== 0 ? '  PLAYER FAILED: ' + pr.out : ''}`);
};
await run('A', 'no cancellation, player on', false, true);
await run('B', 'echoCancellation:true, player on', true, true);
await run('C', "echoCancellation:'all', player on", 'all', true);
await run('D', "echoCancellation:'all', player OFF", 'all', false);
await run('E', "'all' again, player on", 'all', true);
await browser.close(); srv.close();

const cancelled = L.B - L.C, isTheSignal = L.D - L.C;
console.log(`\n'all' vs true, another app playing: ${cancelled.toFixed(1)} dB lower`);
console.log(`'all', player on vs off:           ${isTheSignal.toFixed(1)} dB lower`);
const verdict = cancelled >= 20 && isTheSignal >= 20 && L.E <= L.C + 6;
console.log(verdict
  ? "\nVERDICT: Whole-PC echo cancellation WORKS on this machine — the booth's default is safe here."
  : "\nVERDICT: Whole-PC echo cancellation did NOT clearly work here — use the booth's \"This tab\" mode on this machine.");
process.exit(verdict ? 0 : 1);
