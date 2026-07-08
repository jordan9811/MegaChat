/**
 * GATE — MPP client path over a WALLET-SHAPED provider (the bug Privy exposed).
 *
 * The join page builds its mppx session over the wallet's EIP-1193 provider.
 * Privy's embedded provider signs fine on Tempo but proxies READS through
 * infrastructure that does not speak Tempo: eth_call on the channel precompile
 * returns '0x' → viem "Cannot convert 0x to a BigInt" → every tick fails →
 * viewer auto-kicked seconds after going live. The raw-key gates never saw it
 * because they read through a direct Tempo RPC.
 *
 * This gate drives REAL MAINNET dust through a shim provider that faithfully
 * mimics Privy (correct chainId, working sends via a local key, broken reads):
 *   0. wrong-chain signer → the preflight must throw the human error
 *   1. OLD construction (viem.custom(provider) for everything) → must
 *      reproduce the exact BigInt failure (no money moves)
 *   2. NEW construction (reads pinned to the public Tempo RPC, signer kept
 *      wallet-only — replicated from web/lib/join-page.ts ensureMppSession)
 *      → full session must work: join → open → ticks → close → refund
 *
 * Run with the unified server on :3211 (PORT=3211 node server.js --prod).
 */
import WebSocket from 'ws';
import { createWalletClient, createPublicClient, http, custom, erc20Abi, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempo } from 'viem/chains';
import { tempo as tempoClient } from 'mppx/client';

try { process.loadEnvFile(); } catch { /* env set externally */ }

const BASE = process.env.GATE_BASE_URL || 'http://localhost:3211';
const WS_URL = BASE.replace(/^http/, 'ws');
const ROOM = 'default';
const USDC = process.env.TEMPO_USDC_ADDRESS;
const RPC = process.env.TEMPO_RPC_URL || 'https://rpc.tempo.xyz';
const TICKS_TO_RUN = 3;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

const viewer = privateKeyToAccount(process.env.TEST_VIEWER_KEY);
console.log('viewer:', viewer.address);

// The shim's SIGNING half: a real local wallet on the real Tempo RPC — this
// is what Privy's iframe does internally when it signs + broadcasts.
const signerWallet = createWalletClient({ account: viewer, chain: tempo, transport: http(RPC) });
const pub = createPublicClient({ chain: tempo, transport: http(RPC) });
const balanceOf = (addr) =>
  pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [addr] });

const TRACE = process.env.GATE_TRACE === '1';
const deepError = (e, depth = 0) => {
  if (!e || depth > 6) return '';
  const own = [e.name, e.message, e.details].filter(Boolean).join(' | ');
  return own + (e.cause ? '\n    ↳ ' + deepError(e.cause, depth + 1) : '');
};

/** RPC-format tx (hex fields, possibly a Tempo 0x76 batch) → viem request. */
function rpcTxToViem(tx) {
  const bi = (v) => (v == null || v === '0x' ? undefined : BigInt(v));
  const out = {
    from: tx.from,
    to: tx.to,
    data: tx.data ?? tx.input,
    nonce: tx.nonce != null ? Number(tx.nonce) : undefined,
    gas: bi(tx.gas),
    value: bi(tx.value),
    maxFeePerGas: bi(tx.maxFeePerGas),
    maxPriorityFeePerGas: bi(tx.maxPriorityFeePerGas),
    chainId: tx.chainId ? Number(tx.chainId) : tempo.id,
  };
  if (tx.type === '0x76' || tx.type === '0x78') out.type = 'tempo';
  if (Array.isArray(tx.calls)) {
    out.calls = tx.calls.map((c) => ({
      to: c.to, data: c.data ?? c.input, value: bi(c.value) ?? 0n,
    }));
  }
  if (tx.feeToken) out.feeToken = tx.feeToken;
  return out;
}

