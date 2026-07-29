/**
 * GATE — POLISH P2: AI moderation for MegaChats. Real payments, mock
 * moderation API (OpenAI-shaped, mode-switchable) via MODERATION_API_BASE —
 * the REAL pipeline code runs end to end.
 *  A. no key   → identical to today (immediate queue, no reviewing state)
 *  B. pass mode → status 'reviewing' → queued + letter_play in <10s
 *  C. flag mode → pending_approval with the flagged reason in the dashboard
 *     list; reject → on-chain refund (auto-refund default on)
 *  D. autoRefundOnReject=false → reject keeps the payment
 */
import { createServer } from 'http';
import { spawn } from 'child_process';
import WebSocket from 'ws';
import puppeteer from 'puppeteer-core';
import { createWalletClient, createPublicClient, http, erc20Abi, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempo } from 'viem/chains';
import { tempo as tempoClient } from 'mppx/client';

try { process.loadEnvFile(); } catch { /* env external */ }

let pass = 0, fail = 0;
const ok = (n, c, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${e ? ' — ' + e : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${e ? ' — ' + e : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Mock moderation API (OpenAI-shaped) on :3997 ────────────────────────────
let mockMode = 'pass'; // 'pass' | 'flag'
const seen = { transcriptions: 0, moderations: 0, lastInputTypes: [] };
const mock = createServer((req, res) => {
  if (req.url === '/__mode' && req.method === 'POST') {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { mockMode = JSON.parse(b).mode; res.end('{"ok":true}'); });
    return;
  }
  if (req.url === '/v1/audio/transcriptions') {
    seen.transcriptions++;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ text: 'hello stream this is a test clip' }));
  }
  if (req.url === '/v1/moderations') {
    seen.moderations++;
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      // UNION across requests, not last-write-wins: since the
      // one-image-per-request fix, the pipeline SPLITS into [text+frame1],
      // [frame2], ... — the final request is image-only BY DESIGN, and
      // asserting on the last one alone failed the gate against correct
      // behavior.
      try { for (const i of JSON.parse(b).input) if (!seen.lastInputTypes.includes(i.type)) seen.lastInputTypes.push(i.type); } catch { /* ignore */ }
      res.setHeader('Content-Type', 'application/json');
      const flagged = mockMode === 'flag';
      res.end(JSON.stringify({
        results: [{
          flagged,
          categories: { violence: flagged },
          category_scores: { violence: flagged ? 0.93 : 0.01, harassment: 0.02 },
        }],
      }));
    });
    return;
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((r) => mock.listen(3997, r));
const setMode = (m) => fetch('http://localhost:3997/__mode', { method: 'POST', body: JSON.stringify({ mode: m }) });

// ── Two app instances: no-key (:3221) and mock-key (:3222) ──────────────────
// Spawned through the shared harness: refuses to start on an occupied port,
// surfaces spawn/early-exit errors, waits for real readiness, and proves via
// a nonce that the responder is OUR process. This suite is why that exists —
// it spent three days driving a zombie server that held :3222.
const { startGateServer } = await import('./_gate-helpers.mjs');
const plainSrv = await startGateServer({
  port: 3221, label: 'no-key', env: { MODERATION_API_KEY: '', MODERATION_API_BASE: '' },
});
const moddedSrv = await startGateServer({
  port: 3222, label: 'mock-key',
  env: { MODERATION_API_KEY: 'mock-key', MODERATION_API_BASE: 'http://localhost:3997/v1' },
});
const plain = plainSrv.child;
const modded = moddedSrv.child;


const viewer = privateKeyToAccount(process.env.TEST_VIEWER_KEY);
const wallet = createWalletClient({ account: viewer, chain: tempo, transport: http(process.env.TEMPO_RPC_URL || 'https://rpc.tempo.xyz') });
const pub = createPublicClient({ chain: tempo, transport: http(process.env.TEMPO_RPC_URL || 'https://rpc.tempo.xyz') });
const balance = () => pub.readContract({ address: process.env.TEMPO_USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [viewer.address] });

