/**
 * CLOUD-SOURCED IDLE MEASUREMENT.
 *
 * The last unverified claim in the project: the zero-burn fix has only ever
 * been proven against a local dev SFU. This measures it against LiveKit Cloud.
 *
 * WHAT THIS PROVES: whether a participant is actually CONNECTED to the Cloud
 * project, observed server-side via RoomService (the management API), which
 * does not depend on our overlay reporting about itself.
 *
 * WHAT IT DOES NOT PROVE: what LiveKit bills. Billing data lives behind the
 * dashboard/analytics API we cannot authenticate against at this tier. A
 * participant-count of zero is strong evidence of zero accrual — LiveKit bills
 * per connected participant-minute — but it is an inference, not the invoice.
 *
 * Budget-aware: an idle window costs nothing (nothing connects). The guest
 * phase connects real participants and is the only part that spends.
 */
import { spawn } from 'child_process';
import puppeteer from 'puppeteer-core';
import { RoomServiceClient } from 'livekit-server-sdk';
import 'dotenv/config';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 3260;
const APP = `http://localhost:${PORT}`;

const URL = process.env.LIVEKIT_URL;
const KEY = process.env.LIVEKIT_API_KEY;
const SECRET = process.env.LIVEKIT_API_SECRET;
const rooms = new RoomServiceClient(URL.replace('wss://', 'https://'), KEY, SECRET);

const IDLE_MIN = Number(process.env.IDLE_MINUTES || 10);
const POLL_MS = 20_000;

/** Participant-minutes observed, integrated from polls. */
let observedParticipantMinutes = 0;

async function participantsIn(roomName) {
  try {
    return await rooms.listParticipants(roomName);
  } catch (e) {
    if (/not found|does not exist/i.test(e.message)) return []; // room not created = nobody connected
    throw e;
  }
}

async function pollWindow(roomName, label, minutes) {
  const started = Date.now();
  const endAt = started + minutes * 60_000;
  const samples = [];
  let lastAt = started;
  console.log(`\n[${label}] polling LiveKit Cloud RoomService every ${POLL_MS / 1000}s for ${minutes} min…`);
  while (Date.now() < endAt) {
    await sleep(POLL_MS);
    const now = Date.now();
    const ps = await participantsIn(roomName);
    const dtMin = (now - lastAt) / 60_000;
    observedParticipantMinutes += ps.length * dtMin;
    lastAt = now;
    samples.push(ps.length);
    const ids = ps.map((p) => p.identity).join(',') || '—';
    console.log(`  t+${((now - started) / 60_000).toFixed(1)}min  participants=${ps.length}  [${ids}]`);
  }
  return samples;
}

const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: {
    ...process.env, PORT: String(PORT),
    DATA_DIR: `${process.env.TEMP || '/tmp'}/cloud-measure-${Date.now()}`,
  },
  stdio: 'ignore', cwd: process.cwd(),
});
await sleep(9000);

let browser;
try {
  const mk = await fetch(`${APP}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Cloud Measure', password: 'cloud-measure',
      config: { transport: 'livekit', passkeyTickPrice: '0' },
    }),
  }).then((r) => r.json());
  const roomId = mk.room.id;
  const lkRoom = `mc-${roomId}`;
  console.log(`room=${roomId}  livekit room=${lkRoom}`);
  console.log(`project=${URL}`);

  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', protocolTimeout: 120000 });
  const overlay = await browser.newPage();
  overlay.on('console', (m) => {
    const t = m.text();
    if (/overlay|LiveKit|lazy/i.test(t)) console.log(`  [overlay] ${t.slice(0, 110)}`);
  });
  await overlay.goto(`${APP}/overlay?room=${roomId}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(4000);

  // ── PHASE 1: idle. Overlay up, no guests. Expect zero participants. ──────
  const idleSamples = await pollWindow(lkRoom, 'IDLE', IDLE_MIN);
  const idleMax = Math.max(0, ...idleSamples);
  const idleMinutesAtStart = observedParticipantMinutes;

  console.log(`\n[IDLE RESULT] samples=${idleSamples.join(',')}`);
  console.log(`[IDLE RESULT] max participants during ${IDLE_MIN} idle minutes: ${idleMax}`);
  console.log(`[IDLE RESULT] observed participant-minutes: ${observedParticipantMinutes.toFixed(3)}`);
  console.log(idleMax === 0
    ? '[IDLE RESULT] ✅ ZERO participants connected while idle — measured server-side by Cloud, not self-reported.'
    : '[IDLE RESULT] ❌ SOMETHING WAS CONNECTED WHILE IDLE — this is the leak signature.');

  // ── PHASE 2: prewarm (join intent) — the overlay should connect now. ─────
  console.log('\n[GUEST] firing prewarm (join-sheet-open equivalent)…');
  const pw = await fetch(`${APP}/api/livekit/prewarm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: roomId }),
  }).then((r) => r.json());
  await sleep(12000);
  const during = await participantsIn(lkRoom);
  console.log(`[GUEST] participants after prewarm: ${during.length} [${during.map((p) => p.identity).join(',') || '—'}]`);
  const connectedOnWake = during.length;

  // hold briefly, integrating minutes
  const holdStart = Date.now();
  await sleep(30_000);
  observedParticipantMinutes += during.length * ((Date.now() - holdStart) / 60_000);

  // ── PHASE 3: release, then confirm it disconnects after grace ────────────
  console.log('[GUEST] cancelling prewarm; waiting out the grace window…');
  await fetch(`${APP}/api/livekit/prewarm/cancel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: roomId, prewarm: pw.prewarm }),
  });
  await sleep(75_000); // grace default 60s + margin
  const after = await participantsIn(lkRoom);
  console.log(`[GUEST] participants after grace: ${after.length} [${after.map((p) => p.identity).join(',') || '—'}]`);

  // ── Reconcile against OUR ledger ─────────────────────────────────────────
  const ours = await fetch(`${APP}/api/livekit/sessions`).then((r) => r.json());
  console.log('\n════════ RECONCILIATION ════════');
  console.log(`Cloud-observed participant-minutes (RoomService polling): ${observedParticipantMinutes.toFixed(3)}`);
  console.log(`Our ledger minutesToday:                                  ${ours.minutesToday}`);
  const delta = +(observedParticipantMinutes - ours.minutesToday).toFixed(3);
  console.log(`DELTA (cloud - ours):                                     ${delta}`);
  console.log(`Idle-phase participant-minutes:                           ${idleMinutesAtStart.toFixed(3)}`);
  console.log(`Overlay connected on wake:                                ${connectedOnWake > 0 ? 'YES' : 'NO'}`);
  console.log(`Disconnected after grace:                                 ${after.length === 0 ? 'YES' : 'NO'}`);
  console.log('════════════════════════════════');
  console.log(`\nTOTAL LIVEKIT PARTICIPANT-MINUTES CONSUMED BY THIS RUN: ~${observedParticipantMinutes.toFixed(2)}`);
} finally {
  if (browser) await browser.close();
  app.kill();
}
