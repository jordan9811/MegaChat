/**
 * GATE — Co-host booth: auto-armed host camera, real local SFU, FREE room
 * (wallet-less join → no payments needed to exercise the loop).
 *
 *  A. booth renders for the livekit room; toggle ON = prophylactic
 *     getUserMedia (called at arm time, tracks stopped after → LED off),
 *     armed flag persisted, and NO publish while zero guests.
 *  B. guest goes live through the REAL join UI (free room, username +
 *     one morphing button) → booth auto-publishes: SFU lists
 *     host:<roomId> with tracks, joiner's #hostLiveMount receives frames,
 *     dashboard status says ON AIR.
 *  C. resilience: dashboard reload mid-session → silent re-arm (permission
 *     remembered) → auto-publish resumes, joiner recovers frames.
 *  D. last guest leaves (UI tap) → auto-off after the grace timer; status
 *     back to Armed. Toggle OFF clears the persisted flag.
 *  E. denied path: getUserMedia throws NotAllowedError → "Camera blocked"
 *     guidance, checkbox stays unchecked.
 */
import { spawn } from 'child_process';
import puppeteer from 'puppeteer-core';
import { RoomServiceClient } from 'livekit-server-sdk';

try { process.loadEnvFile(); } catch { /* env external */ }

const PORT = 3216;
const APP = `http://localhost:${PORT}`;
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const health = await fetch('http://localhost:7880/').then((r) => r.text()).catch(() => null);
if (health !== 'OK') { console.error('local livekit-server not running — start tools/livekit-server.exe --dev'); process.exit(1); }

const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: {
    ...process.env, PORT: String(PORT),
    LIVEKIT_URL: 'ws://localhost:7880', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret',
  },
  stdio: 'ignore', cwd: process.cwd(),
});
await sleep(9000);

const svc = new RoomServiceClient('http://localhost:7880', 'devkey', 'secret');
const hostOnSfu = async (roomId) => {
  const ps = await svc.listParticipants(`mc-${roomId}`).catch(() => []);
  const h = ps.find((p) => p.identity === `host:${roomId}`);
  return h ? (h.tracks || []).length : -1; // -1 = absent, n = track count
};
const pollHost = async (roomId, want, tries = 14) => {
  for (let i = 0; i < tries; i++) {
    const n = await hostOnSfu(roomId);
    if (want === 'present' && n >= 1) return n;
    if (want === 'absent' && n === -1) return n;
    await sleep(1500);
  }
  return await hostOnSfu(roomId);
};

// getUserMedia stand-in: synthetic cam + tone, instrumented so the gate can
// assert WHEN permission was requested and that preflight tracks were
// stopped. __gumDeny simulates the user hitting "Block".
const GUM_OVERRIDE = () => {
  const makeStream = (label) => {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 360;
    const ctx = c.getContext('2d');
    setInterval(() => {
      ctx.fillStyle = `hsl(${Date.now() / 15 % 360},80%,50%)`;
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 40px sans-serif';
      ctx.fillText(label, 250, 195);
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
  window.__gumCalls = 0;
  window.__gumTracks = [];
  navigator.mediaDevices.getUserMedia = async () => {
    window.__gumCalls++;
    if (window.__gumDeny) throw new DOMException('Permission denied', 'NotAllowedError');
    const s = makeStream(window.__gumLabel || 'CAM');
    s.getTracks().forEach((t) => window.__gumTracks.push(t));
    return s;
  };
};

const unlockDashboard = async (page, roomId, password) => {
  // domcontentloaded, NOT networkidle2 — a managing dashboard keeps a WS +
  // 5s poll alive, and an ON-AIR booth adds the SFU socket: never "idle".
  await page.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // The unlock form lives behind the "Have a room ID + password?" disclosure
  // now (the create/manage tab pair is gone).
  await page.waitForFunction(
    () => [...document.querySelectorAll('summary')].some((s) => /room id \+ password/i.test(s.textContent)),
    { timeout: 30000 },
  );
  await page.evaluate(() => {
    const s = [...document.querySelectorAll('summary')].find((x) => /room id \+ password/i.test(x.textContent));
    s?.closest('details')?.setAttribute('open', '');
  });
  await sleep(400);
  await page.type('#manage-room-id', roomId);
  await page.type('#manage-password', password);
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => /unlock room/i.test(b.textContent))?.click();
  });
  await page.waitForFunction(() => !!document.getElementById('cohost-booth'), { timeout: 20000 })
    .catch(() => { /* boothState asserts on it */ });
  await sleep(600);
};

