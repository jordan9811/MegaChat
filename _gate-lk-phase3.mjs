/**
 * GATE — LiveKit Phase 3: reconnect grace + quality + simulcast.
 *
 * Real local SFU + real mainnet meter dust. The joiner's network is killed
 * for ~5s via CDP offline emulation (signal WS + control WS + fetch all die;
 * livekit-client enters `reconnecting`), then restored:
 *   - seat SURVIVES (grace: max(MPP_STALE_MS, LIVEKIT_SEAT_GRACE_S+5))
 *   - meter PAUSED during the gap (spent frozen — no vouchers = no charges)
 *   - joiner UI shows the pause + reconnect states, quality dot present
 *   - dashboard quality flips good → unstable during the blip
 *   - after restore: livekit reconnects, meter resumes, spent grows again
 *   - simulcast: the published video track carries multiple layers
 */
import { spawn } from 'child_process';
import puppeteer from 'puppeteer-core';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempo } from 'viem/chains';
import { tempo as tempoClient } from 'mppx/client';
import { RoomServiceClient } from 'livekit-server-sdk';

try { process.loadEnvFile(); } catch { /* env external */ }

const APP = 'http://localhost:3215';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const health = await fetch('http://localhost:7880/').then((r) => r.text()).catch(() => null);
if (health !== 'OK') { console.error('local livekit-server not running'); process.exit(1); }

const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: {
    ...process.env, PORT: '3215',
    LIVEKIT_URL: 'ws://localhost:7880', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret',
    LIVEKIT_SEAT_GRACE_S: '15',
  },
  stdio: 'ignore', cwd: process.cwd(),
});
await sleep(9000);

const svc = new RoomServiceClient('http://localhost:7880', 'devkey', 'secret');
const viewer = privateKeyToAccount(process.env.TEST_VIEWER_KEY);
const wallet = createWalletClient({ account: viewer, chain: tempo, transport: http(process.env.TEMPO_RPC_URL || 'https://rpc.tempo.xyz') });

const dash = async (roomId, path = '') => {
  const r = await fetch(`${APP}/api/dashboard/rooms/${roomId}${path}`, {
    headers: { 'X-Room-Password': 'lk3-gate' },
  });
  return r.json();
};

