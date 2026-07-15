/**
 * GATE — POLISH P1: per-feature pricing + gates. Real mainnet dust.
 *  A. MegaChats-only room: joins 403, join page hides the live path, the
 *     headline price is the flat MegaChat price, a MegaChat charges it.
 *  B. Join-Stream-only room: MegaChat submit 403, join + ticks charge the
 *     room's own per-second price (distinct from A's flat price).
 *  C. Per-feature gates: Join Stream overridden to minWatch=8s while
 *     MegaChats stay open — fresh wallet blocked from joining but sends a
 *     MegaChat fine; after ~10s of real watch-session time the join passes.
 *  D. Inheritance: gatesSameAsMegaChat=true mirrors the MegaChat gate.
 */
import WebSocket from 'ws';
import { spawn } from 'child_process';
import puppeteer from 'puppeteer-core';
import { createWalletClient, createPublicClient, http, erc20Abi, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempo } from 'viem/chains';
import { tempo as tempoClient } from 'mppx/client';

try { process.loadEnvFile(); } catch { /* env external */ }

const APP = 'http://localhost:3220';
const WS_URL = APP.replace(/^http/, 'ws');
let pass = 0, fail = 0;
const ok = (n, c, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${e ? ' — ' + e : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${e ? ' — ' + e : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: { ...process.env, PORT: '3220' }, stdio: 'ignore', cwd: process.cwd(),
});
await sleep(9000);

const viewer = privateKeyToAccount(process.env.TEST_VIEWER_KEY);
const wallet = createWalletClient({ account: viewer, chain: tempo, transport: http(process.env.TEMPO_RPC_URL || 'https://rpc.tempo.xyz') });
const pub = createPublicClient({ chain: tempo, transport: http(process.env.TEMPO_RPC_URL || 'https://rpc.tempo.xyz') });
const USDC = process.env.TEMPO_USDC_ADDRESS;
const balance = () => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [viewer.address] });

