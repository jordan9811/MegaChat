/**
 * Phase 1 streamer dashboard automated gate.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import fs from 'fs';
import { fileURLToPath } from 'node:url';
import { simulateStreamUntilEmpty } from './passkey-meter.js';
import { resolveRoomConfig, _resetCacheForTests } from './rooms-store.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.GATE_PORT || 3002;
const BASE = `http://127.0.0.1:${PORT}`;
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

let serverProc;
try {
  serverProc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), ROOM_DEFAULT_PASSWORD: 'changeme' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
} catch (e) {
  fail('spawn: ' + e.message);
}

await sleep(2500);

try {
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

  const storePath = path.join(ROOT, 'data', 'rooms.json');
  if (!fs.existsSync(storePath)) fail('data/rooms.json not written');
  else ok('rooms.json persisted on disk');

  const bundle = await fetch(`${BASE}/passkey-wallet.bundle.js`);
  if (bundle.status !== 200) fail('passkey bundle not served');
  else ok('passkey bundle still served');

  const badAuth = await fetch(`${BASE}/api/dashboard/rooms/${createData.room.id}`, {
    headers: { 'X-Room-Password': 'wrong' },
  });
  if (badAuth.status !== 401) fail('dashboard auth should reject bad room password');
  else ok('dashboard auth rejects bad room password');

} catch (e) {
  fail('HTTP: ' + e.message);
}

if (serverProc) serverProc.kill();
await sleep(400);

console.log('');
if (fails.length) {
  console.error(`GATE FAILED (${fails.length}):`);
  fails.forEach((f) => console.error(' -', f));
  process.exit(1);
}
console.log('Phase 1 dashboard gate PASSED.');
console.log('Live verification: see DASHBOARD_TEST.md');
