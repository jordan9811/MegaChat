/**
 * escrow-chain.js — the app's side of contracts/MegaChatEscrow.sol.
 *
 * Live seats no longer pay anyone directly. At join the server pulls the
 * viewer's approved session cap INTO the contract (deposit); the seat ledger
 * meters off-chain exactly as before; at seat end the ledger's figures become
 * one attestation (consumed units, hidden units); after the deadline anyone —
 * in practice this module's sweeper — finalizes, and the contract pays the
 * streamer and refunds the viewer. The platform wallet never holds seat money.
 *
 * THREE ROLES, THREE KEYS, TWO OF THEM HERE.
 *   operator   ESCROW_OPERATOR_KEY   signs deposit and finalize; pays their gas
 *   attester   ESCROW_ATTEST_KEY     signs attest, and NOTHING else — the key
 *                                    that can lower a streamer's payout is not
 *                                    a key that can move money anywhere
 *   owner      (not held here)       tunes escalation parameters on-chain
 * Keys are accepted with or without a 0x prefix. Neither is ever logged.
 *
 * UNITS. The contract's "seconds" are this seat's TICK UNITS: rate is the
 * tick price in atomic token, the cap in units is deposit / rate, consumed
 * is the number of ticks the ledger accrued, hidden is the buried ticks the
 * ledger charged to the streamer. Exact for any tick length; no rounding.
 *
 * THE DEADLINE. releaseAt = joinedAt + cap in ticks × tick length + tail +
 * review. The seat cannot outlive its cap, the tail is the ledger's own
 * manual-paste tail (SEAT_ESCROW_TAIL_MS, default 10 min) and the review
 * margin (SEAT_ESCROW_REVIEW_MS, default 24 h) is the time a human has to
 * attest more hidden time after the seat's latest possible end. Never past
 * the contract's MAX_HOLD.
 *
 * THE LEDGER. data/escrow-chain.jsonl, the same append-only primitive as the
 * seat and settlement ledgers: one row per phase (SENT, DONE, FAILED) per
 * ref, idempotent on ref, SENT rows reconciled by receipt on every sweep.
 *
 * GATE H. This file and settlement.js are the only two server modules in
 * which a transfer-shaped call may appear (Tier 1). Every write here goes
 * through one function, with the fee token explicit — the seller and role
 * wallets hold USDC.e, not pathUSD, and Tempo would otherwise default the fee
 * token for a non-TIP-20 call to pathUSD (the E38 mainnet lesson).
 *
 * WHAT DEGRADES TO THE DIRECT FALLBACK. A preflight (contract has code, its
 * TOKEN / OPERATOR / ATTESTER match ours) runs at boot and every few minutes;
 * a deposit that reverts or cannot reach the chain marks the escrow degraded
 * for a while. Terms then offer the direct viewer→streamer mode. Nothing
 * about whether a clip aired is ever a reason.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, createWalletClient, http, isAddress, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempo as tempoMainnet, tempoModerato } from 'viem/chains';
import { createLedger } from './bounty-ledger.js';

/**
 * A fee token only reaches the wire inside a TEMPO transaction, and only
 * viem's own Tempo chain definitions carry that serializer. server.js's
 * hand-rolled `tempoViemChain` does not: through it, `feeToken` is silently
 * dropped, the write goes out as EIP-1559, and a non-TIP-20 call has its fee
 * charged in pathUSD — which no wallet of ours holds ("insufficient funds …
 * have 0", found by the Session 2 dust gate). TIP-20 calls never noticed,
 * because their fee token is the token itself. So whatever chain object the
 * caller passes, this module signs against viem's real one for that id.
 */
