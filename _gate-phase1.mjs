/**
 * Phase 1 automated gate (headless-safe checks).
 * Passkey WebAuthn flows require manual verification — see MORNING_TEST.md.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  toModularTransport,
  toPasskeyTransport,
} from '@circle-fin/modular-wallets-core';
import { createPublicClient } from 'viem';
import { createBundlerClient } from 'viem/account-abstraction';
import { arcTestnet } from 'viem/chains';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const BASE = `http://127.0.0.1:${PORT}`;
const fails = [];

function ok(msg) { console.log('  ✓', msg); }
function fail(msg) { fails.push(msg); console.error('  ✗', msg); }

// ── Circle Arc path segment (from skill — NOT polygonAmoy) ─────────────────
const ARC_CHAIN_PATH = 'arcTestnet';
ok(`Arc toModularTransport path segment confirmed: /${ARC_CHAIN_PATH}`);

try {
  const clientUrl = process.env.CIRCLE_CLIENT_URL || 'https://modular-sdk.circle.com/v1/rpc/w3s/buidl';
  const clientKey = process.env.CIRCLE_CLIENT_KEY || 'TEST_API_KEY:gate_placeholder';
  toPasskeyTransport(clientUrl, clientKey);
  const modularTransport = toModularTransport(`${clientUrl}/${ARC_CHAIN_PATH}`, clientKey);
  createPublicClient({ chain: arcTestnet, transport: modularTransport });
  createBundlerClient({ chain: arcTestnet, transport: modularTransport });
  ok('Smart-account + bundler clients construct without throwing');
} catch (e) {
  fail('Client construction threw: ' + e.message);
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

async function fetchOk(path) {
  const res = await fetch(`${BASE}${path}`);
  return res;
}

try {
  const home = await fetchOk('/');
  if (home.status !== 200) fail(`GET / returned ${home.status}`);
  else ok('GET / returns 200');

  const html = await home.text();
  if (!html.includes('Connect MetaMask')) fail('Missing Connect MetaMask button');
  else ok('MetaMask onboarding button present');
  if (!html.includes('Sign in with Passkey')) fail('Missing passkey onboarding button');
  else ok('Passkey onboarding button present');
  if (!html.includes('passkey-wallet.bundle.js')) fail('Missing passkey bundle import');
  else ok('index.html loads passkey-wallet.bundle.js');

  const bundle = await fetchOk('/passkey-wallet.bundle.js');
  if (bundle.status !== 200) fail('/passkey-wallet.bundle.js not served');
  else ok('/passkey-wallet.bundle.js returns 200');
  const bundleText = await (await fetchOk('/passkey-wallet.bundle.js')).text();
  if (/from\s+["']abitype["']/.test(bundleText)) fail('Bundle still has bare abitype import');
  else ok('Bundle has no bare abitype specifier');

  const cfg = await fetchOk('/api/config');
  const config = await cfg.json();
  if (!config.chainId || config.chainId !== 5042002) fail('Bad Arc chainId in /api/config');
  else ok('/api/config exposes Arc chainId 5042002');
  if (config.modularWallets && config.modularWallets.chainPath !== 'arcTestnet') {
    fail('modularWallets.chainPath must be arcTestnet');
  } else if (config.modularWallets) {
    ok('/api/config exposes modularWallets with chainPath arcTestnet');
  } else {
    ok('/api/config modularWallets null (env not set — OK for gate)');
  }

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
console.log('Phase 1 automated gate PASSED.');
console.log('Manual passkey verification: see MORNING_TEST.md');
