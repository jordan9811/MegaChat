/**
 * Phase 2 automated gate (headless-safe checks).
 * Live passkey WebAuthn + on-chain pulls require manual verification — see PHASE2_TEST.md.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  simulateStreamUntilEmpty,
} from './passkey-meter.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.GATE_PORT || 3001;
const BASE = `http://127.0.0.1:${PORT}`;
const fails = [];

function ok(msg) { console.log('  ✓', msg); }
function fail(msg) { fails.push(msg); console.error('  ✗', msg); }

// ── Dry-run stream meter math ───────────────────────────────────────────────
try {
  const sessionCap = 2000000n; // 2 USDC
  const tickPrice = 1000n; // 0.001 USDC
  const { ticks, seat, outOfFunds } = simulateStreamUntilEmpty(sessionCap, tickPrice);
  if (ticks !== 2000) fail(`Expected 2000 ticks, got ${ticks}`);
  else ok(`simulateStreamUntilEmpty: ${ticks} ticks drain 2 USDC at 0.001/tick`);
  if (seat.remainingAtomic !== 0n) fail('Remaining should be 0 after sim');
  else ok('Simulated balance reaches zero');
  if (!outOfFunds) fail('outOfFunds flag should be true at zero');
  else ok('out_of_funds condition detected at zero balance');
} catch (e) {
  fail('passkey-meter simulation threw: ' + e.message);
}

// ── Boot server ────────────────────────────────────────────────────────────
let serverProc;
try {
  serverProc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
} catch (e) {
  fail('Could not spawn server: ' + e.message);
}

await sleep(2500);

try {
  const home = await fetch(`${BASE}/`);
  if (home.status !== 200) fail(`GET / returned ${home.status}`);
  else ok('GET / returns 200');

  const html = await home.text();
  if (!html.includes('authorizeSessionGasless') && !html.includes('passkey-wallet.bundle.js')) {
    fail('Passkey bundle not referenced from index');
  } else ok('index.html references passkey client');

  const cfgRes = await fetch(`${BASE}/api/config`);
  const config = await cfgRes.json();
  if (config.passkeyTickSeconds !== 1 && config.passkeyTickSeconds != null) {
    // default 1 — allow env override
  }
  if (!config.passkeyTickPrice) fail('Missing passkeyTickPrice in /api/config');
  else ok(`/api/config exposes passkeyTickPrice=${config.passkeyTickPrice}`);
  if (config.passkeyMeterApproach !== 'B') {
    fail(`Expected passkeyMeterApproach B, got ${config.passkeyMeterApproach}`);
  } else ok('passkeyMeterApproach=B (approve + transferFrom ticks)');

  const bundle = await fetch(`${BASE}/passkey-wallet.bundle.js`);
  if (bundle.status !== 200) fail('/passkey-wallet.bundle.js not served');
  else ok('/passkey-wallet.bundle.js returns 200');
  const bundleText = await bundle.text();
  if (!bundleText.includes('authorizeSessionGasless')) {
    fail('Bundle missing authorizeSessionGasless export');
  } else ok('Passkey bundle exports authorizeSessionGasless');

} catch (e) {
  fail('HTTP checks failed: ' + e.message);
}

if (serverProc) serverProc.kill();
await sleep(500);

console.log('');
if (fails.length) {
  console.error(`GATE FAILED (${fails.length}):`);
  fails.forEach(f => console.error(' -', f));
  process.exit(1);
}
console.log('Phase 2 automated gate PASSED.');
console.log('Live passkey per-second verification: see PHASE2_TEST.md');