function tempoChainFor(chain) {
  const id = Number(chain?.id);
  if (id === tempoMainnet.id) return tempoMainnet;
  if (id === tempoModerato.id) return tempoModerato;
  if (chain && !chain.serializers?.transaction) throw new Error(`escrow-chain: chain ${id} has no Tempo transaction serializer — a fee token cannot be sent through it`);
  return chain;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ARTIFACT = path.join(__dirname, 'contracts', 'build', 'MegaChatEscrow.json');
const DEPLOYMENTS = path.join(__dirname, 'contracts', 'deployments.json');

export const MAX_HOLD_MS = 14 * 24 * 60 * 60_000; // the contract's MAX_HOLD, mirrored
const PREFLIGHT_TTL_MS = 5 * 60_000;
const DEGRADED_MS = 10 * 60_000;

/** A private key as stored by a human: with or without 0x. Null if it is neither. */
export function normalizeKey(v) {
  const t = String(v || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return `0x${t}`;
  return /^0x[0-9a-fA-F]{64}$/.test(t) ? t : null;
}

/** The recorded, non-ephemeral deployment for a chain, newest first. */
export function defaultContractAddress(chainId) {
  try {
    const list = JSON.parse(fs.readFileSync(DEPLOYMENTS, 'utf8'));
    const hit = [...list].reverse().find((d) => Number(d.chainId) === Number(chainId) && !d.ephemeralDeployer && d.onChainBytecodeMatchesArtifact);
    return hit ? hit.address : null;
  } catch { return null; }
}

export function loadEscrowAbi() {
  return JSON.parse(fs.readFileSync(ARTIFACT, 'utf8')).abi;
}

/** bytes32 ids: the seat's, and the session's (the stream the seat sat in). */
export const escrowIdFor = (seatId) => keccak256(toHex(`seat:${seatId}`));
export const sessionIdFor = (roomId, airingId) => keccak256(toHex(`session:${roomId}:${airingId || new Date().toISOString().slice(0, 10)}`));

export function createEscrowChain({
  chain, rpcUrl, contractAddress = null, token, operatorKey = null, attesterKey = null, feeToken = null,
  dataDir = DEFAULT_DATA_DIR, tailMs = 10 * 60_000, reviewMs = 24 * 60 * 60_000, log = console,
} = {}) {
  const abi = loadEscrowAbi();
  const ledger = createLedger({ filePath: path.join(dataDir, 'escrow-chain.jsonl'), kind: 'escrow-chain' });
  const address = contractAddress && isAddress(contractAddress) ? contractAddress : null;
  const opKey = normalizeKey(operatorKey), atKey = normalizeKey(attesterKey);
  const operator = opKey ? privateKeyToAccount(opKey) : null;
  const attester = atKey ? privateKeyToAccount(atKey) : null;
  const chainDef = chain ? tempoChainFor(chain) : null;
  const pub = chainDef ? createPublicClient({ chain: chainDef, transport: http(rpcUrl) }) : null;
  const opClient = operator && chainDef ? createWalletClient({ account: operator, chain: chainDef, transport: http(rpcUrl) }) : null;
  const atClient = attester && chainDef ? createWalletClient({ account: attester, chain: chainDef, transport: http(rpcUrl) }) : null;
  const fee = feeToken || token?.address || null;
  const enabled = !!(address && operator && attester && pub && token?.address);

  const state = { ready: false, reason: enabled ? 'not preflighted yet' : missingReason(), checkedAt: 0, degradedUntil: 0 };
  function missingReason() {
    if (!address) return 'no contract address for this chain';
    if (!operator) return 'ESCROW_OPERATOR_KEY not set';
    if (!attester) return 'ESCROW_ATTEST_KEY not set';
    if (!token?.address) return 'no payment token';
    return 'chain client unavailable';
  }

  // ── ledger fold ───────────────────────────────────────────────────────────
  function fold() {
    const m = new Map();
    for (const r of ledger.all()) {
      const cur = m.get(r.ref) || { ref: r.ref, kind: r.kind, seatId: r.seatId, phase: null, rows: [] };
      cur.rows.push(r);
      if (r.phase) cur.phase = r.phase;
      if (r.txHash) cur.txHash = r.txHash;
      if (r.releaseAt) cur.releaseAt = r.releaseAt;
      if (r.escrowId) cur.escrowId = r.escrowId;
      m.set(r.ref, cur);
    }
    return m;
  }
  const status = (ref) => fold().get(ref) || null;

  // ── one queue per signer: one nonce stream each ────────────────────────────
  const queues = new WeakMap();
  function serialized(client, fn) {
    const prev = queues.get(client) || Promise.resolve();
    const next = prev.then(fn, fn);
    queues.set(client, next.catch(() => {}));
    return next;
  }

  /** Refs whose receipt this process is already waiting on: the sweeper leaves them alone. */
  const inflight = new Set();

  /** The one place a write leaves this module. Fee token explicit, always. */
  async function write(client, functionName, args, { ref, kind, seatId, extra = {} }) {
    const txHash = await client.writeContract({ address, abi, functionName, args, feeToken: fee });
    ledger.append({ type: kind, kind, ref, seatId, phase: 'SENT', txHash, fn: functionName, ...extra, at: Date.now() });
    inflight.add(ref);
    try {
      const rcpt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
      const phase = rcpt.status === 'success' ? 'DONE' : 'FAILED';
      ledger.append({ type: kind, kind, ref, seatId, phase, txHash, blockNumber: rcpt.blockNumber?.toString?.() ?? null, gasUsed: rcpt.gasUsed?.toString?.() ?? null, at: Date.now() });
      if (phase === 'FAILED') throw Object.assign(new Error(`${functionName} reverted on-chain (${txHash})`), { reverted: true, txHash });
      return { txHash, blockNumber: rcpt.blockNumber, gasUsed: rcpt.gasUsed };
    } finally {
      inflight.delete(ref);
    }
  }

  /** viem's shortMessage plus every cause's details: the node's own words survive. */
  function classify(err) {
    let m = String(err?.shortMessage || err?.message || err);
    for (let c = err?.cause; c; c = c.cause) {
      const d = c.details || (c.shortMessage && c.shortMessage !== m ? c.shortMessage : '');
      if (d && !m.includes(String(d))) m += ` | ${String(d).slice(0, 200)}`;
    }
    if (err?.reverted || /revert/i.test(m)) return { kind: 'reverted', message: m };
    return { kind: 'unreachable', message: m };
  }
  function degrade(reason) {
    state.degradedUntil = Date.now() + DEGRADED_MS;
    state.reason = reason;
    log.warn?.(`[escrow] degraded for ${DEGRADED_MS / 60_000} min: ${reason}`);
  }

  // ── preflight ─────────────────────────────────────────────────────────────
  async function preflight({ force = false } = {}) {
    if (!enabled) return { ...state, ready: false };
    if (!force && Date.now() - state.checkedAt < PREFLIGHT_TTL_MS) return { ...state };
    try {
      const code = await pub.getBytecode({ address });
      if (!code || code.length <= 2) throw new Error('no code at the escrow address');
      const [tok, op, at] = await Promise.all([
        pub.readContract({ address, abi, functionName: 'TOKEN' }),
        pub.readContract({ address, abi, functionName: 'OPERATOR' }),
        pub.readContract({ address, abi, functionName: 'ATTESTER' }),
      ]);
      const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
      if (!same(tok, token.address)) throw new Error(`escrow token ${tok} is not the room token ${token.address}`);
      if (!same(op, operator.address)) throw new Error(`escrow OPERATOR ${op} is not ESCROW_OPERATOR_KEY's address ${operator.address}`);
      if (!same(at, attester.address)) throw new Error(`escrow ATTESTER ${at} is not ESCROW_ATTEST_KEY's address ${attester.address}`);
      state.ready = true; state.reason = null;
    } catch (e) {
      state.ready = false; state.reason = classify(e).message;
    }
    state.checkedAt = Date.now();
    return { ...state };
  }

  /** 'escrow' when the contract can be used right now, else 'direct' with the reason. */
  function mode() {
    if (!enabled) return { mode: 'direct', reason: state.reason };
    if (Date.now() < state.degradedUntil) return { mode: 'direct', reason: `degraded: ${state.reason}` };
    if (!state.ready) return { mode: 'direct', reason: state.reason || 'preflight not passed' };
    return { mode: 'escrow', reason: null };
  }

  /** The deadline, in unix seconds, for a seat joined at `at` with `capUnits` ticks of `tickMs`. */
  function releaseAtFor({ at = Date.now(), capUnits, tickMs }) {
    const wanted = at + Number(capUnits) * tickMs + tailMs + reviewMs;
    const latest = at + MAX_HOLD_MS - 60_000;
    return Math.floor(Math.min(wanted, latest) / 1000);
  }

  // ── deposit: pull the cap into the contract, before the seat is granted ───
  async function deposit({ seatId, roomId, airingId = null, viewer, streamer, amountAtomic, rateAtomic, tickMs, at = Date.now() }) {
    if (!enabled) throw new Error('escrow not enabled');
    if (!isAddress(streamer)) throw Object.assign(new Error('no payout address — refusing to deposit'), { hardStop: true });
    const ref = `escrow:${seatId}:deposit`;
    const existing = status(ref);
    if (existing?.phase === 'DONE') return { deduped: true, txHash: existing.txHash, releaseAt: existing.releaseAt, escrowId: existing.escrowId };
    const amount = BigInt(amountAtomic), rate = BigInt(rateAtomic);
    const capUnits = amount / rate;
    const releaseAt = releaseAtFor({ at, capUnits, tickMs });
    const escrowId = escrowIdFor(seatId);
    const sessionId = sessionIdFor(roomId, airingId);
    const send = () => serialized(opClient, () => write(opClient, 'deposit',
      [escrowId, viewer, streamer, amount, BigInt(releaseAt), 0, rate, sessionId],
      { ref, kind: 'DEPOSIT', seatId, extra: { escrowId, sessionId, viewer, streamer, amountAtomic: amount.toString(), rateAtomic: rate.toString(), releaseAt, roomId } }));
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await send();
        log.log?.(`[escrow] seat ${seatId}: deposited ${amount} atomic for ${streamer} (release ${new Date(releaseAt * 1000).toISOString()}) tx ${r.txHash}${attempt > 1 ? ' (retry)' : ''}`);
        return { deduped: false, txHash: r.txHash, releaseAt, escrowId };
      } catch (e) {
        lastError = e;
        const c = classify(e);
        log.warn?.(`[escrow] seat ${seatId}: deposit attempt ${attempt} ${c.kind}: ${c.message.slice(0, 400)}`);
        // A revert is an answer; anything else is worth one more try after a
        // beat. A retry after a send that DID land is safe: the contract
        // refuses the second deposit with EscrowExists, which is a revert.
        if (e?.reverted || attempt === 2) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    const c = classify(lastError);
    if (!lastError?.reverted) ledger.append({ type: 'DEPOSIT', kind: 'DEPOSIT', ref, seatId, phase: 'FAILED', error: c.message.slice(0, 400), at: Date.now() });
    degrade(`deposit ${c.kind}: ${c.message.slice(0, 140)}`);
    throw Object.assign(new Error(`escrow deposit ${c.kind}`), { escrow: c });
  }

  // ── attest: the ledger's figures, viewer-ward only, from the attester key ──
  async function attest({ seatId, consumedUnits, hiddenUnits }) {
    if (!enabled) throw new Error('escrow not enabled');
    const dep = status(`escrow:${seatId}:deposit`);
    if (!dep || dep.phase !== 'DONE') return { skipped: 'no deposit' };
    const c = Math.max(0, Math.floor(Number(consumedUnits))), h = Math.max(0, Math.min(c, Math.floor(Number(hiddenUnits))));
    const ref = `escrow:${seatId}:attest:${c}-${h}`;
    const existing = status(ref);
    if (existing?.phase === 'DONE') return { deduped: true, txHash: existing.txHash };
    try {
      const r = await serialized(atClient, () => write(atClient, 'attest', [dep.escrowId, c, h], { ref, kind: 'ATTEST', seatId, extra: { consumedUnits: c, hiddenUnits: h } }));
      log.log?.(`[escrow] seat ${seatId}: attested consumed ${c}, hidden ${h} tx ${r.txHash}`);
      return { deduped: false, txHash: r.txHash, consumedUnits: c, hiddenUnits: h };
    } catch (e) {
      const cl = classify(e);
      if (!e?.reverted) ledger.append({ type: 'ATTEST', kind: 'ATTEST', ref, seatId, phase: 'FAILED', error: cl.message.slice(0, 200), at: Date.now() });
      log.warn?.(`[escrow] seat ${seatId}: attest ${cl.kind}: ${cl.message.slice(0, 160)}`);
      return { failed: cl };
    }
  }

  // ── finalize: permissionless on-chain, done by the operator here ──────────
  async function finalizeDue({ now = Date.now() } = {}) {
    const out = { finalized: [], skipped: 0, reconciled: 0, failed: [] };
    if (!enabled) return out;
    const recs = [...fold().values()];
    // 1. SENT rows without a terminal phase: reconcile by receipt, never re-send.
    // A write this process is still waiting on will record its own receipt;
    // only a SENT left behind by a crash or restart is reconciled here.
    for (const rec of recs.filter((r) => r.phase === 'SENT' && r.txHash && !inflight.has(r.ref))) {
      try {
        const rcpt = await pub.getTransactionReceipt({ hash: rec.txHash });
        if (!rcpt) continue;
        ledger.append({ type: rec.kind, kind: rec.kind, ref: rec.ref, seatId: rec.seatId, phase: rcpt.status === 'success' ? 'DONE' : 'FAILED', txHash: rec.txHash, blockNumber: rcpt.blockNumber?.toString?.() ?? null, gasUsed: rcpt.gasUsed?.toString?.() ?? null, at: Date.now(), reconciled: true });
        out.reconciled += 1;
      } catch { /* not mined yet, or unreachable — next sweep */ }
    }
    // 2. deposits past their deadline with no finalize: finalize them.
    const byRef = fold();
    for (const dep of [...byRef.values()].filter((r) => r.kind === 'DEPOSIT' && r.phase === 'DONE')) {
      const fref = `escrow:${dep.seatId}:finalize`;
      const fin = byRef.get(fref);
      if (fin && (fin.phase === 'DONE' || fin.phase === 'SENT')) continue;
      if (!dep.releaseAt || dep.releaseAt * 1000 > now) { out.skipped += 1; continue; }
      try {
        const r = await serialized(opClient, () => write(opClient, 'finalize', [dep.escrowId], { ref: fref, kind: 'FINALIZE', seatId: dep.seatId, extra: { escrowId: dep.escrowId } }));
        out.finalized.push({ seatId: dep.seatId, txHash: r.txHash });
        log.log?.(`[escrow] seat ${dep.seatId}: finalized tx ${r.txHash}`);
      } catch (e) {
        const c = classify(e);
        // AlreadyFinalized: someone else finalized (it is permissionless). Record it as done.
        if (/AlreadyFinalized/.test(c.message)) { ledger.append({ type: 'FINALIZE', kind: 'FINALIZE', ref: fref, seatId: dep.seatId, phase: 'DONE', txHash: null, byOther: true, at: Date.now() }); continue; }
        if (/TooEarly/.test(c.message)) { out.skipped += 1; continue; }
        out.failed.push({ seatId: dep.seatId, error: c.message.slice(0, 160) });
      }
    }
    return out;
  }

  /** What the ledger says about one seat, for the join response, the gate and the dashboard. */
  function seatStatus(seatId) {
    const m = fold();
    const dep = m.get(`escrow:${seatId}:deposit`) || null;
    const attests = [...m.values()].filter((r) => r.kind === 'ATTEST' && r.seatId === seatId);
    const fin = m.get(`escrow:${seatId}:finalize`) || null;
    return { deposit: dep && { phase: dep.phase, txHash: dep.txHash, releaseAt: dep.releaseAt, escrowId: dep.escrowId }, attests: attests.map((a) => ({ phase: a.phase, txHash: a.txHash, ref: a.ref })), finalize: fin && { phase: fin.phase, txHash: fin.txHash } };
  }

  async function readEscrow(seatId) {
    if (!enabled) return null;
    return pub.readContract({ address, abi, functionName: 'escrow', args: [escrowIdFor(seatId)] });
  }

  return {
    enabled, address, token, feeToken: fee, tailMs, reviewMs,
    operatorAddress: operator?.address || null, attesterAddress: attester?.address || null,
    preflight, mode, releaseAtFor, deposit, attest, finalizeDue, seatStatus, readEscrow, escrowIdFor, sessionIdFor,
    status: () => ({ enabled, address, ...state, mode: mode().mode, operator: operator?.address || null, attester: attester?.address || null, tailMs, reviewMs }),
    ledger,
  };
}