/**
 * Privy-like provider with broken READS (non-Tempo proxy) and three signer
 * personalities:
 *   faithful    — signs any Tempo envelope (a fully tempo-aware wallet)
 *   strictParse — BigInt("0x") dies on bare "0x" fields (the REAL Privy bug);
 *                 fine once the tx is normalized
 *   sendOnly    — eth_signTransaction unsupported; can only SEND (its own
 *                 fill+sign+broadcast), like wallets without sign-only APIs
 */
function makePrivyLikeProvider({ chainIdHex = '0x1079', switchWorks = true, mode = 'faithful' } = {}) {
  const hasBareHex = (tx) =>
    ['value', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'nonce'].some((k) => tx[k] === '0x')
    || (Array.isArray(tx.calls) && tx.calls.some((c) => c?.value === '0x'));
  const signFaithfully = async (tx) => signerWallet.signTransaction(rpcTxToViem(tx));
  return {
    async request({ method, params = [] }) {
      if (TRACE) console.log('      [wallet]', method, mode);
      switch (method) {
        case 'eth_chainId': return chainIdHex;
        case 'eth_accounts':
        case 'eth_requestAccounts': return [viewer.address];
        case 'wallet_switchEthereumChain':
          if (switchWorks) return null;
          throw new Error('unsupported chain');
        case 'eth_signTransaction': {
          const [tx] = params;
          if (mode === 'sendOnly') throw new Error('eth_signTransaction is not supported');
          if (mode === 'strictParse' && hasBareHex(tx)) throw new Error('Cannot convert 0x to a BigInt');
          if (TRACE) console.log('      [wallet] signing:', JSON.stringify(tx).slice(0, 200));
          return signFaithfully(tx);
        }
        case 'eth_sendTransaction': {
          const [tx] = params;
          if (mode === 'strictParse' && hasBareHex(tx)) throw new Error('Cannot convert 0x to a BigInt');
          if (TRACE) console.log('      [wallet] sending:', JSON.stringify(tx).slice(0, 200));
          // A tempo-aware wallet send: sign the envelope, broadcast through
          // the wallet's own (working) infrastructure.
          const raw = await signFaithfully(tx);
          return pub.request({ method: 'eth_sendRawTransaction', params: [raw] });
        }
        case 'eth_signTypedData_v4': {
          const [, json] = params;
          const td = typeof json === 'string' ? JSON.parse(json) : json;
          const { EIP712Domain, ...types } = td.types;
          return viewer.signTypedData({
            domain: td.domain, types, primaryType: td.primaryType, message: td.message,
          });
        }
        case 'personal_sign':
          return viewer.signMessage({ message: { raw: params[0] } });
        default:
          // THE PRIVY BEHAVIOR UNDER TEST: any read (eth_call, estimateGas,
          // getTransactionCount, …) hits an RPC that does not speak Tempo.
          if (method === 'eth_call') return '0x';
          throw new Error(`read proxy has no route for ${method} on this chain`);
      }
    },
  };
}

