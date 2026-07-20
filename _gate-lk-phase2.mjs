/**
 * GATE — LiveKit Phase 2: return feed + letter parity, real local SFU +
 * real mainnet dust for the letter payment.
 *
 *  A. host token auth: password-gated (401 wrong password).
 *  B. host arms the co-host booth from the real dashboard UI (unlock → arm
 *     with a synthetic camera); the booth AUTO-publishes when a guest seat
 *     goes live → SFU lists host:<room> with published tracks (checked in C).
 *  C. joiner in a live slot receives the host feed sub-second: hostLiveFeed
 *     <video> gets real frames; the delayed Twitch embed is REMOVED during
 *     the slot (echo safety) and restored after leave.
 *  D. letters on a livekit room: pay (raw key) → upload webm → letter_play →
 *     overlay letter tile renders (transport-independent, verified).
 *  E. vdo control room: return feed still mounts the vdo iframe.
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
  },
  stdio: 'ignore', cwd: process.cwd(),
});
await sleep(9000);

const svc = new RoomServiceClient('http://localhost:7880', 'devkey', 'secret');
const viewer = privateKeyToAccount(process.env.TEST_VIEWER_KEY);
const wallet = createWalletClient({ account: viewer, chain: tempo, transport: http(process.env.TEMPO_RPC_URL || 'https://rpc.tempo.xyz') });

const mk = async (name, config) => {
  const res = await fetch(`${APP}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password: 'lk2-gate', config }),
  });
  const { room } = await res.json();
  return room;
};

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
  navigator.mediaDevices.getUserMedia = async () => makeStream(window.__gumLabel || 'CAM');
};

try {
  const roomLk = await mk('LK Return', {
    transport: 'livekit',
    twitchChannel: 'megachattv',
    letters: { enabled: true, maxSeconds: 5, price: '0.01', moderation: 'auto' },
  });
  // Explicit transport: 'vdo' — LiveKit became the DEFAULT for rooms created
  // without a choice, so the vdo control room must opt out or E tests nothing.
  const roomVdo = await mk('VDO Return', { transport: 'vdo', twitchChannel: 'megachattv' });
  console.log('  [setup] rooms', roomLk.id, roomVdo.id);

  // ── A. host token auth ─────────────────────────────────────────────────────
  const badPwd = await fetch(`${APP}/api/livekit/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Room-Password': 'wrong' },
    body: JSON.stringify({ room: roomLk.id, role: 'host' }),
  });
  ok('host token is password-gated (401 on wrong)', badPwd.status === 401);

  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });

  // ── B. host on air via the real dashboard ──────────────────────────────────
  const host = await browser.newPage();
  await host.evaluateOnNewDocument(GUM_OVERRIDE);
  await host.evaluateOnNewDocument(() => { window.__gumLabel = 'HOST'; });
  await host.goto(`${APP}/dashboard`, { waitUntil: 'networkidle2', timeout: 60000 });
  await host.evaluate(() => {
    const tab = [...document.querySelectorAll('button')].find((b) => /manage existing/i.test(b.textContent));
    tab?.click();
  });
  await sleep(400);
  await host.type('#manage-room-id', roomLk.id);
  await host.type('#manage-password', 'lk2-gate');
  await host.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => /unlock room/i.test(b.textContent))?.click();
  });
  await sleep(2500);
  const boothFound = await host.evaluate(() => {
    const t = document.getElementById('cohost-booth');
    if (!t) return false;
    t.click(); // arm — permission preflight runs on this gesture
    return true;
  });
  ok('dashboard shows the co-host booth for the livekit room', boothFound);
  await sleep(2000);
  const armedNow = await host.evaluate(() => document.getElementById('cohost-booth')?.checked === true);
  ok('booth armed (camera+mic preflight cleared)', armedNow);
  // NOTE: no SFU check here — the booth intentionally publishes only once a
  // guest seat is live; the host-on-SFU assert moved into section C.

  // ── C. joiner live slot: host feed + echo safety ───────────────────────────
  const joinRes = await fetch(`${APP}/api/join/mpp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'lk2-gate', address: viewer.address, room: roomLk.id }),
  });
  const join = await joinRes.json();
  if (!join.seatId) { console.error('join failed', join); process.exit(1); }
  const session = tempoClient.session.manager({
    client: wallet, account: viewer, maxDeposit: String(join.sessionCap), decimals: 6,
  });
  let ticking = true;
  const tickLoop = (async () => {
    while (ticking) {
      try { await session.fetch(`${APP}${join.tickUrl}`, { method: 'POST' }); } catch { /* keep going */ }
      await sleep(2500);
    }
  })();

  const joiner = await browser.newPage();
  joiner.on('console', (m) => {
    if (/livekit|host feed|error/i.test(m.text())) console.log('  [joiner]', m.text().slice(0, 150));
  });
  await joiner.evaluateOnNewDocument(GUM_OVERRIDE);
  await joiner.goto(`${APP}/join?room=${roomLk.id}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1500);
  const preEmbed = await joiner.evaluate(() => !!document.querySelector('#streamPreviewMount iframe'));
  ok('pre-slot: delayed Twitch embed mounted', preEmbed);

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

  // Guest seat is live → the armed booth must publish BY ITSELF.
  let hostP = null;
  for (let i = 0; i < 12 && !hostP; i++) {
    await sleep(1500);
    const participants = await svc.listParticipants(`mc-${roomLk.id}`).catch(() => []);
    hostP = participants.find((p) => p.identity === `host:${roomLk.id}`) || null;
  }
  ok('SFU lists the host with published tracks (booth auto-published)',
    !!hostP && (hostP.tracks || []).length >= 1, hostP ? `tracks=${hostP.tracks.length}` : 'not found');

  await joiner.bringToFront();
  let feed = { w: 0 };
  for (let i = 0; i < 12; i++) {
    await sleep(1500);
    feed = await joiner.evaluate(async () => {
      const v = document.querySelector('#hostLiveMount video');
      if (v && v.paused) { try { await v.play(); } catch { /* diagnostic only */ } }
      const t = v && v.srcObject && v.srcObject.getVideoTracks ? v.srcObject.getVideoTracks()[0] : null;
      return {
        w: v ? v.videoWidth : 0,
        paused: v ? v.paused : null,
        ready: v ? v.readyState : null,
        trackState: t ? t.readyState : null,
        trackMuted: t ? t.muted : null,
        visible: getComputedStyle(document.getElementById('hostLiveFeed')).display !== 'none',
        embedGone: document.querySelectorAll('#streamPreviewMount iframe').length === 0,
        label: document.getElementById('hostLiveFeed').textContent.includes('Real-time with the host'),
      };
    });
    if (i % 3 === 2) console.log('  [diag] host feed video:', JSON.stringify(feed));
    if (feed.w > 0) break;
  }
  ok('live slot: host feed <video> visible with the real-time label', feed.visible && feed.label);
  ok('live slot: HOST FRAMES FLOW sub-second pipe', feed.w > 0, `videoWidth=${feed.w}`);
  ok('live slot: delayed embed REMOVED (echo-safe)', feed.embedGone);

  // leave → embed restored
  await joiner.evaluate(() => window.leaveStream());
  await sleep(2000);
  const post = await joiner.evaluate(() => ({
    embedBack: !!document.querySelector('#streamPreviewMount iframe'),
    feedGone: getComputedStyle(document.getElementById('hostLiveFeed')).display === 'none',
  }));
  ok('post-leave: embed restored, host feed unmounted', post.embedBack && post.feedGone);
  ticking = false;
  await tickLoop;
  await session.close().catch(() => {});
  await fetch(`${APP}/api/leave/${join.seatId}`, { method: 'POST' });

  // ── D. letters on a livekit room (transport-independent) ──────────────────
  const rec = await browser.newPage();
  await rec.goto('about:blank');
  const webmB64 = await rec.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 180;
    const ctx = c.getContext('2d');
    const draw = setInterval(() => {
      ctx.fillStyle = `hsl(${Date.now() / 10 % 360},80%,50%)`;
      ctx.fillRect(0, 0, 320, 180);
    }, 66);
    const stream = c.captureStream(15);
    const mr = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = [];
    mr.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((res) => { mr.onstop = res; });
    mr.start();
    await new Promise((r) => setTimeout(r, 2500));
    mr.stop();
    await done;
    clearInterval(draw);
    const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  const webm = Buffer.from(webmB64, 'base64');

  const overlay = await browser.newPage();
  await overlay.goto(`${APP}/overlay?room=${roomLk.id}`, { waitUntil: 'networkidle2' });

  const lSession = tempoClient.session.manager({
    client: wallet, account: viewer, maxDeposit: '0.01', decimals: 6,
  });
  const sub = await lSession.fetch(`${APP}/api/letter/submit?room=${roomLk.id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room: roomLk.id, username: 'lk-letter', address: viewer.address,
      durationS: 3, mime: 'video/webm', flyIn: 'storm', flyOut: 'crt',
    }),
  });
  const subData = await sub.json();
  lSession.close().catch(() => {});
  const up = await fetch(`${APP}${subData.uploadUrl}`, {
    method: 'PUT', headers: { 'Content-Type': 'video/webm' }, body: webm,
  });
  ok('letter paid + uploaded on the livekit room', up.ok);
  let letterTile = null;
  for (let i = 0; i < 8 && !letterTile; i++) {
    await sleep(1500);
    letterTile = await overlay.evaluate(() => {
      const box = [...document.querySelectorAll('.tile')].find((b) => (b.dataset.seatId || '').startsWith('letter:'));
      return box ? { video: !!box.querySelector('video'), label: box.querySelector('.username-label')?.textContent } : null;
    });
  }
  ok('letter tile plays on the livekit-room overlay', !!letterTile && letterTile.video && /lk-letter/.test(letterTile.label || ''), JSON.stringify(letterTile));

  // ── E. vdo control room: return feed still vdo ─────────────────────────────
  const vdoPage = await browser.newPage();
  await vdoPage.goto(`${APP}/join?room=${roomVdo.id}`, { waitUntil: 'networkidle2' });
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
      pushUrl: 'https://vdo.ninja/?push=mc-x-' + Math.random().toString(36).slice(2, 6),
    });
    window.goLive();
  });
  await sleep(1500);
  const vdoFeed = await vdoPage.evaluate(() => {
    const iframe = document.querySelector('#hostLiveMount iframe');
    return { isIframe: !!iframe, src: iframe ? iframe.src : null };
  });
  ok('vdo room: return feed still mounts the vdo iframe (untouched)',
    vdoFeed.isIframe && /vdo\.ninja/.test(vdoFeed.src || ''), (vdoFeed.src || '').slice(0, 50));

  await browser.close();
} finally {
  app.kill();
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
