/**
 * Auth gate — per-room passwords replace global dashboard key.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.GATE_PORT || 3005;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOM_PW = 'gate-test-secret';
const WRONG_PW = 'wrong-password';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const fails = [];

function ok(m) { console.log('  ✓', m); }
function fail(m) { fails.push(m); console.error('  ✗', m); }

const dataDir = path.join(ROOT, 'data');
const roomsPath = path.join(dataDir, 'rooms.json');
let roomsBackup = null;
if (fs.existsSync(roomsPath)) {
  roomsBackup = fs.readFileSync(roomsPath, 'utf8');
}

let serverProc;
try {
  serverProc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      ROOM_DEFAULT_PASSWORD: 'legacy-default-pw',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
} catch (e) {
  fail('spawn: ' + e.message);
}

await sleep(2500);

try {
  for (const p of ['/dashboard', '/', '/overlay']) {
    const res = await fetch(`${BASE}${p}`);
    if (res.status !== 200) fail(`GET ${p} => ${res.status}`);
    else ok(`GET ${p} 200`);
  }

  const dashHtml = await (await fetch(`${BASE}/dashboard`)).text();
  if (dashHtml.includes('STREAMER_DASHBOARD_KEY')) fail('dashboard still references global key');
  else ok('global dashboard key removed from UI');
  if (!dashHtml.includes('createRoomPassword')) fail('create flow missing room password');
  else ok('create flow has room password field');
  if (!dashHtml.includes('manageRoomId')) fail('manage flow missing room id');
  else ok('manage flow has room id + password');

  const created = await fetch(`${BASE}/api/dashboard/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Auth Gate Room',
      password: ROOM_PW,
      config: { paymentTokenAddress: ARC_USDC },
    }),
  });
  const cdata = await created.json();
  if (!created.ok || !cdata.room?.id) fail('create room with password failed');
  else ok('create room with password works');

  const storeRaw = fs.readFileSync(roomsPath, 'utf8');
  if (storeRaw.includes(ROOM_PW)) fail('plaintext password found in rooms.json');
  else ok('password stored hashed (not plaintext in JSON)');

  const badUnlock = await fetch(`${BASE}/api/dashboard/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId: cdata.room.id, password: WRONG_PW }),
  });
  if (badUnlock.status !== 401) fail(`wrong password should 401, got ${badUnlock.status}`);
  else ok('wrong password rejected (401)');

  const goodUnlock = await fetch(`${BASE}/api/dashboard/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId: cdata.room.id, password: ROOM_PW }),
  });
  if (!goodUnlock.ok) fail('correct password unlock failed');
  else ok('correct password unlocks room');

  const noAuthGet = await fetch(`${BASE}/api/dashboard/rooms/${cdata.room.id}`);
  if (noAuthGet.status !== 401) fail('manage GET without password should 401');
  else ok('manage API requires password');

  const authedGet = await fetch(`${BASE}/api/dashboard/rooms/${cdata.room.id}`, {
    headers: { 'X-Room-Password': ROOM_PW },
  });
  if (!authedGet.ok) fail('manage GET with password failed');
  else ok('manage GET with password works');

  const cfg = await (await fetch(`${BASE}/api/config?room=${cdata.room.id}`)).json();
  if (!cfg.roomId) fail('viewer config broken');
  else ok('viewer /api/config still public (no password)');

  const bundle = await fetch(`${BASE}/passkey-wallet.bundle.js`);
  if (bundle.status !== 200) fail('passkey bundle missing');
  else ok('join page assets still served');

} catch (e) {
  fail('HTTP: ' + e.message);
}

if (serverProc) serverProc.kill();
await sleep(400);

if (roomsBackup != null) fs.writeFileSync(roomsPath, roomsBackup);
else if (fs.existsSync(roomsPath)) fs.unlinkSync(roomsPath);

console.log('');
if (fails.length) {
  console.error(`AUTH GATE FAILED (${fails.length})`);
  fails.forEach((f) => console.error(' -', f));
  process.exit(1);
}
console.log('Auth gate PASSED. Live: AUTH_TEST.md');