// Replicates web/lib/join-page.ts ensureMppSession EXACTLY (post-fix).
const normalizeTempoTx = (tx) => {
  const fix = (v) => (v === '0x' ? '0x0' : v);
  const out = { ...tx };
  for (const k of ['value', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'nonce']) {
    if (out[k] !== undefined) out[k] = fix(out[k]);
  }
  if (Array.isArray(out.calls)) {
    out.calls = out.calls.map((c) => (c && typeof c === 'object' ? { ...c, value: fix(c.value) } : c));
  }
  return out;
};
const WALLET_ONLY_METHODS = new Set([
  'eth_sendTransaction', 'eth_signTransaction', 'personal_sign', 'eth_sign',
  'eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4',
  'eth_accounts', 'eth_requestAccounts',
  'wallet_switchEthereumChain', 'wallet_addEthereumChain',
]);
async function buildFixedSession(provider, sessionCap, decimals) {
  const expectHex = '0x' + tempo.id.toString(16);
  const walletChain = await provider.request({ method: 'eth_chainId' }).catch(() => null);
  if (walletChain && parseInt(walletChain, 16) !== tempo.id) {
    try {
      await provider.request({
        method: 'wallet_switchEthereumChain', params: [{ chainId: expectHex }],
      });
    } catch {
      throw new Error(
        `Wallet is on chain ${parseInt(walletChain, 16)} instead of Tempo (${tempo.id}) — reconnect your wallet and try again.`
      );
    }
  }
  const readClient = createPublicClient({ chain: tempo, transport: http(RPC) });
  const client = createWalletClient({
    account: viewer.address, // address string, same as the page
    chain: tempo,
    transport: custom({
      async request(args) {
        if (TRACE) console.log('      [route]', args.method, WALLET_ONLY_METHODS.has(args.method) ? '→ wallet' : '→ public rpc');
        if (args.method === 'eth_signTransaction') {
          const [tx] = args.params || [];
          try {
            return await provider.request(args);
          } catch (errRaw) {
            const norm = normalizeTempoTx(tx || {});
            try {
              return await provider.request({ method: 'eth_signTransaction', params: [norm] });
            } catch (errNorm) {
              if (TRACE) console.log('      [route] sign ladder exhausted:', errNorm.message);
              throw new Error(
                'This wallet cannot sign Tempo channel transactions — connect MetaMask (or another Tempo-compatible wallet) to join.'
              );
            }
          }
        }
        if (WALLET_ONLY_METHODS.has(args.method)) return provider.request(args);
        return readClient.request(args);
      },
    }),
  });
  return tempoClient.session.manager({
    client, account: viewer.address, maxDeposit: String(sessionCap), decimals,
  });
}

// ── Scenario 0: wrong-chain signer must fail with the HUMAN error ──────────
{
  const provider = makePrivyLikeProvider({ chainIdHex: '0x1', switchWorks: false });
  let err = null;
  try { await buildFixedSession(provider, '0.1', 6); } catch (e) { err = e; }
  ok('preflight rejects wrong-chain wallet with a clear message',
    !!err && /Wallet is on chain 1 instead of Tempo/.test(err.message), err?.message);
}

