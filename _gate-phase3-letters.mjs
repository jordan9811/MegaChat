/**
 * GATE — MEGA Phase 3: letter mode. REAL MAINNET DUST for the payment leg.
 *
 *  A. auto-play room: record a real webm in a browser (canvas+oscillator via
 *     MediaRecorder), pay the flat price through a one-voucher MPP session
 *     (TEST_VIEWER_KEY, same rails as ticks), upload, watch the scheduler
 *     broadcast letter_play with a working media URL, see the overlay render
 *     the letter tile with stingers, letter_end afterwards, media gone.
 *  B. approve-queue room: submit+upload → pending_approval (no play), list
 *     shows it, REJECT refunds the payer on-chain (balance delta), approve
 *     path exercised with a second letter → plays.
 *  C. join flow unregressed: letter button hidden when disabled, visible
 *     with price when enabled; join card intact.
 */
import WebSocket from 'ws';
import puppeteer from 'puppeteer-core';
import { createWalletClient, createPublicClient, http, custom, erc20Abi, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempo } from 'viem/chains';
import { tempo as tempoClient } from 'mppx/client';

try { process.loadEnvFile(); } catch { /* env external */ }

const BASE = process.env.GATE_BASE_URL || 'http://localhost:3212';
const WS_URL = BASE.replace(/^http/, 'ws');
const RPC = process.env.TEMPO_RPC_URL || 'https://rpc.tempo.xyz';
const USDC = process.env.TEMPO_USDC_ADDRESS;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const viewer = privateKeyToAccount(process.env.TEST_VIEWER_KEY);
const pub = createPublicClient({ chain: tempo, transport: http(RPC) });
const balanceOf = () =>
  pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [viewer.address] });

// One-voucher letter payment session (raw key — the same client rails the
// join page uses; the Privy-provider path is gated by _gate-mpp-clientpath).
const wallet = createWalletClient({ account: viewer, chain: tempo, transport: http(RPC) });
function letterSession(price) {
  return tempoClient.session.manager({
    client: wallet, account: viewer, maxDeposit: String(price), decimals: 6,
  });
}

const mk = async (name, config) => {
  const res = await fetch(`${BASE}/api/dashboard/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password: 'phase3-gate', config }),
  });
  const data = await res.json();
  if (res.status !== 201) { console.error('create failed', data); process.exit(1); }
  return data.room;
};

// letter price: 5s × 0.002/s = 0.01 (explicit price keeps the math obvious)
const roomAuto = await mk('Letters Auto', {
  letters: { enabled: true, maxSeconds: 5, price: '0.01', moderation: 'auto' },
});
const roomMod = await mk('Letters Mod', {
  letters: { enabled: true, maxSeconds: 5, price: '0.01', moderation: 'approve' },
});
const roomOff = await mk('Letters Off', {});
console.log('  [setup] rooms', roomAuto.id, roomMod.id, roomOff.id);

const cfgAuto = await (await fetch(`${BASE}/api/config?room=${roomAuto.id}`)).json();
ok('config exposes letters block', cfgAuto.letters?.enabled === true
  && cfgAuto.letters.price === '0.01' && cfgAuto.letters.maxSeconds === 5,
  JSON.stringify(cfgAuto.letters));

// ── Record a REAL webm via MediaRecorder in a browser ───────────────────────
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const rec = await browser.newPage();
await rec.goto('about:blank');
const webmB64 = await rec.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 180;
  const ctx = c.getContext('2d');
  const draw = setInterval(() => {
    ctx.fillStyle = `hsl(${Date.now() / 10 % 360},80%,50%)`;
    ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText('LETTER', 90, 100);
  }, 66);
  const stream = c.captureStream(15);
  const ac = new AudioContext();
  const osc = ac.createOscillator();
  const dst = ac.createMediaStreamDestination();
  osc.connect(dst); osc.start();
  dst.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
    ? 'video/webm;codecs=vp8,opus' : 'video/webm';
  const mr = new MediaRecorder(stream, { mimeType: mime });
  const chunks = [];
  mr.ondataavailable = (e) => chunks.push(e.data);
  const done = new Promise((res) => { mr.onstop = res; });
  mr.start();
  await new Promise((r) => setTimeout(r, 3200));
  mr.stop();
  await done;
  clearInterval(draw);
  const blob = new Blob(chunks, { type: 'video/webm' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  }
  return btoa(bin);
});
const webm = Buffer.from(webmB64, 'base64');
ok('recorded a real webm clip in-browser', webm.length > 10_000, `${(webm.length / 1024).toFixed(0)}KB`);

async function payAndUpload(room, username) {
  const session = letterSession('0.01');
  const resp = await session.fetch(`${BASE}/api/letter/submit?room=${room.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room: room.id, username, address: viewer.address,
      durationS: 3, mime: 'video/webm', flyIn: 'storm', flyOut: 'crt',
    }),
  });
  const data = await resp.json().catch(() => ({}));
  session.close().catch(() => {});
  if (!resp.ok) throw new Error(data.error || `submit ${resp.status}`);
  const up = await fetch(`${BASE}${data.uploadUrl}`, {
    method: 'PUT', headers: { 'Content-Type': 'video/webm' }, body: webm,
  });
  const upData = await up.json().catch(() => ({}));
  if (!up.ok) throw new Error(upData.error || `upload ${up.status}`);
  return { ...data, uploadStatus: upData.status };
}

