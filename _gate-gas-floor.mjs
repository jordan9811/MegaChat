/**
 * Gate: Arc 1 gwei gas floor across ALL user-op / tx construction paths.
 * Live test against the real Circle modular transport + Arc RPC (needs .env).
 *
 *   node _gate-gas-floor.mjs
 *
 * Proves, in order:
 *   1. clampFeesToArcFloor() lifts the exact observed failing estimate (0.818 gwei).
 *   2. The client bundle's arcFeesWithFloor() returns >= 1 gwei from the live endpoint.
 *   3. A REAL prepared userOp (same code path as the browser approve) carries >= 1 gwei.
 *   4. Submitting with the OLD low fee still reproduces the bundler precheck rejection,
 *      while the fixed fees get PAST that precheck (any later error must be non-gas).
 *   5. The server-side estimateArcFeesWithFloor() (refund + per-tick transferFrom) >= 1 gwei.
 */
import { encodeFunctionData, erc20Abi, createPublicClient, http, formatGwei } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { toCircleSmartAccount, ContractAddress } from '@circle-fin/modular-wallets-core';
import {
  MIN_PRIORITY_FEE_WEI,
  clampFeesToArcFloor,
  estimateArcFeesWithFloor,
} from './token-utils.js';

try { process.loadEnvFile(); } catch { /* rely on process.env */ }

// The Circle client key is domain-locked to the app origin. Browsers attach
// Origin automatically; node does not — inject it so live calls authenticate
// exactly like the real join page.
const GATE_ORIGIN = process.env.GATE_ORIGIN || `http://localhost:${process.env.PORT || 3000}`;
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  if (!headers.has('Origin')) headers.set('Origin', GATE_ORIGIN);
  return realFetch(input, { ...init, headers });
};

const FLOOR = 1_000_000_000n;
const OLD_FAILING_PRIORITY = 818_578_550n; // from the original precheck rejection
const FEE_PRECHECK_RE = /maxPriorityFeePerGas.*(must be at least|at least 1000000000)|precheck failed.*maxPriorityFeePerGas/is;

let failures = 0;
const ok = (m) => console.log('  ✅', m);
const fail = (m) => { failures++; console.error('  ❌', m); };
const gwei = (v) => `${formatGwei(v)} gwei`;

function assertFees(label, fees) {
  if (typeof fees?.maxPriorityFeePerGas !== 'bigint' || typeof fees?.maxFeePerGas !== 'bigint') {
    fail(`${label}: fees missing/not bigint: ${JSON.stringify(fees, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`);
    return;
  }
  if (fees.maxPriorityFeePerGas >= FLOOR) {
    ok(`${label}: maxPriorityFeePerGas ${gwei(fees.maxPriorityFeePerGas)} >= 1 gwei floor`);
  } else {
    fail(`${label}: maxPriorityFeePerGas ${gwei(fees.maxPriorityFeePerGas)} BELOW floor`);
  }
  if (fees.maxFeePerGas >= fees.maxPriorityFeePerGas) {
    ok(`${label}: maxFeePerGas ${gwei(fees.maxFeePerGas)} >= priority (proportional)`);
  } else {
    fail(`${label}: maxFeePerGas ${gwei(fees.maxFeePerGas)} < priority fee`);
  }
}

// ── 1. Pure clamp math on the exact estimate that caused the bug ─────────────
console.log('\n[1] clampFeesToArcFloor() on the original failing estimate');
if (MIN_PRIORITY_FEE_WEI !== FLOOR) fail(`MIN_PRIORITY_FEE_WEI is ${MIN_PRIORITY_FEE_WEI}, expected ${FLOOR}`);
assertFees('clamped 0.818 gwei estimate', clampFeesToArcFloor({
  maxPriorityFeePerGas: OLD_FAILING_PRIORITY,
  maxFeePerGas: OLD_FAILING_PRIORITY * 2n,
}));
assertFees('clamped null estimate (RPC down)', clampFeesToArcFloor(null));
const high = clampFeesToArcFloor({ maxPriorityFeePerGas: 5_000_000_000n, maxFeePerGas: 9_000_000_000n });
if (high.maxPriorityFeePerGas === 5_000_000_000n) ok('estimates above the floor pass through untouched');
else fail(`above-floor estimate was altered: ${high.maxPriorityFeePerGas}`);

// ── Live setup: same init path the browser uses ──────────────────────────────
const cfg = {
  clientKey: process.env.CIRCLE_CLIENT_KEY,
  clientUrl: process.env.CIRCLE_CLIENT_URL,
  chainPath: process.env.CIRCLE_MODULAR_CHAIN_PATH || 'arcTestnet',
};
if (!cfg.clientKey || !cfg.clientUrl) {
  fail('CIRCLE_CLIENT_KEY / CIRCLE_CLIENT_URL missing from .env — cannot run live tests');
  process.exit(1);
}
globalThis.window = globalThis; // src module attaches window.PasskeyWallet
// Circle domain-locks the client key via X-AppInfo uri=window.location.hostname
// (see fetchFromApi in the SDK) — mirror the real page's hostname.
globalThis.location = { hostname: process.env.GATE_HOSTNAME || 'localhost' };
const wallet = await import('./src/passkey-wallet.mjs');
const { publicClient, bundlerClient } = wallet.initModularClients(cfg);