const mk = async (name, config) => {
  const r = await fetch(`${APP}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password: 'p1-gate', config }),
  });
  return (await r.json()).room;
};

try {
  const roomA = await mk('MC only', {
    joinStream: { enabled: false },
    letters: { enabled: true, maxSeconds: 5, price: '0.01', moderation: 'auto' },
  });
  const roomB = await mk('JS only', {
    passkeyTickPrice: '0.002', passkeyTickSeconds: 1,
    letters: { enabled: false },
  });
  const roomC = await mk('Gated JS', {
    passkeyTickPrice: '0.001', passkeyTickSeconds: 1,
    letters: { enabled: true, maxSeconds: 5, price: '0.01', moderation: 'auto', gates: { minWatchSeconds: 0 } },
    joinStream: { enabled: true, gatesSameAsMegaChat: false, gates: { minWatchSeconds: 8 } },
  });
  const roomD = await mk('Inherit', {
    letters: { enabled: true, maxSeconds: 5, price: '0.01', moderation: 'auto', gates: { minWatchSeconds: 5 } },
    joinStream: { enabled: true, gatesSameAsMegaChat: true },
  });
  console.log('  [setup] rooms', roomA.id, roomB.id, roomC.id, roomD.id);

  // shared: a real recorded webm
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  });
  const rec = await browser.newPage();
  await rec.goto('about:blank');
  const webmB64 = await rec.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 180;
    const ctx = c.getContext('2d');
    const t = setInterval(() => { ctx.fillStyle = `hsl(${Date.now() / 9 % 360},80%,50%)`; ctx.fillRect(0, 0, 320, 180); }, 66);
    const mr = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm' });
    const chunks = []; mr.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((res) => { mr.onstop = res; });
    mr.start(); await new Promise((r) => setTimeout(r, 2200)); mr.stop(); await done; clearInterval(t);
    const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  const webm = Buffer.from(webmB64, 'base64');

  const sendMegaChat = async (room) => {
    const s = tempoClient.session.manager({ client: wallet, account: viewer, maxDeposit: '0.01', decimals: 6 });
    const r = await s.fetch(`${APP}/api/letter/submit?room=${room.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: room.id, username: 'p1-gate', address: viewer.address, durationS: 3, mime: 'video/webm' }),
    });
    const d = await r.json().catch(() => ({}));
    s.close().catch(() => {});
    if (!r.ok) return { status: r.status, ...d };
    const up = await fetch(`${APP}${d.uploadUrl}`, { method: 'PUT', headers: { 'Content-Type': 'video/webm' }, body: webm });
    return { status: r.status, upload: up.status, ...d };
  };

  // ── A. MegaChats only ────────────────────────────────────────────────────
  const cfgA = await (await fetch(`${APP}/api/config?room=${roomA.id}`)).json();
  ok('A: config says joinStream disabled', cfgA.joinStream?.enabled === false);
  const joinA = await fetch(`${APP}/api/join/mpp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'p1', address: viewer.address, room: roomA.id }),
  });
  const joinAData = await joinA.json();
  ok('A: live join 403 feature_disabled', joinA.status === 403 && joinAData.reason === 'feature_disabled',
    joinAData.hint);
  const pageA = await browser.newPage();
  await pageA.goto(`${APP}/join?room=${roomA.id}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1800);
  const uiA = await pageA.evaluate(() => ({
    joinHidden: getComputedStyle(document.getElementById('joinBtn')).display === 'none',
    mcVisible: getComputedStyle(document.getElementById('letterBtn')).display !== 'none',
    price: document.getElementById('priceAmount')?.textContent,
    label: document.getElementById('priceLabel')?.textContent,
  }));
  ok('A: join page hides live path, headlines the MegaChat price',
    uiA.joinHidden && uiA.mcVisible && /0\.01/.test(uiA.price || '') && /per MegaChat/.test(uiA.label || ''),
    JSON.stringify(uiA));
  const balBefore = await balance();
  const mcA = await sendMegaChat(roomA);
  ok('A: MegaChat accepted', mcA.status === 200 && mcA.upload === 200, JSON.stringify({ s: mcA.status, up: mcA.upload }));
  const paidA = Number(formatUnits(balBefore - await balance(), 6));
  ok('A: charged the flat price (~0.01 + fees)', paidA >= 0.01 && paidA < 0.03, `-${paidA.toFixed(6)}`);

  // ── B. Join Stream only ──────────────────────────────────────────────────
  const mcB = await sendMegaChat(roomB);
  ok('B: MegaChat 403 when disabled', mcB.status === 403, mcB.error);
  const joinB = await fetch(`${APP}/api/join/mpp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'p1-live', address: viewer.address, room: roomB.id }),
  });
  const seatB = await joinB.json();
  ok('B: live join accepted', joinB.ok && !!seatB.seatId);
  const sess = tempoClient.session.manager({ client: wallet, account: viewer, maxDeposit: String(seatB.sessionCap), decimals: 6 });
  // go live so ticks charge
  const wsB = new WebSocket(WS_URL);
  await new Promise((res, rej) => { wsB.on('open', res); wsB.on('error', rej); });
  wsB.send(JSON.stringify({ type: 'subscribe_room', room: roomB.id }));
  wsB.send(JSON.stringify({ type: 'camera_ready', seatId: seatB.seatId }));
  await sleep(400);
  for (let i = 0; i < 3; i++) { await sess.fetch(`${APP}${seatB.tickUrl}`, { method: 'POST' }); await sleep(1100); }
  const dashB = await (await fetch(`${APP}/api/dashboard/rooms/${roomB.id}`, { headers: { 'X-Room-Password': 'p1-gate' } })).json();
  const spentB = parseFloat(dashB.seats.find((s) => s.id === seatB.seatId)?.spent || '0');
  ok('B: ticks charge the room\'s own price (0.002/s × 3)', Math.abs(spentB - 0.006) < 0.0021, `spent=${spentB}`);
  await sess.close().catch(() => {});
  await fetch(`${APP}/api/leave/${seatB.seatId}`, { method: 'POST' });
  wsB.close();
  const pageB = await browser.newPage();
  await pageB.goto(`${APP}/join?room=${roomB.id}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1500);
  const uiB = await pageB.evaluate(() => ({
    joinVisible: getComputedStyle(document.getElementById('joinBtn')).display !== 'none',
    mcHidden: getComputedStyle(document.getElementById('letterBtn')).display === 'none',
  }));
  ok('B: join page shows live path, hides MegaChats', uiB.joinVisible && uiB.mcHidden);

  // ── C. per-feature gates (override) ─────────────────────────────────────
  const cfgC = await (await fetch(`${APP}/api/config?room=${roomC.id}`)).json();
  ok('C: config exposes the Join Stream override gate', cfgC.joinStream?.minWatchSeconds === 8);
  const joinC1 = await fetch(`${APP}/api/join/mpp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'p1-gated', address: viewer.address, room: roomC.id }),
  });
  const joinC1Data = await joinC1.json();
  ok('C: fresh wallet blocked from Join Stream (min watch)',
    joinC1.status === 403 && joinC1Data.reason === 'min_watch_time' && joinC1Data.requiredSeconds === 8,
    joinC1Data.hint);
  const mcC = await sendMegaChat(roomC);
  ok('C: same wallet CAN send a MegaChat (gates differ per feature)', mcC.status === 200 && mcC.upload === 200);
  // build real watch time via the rewards session
  const wsC = new WebSocket(WS_URL);
  await new Promise((res, rej) => { wsC.on('open', res); wsC.on('error', rej); });
  wsC.send(JSON.stringify({ type: 'rewards_register', wallet: viewer.address, roomId: roomC.id }));
  wsC.send(JSON.stringify({ type: 'rewards_visibility', visible: true }));
  await sleep(10_500);
  const joinC2 = await fetch(`${APP}/api/join/mpp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'p1-gated', address: viewer.address, room: roomC.id }),
  });
  const joinC2Data = await joinC2.json();
  ok('C: after ~10s of watching the join passes', joinC2.ok && !!joinC2Data.seatId,
    joinC2.ok ? joinC2Data.seatId.slice(0, 8) : JSON.stringify(joinC2Data));
  if (joinC2Data.seatId) await fetch(`${APP}/api/leave/${joinC2Data.seatId}`, { method: 'POST' });
  wsC.close();

  // ── D. inheritance ───────────────────────────────────────────────────────
  const cfgD = await (await fetch(`${APP}/api/config?room=${roomD.id}`)).json();
  ok('D: joinStream inherits the MegaChat gate', cfgD.joinStream?.minWatchSeconds === 5);
  const joinD = await fetch(`${APP}/api/join/mpp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'p1-inh', address: viewer.address, room: roomD.id }),
  });
  const joinDData = await joinD.json();
  ok('D: inherited gate enforces on Join Stream', joinD.status === 403 && joinDData.requiredSeconds === 5);

  await browser.close();
} finally {
  app.kill();
}
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
