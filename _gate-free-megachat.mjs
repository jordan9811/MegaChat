/**
 * GATE — free-room MegaChat send, end to end through the REAL UI:
 * open stage → record (synthetic cam+tone) → Send → upload → queued.
 *
 * Guards two shipped bugs:
 *  - the free-path session stub had no close() → TypeError after submit,
 *    "Sending…" then silence, letter orphaned as awaiting_upload;
 *  - with a real MODERATION_API_KEY, multi-frame reviews 400'd
 *    (too_many_images: the API takes ONE image per request) and failed
 *    open — moderation never actually ran. Key present → asserts the
 *    verdict round-trip completes; absent → straight to queued.
 */
import { spawn } from 'child_process';
import puppeteer from 'puppeteer-core';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

try { process.loadEnvFile(); } catch { /* env external */ }
console.log('moderation key present:', !!process.env.MODERATION_API_KEY);

const PORT = 3221, APP = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'], cwd: process.cwd(),
});
app.stdout.on('data', (d) => {
  const s = d.toString();
  if (/letter|moderat|error/i.test(s)) process.stdout.write('  [server] ' + s);
});
app.stderr.on('data', (d) => process.stdout.write('  [server:err] ' + d.toString().slice(0, 300)));
await sleep(9000);

const GUM_OVERRIDE = () => {
  const makeStream = () => {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 360;
    const ctx = c.getContext('2d');
    setInterval(() => {
      ctx.fillStyle = `hsl(${Date.now() / 15 % 360},80%,50%)`;
      ctx.fillRect(0, 0, 640, 360);
    }, 66);
    const stream = c.captureStream(15);
    try {
      const ac = new AudioContext();
      const osc = ac.createOscillator();
      const dst = ac.createMediaStreamDestination();
      osc.connect(dst); osc.start();
      dst.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    } catch { /* video only */ }
    return stream;
  };
  navigator.mediaDevices.getUserMedia = async () => makeStream();
};

try {
  const res = await fetch(`${APP}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Free MC Diag', password: 'diag-mc', config: { passkeyTickPrice: '0' } }),
  });
  const { room } = await res.json();
  console.log('free room', room.id, 'letters price should derive to 0');

  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', protocolTimeout: 90000,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (/letter|error|failed|close/i.test(m.text())) console.log('  [page]', m.type(), m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 250)));
  await page.evaluateOnNewDocument(GUM_OVERRIDE);
  await page.goto(`${APP}/join?room=${room.id}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1500);

  const btnText = await page.evaluate(() => document.getElementById('letterBtn')?.textContent || 'NO BUTTON');
  console.log('letter CTA:', JSON.stringify(btnText));

  await page.type('#username', 'diag-sender');
  await page.evaluate(() => document.getElementById('letterBtn').click());
  await sleep(1200);
  await page.evaluate(() => document.getElementById('letterRecordBtn').click());
  await sleep(2500);
  await page.evaluate(() => document.getElementById('letterRecordBtn').click()); // stop
  await sleep(1500);
  const preSend = await page.evaluate(() => ({
    sendVisible: document.getElementById('letterSendBtn')?.style.display !== 'none',
    status: document.getElementById('letterStatus')?.textContent || '',
  }));
  console.log('pre-send:', JSON.stringify(preSend));
  await page.evaluate(() => document.getElementById('letterSendBtn').click());

  // client side: success message lands, stage closes, no failure text
  let clientSt = null;
  for (let i = 0; i < 10; i++) {
    await sleep(2500);
    clientSt = await page.evaluate(() => ({
      letterStatus: document.getElementById('letterStatus')?.textContent || '',
      message: (document.getElementById('message')?.innerText || '').slice(0, 160),
      stageOpen: document.getElementById('letterStage')?.style.display !== 'none',
    }));
    if (/sent|review/i.test(clientSt.message) || /failed|❌/i.test(clientSt.message + clientSt.letterStatus)) break;
  }
  ok('free send: client shows SENT (no silent death, no failure)',
    /sent|review/i.test(clientSt.message) && !/failed|❌/.test(clientSt.message + clientSt.letterStatus)
    && !clientSt.stageOpen, JSON.stringify(clientSt));

  // server side: the letter exists and reaches a settled state
  const listLetters = async () => {
    const admin = await fetch(`${APP}/api/dashboard/rooms/${room.id}/letters`, {
      headers: { 'X-Room-Password': 'diag-mc' },
    });
    return (await admin.json()).letters || [];
  };
  let ls = await listLetters();
  ok('free send: letter visible on the dashboard letters list', ls.length === 1, `status=${ls[0]?.status}`);

  // with a key: the REAL whisper+omni round-trip must complete (no 400
  // fail-open); without: it settles straight to queued
  let finalSt = ls[0]?.status;
  for (let i = 0; i < 12 && finalSt === 'reviewing'; i++) {
    await sleep(2500);
    ls = await listLetters();
    finalSt = ls[0]?.status || 'gone';
  }
  ok('free send: review settles to queued (never stuck reviewing/awaiting_upload)',
    finalSt === 'queued', `final=${finalSt}`);

  // ── NO overlay connected: the clip must HOLD, not burn into the void ──────
  // (the scheduler sweeps every 2s — 3 sweeps of margin)
  await sleep(7000);
  ls = await listLetters();
  ok('no overlay: clip HELD in queue (not consumed invisibly)',
    ls.length === 1 && ls[0].status === 'queued', `status=${ls[0]?.status ?? 'GONE'}`);
  ok('no overlay: sender was warned it is queued, not lied to about airing',
    await page.evaluate(() => /overlay isn't online yet/i.test(document.getElementById('message')?.innerText || '')),
    await page.evaluate(() => (document.getElementById('message')?.innerText || '').slice(0, 120)));

  // ── overlay connects → the clip plays FOR REAL, sender notified ───────────
  const overlay = await browser.newPage();
  await overlay.goto(`${APP}/overlay?room=${room.id}`, { waitUntil: 'networkidle2', timeout: 60000 });
  let tile = null;
  for (let i = 0; i < 8 && !tile; i++) {
    await sleep(1500);
    tile = await overlay.evaluate(() => {
      const box = [...document.querySelectorAll('.tile')].find((b) => (b.dataset.seatId || '').startsWith('letter:'));
      if (!box) return null;
      const v = box.querySelector('video');
      return { hasVideo: !!v, label: box.querySelector('.username-label')?.textContent || '' };
    });
  }
  ok('overlay online: letter tile renders with its video', !!tile && tile.hasVideo && /diag-sender/.test(tile.label), JSON.stringify(tile));
  const senderNotified = await page.evaluate(() => /RIGHT NOW/i.test(document.getElementById('message')?.innerText || ''));
  ok('sender sees "on stream RIGHT NOW" only when it actually IS', senderNotified);

  // ── one-shot completes: tile leaves, letter leaves the dashboard ──────────
  await sleep(8000); // 3s clip + stinger buffer + sweep margin
  const tileGone = await overlay.evaluate(() =>
    ![...document.querySelectorAll('.tile')].some((b) => (b.dataset.seatId || '').startsWith('letter:')));
  ls = await listLetters();
  ok('one-shot: tile removed and letter cleared after playing', tileGone && ls.length === 0,
    `tileGone=${tileGone} listed=${ls.length}`);

  await browser.close();
} finally {
  app.kill();
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