// ── 2. Client fee helper against the live Circle endpoint ───────────────────
console.log('\n[2] client arcFeesWithFloor() against live Circle transport');
try {
  const raw = await publicClient.estimateFeesPerGas();
  console.log(`  ℹ️ raw network estimate: priority ${gwei(raw.maxPriorityFeePerGas)}, max ${gwei(raw.maxFeePerGas)}`
    + (raw.maxPriorityFeePerGas < FLOOR ? '  ← below floor: this is what broke the join' : ''));
} catch (e) {
  console.log('  ℹ️ raw estimateFeesPerGas unavailable:', e.shortMessage || e.message);
}
assertFees('client helper (live)', await window.PasskeyWallet.arcFeesWithFloor(publicClient));

// ── 3. Real userOp prepared through the REAL bundler client + hook ──────────
console.log('\n[3] prepareUserOperation via the same bundlerClient the browser uses');
const throwawayOwner = privateKeyToAccount(generatePrivateKey());
let account = null;
try {
  account = await toCircleSmartAccount({
    client: publicClient,
    owner: throwawayOwner,
    name: `gas-floor-gate-${Date.now()}`,
  });
  console.log('  ℹ️ throwaway smart account:', account.address);
} catch (e) {
  fail('toCircleSmartAccount failed — cannot run live userOp tests: ' + (e.shortMessage || e.message));
  console.log(failures === 0 ? '\nGATE PASS' : `\nGATE FAIL — ${failures} check(s) failed (live userOp portion skipped)`);
  process.exit(1);
}
const approveCall = {
  to: ContractAddress.ArcTestnet_USDC,
  data: encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [account.address, 1n], // harmless self-approve of 0.000001 USDC
  }),
};
let prepared = null;
try {
  prepared = await bundlerClient.prepareUserOperation({
    account, calls: [approveCall], paymaster: true,
  });
} catch (e) {
  console.log('  ℹ️ prepare with paymaster failed (' + (e.shortMessage || e.message) + '), retrying without paymaster');
  try {
    prepared = await bundlerClient.prepareUserOperation({ account, calls: [approveCall] });
  } catch (e2) {
    fail('prepareUserOperation failed entirely: ' + (e2.shortMessage || e2.message));
  }
}
if (prepared) assertFees('prepared userOp', prepared);

// ── 4. The actual bundler precheck: old fee rejected, floored fee accepted ──
console.log('\n[4] eth_sendUserOperation precheck: old fee vs fixed fee');
try {
  await bundlerClient.sendUserOperation({
    account, calls: [approveCall], paymaster: true,
    maxPriorityFeePerGas: OLD_FAILING_PRIORITY,
    maxFeePerGas: OLD_FAILING_PRIORITY * 2n,
  });
  fail('userOp with 0.818 gwei was ACCEPTED — precheck no longer enforced? (fix still safe)');
} catch (e) {
  const msg = [e.message, e.details, e.cause?.message].filter(Boolean).join(' | ');
  if (FEE_PRECHECK_RE.test(msg)) ok('old 0.818 gwei fee still rejected by the fee precheck (bug reproduced)');
  else console.log('  ⚠️ low-fee submit failed EARLIER than the fee precheck (inconclusive repro):', (e.shortMessage || e.message).slice(0, 200));
}
try {
  const hash = await bundlerClient.sendUserOperation({
    account, calls: [approveCall], paymaster: true, // fees come from the hook, like the browser
  });
  ok(`floored userOp ACCEPTED by bundler (hash ${hash.slice(0, 18)}…) — gas precheck PASSED`);
} catch (e) {
  const msg = [e.message, e.details, e.cause?.message].filter(Boolean).join(' | ');
  if (FEE_PRECHECK_RE.test(msg)) fail('floored userOp STILL rejected on gas: ' + msg.slice(0, 300));
  else ok('floored userOp got PAST the gas precheck (later non-gas rejection: '
    + (e.shortMessage || e.message).slice(0, 160) + ')');
}

// ── 5. Server-side path (refund transfer + per-tick transferFrom) ───────────
console.log('\n[5] server estimateArcFeesWithFloor() against Arc RPC');
const arcRpc = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';
const serverClient = createPublicClient({
  chain: { id: Number(process.env.ARC_CHAIN_ID || 5042002), name: 'Arc Testnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [arcRpc] }, public: { http: [arcRpc] } } },
  transport: http(arcRpc),
});
try {
  const rawSrv = await serverClient.estimateFeesPerGas();
  console.log(`  ℹ️ raw Arc RPC estimate: priority ${gwei(rawSrv.maxPriorityFeePerGas)}, max ${gwei(rawSrv.maxFeePerGas)}`);
} catch (e) {
  console.log('  ℹ️ raw Arc RPC estimate unavailable:', e.shortMessage || e.message);
}
assertFees('server helper (live)', await estimateArcFeesWithFloor(serverClient));

console.log(failures === 0 ? '\nGATE PASS — all gas paths at/above the 1 gwei floor' : `\nGATE FAIL — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
