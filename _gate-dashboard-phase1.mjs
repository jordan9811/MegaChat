/**
 * Phase 1 streamer dashboard automated gate.
 *
 * Everything it writes goes to a SCRATCH data directory, in this process and
 * in the server it boots (startGateServer, --prod, money keys blanked). It
 * used to import rooms-store with no DATA_DIR and spawn a dev server with
 * none either, so it wrote — and the boot pruner then pruned — the repo's
 * real data/rooms.json.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import fs from 'fs';
import os from 'node:os';
import { simulateStreamUntilEmpty } from './passkey-meter.js';
import { startGateServer } from './_gate-helpers.mjs';

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-dash-p1-'));
process.env.DATA_DIR = SCRATCH; // before rooms-store first reads its file
const { resolveRoomConfig, _resetCacheForTests } = await import('./rooms-store.js');

const PORT = Number(process.env.GATE_PORT || 3002);
// localhost, not 127.0.0.1: server.js 301s the latter, and fetch turns a
// redirected POST into a GET.
const BASE = `http://localhost:${PORT}`;
const ROOM_PW = process.env.GATE_ROOM_PASSWORD || 'dashboard-gate-secret';
const fails = [];

function ok(msg) { console.log('  ✓', msg); }
function fail(msg) { fails.push(msg); console.error('  ✗', msg); }

// ── Room store unit checks ───────────────────────────────────────────────────
try {
  _resetCacheForTests();
  const cfg = resolveRoomConfig('default');
  if (!cfg || !cfg.tickPrice) fail('default room config missing');
  else ok('default room config resolves');
} catch (e) {
  fail('rooms-store: ' + e.message);
}

try {
  const { ticks, outOfFunds } = simulateStreamUntilEmpty(2000000n, 1000n);
  if (ticks !== 2000 || !outOfFunds) fail('passkey meter sim failed');
  else ok('passkey meter dry-run still works');
} catch (e) {
  fail('passkey-meter: ' + e.message);
}

let srv = null;
try {
  srv = await startGateServer({
    port: PORT, dataDir: SCRATCH, label: 'dashboard-phase1',
    // Every live key starts blank (startGateServer, SENSITIVE_ENV).
    env: { FOLLOW_STREAM: '0', TEMPO_RPC_URL: 'http://127.0.0.1:9' },
  });
  process.on('exit', () => srv?.kill());
} catch (e) {
  fail('server: ' + e.message);
}

if (srv) try {
  for (const p of ['/', '/overlay', '/dashboard']) {
    const res = await fetch(`${BASE}${p}`);
    if (res.status !== 200) fail(`GET ${p} returned ${res.status}`);
    else ok(`GET ${p} returns 200`);
  }

  const cfg = await (await fetch(`${BASE}/api/config?room=default`)).json();
  if (!cfg.roomId || cfg.roomId !== 'default') fail('config missing roomId');
  else ok('/api/config?room=default exposes room config');

  const created = await fetch(`${BASE}/api/dashboard/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Gate Test Room',
      password: ROOM_PW,
      config: { passkeyTickPrice: '0.002' },
    }),
  });
  const createData = await created.json();
  if (!created.ok || !createData.room?.id) fail('create room failed');
  else ok(`created room ${createData.room.id}`);

  const roomId = createData.room.id;
  const roomCfg = await (await fetch(`${BASE}/api/config?room=${roomId}`)).json();
  if (roomCfg.passkeyTickPrice !== '0.002') fail('room config not persisted');
  else ok('room config readable by join page');

  const storePath = path.join(SCRATCH, 'rooms.json');
  const onDisk = fs.existsSync(storePath) ? JSON.parse(fs.readFileSync(storePath, 'utf8')) : null;
  if (!onDisk?.rooms?.[roomId]) fail('rooms.json in the scratch data dir does not hold the new room');
  else ok('rooms.json persisted on disk (scratch data dir)');

  // Nothing bundles the passkey wallet into public/ any more (housekeeping,
  // 2026-10-24; Gate H asserts the same): this used to expect a 200.
  const bundle = await fetch(`${BASE}/passkey-wallet.bundle.js`);
  if (bundle.status !== 404) fail(`passkey bundle answered ${bundle.status}, not 404`);
  else ok('passkey bundle is not served (404)');

  const badAuth = await fetch(`${BASE}/api/dashboard/rooms/${createData.room.id}`, {
    headers: { 'X-Room-Password': 'wrong' },
  });
  if (badAuth.status !== 401) fail('dashboard auth should reject bad room password');
  else ok('dashboard auth rejects bad room password');

} catch (e) {
  fail('HTTP: ' + e.message);
}

if (srv) srv.kill();
await sleep(1000);
try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* OneDrive may hold a file */ }

console.log('');
if (fails.length) {
  console.error(`GATE FAILED (${fails.length}):`);
  fails.forEach((f) => console.error(' -', f));
  process.exit(1);
}
console.log('Phase 1 dashboard gate PASSED.');
console.log('Live verification: see DASHBOARD_TEST.md');
