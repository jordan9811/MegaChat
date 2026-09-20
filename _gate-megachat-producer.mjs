/**
 * GATE — the producer's desk: approving does not air, and the pile survives.
 *
 * SPENDS NOTHING. Every room here prices MegaChats at 0, which skips the
 * payment handshake entirely (letters.js: "Free rooms: price 0 → skip the
 * payment handshake"). The one PAID clip is seeded straight into the store's
 * metadata before boot, so its refund is recorded at the settlement door and
 * never sent — the gate runs with PLATFORM_SETTLEMENT_KEY blank.
 *
 * WHAT IT PROVES
 *   A. approve mode holds: approved → `ready`, and the scheduler never drains it
 *   B. DISCRIMINATES: the same clip in AUTO mode airs by itself, unaided
 *   C. a mod airs a ready clip explicitly, and then it plays
 *   D. the pile survives a restart with its status and its refund clock intact
 *   E. a clip whose media did not survive is refunded, not resurrected empty
 *   F. a held clip nobody airs is refunded when its hold expires
 *   G. an interrupted AI review goes to a human, never to the queue
 *
 * An overlay is connected throughout, so "it did not air" means the scheduler
 * chose not to — not that nothing could have rendered it.
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import WebSocket from 'ws';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'mc-producer-'));
const PORT = 3343;
const APP = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n── the producer’s desk ─────────────────────────────────────');

process.env.DATA_DIR = SCRATCH;
const rooms = await import('./rooms-store.js');
const { startGateServer, mintBountyAuth } = await import('./_gate-helpers.mjs');

const auth = mintBountyAuth({ handles: ['prodhost'], dataDir: SCRATCH });
const LETTERS = { enabled: true, price: '0', minSeconds: 1, maxSeconds: 10, autoRefundOnReject: true };
const producerRoom = rooms.createRoom('producer room', { letters: { ...LETTERS, moderation: 'approve' }, maxSeats: 3 });
const autoRoom = rooms.createRoom('auto room', { letters: { ...LETTERS, moderation: 'auto' }, maxSeats: 3 });
// The dashboard routes authorise by owner cookie; owner keys are account ids.
rooms.setRoomOwner(producerRoom.id, auth.accountIdFor('prodhost'));
rooms.setRoomOwner(autoRoom.id, auth.accountIdFor('prodhost'));

// MODERATION_API_KEY blank: no AI step, so a clip lands in its resting state
// immediately and the test is about WHO decides, not about the AI.
const ENV = { ...auth.env, KEEP_ORPHAN_ROOMS: 'true', MODERATION_API_KEY: '', PLATFORM_SETTLEMENT_KEY: '', LETTER_HOLD_TTL_MS: '3600000' };
let srv = await startGateServer({ port: PORT, dataDir: SCRATCH, label: 'producer', env: ENV });

const post = (p, body, headers = {}) => fetch(`${APP}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const asHost = { Cookie: auth.cookieFor('prodhost') };
const listFor = (roomId) => fetch(`${APP}/api/dashboard/rooms/${roomId}/letters`, { headers: asHost }).then((r) => r.json());
const metaRows = () => { try { return JSON.parse(readFileSync(path.join(SCRATCH, 'letters', 'meta.json'), 'utf8')).letters; } catch { return []; } };
const doorRows = () => { try { return readFileSync(path.join(SCRATCH, 'settlement.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

/** An overlay, so "it did not air" is a decision and not an absence. */
async function overlay(roomId) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const played = [];
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'letter_play') played.push(m.letter.id);
  });
  ws.send(JSON.stringify({ type: 'subscribe_room', room: roomId, role: 'overlay' }));
  await sleep(400);
  return { ws, played };
}

/** Submit + upload a free clip. Returns its id. */
async function sendClip(roomId, username = 'fan') {
  const s = await post('/api/letter/submit', { room: roomId, username, durationS: 2, mime: 'video/webm' });
  if (s.status !== 200 || !s.body.letterId) throw new Error(`submit failed ${s.status} ${JSON.stringify(s.body).slice(0, 140)}`);
  const up = await fetch(`${APP}/api/letter/upload/${s.body.letterId}`, {
    method: 'PUT', headers: { 'Content-Type': 'video/webm' }, body: Buffer.alloc(4096, 7),
  });
  if (!up.ok) throw new Error(`upload failed ${up.status}`);
  return s.body.letterId;
}

