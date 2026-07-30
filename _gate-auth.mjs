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
// localhost, NOT 127.0.0.1: the server 301-redirects 127.0.0.1 to localhost
// (passkeys are domain-bound), and fetch turns a redirected POST into a GET —
// so every POST here silently became a GET, missed its route, and fell through
// to Next's 404 page. The product was fine; the gate's base URL was the bug.
const BASE = `http://localhost:${PORT}`;
const ROOM_PW = 'gate-test-secret';
const WRONG_PW = 'wrong-password';
const fails = [];

function ok(m) { console.log('  ✓', m); }
function fail(m) { fails.push(m); console.error('  ✗', m); }

// Harness-spawned on a TEMP data dir: readiness polling instead of a blind
// 2.5s sleep (the server takes ~10s to mount Next, so every clean-checkout run
// failed with 'fetch failed'), a nonce proving the responder is ours, and no
// more backing up and restoring the developer's real rooms.json.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
const { startGateServer } = await import('./_gate-helpers.mjs');
const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-auth-'));
const roomsPath = path.join(dataDir, 'rooms.json');
const srv = await startGateServer({
  port: Number(PORT), dataDir, label: 'auth',
  env: { ROOM_DEFAULT_PASSWORD: 'legacy-default-pw', KEEP_ORPHAN_ROOMS: 'true' },
});
const serverProc = srv.child;

try {
  for (const p of ['/dashboard', '/', '/overlay']) {
    const res = await fetch(`${BASE}${p}`);
    if (res.status !== 200) fail(`GET ${p} => ${res.status}`);
    else ok(`GET ${p} 200`);
  }

  // The legacy static dashboard moved to /dashboard.html when Next took over
  // /dashboard; the password-field markers under test live in the legacy page.
  const dashHtml = await (await fetch(`${BASE}/dashboard.html`)).text();
  if (dashHtml.includes('STREAMER_DASHBOARD_KEY')) fail('dashboard still references global key');
  else ok('global dashboard key removed from UI');
  if (!dashHtml.includes('createRoomPassword')) fail('create flow missing room password');
  else ok('create flow has room password field');
  if (!dashHtml.includes('manageRoomId')) fail('manage flow missing room id');
  else ok('manage flow has room id + password');

  const created = await fetch(`${BASE}/api/dashboard/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // No custom payment token: a custom address triggers LIVE on-chain
    // decimals() validation, which is an external call this gate must not
    // make — and the hardcoded Arc address went stale on Tempo anyway. Auth
    // semantics are what is under test, and they do not depend on the token.
    body: JSON.stringify({ name: 'Auth Gate Room', password: ROOM_PW }),
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

console.log('');
if (fails.length) {
  console.error(`AUTH GATE FAILED (${fails.length})`);
  fails.forEach((f) => console.error(' -', f));
  process.exit(1);
}
console.log('Auth gate PASSED. Live: AUTH_TEST.md');
