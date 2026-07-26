/**
 * REPRO — guest joins, viewer sees them, but the OBS overlay tile is black.
 *
 * Exercises the REAL overlay page (not a mirror of its logic, which is what
 * the existing gate does and why this slipped through): publishes a real track
 * as seat:<id> to a real SFU, broadcasts a real seat_added, then inspects the
 * tile's classes and the <video> element's actual state.
 */
import { spawn } from 'child_process';
import puppeteer from 'puppeteer-core';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 3270;
const APP = `http://localhost:${PORT}`;

const health = await fetch('http://localhost:7880').then((r) => r.text()).catch(() => '');
if (!health.includes('OK')) { console.error('start tools/livekit-server.exe --dev'); process.exit(1); }

const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: {
    ...process.env, PORT: String(PORT),
    LIVEKIT_URL: 'ws://localhost:7880', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret',
    DATA_DIR: `${process.env.TEMP || '/tmp'}/repro-${Date.now()}`,
  },
  stdio: 'ignore', cwd: process.cwd(),
});
await sleep(9000);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 120000,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

try {
  const room = await fetch(`${APP}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Repro', password: 'repro', config: { transport: 'livekit', passkeyTickPrice: '0' } }),
  }).then((r) => r.json()).then((d) => d.room);

  // 1) overlay up
  const overlay = await browser.newPage();
  overlay.on('console', (m) => {
    const t = m.text();
    if (/overlay|LiveKit|lazy|reveal/i.test(t)) console.log(`  [overlay] ${t.slice(0, 120)}`);
  });
  await overlay.goto(`${APP}/overlay?room=${room.id}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(3000);

  // 2) force the overlay awake (prewarm), then publish a REAL track as seat:X
  await fetch(`${APP}/api/livekit/prewarm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: room.id }),
  });
  await sleep(6000);

  // Mint a PUBLISHER token directly with the dev keys under the exact identity
  // the overlay expects (`seat:<id>`), bypassing the paid join flow.
  const SEAT = 'TESTSEAT';
  const { AccessToken } = await import('livekit-server-sdk');
  const at = new AccessToken('devkey', 'secret', { identity: `seat:${SEAT}`, ttl: '10m' });
  at.addGrant({ roomJoin: true, room: `mc-${room.id}`, canPublish: true, canSubscribe: true });
  const pubTok = { url: 'ws://localhost:7880', token: await at.toJwt() };

  // IMPORTANT: a blank page, NOT /overlay. Loading the overlay here spawns a
  // SECOND overlay which connects under the same stable identity
  // `overlay:<roomId>` and evicts the first — that is the dedupe behaviour
  // working as designed, and it cost me a false root cause once already.
  const pub = await browser.newPage();
  await pub.goto(`${APP}/how-it-works`, { waitUntil: 'domcontentloaded' });
  const published = await pub.evaluate(async ({ url, token, app }) => {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = `${app}/vendor/livekit-client.umd.js`; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
    const LK = window.LivekitClient;
    const r = new LK.Room();
    await r.connect(url, token);
    const c = document.createElement('canvas'); c.width = 320; c.height = 180;
    const ctx = c.getContext('2d');
    setInterval(() => { ctx.fillStyle = '#0f0'; ctx.fillRect(0, 0, 320, 180); }, 100);
    const stream = c.captureStream(15);
    try {
      await r.localParticipant.publishTrack(stream.getVideoTracks()[0]);
      return { ok: true, identity: r.localParticipant.identity };
    } catch (e) { return { ok: false, err: e.message }; }
  }, { url: pubTok.url, token: pubTok.token, app: APP });
  console.log('publisher:', JSON.stringify(published));
  await sleep(3000);

  // 3) drive the REAL overlay code path with whatever identity actually joined
  const drive = await overlay.evaluate((seatId) => {
    if (typeof addVideoBox !== 'function') return { err: 'addVideoBox not global' };
    const hadTrack = !!lkTracks.get('seat:' + seatId);
    addVideoBox({ id: seatId, username: 'wwse', flyIn: 'default' });
    return { ok: true, seatId, hadTrackAtAdd: hadTrack, knownIdentities: [...lkTracks.keys()] };
  }, SEAT);
  console.log('drive:', JSON.stringify(drive));
  await sleep(4000);

  // 5) INSPECT the real tile
  const state = await overlay.evaluate(() => {
    const tile = document.querySelector('.tile');
    if (!tile) return { tile: false };
    const v = tile.querySelector('video');
    const cs = v ? getComputedStyle(v) : null;
    return {
      tile: true,
      tileClasses: tile.className,
      hasHolding: tile.classList.contains('lk-holding'),
      hasVideo: !!v,
      videoClasses: v ? v.className : null,
      opacity: cs ? cs.opacity : null,
      readyState: v ? v.readyState : null,
      videoWidth: v ? v.videoWidth : null,
      srcObject: v ? !!v.srcObject : null,
      paused: v ? v.paused : null,
    };
  });
  // DISCRIMINATOR: make the video visible (drop lk-holding) and see whether
  // adaptiveStream then delivers the track. If it does, the hold state's
  // opacity:0 is what suppressed the subscription.
  const afterUnhide = await overlay.evaluate(() => {
    document.querySelectorAll('.tile.lk-holding').forEach((t) => t.classList.remove('lk-holding'));
    return { removed: true };
  });
  await sleep(5000);
  const post = await overlay.evaluate(() => {
    const v = document.querySelector('.tile video');
    return {
      knownIdentities: [...lkTracks.keys()],
      srcObject: v ? !!v.srcObject : null,
      videoWidth: v ? v.videoWidth : null,
    };
  });
  const roomState = await overlay.evaluate(() => {
    const r = (typeof lkOverlayRoom !== "undefined" && lkOverlayRoom) || null;
    if (!r) return { connected: false, note: 'lkOverlayRoom not exposed on window' };
    const parts = [];
    const rp = r.remoteParticipants || r.participants;
    if (rp) {
      for (const [, p] of rp) {
        const pubs = [];
        const tp = p.trackPublications || p.tracks;
        if (tp) for (const [, t] of tp) {
          pubs.push({ kind: t.kind, subscribed: t.isSubscribed, hasTrack: !!t.track, source: String(t.source) });
        }
        parts.push({ identity: p.identity, pubs });
      }
    }
    return { state: r.state, localIdentity: r.localParticipant?.identity, remoteCount: parts.length, parts };
  });
  console.log('\n── OVERLAY ROOM STATE ──');
  console.log(JSON.stringify(roomState, null, 2));

  console.log('\n── after removing lk-holding ──');
  console.log(JSON.stringify(post));
  if (post.knownIdentities.length > 0) {
    console.log('>>> CONFIRMED: adaptiveStream refused to subscribe while the element was hidden.');
  } else {
    console.log('>>> NOT the hold state — track still absent, look upstream (subscription/permissions).');
  }

  console.log('\n════ TILE STATE ════');
  console.log(JSON.stringify(state, null, 2));
  console.log('════════════════════');
  if (state.hasHolding) console.log('\n>>> STUCK IN lk-holding — video opacity 0. This is the black tile.');
  else if (state.opacity === '0') console.log('\n>>> video opacity 0 for another reason.');
  else if (!state.srcObject) console.log('\n>>> no srcObject — track never attached.');
  else if (state.videoWidth === 0) console.log('\n>>> attached but no frames (videoWidth 0).');
  else console.log('\n>>> tile looks HEALTHY — black must come from elsewhere.');
} finally {
  await browser.close();
  app.kill();
}
