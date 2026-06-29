/**
 * Part A UX gate — dashboard + join page overhaul.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.GATE_PORT || 3003;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOM_PW = process.env.GATE_ROOM_PASSWORD || 'dashboard-gate-secret';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const fails = [];

function ok(m) { console.log('  ✓', m); }
function fail(m) { fails.push(m); console.error('  ✗', m); }

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
  for (const p of ['/dashboard', '/', '/overlay']) {
    const res = await fetch(`${BASE}${p}`);
    if (res.status !== 200) fail(`GET ${p} => ${res.status}`);
    else ok(`GET ${p} 200`);
  }

  const dashHtml = await (await fetch(`${BASE}/dashboard`)).text();
  if (!dashHtml.includes('tokenPreset')) fail('dashboard missing token dropdown');
  else ok('dashboard has token dropdown (USDC default)');
  if (!dashHtml.includes('resultPanel')) fail('dashboard missing result panel');
  else ok('dashboard has post-create result panel');
  if (!dashHtml.includes('Create room') && !dashHtml.includes('createRoomBtn')) {
    fail('dashboard missing create room flow');
  } else ok('create room before URLs pattern present');
  if (!dashHtml.includes('Rewards (optional)')) fail('missing rewards optional section');
  else ok('rewards optional section present');
  if (!dashHtml.includes('coming soon')) fail('missing platform stub');
  else ok('Twitch/Kick stub present');

  const indexHtml = await (await fetch(`${BASE}/`)).text();
  if (!indexHtml.includes('app-theme.css')) fail('join page missing theme');
  else ok('join page loads app-theme.css');
  if (!indexHtml.includes('Pay to go on camera')) fail('join page missing product framing');
  else ok('join page product framing');

  const theme = await fetch(`${BASE}/app-theme.css`);
  if (theme.status !== 200) fail('app-theme.css not served');
  else ok('app-theme.css served');

  const created = await fetch(`${BASE}/api/dashboard/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'UI Gate Room',
      password: ROOM_PW,
      config: {
        passkeyTickPrice: '0.001',
        passkeyTickSeconds: 1,
        paymentTokenAddress: ARC_USDC,
      },
    }),
  });
  const cdata = await created.json();
  if (!created.ok || !cdata.joinUrl || !cdata.overlayUrl) fail('create room missing urls');
  else ok('create room returns scoped JOIN + OVERLAY urls');
  if (!cdata.joinUrl.includes('room=')) fail('join url missing room id');
  else ok('JOIN url carries room id');

  const cfg = await (await fetch(`${BASE}/api/config?room=${cdata.room.id}`)).json();
  if (cfg.paymentTokenSymbol !== 'USDC') fail('USDC default token symbol');
  else ok('room config defaults USDC token');

  const bundle = await fetch(`${BASE}/passkey-wallet.bundle.js`);
  if (bundle.status !== 200) fail('passkey bundle missing');
  else ok('passkey bundle still served');

} catch (e) {
  fail('HTTP: ' + e.message);
}

if (serverProc) serverProc.kill();
await sleep(400);

console.log('');
if (fails.length) {
  console.error(`PART A GATE FAILED (${fails.length})`);
  fails.forEach((f) => console.error(' -', f));
  process.exit(1);
}
console.log('Part A gate PASSED. Live: UI_TEST.md');
