/**
 * UI overhaul gate — editorial neon-noir theme, dashboard + join page.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.GATE_PORT || 3015;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOM_PW = process.env.GATE_ROOM_PASSWORD || 'ui-gate-secret';
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

  const fav = await fetch(`${BASE}/favicon.svg`);
  if (fav.status !== 200) fail('favicon.svg 404');
  else ok('favicon.svg served');

  const dashHtml = await (await fetch(`${BASE}/dashboard`)).text();
  if (!dashHtml.includes('themeToggle')) fail('dashboard missing theme toggle');
  else ok('theme toggle present');
  if (!dashHtml.includes('createRoomPassword')) fail('missing room password field');
  else ok('room password in form');
  if (!dashHtml.includes('copy-icon')) fail('missing copy icons');
  else ok('compact link rows with copy icons');
  if (!dashHtml.includes('joinToggleBtn')) fail('missing join acceptance toggle');
  else ok('single join toggle');
  if (!dashHtml.includes('Charge interval')) fail('missing short labels');
  else ok('short labels with tooltips');
  if (dashHtml.includes('How often viewers are charged')) fail('verbose label still present');
  else ok('verbose labels removed');
  if (!dashHtml.includes('resultPanel')) fail('missing result panel');
  else ok('result panel markup present');

  const indexHtml = await (await fetch(`${BASE}/`)).text();
  if (!indexHtml.includes('app-theme.css')) fail('join page missing theme');
  else ok('join page loads app-theme.css');
  if (!indexHtml.includes('Put your face on the stream')) fail('join hero missing');
  else ok('join page hero copy');
  if (!indexHtml.includes('theme.js')) fail('join page missing theme.js');
  else ok('join page theme script');

  const theme = await fetch(`${BASE}/app-theme.css`);
  if (theme.status !== 200) fail('app-theme.css not served');
  else ok('app-theme.css served');

  const created = await fetch(`${BASE}/api/dashboard/create`, {
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
  console.error(`UI GATE FAILED (${fails.length})`);
  fails.forEach((f) => console.error(' -', f));
  process.exit(1);
}
console.log('UI gate PASSED. Live: UI_TEST.md');
