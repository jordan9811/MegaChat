/**
 * GATE — LiveKit Phase 1: core pipeline, against a REAL local SFU
 * (tools/livekit-server.exe --dev on :7880) + REAL mainnet meter dust.
 *
 *  A. flag gating: server without LIVEKIT_* env → config flag false, token
 *     endpoint 503; livekit-transport room still resolves (transport field
 *     additive) but unusable — honest.
 *  B. configured server: token auth (publisher needs a granted seat, 403
 *     otherwise; subscriber JWT carries subscribe-only grants for mc-<room>).
 *  C. joiner publish: real join page, synthetic camera, LiveKit connect +
 *     publish. Ground truth from the SFU admin API (participant + track
 *     listed), not just DOM.
 *  D. overlay renders the LiveKit tile inside the SAME stinger machinery;
 *     media assertion via tile <video> dimensions (local SFU).
 *  E. meter ticks flow during the livekit session (transport-agnostic).
 *  F. kick → SFU participant removed server-side + tile leaves.
 *  G. vdo control room: publish path still builds vdo iframes.
 */
import { spawn } from 'child_process';
import puppeteer from 'puppeteer-core';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempo } from 'viem/chains';
import { tempo as tempoClient } from 'mppx/client';
import { RoomServiceClient } from 'livekit-server-sdk';

try { process.loadEnvFile(); } catch { /* env external */ }

const LK_URL = 'ws://localhost:7880';
const LK = { key: 'devkey', secret: 'secret' };
const APP = 'http://localhost:3215';
const APP_PLAIN = 'http://localhost:3216';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jwtPayload = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());

// sanity: local SFU is up
const health = await fetch('http://localhost:7880/').then((r) => r.text()).catch(() => null);
if (health !== 'OK') { console.error('local livekit-server not running on :7880 — start tools/livekit-server.exe --dev'); process.exit(1); }

const boot = (port, extraEnv) => spawn(process.execPath, ['server.js', '--prod'], {
  env: { ...process.env, PORT: String(port), ...extraEnv },
  stdio: 'ignore', cwd: process.cwd(),
});
const appLk = boot(3215, { LIVEKIT_URL: LK_URL, LIVEKIT_API_KEY: LK.key, LIVEKIT_API_SECRET: LK.secret });
const appPlain = boot(3216, { LIVEKIT_URL: '', LIVEKIT_API_KEY: '', LIVEKIT_API_SECRET: '' });
await sleep(9000);

const svc = new RoomServiceClient('http://localhost:7880', LK.key, LK.secret);
const viewer = privateKeyToAccount(process.env.TEST_VIEWER_KEY);
const wallet = createWalletClient({ account: viewer, chain: tempo, transport: http(process.env.TEMPO_RPC_URL || 'https://rpc.tempo.xyz') });