// ── Seat helper: join + WS + camera_ready ───────────────────────────────────
async function joinSeat(username) {
  const res = await fetch(`${BASE}/api/join/mpp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, address: viewer.address, room: ROOM }),
  });
  const join = await res.json();
  if (!res.ok) { console.error('join failed:', JSON.stringify(join)); process.exit(1); }
  const meterUpdates = [];
  const ws = new WebSocket(WS_URL);
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.send(JSON.stringify({ type: 'subscribe_room', room: ROOM }));
  ws.send(JSON.stringify({ type: 'register_seat', seatId: join.seatId }));
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'meter_update' && m.seatId === join.seatId) meterUpdates.push(m);
    } catch { /* ignore */ }
  });
  ws.send(JSON.stringify({ type: 'camera_ready', seatId: join.seatId }));
  return { join, ws, meterUpdates };
}

// ── Scenario 1: REPRODUCE the live bug (old construction, broken reads) ────
const seat1 = await joinSeat('clientpath-old');
ok('join accepted', true, `cap=${seat1.join.sessionCap} tick=${seat1.join.tickPrice}/${seat1.join.tickSeconds}s`);
{
  const provider = makePrivyLikeProvider();
  const oldClient = createWalletClient({
    account: viewer.address, chain: tempo, transport: custom(provider),
  });
  const oldSession = tempoClient.session.manager({
    client: oldClient, account: viewer.address,
    maxDeposit: String(seat1.join.sessionCap), decimals: seat1.join.paymentTokenDecimals ?? 6,
  });
  let err = null;
  try { await oldSession.fetch(`${BASE}${seat1.join.tickUrl}`, { method: 'POST' }); }
  catch (e) { err = e; }
  const chain = deepError(err);
  ok('OLD path reproduces the live failure over a Privy-like provider',
    !!err && /BigInt|0x|no route/.test(chain), chain.split('\n')[0].slice(0, 110));
  if (TRACE && err) console.log('    old-path error chain:\n    ' + chain);
}
await fetch(`${BASE}/api/leave/${seat1.join.seatId}`, { method: 'POST' });
seat1.ws.close();

// ── Scenarios 2a/2b/2c: FIXED path over the embedded-wallet personalities ──
async function runFixedScenario(label, providerOpts, expect = 'works') {
  console.log(`  [${label}] starting`);
  const before = await balanceOf(viewer.address);
  const { join, ws, meterUpdates } = await joinSeat(`clientpath-${label}`);
  const provider = makePrivyLikeProvider(providerOpts);
  const session = await buildFixedSession(
    provider, join.sessionCap, join.paymentTokenDecimals ?? 6,
  );
  let tickErrors = 0;
  let lastErr = null;
  for (let i = 0; i < TICKS_TO_RUN; i++) {
    const t0 = Date.now();
    try {
      const resp = await session.fetch(`${BASE}${join.tickUrl}`, { method: 'POST' });
      if (!resp.ok) throw new Error(`tick rejected (${resp.status})`);
      console.log(`  [${label}] tick ${i + 1}: ${Date.now() - t0}ms${i === 0 ? ' (channel open)' : ''}`);
    } catch (e) {
      tickErrors++;
      lastErr = e;
      if (expect === 'works') console.error(`  [${label}] tick ${i + 1} ERROR chain:\n    ` + deepError(e));
    }
    await new Promise((r) => setTimeout(r, join.tickSeconds * 1000));
  }

  if (expect === 'works') {
    ok(`${label}: all ticks accepted over the broken-reads provider`,
      tickErrors === 0, `${TICKS_TO_RUN} ticks`);
    ok(`${label}: channel opened on-chain`, !!session.channelId, session.channelId?.slice(0, 20));
    ok(`${label}: meter updates flowed`, meterUpdates.length >= 2, `updates: ${meterUpdates.length}`);
    const receipt = await session.close().catch((e) => {
      console.error(`  [${label}] close failed:`, deepError(e).split('\n')[0]);
      return null;
    });
    ok(`${label}: cooperative close settled`, !!receipt, receipt?.txHash?.slice(0, 20));
  } else {
    // fail-safe expectation: incapable wallets must fail CLEAN — a clear
    // error, no channel, and crucially NO deposit leaving the wallet.
    ok(`${label}: ticks fail (wallet is incapable by design)`, tickErrors === TICKS_TO_RUN);
    ok(`${label}: failure message is actionable`,
      /cannot sign Tempo channel transactions/.test(deepError(lastErr)),
      deepError(lastErr).split('\n')[0].slice(0, 100));
    ok(`${label}: no channel was opened`, !session.channelId);
  }
  await fetch(`${BASE}/api/leave/${join.seatId}`, { method: 'POST' });
  ws.close();
  await new Promise((r) => setTimeout(r, 8000));
  const lost = Number(formatUnits(before - await balanceOf(viewer.address), 6));
  const lossCap = expect === 'works' ? 0.05 : 0.001;
  ok(`${label}: viewer funds safe (lost ${expect === 'works' ? 'spent + dust fees' : 'NOTHING'})`,
    lost >= 0 && lost < lossCap, `viewer -${lost.toFixed(6)}`);
}

// 2a: fully tempo-aware wallet (signs the raw envelope, bare "0x" and all)
await runFixedScenario('faithful-signer', { mode: 'faithful' });
// 2b: THE PRIVY BUG — BigInt("0x") parse death; normalized retry must land
await runFixedScenario('strict-parse', { mode: 'strictParse' });
// 2c: wallet without sign-only support must FAIL SAFE (no stranded deposit)
await runFixedScenario('send-only', { mode: 'sendOnly' }, 'fail-safe');

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