// ── A. auto-play end to end ──────────────────────────────────────────────────
{
  // overlay page + WS listener BEFORE submitting
  const overlay = await browser.newPage();
  await overlay.goto(`${BASE}/overlay?room=${roomAuto.id}`, { waitUntil: 'networkidle2' });

  const events = [];
  const ws = new WebSocket(WS_URL);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'subscribe_room', room: roomAuto.id }));
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'letter_play' || m.type === 'letter_end' || m.type === 'letter_queued') events.push(m);
    } catch { /* ignore */ }
  });

  const before = await balanceOf();
  const sub = await payAndUpload(roomAuto, 'gate-auto');
  ok('paid submit + upload accepted (auto room)', sub.uploadStatus === 'queued', `status=${sub.uploadStatus}`);
  const after = await balanceOf();
  const paid = Number(formatUnits(before - after, 6));
  ok('flat price actually paid on-chain', paid >= 0.01 && paid < 0.03, `viewer -${paid.toFixed(6)}`);

  // scheduler tick ≤2s + play
  let played = null;
  for (let i = 0; i < 8 && !played; i++) {
    await sleep(1000);
    played = events.find((e) => e.type === 'letter_play');
  }
  ok('letter_play broadcast with media + stingers',
    !!played && played.letter.id === sub.letterId && played.letter.flyIn === 'storm',
    played ? JSON.stringify({ id: played.letter.id.slice(0, 8), flyIn: played.letter.flyIn }) : 'no event');

  if (played) {
    const media = await fetch(`${BASE}${played.letter.mediaUrl}`);
    ok('media URL serves the clip', media.ok
      && (media.headers.get('content-type') || '').includes('video/webm'));
    await sleep(800);
    const tile = await overlay.evaluate(() => {
      const boxes = [...document.querySelectorAll('.tile')];
      const letterBox = boxes.find((b) => (b.dataset.seatId || '').startsWith('letter:'));
      return letterBox ? {
        hasVideo: !!letterBox.querySelector('video'),
        label: letterBox.querySelector('.username-label')?.textContent,
      } : null;
    });
    ok('overlay renders the letter tile (video + label)',
      !!tile && tile.hasVideo && /gate-auto/.test(tile.label || ''), JSON.stringify(tile));
  }

  let ended = null;
  for (let i = 0; i < 10 && !ended; i++) {
    await sleep(1000);
    ended = events.find((e) => e.type === 'letter_end');
  }
  ok('letter_end broadcast after playback', !!ended);
  if (played) {
    await sleep(62_000); // MEDIA_TTL
    const gone = await fetch(`${BASE}${played.letter.mediaUrl}`);
    ok('one-shot: media deleted after playback (+TTL)', gone.status === 404, `status ${gone.status}`);
  }
  ws.close();
}