const boothState = (page) => page.evaluate(() => ({
  present: !!document.getElementById('cohost-booth'),
  checked: document.getElementById('cohost-booth')?.checked ?? null,
  status: document.getElementById('boothStatus')?.textContent || '',
  error: document.getElementById('boothError')?.textContent || '',
  gumCalls: window.__gumCalls || 0,
  tracksEnded: (window.__gumTracks || []).map((t) => t.readyState),
}));

try {
  // FREE livekit room — wallet-less joins keep the gate payment-free.
  const res = await fetch(`${APP}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Booth Gate', password: 'booth-gate',
      config: { transport: 'livekit', passkeyTickPrice: '0', twitchChannel: 'megachattv' },
    }),
  });
  const { room } = await res.json();
  if (!room?.id) { console.error('room create failed'); process.exit(1); }
  console.log('  [setup] free livekit room', room.id);

  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    protocolTimeout: 90000,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  // permissions.query must say "granted" for the silent re-arm path (C).
  await browser.defaultBrowserContext().overridePermissions(APP, ['camera', 'microphone']);

  // ── A. arm = permission preflight, not a publish ───────────────────────────
  const host = await browser.newPage();
  host.on('console', (m) => { if (/booth|livekit|error/i.test(m.text())) console.log('  [host]', m.text().slice(0, 140)); });
  // The ON-AIR booth warns on close (beforeunload) — accept it like a user
  // clicking "Leave" so the mid-session reload in section C can proceed.
  let unloadWarned = false;
  host.on('dialog', (d) => { unloadWarned = true; void d.accept(); });
  await host.evaluateOnNewDocument(GUM_OVERRIDE);
  await host.evaluateOnNewDocument(() => { window.__gumLabel = 'HOST'; });
  await unlockDashboard(host, room.id, 'booth-gate');

  let st = await boothState(host);
  ok('booth card renders for the livekit room', st.present, st.status.slice(0, 60));
  ok('booth starts off (guests see waiting screen)', st.checked === false && /booth off/i.test(st.status));

  await host.click('#cohost-booth');
  await sleep(1500);
  st = await boothState(host);
  ok('arming asked for camera+mic RIGHT THEN (prophylactic)', st.gumCalls >= 1, `gumCalls=${st.gumCalls}`);
  ok('preflight tracks stopped after the grant (no idle LED)',
    st.tracksEnded.length > 0 && st.tracksEnded.every((s) => s === 'ended'), JSON.stringify(st.tracksEnded));
  ok('booth is armed + persisted', st.checked === true && /armed/i.test(st.status)
    && await host.evaluate((id) => localStorage.getItem('mc-booth-armed:' + id) === '1', room.id));
  await sleep(3000);
  ok('armed ≠ on air: no host on the SFU with zero guests', (await hostOnSfu(room.id)) === -1);

  // ── B. guest goes live via the REAL free-room UI → auto-publish ────────────
  const joiner = await browser.newPage();
  joiner.on('console', (m) => { if (/livekit|host feed|error/i.test(m.text())) console.log('  [joiner]', m.text().slice(0, 140)); });
  joiner.on('dialog', (d) => void d.accept());
  await joiner.evaluateOnNewDocument(GUM_OVERRIDE);
  await joiner.evaluateOnNewDocument(() => { window.__gumLabel = 'GUEST'; });
  await joiner.goto(`${APP}/join?room=${room.id}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1500);
  await joiner.type('#username', 'booth-guest');
  await joiner.click('#joinBtn');
  await joiner.waitForFunction(
    () => /go live/i.test(document.getElementById('joinBtn')?.textContent || ''),
    { timeout: 25000 },
  );
  await joiner.click('#joinBtn');
  await joiner.waitForFunction(
    () => /you're live/i.test(document.getElementById('joinBtn')?.textContent || ''),
    { timeout: 25000 },
  );
  console.log('  [joiner] live on the free room');

  const tracks = await pollHost(room.id, 'present');
  ok('guest live → booth AUTO-publishes (SFU lists host with tracks)', tracks >= 1, `tracks=${tracks}`);

  await joiner.bringToFront();
  let feed = { w: 0 };
  for (let i = 0; i < 12 && feed.w === 0; i++) {
    await sleep(1500);
    feed = await joiner.evaluate(async () => {
      const v = document.querySelector('#hostLiveMount video');
      if (v && v.paused) { try { await v.play(); } catch { /* diagnostic */ } }
      return { w: v ? v.videoWidth : 0 };
    });
  }
  ok('joiner receives host frames sub-second pipe', feed.w > 0, `videoWidth=${feed.w}`);
  st = await boothState(host);
  ok('dashboard status says ON AIR with guest count', /on air/i.test(st.status) && /1 guest/i.test(st.status), st.status.slice(0, 80));

  // ── C. resilience: reload mid-session → silent re-arm → publish resumes ────
  await unlockDashboard(host, room.id, 'booth-gate'); // full page nav = reload
  ok('ON AIR tab warns before closing (beforeunload fired)', unloadWarned);
  await host.waitForFunction(
    () => document.getElementById('cohost-booth')?.checked === true,
    { timeout: 15000 },
  ).catch(() => {});
  st = await boothState(host);
  ok('reload: booth re-arms silently (flag + remembered grant)', st.checked === true, st.status.slice(0, 80));
  const tracks2 = await pollHost(room.id, 'present');
  ok('reload: auto-publish resumes without a click', tracks2 >= 1, `tracks=${tracks2}`);
  feed = { w: 0 };
  for (let i = 0; i < 12 && feed.w === 0; i++) {
    await sleep(1500);
    feed = await joiner.evaluate(async () => {
      const v = document.querySelector('#hostLiveMount video');
      if (v && v.paused) { try { await v.play(); } catch { /* diagnostic */ } }
      return { w: v ? v.videoWidth : 0 };
    });
  }
  ok('joiner recovers host frames after the reload', feed.w > 0, `videoWidth=${feed.w}`);

  // ── D. last guest leaves → auto-off; toggle OFF clears the flag ────────────
  // evaluate-click: puppeteer's ElementHandle click can stall on a page with
  // third-party iframes mid-teardown; an in-page click is one CDP call.
  await joiner.evaluate(() => document.getElementById('joinBtn')?.click()); // live button doubles as leave
  await sleep(1000);
  const gone = await pollHost(room.id, 'absent', 18); // 5s grace + teardown
  ok('guest left → booth hangs up by itself (grace-timed)', gone === -1);
  st = await boothState(host);
  ok('status back to Armed after auto-off', st.checked === true && /armed/i.test(st.status) && !st.status.includes('🔴'), st.status.slice(0, 80));

  await host.click('#cohost-booth');
  await sleep(800);
  st = await boothState(host);
  const flagCleared = await host.evaluate((id) => localStorage.getItem('mc-booth-armed:' + id) === null, room.id);
  ok('toggle OFF: disarmed + persisted flag cleared', st.checked === false && flagCleared);

  // ── E. denied path: block → guidance, stays disarmed ───────────────────────
  const denied = await browser.newPage();
  await denied.evaluateOnNewDocument(GUM_OVERRIDE);
  await denied.evaluateOnNewDocument(() => { window.__gumDeny = true; });
  await unlockDashboard(denied, room.id, 'booth-gate');
  await denied.click('#cohost-booth');
  await sleep(1200);
  st = await boothState(denied);
  ok('denied: "Camera blocked" guidance shown, booth stays off',
    st.checked === false && /camera blocked/i.test(st.error), st.error.slice(0, 80));

  await browser.close();
} finally {
  app.kill();
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