let ovP = null, ovA = null;
try {
  ovP = await overlay(producerRoom.id);
  ovA = await overlay(autoRoom.id);

  // ═══ A. approve mode HOLDS ═══
  const held = await sendClip(producerRoom.id, 'producerfan');
  let list = await listFor(producerRoom.id);
  let row = list.letters.find((l) => l.id === held);
  ok('A. a clip in approve mode lands in review, not in the queue', row?.status === 'pending_approval', row?.status);
  const appr = await post(`/api/dashboard/rooms/${producerRoom.id}/letters/${held}/approve`, {}, asHost);
  ok('A. approving answers with the HELD state, not "queued"', appr.status === 200 && appr.body.status === 'ready', JSON.stringify(appr.body));
  list = await listFor(producerRoom.id);
  row = list.letters.find((l) => l.id === held);
  ok('A. ...the clip is READY: approved, and waiting on a person', row?.status === 'ready' && !!row?.heldSince);
  ok('A. ...and it carries a refund deadline, so the fan is not waiting forever', typeof row?.expiresAt === 'number' && row.expiresAt > Date.now(), row?.expiresAt ? `${Math.round((row.expiresAt - Date.now()) / 60_000)} min left` : 'none');
  console.log('  waiting out several scheduler ticks with an overlay connected…');
  await sleep(7_000);
  list = await listFor(producerRoom.id);
  row = list.letters.find((l) => l.id === held);
  ok('A. THE SCHEDULER NEVER TOOK IT: still ready after 7s with an overlay live and a free tile',
    row?.status === 'ready' && !ovP.played.includes(held), `status=${row?.status} plays=${ovP.played.length}`);

  // ═══ B. DISCRIMINATES — the same clip in auto mode airs by itself ═══
  const autoClip = await sendClip(autoRoom.id, 'autofan');
  let autoRow = (await listFor(autoRoom.id)).letters.find((l) => l.id === autoClip);
  ok('B. in AUTO mode the same clip queues instead of waiting for a person', autoRow?.status === 'queued', autoRow?.status);
  for (let i = 0; i < 12 && !ovA.played.includes(autoClip); i++) await sleep(1000);
  ok('B. DISCRIMINATES: auto mode aired it unaided, approve mode did not — the two disagree',
    ovA.played.includes(autoClip) && !ovP.played.includes(held), `auto aired=${ovA.played.includes(autoClip)} producer aired=${ovP.played.includes(held)}`);

  // ═══ C. a mod airs it explicitly ═══
  const aired = await post(`/api/dashboard/rooms/${producerRoom.id}/letters/${held}/play`, {}, asHost);
  ok('C. a mod airs the ready clip', aired.status === 200, `http ${aired.status}`);
  for (let i = 0; i < 10 && !ovP.played.includes(held); i++) await sleep(500);
  ok('C. ...and the overlay receives it — the clip only ever aired because a person said so', ovP.played.includes(held));

  // ═══ D. the pile survives a restart ═══
  const survivor = await sendClip(producerRoom.id, 'survivor');
  await post(`/api/dashboard/rooms/${producerRoom.id}/letters/${survivor}/approve`, {}, asHost);
  const beforeRow = (await listFor(producerRoom.id)).letters.find((l) => l.id === survivor);
  const pendingSurvivor = await sendClip(producerRoom.id, 'stillwaiting');
  ok('D. two clips are on the desk before the restart: one ready, one in review',
    beforeRow?.status === 'ready' && metaRows().some((r) => r.id === pendingSurvivor && r.status === 'pending_approval'), `${metaRows().length} row(s) on disk`);
  ok('D. ...and their video is on disk, not only in memory', existsSync(path.join(SCRATCH, 'letters', 'media', survivor)));

  srv.kill();
  await sleep(1500);
  ovP.ws.close(); ovA.ws.close();
  srv = await startGateServer({ port: PORT, dataDir: SCRATCH, label: 'producer-restarted', env: ENV });
  ovP = await overlay(producerRoom.id);

  list = await listFor(producerRoom.id);
  const afterRow = list.letters.find((l) => l.id === survivor);
  ok('D. AFTER A RESTART the approved clip is still there, still held', afterRow?.status === 'ready', afterRow?.status || 'gone');
  ok('D. ...with its ORIGINAL refund clock — a deploy does not restart somebody’s wait',
    afterRow?.heldSince === beforeRow?.heldSince, `${beforeRow?.heldSince} → ${afterRow?.heldSince}`);
  ok('D. ...the one still in review survived too', list.letters.some((l) => l.id === pendingSurvivor && l.status === 'pending_approval'));
  ok('D. ...and its video still plays back', (await fetch(`${APP}/api/letter/media/${survivor}`)).status === 200);
  await sleep(5_000);
  ok('D. ...and the restart did not hand it to the scheduler', (await listFor(producerRoom.id)).letters.find((l) => l.id === survivor)?.status === 'ready' && !ovP.played.includes(survivor));

  // ═══ E. media lost across a restart → refunded, not resurrected ═══
  const doomed = await sendClip(producerRoom.id, 'doomed');
  await post(`/api/dashboard/rooms/${producerRoom.id}/letters/${doomed}/approve`, {}, asHost);
  srv.kill();
  await sleep(1200);
  unlinkSync(path.join(SCRATCH, 'letters', 'media', doomed)); // the disk lost it
  srv = await startGateServer({ port: PORT, dataDir: SCRATCH, label: 'producer-lostmedia', env: ENV });
  await sleep(1200);
  list = await listFor(producerRoom.id);
  ok('E. a clip whose media did not survive is dropped, never offered as a playable empty', !list.letters.some((l) => l.id === doomed));

  // ═══ F. a held clip nobody airs is refunded when the hold expires ═══
  // Seeded as PAID and already stale, so the refund is recorded at the door.
  // Nothing is sent: the gate runs with no payout key.
  srv.kill();
  await sleep(1200);
  const stale = 'stale-held-clip';
  mkdirSync(path.join(SCRATCH, 'letters', 'media'), { recursive: true });
  writeFileSync(path.join(SCRATCH, 'letters', 'media', stale), Buffer.alloc(4096, 3));
  const meta = metaRows();
  meta.push({
    id: stale, roomId: producerRoom.id, username: 'patientfan',
    payer: '0x00000000000000000000000000000000000000f1', price: '0.01',
    durationS: 2, mime: 'video/webm', status: 'ready',
    paidAt: Date.now() - 7_200_000, uploadedAt: Date.now() - 7_200_000,
    heldSince: Date.now() - 7_200_000, // older than the 1h TTL this gate sets
  });
  writeFileSync(path.join(SCRATCH, 'letters', 'meta.json'), JSON.stringify({ version: 1, letters: meta }, null, 2));
  srv = await startGateServer({ port: PORT, dataDir: SCRATCH, label: 'producer-expiry', env: ENV });
  let refund = null;
  for (let i = 0; i < 15 && !refund; i++) {
    await sleep(1000);
    refund = doorRows().find((r) => r.ref === `letter:${stale}:refund`);
  }
  ok('F. a ready clip nobody aired is refunded when its hold expires', !!refund, refund ? `${refund.type} ${refund.amountAtomic}` : 'no intent');
  ok('F. ...as a recorded INTENT at the settlement door, for the price paid, to the payer',
    refund?.type === 'INTENT' && refund?.kind === 'refund' && refund?.amountAtomic === '10000' && refund?.to === '0x00000000000000000000000000000000000000f1',
    JSON.stringify({ type: refund?.type, amount: refund?.amountAtomic }));
  ok('F. ...and the clip leaves the desk', !(await listFor(producerRoom.id)).letters.some((l) => l.id === stale));

  // ═══ G. an interrupted AI review goes to a human ═══
  srv.kill();
  await sleep(1200);
  const interrupted = 'interrupted-review';
  writeFileSync(path.join(SCRATCH, 'letters', 'media', interrupted), Buffer.alloc(4096, 5));
  const meta2 = metaRows();
  meta2.push({
    id: interrupted, roomId: producerRoom.id, username: 'midreview', payer: null, price: '0',
    durationS: 2, mime: 'video/webm', status: 'reviewing', paidAt: Date.now(), uploadedAt: Date.now(),
  });
  writeFileSync(path.join(SCRATCH, 'letters', 'meta.json'), JSON.stringify({ version: 1, letters: meta2 }, null, 2));
  srv = await startGateServer({ port: PORT, dataDir: SCRATCH, label: 'producer-interrupted', env: ENV });
  await sleep(1200);
  const midRow = (await listFor(producerRoom.id)).letters.find((l) => l.id === interrupted);
  ok('G. a clip caught mid-AI-review goes to a HUMAN, never straight to the queue',
    midRow?.status === 'pending_approval' && /interrupted/i.test(midRow?.flaggedReason || ''), `${midRow?.status} — ${midRow?.flaggedReason}`);

  // ═══ the money path is untouched ═══
  ok('H. no transfer was ever signed here: every door row is a recorded intent',
    doorRows().every((r) => r.type === 'INTENT' || r.type === 'RETAINED'), doorRows().map((r) => r.type).join(',') || 'none');
} finally {
  try { ovP?.ws.close(); ovA?.ws.close(); } catch { /* gone */ }
  if (fail) { console.log('--- server tail ---'); console.log(srv.stderr().slice(-2500)); }
  srv.kill();
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