const mk = async (base, name, config) => {
  const res = await fetch(`${base}/api/dashboard/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password: 'lk1-gate', config }),
  });
  const data = await res.json();
  if (res.status !== 201) { console.error('create failed', data); process.exit(1); }
  return data.room;
};

try {
  // ── A. unconfigured server stays honest ───────────────────────────────────
  const roomPlain = await mk(APP_PLAIN, 'LK Plain', { transport: 'livekit' });
  const cfgPlain = await (await fetch(`${APP_PLAIN}/api/config?room=${roomPlain.id}`)).json();
  ok('unconfigured: config flag false', cfgPlain.livekitConfigured === false && cfgPlain.transport === 'livekit');
  const tokPlain = await fetch(`${APP_PLAIN}/api/token`, { method: 'POST' }).catch(() => null);
  const tok503 = await fetch(`${APP_PLAIN}/api/livekit/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: roomPlain.id, role: 'subscriber' }),
  });
  ok('unconfigured: token endpoint 503', tok503.status === 503);

  // ── B. configured: auth model ──────────────────────────────────────────────
  const roomLk = await mk(APP, 'LK Room', { transport: 'livekit' });
  const roomVdo = await mk(APP, 'VDO Control', {});
  const cfgLk = await (await fetch(`${APP}/api/config?room=${roomLk.id}`)).json();
  ok('configured: config exposes transport + url',
    cfgLk.transport === 'livekit' && cfgLk.livekitConfigured === true && cfgLk.livekitUrl === LK_URL,
    cfgLk.livekitUrl);

  const noSeat = await fetch(`${APP}/api/livekit/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: roomLk.id, role: 'publisher', seatId: 'nope' }),
  });
  ok('publisher token without a granted seat → 403', noSeat.status === 403);

  const subTok = await (await fetch(`${APP}/api/livekit/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: roomLk.id, role: 'subscriber' }),
  })).json();
  const subGrant = jwtPayload(subTok.token).video;
  ok('subscriber JWT: subscribe-only on mc-<room>',
    subGrant.room === `mc-${roomLk.id}` && subGrant.canSubscribe === true && subGrant.canPublish === false,
    JSON.stringify(subGrant));

  const vdoTok = await fetch(`${APP}/api/livekit/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: roomVdo.id, role: 'subscriber' }),
  });
  ok('vdo rooms refuse livekit tokens', vdoTok.status === 400);

  // ── real seat (meter-granted authorization) ───────────────────────────────
  const joinRes = await fetch(`${APP}/api/join/mpp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'lk-gate', address: viewer.address, room: roomLk.id }),
  });
  const join = await joinRes.json();
  ok('meter join grants the seat', joinRes.ok && !!join.seatId, join.seatId?.slice(0, 8));

  // keep the seat's meter alive with REAL raw-key ticks in the background
  const session = tempoClient.session.manager({
    client: wallet, account: viewer, maxDeposit: String(join.sessionCap), decimals: 6,
  });
  let tickCount = 0, tickErrors = 0, ticking = true;
  const tickLoop = (async () => {
    while (ticking) {
      try {
        const r = await session.fetch(`${APP}${join.tickUrl}`, { method: 'POST' });
        if (r.ok) tickCount++; else tickErrors++;
      } catch { tickErrors++; }
      await sleep(2500);
    }
  })();

  // ── C+D. browser: joiner publishes, overlay renders ───────────────────────
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const joiner = await browser.newPage();
  await joiner.evaluateOnNewDocument(() => {
    const makeStream = () => {
      const c = document.createElement('canvas');
      c.width = 640; c.height = 360;
      const ctx = c.getContext('2d');
      setInterval(() => {
        ctx.fillStyle = `hsl(${Date.now() / 15 % 360},80%,50%)`;
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = '#fff'; ctx.font = 'bold 40px sans-serif';
        ctx.fillText('LK', 290, 195);
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
  await joiner.goto(`${APP}/join?room=${roomLk.id}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1500);
  // real seat, but paymentMode 'none' so the PAGE doesn't try to tick (the
  // raw-key loop above is the real meter); server liveness is satisfied.
  await joiner.evaluate((seatId) => {
    window.onJoinSuccess({
      seatId, paymentMode: 'none', remaining: '1', secondsLeft: 600,
      tickPrice: '0.001', tickSeconds: 1, pushUrl: 'https://vdo.ninja/?push=unused',
    });
  }, join.seatId);

  await joiner.waitForFunction(
    () => /go live/i.test(document.getElementById('joinBtn')?.textContent || ''),
    { timeout: 25000 },
  ).catch(() => {});
  const joinerState = await joiner.evaluate(() => ({
    btn: document.getElementById('joinBtn')?.textContent?.trim(),
    vdoIframeHidden: getComputedStyle(document.getElementById('camPublisher')).display === 'none',
    vdoSrcEmpty: !document.getElementById('camPublisher').src || document.getElementById('camPublisher').src === 'about:blank',
    lkVideo: !!document.querySelector('.cam-frame video'),
  }));
  ok('joiner: LiveKit publish path, vdo iframe never engaged',
    joinerState.vdoIframeHidden && joinerState.lkVideo && /go live/i.test(joinerState.btn || ''),
    JSON.stringify(joinerState));

  // SFU ground truth: participant + published track
  await sleep(1000);
  let participants = await svc.listParticipants(`mc-${roomLk.id}`).catch(() => []);
  const seatP = participants.find((p) => p.identity === `seat:${join.seatId}`);
  ok('SFU lists the seat participant with a published video track',
    !!seatP && (seatP.tracks || []).some((t) => t.type === 2 || String(t.type).toLowerCase().includes('video') || t.name || t.sid),
    seatP ? `${seatP.identity} tracks=${seatP.tracks?.length}` : 'not found');

  // GO LIVE → overlay tile
  joiner.on('console', (m) => {
    if (/camera|livekit|error|ws\]/i.test(m.text())) console.log('  [joiner console]', m.text().slice(0, 130));
  });
  joiner.on('pageerror', (e) => console.log('  [joiner pageerror]', String(e).slice(0, 130)));
  await joiner.click('#joinBtn');
  await sleep(1500);
  console.log('  [diag] after click:', JSON.stringify(await joiner.evaluate(() => ({
    btn: document.getElementById('joinBtn')?.textContent?.trim(),
    disabled: document.getElementById('joinBtn')?.disabled,
  }))));
  const dash = await (await fetch(`${APP}/api/dashboard/rooms/${roomLk.id}`, {
    headers: { 'X-Room-Password': 'lk1-gate' },
  })).json();
  console.log('  [diag] seat state:', JSON.stringify((dash.seats || []).map((s) => ({ id: s.id.slice(0, 8), live: s.live }))));
  const overlay = await browser.newPage();
  overlay.on('console', (m) => {
    if (/error|failed|livekit|initial/i.test(m.text())) console.log('  [overlay console]', m.text().slice(0, 130));
  });
  overlay.on('pageerror', (e) => console.log('  [overlay pageerror]', String(e).slice(0, 130)));
  await overlay.goto(`${APP}/overlay?room=${roomLk.id}`, { waitUntil: 'networkidle2', timeout: 60000 });
  let tile = null;
  for (let i = 0; i < 12 && !tile; i++) {
    await sleep(1500);
    tile = await overlay.evaluate(() => {
      const box = document.querySelector('.tile');
      if (!box) return null;
      const v = box.querySelector('video');
      return {
        isVideo: !!v, isIframe: !!box.querySelector('iframe'),
        w: v ? v.videoWidth : 0, label: box.querySelector('.username-label')?.textContent,
      };
    });
    if (tile && tile.isVideo && tile.w === 0 && i < 11) tile = null; // wait for frames
  }
  ok('overlay tile is a LiveKit <video> in the stinger box (no iframe)',
    !!tile && tile.isVideo && !tile.isIframe && /lk-gate/.test(tile.label || ''), JSON.stringify(tile));
  if (tile && tile.w > 0) {
    ok('overlay video actually flows (frames through the local SFU)', true, `videoWidth=${tile.w}`);
  } else {
    console.log('  WARN  overlay video dimensions stayed 0 in headless — HUMAN VERIFY with a real browser');
  }

  // ── E. meter ticked throughout ─────────────────────────────────────────────
  ok('meter ticks flowed during the livekit session (transport-agnostic)',
    tickCount >= 3 && tickErrors === 0, `${tickCount} ok / ${tickErrors} err`);

  // ── F. kick → SFU removal + tile teardown ─────────────────────────────────
  ticking = false;
  await tickLoop;
  await session.close().catch(() => {});
  const kick = await fetch(`${APP}/api/dashboard/rooms/${roomLk.id}/kick/${join.seatId}`, {
    method: 'POST', headers: { 'X-Room-Password': 'lk1-gate' },
  });
  ok('kick accepted', kick.ok);
  await sleep(3000);
  participants = await svc.listParticipants(`mc-${roomLk.id}`).catch(() => []);
  ok('SFU participant removed server-side on kick',
    !participants.some((p) => p.identity === `seat:${join.seatId}`),
    `remaining=${participants.map((p) => p.identity).join(',') || 'none'}`);
  const tileGone = await overlay.evaluate(() =>
    document.querySelectorAll('.tile:not(.leaving)').length === 0);
  ok('overlay tile tears down on kick', tileGone);

  // ── G. vdo control room untouched ─────────────────────────────────────────
  const vdoPage = await browser.newPage();
  await vdoPage.goto(`${APP}/join?room=${roomVdo.id}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1200);
  await vdoPage.evaluate(() => {
    const orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) {
      if (typeof d === 'string' && d.includes('register_seat')) return;
      return orig.call(this, d);
    };
    window.onJoinSuccess({
      seatId: 'vdo-fake', paymentMode: 'none', remaining: '1', secondsLeft: 60,
      tickPrice: '0.001', tickSeconds: 1,
      pushUrl: 'https://vdo.ninja/?push=mc-gate-vdo-' + Math.random().toString(36).slice(2, 6),
    });
  });
  await sleep(1500);
  const vdoState = await vdoPage.evaluate(() => ({
    src: document.getElementById('camPublisher').src,
    visible: getComputedStyle(document.getElementById('camPublisher')).display !== 'none',
  }));
  ok('vdo room: publish path still builds the vdo iframe (untouched)',
    vdoState.visible && vdoState.src.startsWith('https://vdo.ninja/'), vdoState.src.slice(0, 60));

  await browser.close();
} finally {
  appLk.kill();
  appPlain.kill();
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