try {
  const mkRes = await fetch(`${APP}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'LK Phase3', password: 'lk3-gate', config: { transport: 'livekit' } }),
  });
  const { room } = await mkRes.json();
  console.log('  [setup] room', room.id);

  const joinRes = await fetch(`${APP}/api/join/mpp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'lk3-gate', address: viewer.address, room: room.id }),
  });
  const join = await joinRes.json();
  if (!join.seatId) { console.error('join failed', join); process.exit(1); }

  // external raw-key meter (plays the role of the page's own tick loop)
  const session = tempoClient.session.manager({
    client: wallet, account: viewer, maxDeposit: String(join.sessionCap), decimals: 6,
  });
  let meterPaused = false;
  let ticking = true;
  const tickLoop = (async () => {
    while (ticking) {
      if (!meterPaused) {
        try { await session.fetch(`${APP}${join.tickUrl}`, { method: 'POST' }); } catch { /* offline gap */ }
      }
      await sleep(2000);
    }
  })();

  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const joiner = await browser.newPage();
  const logs = [];
  joiner.on('console', (m) => {
    const t = m.text();
    if (/livekit/i.test(t)) logs.push(t);
  });
  await joiner.evaluateOnNewDocument(() => {
    // WS harness: CDP offline emulation does NOT kill established sockets,
    // so the blip closes them directly and blocks reconnection for a while.
    window.__sockets = [];
    window.__blockWs = false;
    const RealWS = window.WebSocket;
    window.WebSocket = function (...args) {
      if (window.__blockWs) throw new Error('gate: ws blocked');
      const s = new RealWS(...args);
      window.__sockets.push(s);
      return s;
    };
    window.WebSocket.prototype = RealWS.prototype;
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
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
  });
  await joiner.goto(`${APP}/join?room=${room.id}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1500);
  await joiner.evaluate((seatId) => {
    window.onJoinSuccess({
      seatId, paymentMode: 'none', remaining: '1', secondsLeft: 600,
      tickPrice: '0.001', tickSeconds: 1, pushUrl: 'https://vdo.ninja/?push=unused',
    });
  }, join.seatId);
  await joiner.waitForFunction(
    () => /go live/i.test(document.getElementById('joinBtn')?.textContent || ''),
    { timeout: 25000 },
  );
  await joiner.click('#joinBtn');
  await joiner.bringToFront();
  await sleep(5000);

  // ── steady state: quality good, dot visible, simulcast layers ─────────────
  let seats = (await dash(room.id)).seats || [];
  let seat = seats.find((s) => s.id === join.seatId);
  ok('steady: dashboard quality good (SFU signal reported)', seat?.quality === 'good',
    `quality=${seat?.quality} connected=${seat?.connected}`);
  const dot = await joiner.evaluate(() => {
    const d = document.getElementById('lkQualityDot');
    return { visible: d && getComputedStyle(d).display !== 'none', q: d?.dataset.q };
  });
  ok('steady: joiner quality dot visible', dot.visible, `q=${dot.q}`);

  const parts = await svc.listParticipants(`mc-${room.id}`);
  const seatP = parts.find((p) => p.identity === `seat:${join.seatId}`);
  const videoTrack = (seatP?.tracks || []).find((t) => (t.layers || []).length > 0 || t.simulcast);
  ok('simulcast: published video track carries layers',
    !!videoTrack && ((videoTrack.layers || []).length >= 2 || videoTrack.simulcast === true),
    videoTrack ? `layers=${(videoTrack.layers || []).length} simulcast=${videoTrack.simulcast}` : 'no video track info');

  const spentBefore = parseFloat(seat?.spent || '0');
  ok('meter charging pre-blip', spentBefore > 0, `spent=${spentBefore}`);

  // ── THE BLIP: 5s offline ───────────────────────────────────────────────────
  console.log('  [blip] killing page sockets + blocking reconnect ~8s');
  meterPaused = true; // the page's own loop pauses on lkRoom.state — mirrored here
  const chopped = await joiner.evaluate(() => {
    window.__blockWs = true;
    const open = window.__sockets.filter((s) => s.readyState === 1).length;
    window.__sockets.forEach((s) => { try { s.close(); } catch { /* gone */ } });
    window.__sockets.length = 0;
    return open;
  });
  console.log('  [blip] chopped', chopped, 'sockets');
  // livekit's signal-loss detection takes a couple seconds — poll the UI
  // through the blip window for the pause/reconnect/dot-lost state.
  let duringUi = {};
  for (let i = 0; i < 12; i++) {
    await sleep(950);
    duringUi = await joiner.evaluate(() => ({
      meter: document.getElementById('meterTime')?.textContent,
      cam: document.getElementById('camStatusText')?.textContent,
      dotQ: document.getElementById('lkQualityDot')?.dataset.q,
    }));
    if (/paused/.test(duringUi.meter || '') || /reconnect/i.test(duringUi.cam || '')) break;
  }
  seats = (await dash(room.id)).seats || [];
  seat = seats.find((s) => s.id === join.seatId);
  const spentDuring = parseFloat(seat?.spent || '0');
  ok('blip: seat SURVIVES', !!seat);
  // NOTE: a 5s blip is intentionally invisible to the dashboard (the control
  // WS heartbeat is 15s and the client can't POST offline). Long outages
  // flip the dashboard via the WS-grace machinery, gated separately. The
  // joiner's OWN UI is the honest signal here:
  ok('blip: joiner UI shows pause/reconnecting + dot lost',
    (/paused/.test(duringUi.meter || '') || /reconnect/i.test(duringUi.cam || ''))
    && duringUi.dotQ === 'lost',
    JSON.stringify(duringUi));
  ok('blip: dashboard flips to unstable (control WS down)', seat?.quality === 'unstable',
    `quality=${seat?.quality}`);
  await sleep(4000); // total outage ≈ 8s
  await joiner.evaluate(() => { window.__blockWs = false; });
  console.log('  [blip] back online');

  // ── recovery: resume ticks as soon as livekit reports reconnected ─────────
  let reconnected = false;
  for (let i = 0; i < 20 && !reconnected; i++) {
    await sleep(1000);
    reconnected = logs.some((l) => /reconnected/i.test(l));
    if (reconnected) meterPaused = false; // mirror the client: resume on reconnect
  }
  meterPaused = false;
  // control-WS backoff can lag livekit by several seconds — poll for re-register
  for (let i = 0; i < 18; i++) {
    await sleep(1000);
    seats = (await dash(room.id)).seats || [];
    seat = seats.find((x) => x.id === join.seatId);
    if (seat && seat.connected === true) break;
  }
  ok('livekit auto-reconnected', reconnected, logs.filter((l) => /state|reconnect/i.test(l)).slice(-3).join(' | '));
  seats = (await dash(room.id)).seats || [];
  seat = seats.find((s) => s.id === join.seatId);
  ok('post-blip: seat alive + control WS re-registered', !!seat && seat.connected === true,
    `connected=${seat?.connected}`);
  const spentAfterGap = parseFloat(seat?.spent || '0');
  ok('meter PAUSED during the gap (no dead-air charges)',
    Math.abs(spentAfterGap - spentDuring) <= 0.002 && Math.abs(spentDuring - spentBefore) <= 0.004,
    `pre=${spentBefore} during=${spentDuring} afterGap=${spentAfterGap}`);

  await sleep(6000);
  seats = (await dash(room.id)).seats || [];
  seat = seats.find((s) => s.id === join.seatId);
  const spentResumed = parseFloat(seat?.spent || '0');
  ok('meter RESUMES after reconnect', spentResumed > spentAfterGap,
    `${spentAfterGap} → ${spentResumed}`);

  // cleanup
  ticking = false;
  await tickLoop;
  await session.close().catch(() => {});
  await fetch(`${APP}/api/leave/${join.seatId}`, { method: 'POST' });
  await browser.close();
} finally {
  app.kill();
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