const mk = async (base, name, config) => {
  const r = await fetch(`${base}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password: 'p2-gate', config }),
  });
  return (await r.json()).room;
};

// real webm + fake frames
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
});
const rec = await browser.newPage();
await rec.goto('about:blank');
const { webmB64, frame } = await rec.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 320; c.height = 180;
  const ctx = c.getContext('2d');
  const t = setInterval(() => { ctx.fillStyle = `hsl(${Date.now() / 9 % 360},80%,50%)`; ctx.fillRect(0, 0, 320, 180); }, 66);
  const mr = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm' });
  const chunks = []; mr.ondataavailable = (e) => chunks.push(e.data);
  const done = new Promise((res) => { mr.onstop = res; });
  mr.start(); await new Promise((r) => setTimeout(r, 2200)); mr.stop(); await done; clearInterval(t);
  const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
  let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { webmB64: btoa(bin), frame: c.toDataURL('image/jpeg', 0.6) };
});
const webm = Buffer.from(webmB64, 'base64');

async function sendMegaChat(base, room, withFrames = true) {
  const s = tempoClient.session.manager({ client: wallet, account: viewer, maxDeposit: '0.01', decimals: 6 });
  const r = await s.fetch(`${base}/api/letter/submit?room=${room.id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: room.id, username: 'p2-gate', address: viewer.address, durationS: 3, mime: 'video/webm' }),
  });
  const d = await r.json();
  s.close().catch(() => {});
  if (!r.ok) return { status: r.status, ...d };
  if (withFrames) {
    await fetch(`${base}/api/letter/frames/${d.letterId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frames: [frame, frame] }),
    });
  }
  const up = await fetch(`${base}${d.uploadUrl}`, { method: 'PUT', headers: { 'Content-Type': 'video/webm' }, body: webm });
  const upData = await up.json();
  return { status: r.status, upload: up.status, uploadStatus: upData.status, letterId: d.letterId };
}

const dashList = async (base, room) =>
  (await (await fetch(`${base}/api/dashboard/rooms/${room.id}/letters`, { headers: { 'X-Room-Password': 'p2-gate' } })).json()).letters || [];

try {
  // ── A. no key → identical to today ─────────────────────────────────────────
  const roomA = await mk('http://localhost:3221', 'NoKey', {
    letters: { enabled: true, maxSeconds: 5, price: '0.01', moderation: 'auto' },
  });
  const a = await sendMegaChat('http://localhost:3221', roomA);
  ok('A: keyless upload queues immediately (no reviewing state)', a.uploadStatus === 'queued', a.uploadStatus);

  // ── B. pass mode → reviewing → queued fast ─────────────────────────────────
  await setMode('pass');
  const roomB = await mk('http://localhost:3222', 'Clean', {
    letters: { enabled: true, maxSeconds: 5, price: '0.01', moderation: 'auto' },
  });
  const events = [];
  const ws = new WebSocket('ws://localhost:3222');
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  // role:'overlay' — clips only PLAY while an overlay is connected (a
  // deliberate product change AFTER this gate was written: paid clips must
  // not burn into a room where nothing renders them). Without it the
  // play-path case starves forever.
  ws.send(JSON.stringify({ type: 'subscribe_room', room: roomB.id, role: 'overlay' }));
  ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (/^letter_/.test(m.type)) events.push({ ...m, at: Date.now() }); } catch { } });
  const t0 = Date.now();
  const b = await sendMegaChat('http://localhost:3222', roomB);
  ok('B: upload answers "reviewing"', b.uploadStatus === 'reviewing', b.uploadStatus);
  let queuedEvt = null;
  for (let i = 0; i < 12 && !queuedEvt; i++) {
    await sleep(1000);
    queuedEvt = events.find((e) => e.type === 'letter_queued' && e.letterId === b.letterId && e.status === 'queued');
  }
  const reviewMs = queuedEvt ? queuedEvt.at - t0 : Infinity;
  ok('B: clean clip sails through in <10s', !!queuedEvt && reviewMs < 10_000, `${reviewMs}ms`);
  ok('B: pipeline really ran (transcription + moderation hit, text+images sent)',
    seen.transcriptions >= 1 && seen.moderations >= 1 && seen.lastInputTypes.includes('text') && seen.lastInputTypes.includes('image_url'),
    JSON.stringify({ ...seen }));
  let played = null;
  for (let i = 0; i < 8 && !played; i++) {
    await sleep(1000);
    played = events.find((e) => e.type === 'letter_play');
  }
  ok('B: plays on the overlay pipeline afterwards', !!played);

  // ── C. flag mode → held with reason → reject refunds ───────────────────────
  await setMode('flag');
  const c = await sendMegaChat('http://localhost:3222', roomB);
  ok('C: flagged upload also answers "reviewing" first', c.uploadStatus === 'reviewing');
  let held = null;
  for (let i = 0; i < 12 && !held; i++) {
    await sleep(1000);
    const list = await dashList('http://localhost:3222', roomB);
    held = list.find((l) => l.id === c.letterId && l.status === 'pending_approval');
  }
  ok('C: flagged clip lands in the approve queue with the reason',
    !!held && /violence \(93%\)/.test(held.flaggedReason || ''), held?.flaggedReason);
  const balBefore = await balance();
  await fetch(`http://localhost:3222/api/dashboard/rooms/${roomB.id}/letters/${c.letterId}/reject`, {
    method: 'POST', headers: { 'X-Room-Password': 'p2-gate' },
  });
  await sleep(6000);
  const net = Number(formatUnits(balBefore - await balance(), 6));
  ok('C: reject refunded on-chain (balance recovered the 0.01)', net < -0.009, `delta ${(-net).toFixed(6)} back`);

  // ── D. autoRefundOnReject = false ──────────────────────────────────────────
  const roomD = await mk('http://localhost:3222', 'NoRefund', {
    letters: { enabled: true, maxSeconds: 5, price: '0.01', moderation: 'auto', autoRefundOnReject: false },
  });
  const d = await sendMegaChat('http://localhost:3222', roomD);
  let heldD = null;
  for (let i = 0; i < 12 && !heldD; i++) {
    await sleep(1000);
    heldD = (await dashList('http://localhost:3222', roomD)).find((l) => l.id === d.letterId && l.status === 'pending_approval');
  }
  ok('D: flagged + held', !!heldD);
  const balD = await balance();
  const rej = await (await fetch(`http://localhost:3222/api/dashboard/rooms/${roomD.id}/letters/${d.letterId}/reject`, {
    method: 'POST', headers: { 'X-Room-Password': 'p2-gate' },
  })).json();
  await sleep(5000);
  const netD = Number(formatUnits(balD - await balance(), 6));
  ok('D: reject with auto-refund OFF keeps the payment', rej.refunded === false && Math.abs(netD) < 0.001,
    `refunded=${rej.refunded} delta=${netD.toFixed(6)}`);

  ws.close();
  await browser.close();
} finally {
  plain.kill();
  modded.kill();
  mock.close();
}
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