// ── B. approve queue: reject refunds; approve plays ─────────────────────────
{
  const before = await balanceOf();
  const sub1 = await payAndUpload(roomMod, 'gate-reject-me');
  ok('moderated letter lands in pending_approval', sub1.uploadStatus === 'pending_approval', sub1.uploadStatus);

  const list = await (await fetch(`${BASE}/api/dashboard/rooms/${roomMod.id}/letters`, {
    headers: { 'X-Room-Password': 'phase3-gate' },
  })).json();
  ok('moderation list shows the pending letter',
    list.letters?.some((l) => l.id === sub1.letterId && l.status === 'pending_approval'));

  const rej = await fetch(`${BASE}/api/dashboard/rooms/${roomMod.id}/letters/${sub1.letterId}/reject`, {
    method: 'POST', headers: { 'X-Room-Password': 'phase3-gate' },
  });
  ok('reject accepted', rej.ok);
  await sleep(6000); // refund tx
  const after = await balanceOf();
  const net = Number(formatUnits(before - after, 6));
  ok('REJECT REFUNDED the payer (net cost ≈ channel fees only)',
    net < 0.008, `net -${net.toFixed(6)} (price was 0.01, refunded)`);

  const noPass = await fetch(`${BASE}/api/dashboard/rooms/${roomMod.id}/letters`);
  ok('moderation routes are password-gated', noPass.status === 401);

  // approve path: second letter → approve → plays
  const events = [];
  const ws = new WebSocket(WS_URL);
  await new Promise((res, rej2) => { ws.on('open', res); ws.on('error', rej2); });
  ws.send(JSON.stringify({ type: 'subscribe_room', room: roomMod.id }));
  ws.on('message', (raw) => {
    try { const m = JSON.parse(raw.toString()); if (m.type === 'letter_play') events.push(m); } catch { }
  });
  const sub2 = await payAndUpload(roomMod, 'gate-approve-me');
  await fetch(`${BASE}/api/dashboard/rooms/${roomMod.id}/letters/${sub2.letterId}/approve`, {
    method: 'POST', headers: { 'X-Room-Password': 'phase3-gate' },
  });
  let played = null;
  for (let i = 0; i < 8 && !played; i++) {
    await sleep(1000);
    played = events.find((e) => e.letter?.id === sub2.letterId);
  }
  ok('approved letter plays', !!played);
  ws.close();
}

// ── C. join page: button visibility + no regression ─────────────────────────
{
  const page = await browser.newPage();
  await page.goto(`${BASE}/join?room=${roomAuto.id}`, { waitUntil: 'networkidle2' });
  await sleep(1500);
  const on = await page.evaluate(() => ({
    visible: getComputedStyle(document.getElementById('letterBtn')).display !== 'none',
    text: document.getElementById('letterBtn').textContent,
    joinIntact: ['username', 'joinBtn', 'priceAmount'].every((id) => !!document.getElementById(id)),
  }));
  ok('letter button visible with price in letters room',
    on.visible && /0\.01/.test(on.text) && /5s/.test(on.text), on.text.trim());
  ok('join controls intact', on.joinIntact);

  await page.goto(`${BASE}/join?room=${roomOff.id}`, { waitUntil: 'networkidle2' });
  await sleep(1200);
  const off = await page.evaluate(() =>
    getComputedStyle(document.getElementById('letterBtn')).display === 'none');
  ok('letter button hidden when room has letters off', off);
}

await browser.close();
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
