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
 * seat and settlement ledgers: one row per phase per ref, idempotent on ref.
 *   SENT     signed locally, hash and nonce recorded BEFORE the raw send
 *   DONE     a receipt for that hash, success; or `reconciled`: the escrow was
 *            read back from the chain and matches (a landed deposit is landed)
 *   FAILED   reverted, or refused before signing, or read back absent
 *   UNKNOWN  sent, and the chain could not be read back: not a failure
 *   ORPHAN   a deposit recorded FAILED/UNKNOWN that the chain DOES hold. Its
 *            seat was refused, so it is attested 0/0 and the viewer is
 *            refunded in full at finalize (DECISIONS 2026-10-24)
 *   ABSENT   a FAILED/UNKNOWN deposit still not on chain a day later: closed
 * SENT rows are reconciled by receipt on every sweep.
 *
 * GATE H. This file and settlement.js are the only two server modules in
 * which a transfer-shaped call may appear (Tier 1). Every write here goes
 * through one function, with the fee token explicit — the seller and role
 * wallets hold USDC.e, not pathUSD, and Tempo would otherwise default the fee
 * token for a non-TIP-20 call to pathUSD (the E38 mainnet lesson).
 *
 * ONE QUEUE PER KEY, PREPARE TO SEND ONLY. The receipt is awaited outside the
 * queue (money-11), so a 20-finalize sweep cannot hold a viewer's join
 * deposit behind 20 receipt waits, and deposits jump queued finalizes.
 *
 * WHAT DEGRADES TO THE DIRECT FALLBACK. A preflight (contract has code, its
 * TOKEN / OPERATOR / ATTESTER match ours) runs at boot and every few minutes;
 * a deposit that provably did not land (refused before signing, or read back
 * absent) marks the escrow degraded for a while. Terms then offer the direct
 * viewer→streamer mode. Nothing about whether a clip aired is ever a reason.
 * A corrupt money ledger (bounty-ledger.js latch) stops every write here.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, createWalletClient, encodeFunctionData, http, isAddress, keccak256, toHex } from 'viem';
import { getContractError } from 'viem/utils';
import { privateKeyToAccount } from 'viem/accounts';
import { tempo as tempoMainnet, tempoModerato } from 'viem/chains';
import { createLedger, corruptMoneyLedger } from './bounty-ledger.js';
import { normalizeKey, sameAddress as sameHex } from './token-utils.js';

export { normalizeKey };

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
const RECEIPT_TIMEOUT_MS = 120_000;
/** Finalizes per sweep: a day's seats falling due together are spread over sweeps. */
export const FINALIZE_PER_SWEEP = 10;
/** How long a FAILED/UNKNOWN deposit is re-read for a late landing before it is closed ABSENT. */
export const ORPHAN_WATCH_MS = 24 * 60 * 60_000;

const markPreSend = (e) => { try { e.preSend = true; } catch { /* frozen */ } return e; };

/**
 * One FIFO per signing key with a priority lane: a join's deposit goes ahead
 * of every queued finalize. Each job is prepare → sign → record → send only.
 */
function laneQueue() {
  const high = [], low = [];
  let running = false;
  function pump() {
    if (running) return;
    const job = high.shift() || low.shift();
    if (!job) return;
    running = true;
    Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { running = false; pump(); });
  }
  return (fn, { priority = false } = {}) => new Promise((resolve, reject) => { (priority ? high : low).push({ fn, resolve, reject }); pump(); });
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
  const ledger = createLedger({ filePath: path.join(dataDir, 'escrow-chain.jsonl'), kind: 'escrow-chain', log });
  // Validated at construction (boot): a damaged ledger latches and is reported
  // now, not at the first deposit. Writes check the latch (halted, below).
  try { ledger.load(); } catch { /* latched: ledgerHealth() and halted() say so */ }
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
  const queues = new Map();
  function serialized(client, fn, opts) {
    if (!queues.has(client)) queues.set(client, laneQueue());
    return queues.get(client)(fn, opts);
  }

  /** Refs whose receipt this process is already waiting on: the sweeper leaves them alone. */
  const inflight = new Set();

  /** A latched money ledger in this data directory stops every write (bounty-ledger.js). */
  function halted() { return ledger.corrupt || corruptMoneyLedger(dataDir); }

  const contractError = (e, functionName, args, client) => getContractError(e, { abi, address, args, functionName, sender: client.account?.address });

  /**
   * The one place a write leaves this module. Fee token explicit, always.
   * SIGNED AHEAD (money-4): prepare and sign locally, record SENT with the
   * hash and nonce, then send — inside the key's queue; the receipt is awaited
   * outside it. Before this, writeContract returned the hash only after the
   * send, so a lost answer left no hash at all and a deposit that landed was
   * recorded FAILED. A throw before SENT is tagged preSend (nothing can land);
   * any throw after it carries `sent: true` and the hash.
   */
  async function write(client, functionName, args, { ref, kind, seatId, extra = {}, priority = false }) {
    const stop = halted();
    if (stop) throw markPreSend(Object.assign(new Error(`escrow writes halted: a money ledger is corrupt (${stop.message})`), { code: 'money_halted' }));
    const { txHash } = await serialized(client, async () => {
      let request, serializedTransaction;
      try {
        request = await client.prepareTransactionRequest({
          account: client.account, chain: client.chain, to: address,
          data: encodeFunctionData({ abi, functionName, args }), feeToken: fee,
        });
        serializedTransaction = await client.signTransaction({ ...request, account: client.account, chain: client.chain });
      } catch (e) { throw markPreSend(contractError(e, functionName, args, client)); }
      const signed = keccak256(serializedTransaction);
      ledger.append({ type: kind, kind, ref, seatId, phase: 'SENT', txHash: signed, nonce: typeof request.nonce === 'number' ? request.nonce : null, signedAhead: true, fn: functionName, ...extra, at: Date.now() });
      inflight.add(ref);
      try { await client.sendRawTransaction({ serializedTransaction }); }
      catch (e) { inflight.delete(ref); throw Object.assign(contractError(e, functionName, args, client), { sent: true, txHash: signed }); }
      return { txHash: signed };
    }, { priority });
    try {
      let rcpt;
      try { rcpt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS, checkReplacement: false }); }
      catch (e) { throw Object.assign(new Error(`${functionName} ${txHash}: no receipt yet (${e?.shortMessage || e?.message})`), { sent: true, txHash }); }
      if (!sameHex(rcpt.transactionHash, txHash)) throw Object.assign(new Error(`${functionName} ${txHash}: the receipt answered is for ${rcpt.transactionHash}`), { sent: true, txHash });
      const phase = rcpt.status === 'success' ? 'DONE' : 'FAILED';
      ledger.append({ type: kind, kind, ref, seatId, phase, txHash, blockNumber: rcpt.blockNumber?.toString?.() ?? null, gasUsed: rcpt.gasUsed?.toString?.() ?? null, at: Date.now() });
      if (phase === 'FAILED') throw Object.assign(new Error(`${functionName} reverted on-chain (${txHash})`), { reverted: true, sent: true, txHash });
      return { txHash, blockNumber: rcpt.blockNumber, gasUsed: rcpt.gasUsed };
    } finally {
      inflight.delete(ref);
    }
  }

  /** viem's shortMessage plus every cause's details and decoded error name: the node's own words survive. */
  function classify(err) {
    let m = String(err?.shortMessage || err?.message || err);
    for (let c = err?.cause; c; c = c.cause) {
      const d = c.details || (c.shortMessage && c.shortMessage !== m ? c.shortMessage : '');
      if (d && !m.includes(String(d))) m += ` | ${String(d).slice(0, 200)}`;
      if (c.data?.errorName && !m.includes(c.data.errorName)) m += ` | ${c.data.errorName}`;
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

  /**
   * What the chain holds for this seat's escrow id, judged against what we
   * meant to deposit: 'match' (it landed), 'absent', 'mismatch' (an escrow
   * under this id that is not ours: never treated as landed), or
   * 'unreachable' (the read failed: we cannot tell).
   */
  async function readBack(seatId, want = null) {
    let e;
    try { e = await pub.readContract({ address, abi, functionName: 'escrow', args: [escrowIdFor(seatId)] }); }
    catch (err) { return { verdict: 'unreachable', error: classify(err).message }; }
    if (!e || /^0x0{40}$/i.test(String(e.viewer))) return { verdict: 'absent' };
    const found = { viewer: e.viewer, streamer: e.streamer, deposited: BigInt(e.deposited), releaseAt: Number(e.releaseAt), finalized: !!e.finalized, attested: !!e.attested };
    if (!want) return { verdict: 'match', ...found };
    const ok = sameHex(e.viewer, want.viewer) && sameHex(e.streamer, want.streamer) && BigInt(e.deposited) === BigInt(want.amount);
    return { verdict: ok ? 'match' : 'mismatch', ...found };
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
    const stop = halted();
    if (stop) {
      degrade('a money ledger is corrupt — escrow writes are halted');
      throw Object.assign(new Error('escrow deposit halted'), { escrow: { kind: 'halted', message: stop.message } });
    }
    const send = () => write(opClient, 'deposit',
      [escrowId, viewer, streamer, amount, BigInt(releaseAt), 0, rate, sessionId],
      { ref, kind: 'DEPOSIT', seatId, priority: true, extra: { escrowId, sessionId, viewer, streamer, amountAtomic: amount.toString(), rateAtomic: rate.toString(), releaseAt, roomId } });
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await send();
        log.log?.(`[escrow] seat ${seatId}: deposited ${amount} atomic for ${streamer} (release ${new Date(releaseAt * 1000).toISOString()}) tx ${r.txHash}${attempt > 1 ? ' (retry)' : ''}`);
        return { deduped: false, txHash: r.txHash, releaseAt, escrowId };
      } catch (e) {
        lastError = e;
        const c = classify(e);
        log.warn?.(`[escrow] seat ${seatId}: deposit attempt ${attempt} ${c.kind}${e?.sent ? ' after the send' : ''}: ${c.message.slice(0, 400)}`);
        // Only a failure that provably sent nothing and might pass next time
        // (the chain unreachable before signing) is retried. Anything after
        // the send is decided by reading the chain, never by sending again.
        if (attempt === 2 || !e?.preSend || c.kind !== 'unreachable') break;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    // Every failure ends with a read of the chain: a deposit that is there IS
    // landed (an EscrowExists revert included), whatever the send reported.
    const back = await readBack(seatId, { viewer, streamer, amount });
    const txHash = lastError?.txHash || null;
    if (back.verdict === 'match') {
      ledger.append({ type: 'DEPOSIT', kind: 'DEPOSIT', ref, seatId, phase: 'DONE', reconciled: true, txHash, escrowId, sessionId, viewer, streamer, amountAtomic: amount.toString(), rateAtomic: rate.toString(), releaseAt: back.releaseAt, roomId, at: Date.now() });
      log.warn?.(`[escrow] seat ${seatId}: the deposit failed to report (${classify(lastError).message.slice(0, 120)}) but the chain holds it — recorded DONE (reconciled)`);
      return { deduped: false, reconciled: true, txHash, releaseAt: back.releaseAt, escrowId };
    }
    const c = classify(lastError);
    if (back.verdict === 'unreachable' && lastError?.sent) {
      // Sent, and we cannot read the chain: UNKNOWN, not FAILED, and not a
      // reason to degrade on its own. The sweeper re-reads it; if it landed,
      // it is an orphan and the viewer is refunded in full.
      ledger.append({ type: 'DEPOSIT', kind: 'DEPOSIT', ref, seatId, phase: 'UNKNOWN', txHash, escrowId, error: `${c.message.slice(0, 300)} | read back: ${back.error?.slice(0, 100)}`, at: Date.now() });
      throw Object.assign(new Error('escrow deposit unconfirmed'), { escrow: { kind: 'unconfirmed', message: c.message } });
    }
    if (back.verdict === 'mismatch') log.error?.(`[escrow] seat ${seatId}: escrow ${escrowId} exists on chain with other terms — not ours, not landed`);
    // An on-chain revert already wrote FAILED in write(); everything else is recorded here.
    if (status(ref)?.phase !== 'FAILED') ledger.append({ type: 'DEPOSIT', kind: 'DEPOSIT', ref, seatId, phase: 'FAILED', txHash, escrowId, error: c.message.slice(0, 400), at: Date.now() });
    degrade(`deposit ${c.kind}: ${c.message.slice(0, 140)}`);
    throw Object.assign(new Error(`escrow deposit ${c.kind}`), { escrow: c });
  }

  // ── attest: the ledger's figures, viewer-ward only, from the attester key ──
  async function attestEscrow({ seatId, escrowId, c, h }) {
    const ref = `escrow:${seatId}:attest:${c}-${h}`;
    const existing = status(ref);
    if (existing?.phase === 'DONE') return { deduped: true, txHash: existing.txHash };
    try {
      const r = await write(atClient, 'attest', [escrowId, c, h], { ref, kind: 'ATTEST', seatId, extra: { consumedUnits: c, hiddenUnits: h } });
      log.log?.(`[escrow] seat ${seatId}: attested consumed ${c}, hidden ${h} tx ${r.txHash}`);
      return { deduped: false, txHash: r.txHash, consumedUnits: c, hiddenUnits: h };
    } catch (e) {
      const cl = classify(e);
      if (!e?.reverted) ledger.append({ type: 'ATTEST', kind: 'ATTEST', ref, seatId, phase: 'FAILED', error: cl.message.slice(0, 200), at: Date.now() });
      log.warn?.(`[escrow] seat ${seatId}: attest ${cl.kind}: ${cl.message.slice(0, 160)}`);
      return { failed: cl };
    }
  }
  async function attest({ seatId, consumedUnits, hiddenUnits }) {
    if (!enabled) throw new Error('escrow not enabled');
    const dep = status(`escrow:${seatId}:deposit`);
    if (!dep || dep.phase !== 'DONE') return { skipped: 'no deposit' };
    const c = Math.max(0, Math.floor(Number(consumedUnits))), h = Math.max(0, Math.min(c, Math.floor(Number(hiddenUnits))));
    return attestEscrow({ seatId, escrowId: dep.escrowId, c, h });
  }

  // ── finalize: permissionless on-chain, done by the operator here ──────────
  let sweeping = false;
  async function finalizeDue({ now = Date.now(), max = FINALIZE_PER_SWEEP } = {}) {
    const out = { finalized: [], skipped: 0, reconciled: 0, failed: [], orphans: [] };
    if (!enabled) return out;
    // One sweep at a time: server.js calls this every 30 s, and a sweep that
    // ran longer re-queued finalizes it had not reached yet (money-11).
    if (sweeping) return { ...out, busy: true };
    const stop = halted();
    if (stop) return { ...out, halted: stop.message };
    sweeping = true;
    try {
      // 1. SENT rows without a terminal phase: reconcile by receipt, never re-send.
      // A write this process is still waiting on will record its own receipt;
      // only a SENT left behind by a crash or restart is reconciled here.
      for (const rec of [...fold().values()].filter((r) => r.phase === 'SENT' && r.txHash && !inflight.has(r.ref))) {
        try {
          const rcpt = await pub.getTransactionReceipt({ hash: rec.txHash });
          if (!rcpt || !sameHex(rcpt.transactionHash, rec.txHash)) continue;
          ledger.append({ type: rec.kind, kind: rec.kind, ref: rec.ref, seatId: rec.seatId, phase: rcpt.status === 'success' ? 'DONE' : 'FAILED', txHash: rec.txHash, blockNumber: rcpt.blockNumber?.toString?.() ?? null, gasUsed: rcpt.gasUsed?.toString?.() ?? null, at: Date.now(), reconciled: true });
          out.reconciled += 1;
        } catch { /* not mined yet, or unreachable — next sweep */ }
      }
      // 2. ORPHANS: a deposit recorded FAILED or UNKNOWN whose seat was refused
      // (the join threw) but which the chain DOES hold. Unattested, the
      // contract would pay the streamer the whole cap at finalize; attested
      // 0/0, it refunds the viewer in full (DECISIONS 2026-10-24).
      for (const dep of [...fold().values()].filter((r) => r.kind === 'DEPOSIT' && (r.phase === 'FAILED' || r.phase === 'UNKNOWN') && !inflight.has(r.ref))) {
        const back = await readBack(dep.seatId);
        if (back.verdict === 'unreachable') continue;
        if (back.verdict === 'absent') {
          const since = dep.rows[dep.rows.length - 1]?.at ?? now;
          if (now - since >= ORPHAN_WATCH_MS) ledger.append({ type: 'DEPOSIT', kind: 'DEPOSIT', ref: dep.ref, seatId: dep.seatId, phase: 'ABSENT', at: Date.now() });
          continue;
        }
        const escrowId = dep.escrowId || escrowIdFor(dep.seatId);
        ledger.append({ type: 'DEPOSIT', kind: 'DEPOSIT', ref: dep.ref, seatId: dep.seatId, phase: 'ORPHAN', escrowId, releaseAt: back.releaseAt, reconciled: true, at: Date.now() });
        out.orphans.push(dep.seatId);
        if (back.finalized) {
          // Too late to attest: someone finalized it unattested, which pays the
          // streamer the whole cap. Recorded and said loudly for a person.
          ledger.append({ type: 'FINALIZE', kind: 'FINALIZE', ref: `escrow:${dep.seatId}:finalize`, seatId: dep.seatId, phase: 'DONE', txHash: null, byOther: true, orphanFinalizedUnattested: true, at: Date.now() });
          log.error?.(`[escrow] seat ${dep.seatId}: orphaned escrow ${escrowId} was ALREADY FINALIZED on chain without our attestation — the viewer may have paid the whole cap; a person must check it`);
          continue;
        }
        log.warn?.(`[escrow] seat ${dep.seatId}: orphaned escrow ${escrowId} found on chain (its seat was refused) — attesting 0/0 so the viewer is refunded in full`);
      }
      // ...and every orphan carries a 0/0 attestation before it is finalized.
      // A failed attempt is retried after the degrade window, not every sweep.
      for (const dep of [...fold().values()].filter((r) => r.kind === 'DEPOSIT' && r.phase === 'ORPHAN')) {
        const att = status(`escrow:${dep.seatId}:attest:0-0`);
        if (att?.phase === 'DONE' || att?.phase === 'SENT' || status(`escrow:${dep.seatId}:finalize`)) continue;
        if (att?.phase === 'FAILED' && now - (att.rows[att.rows.length - 1]?.at ?? 0) < DEGRADED_MS) continue;
        await attestEscrow({ seatId: dep.seatId, escrowId: dep.escrowId, c: 0, h: 0 });
      }
      // 3. deposits past their deadline with no finalize: finalize them, at
      // most `max` per sweep, each behind any join deposit waiting.
      const byRef = fold();
      let started = 0;
      for (const dep of [...byRef.values()].filter((r) => r.kind === 'DEPOSIT' && (r.phase === 'DONE' || r.phase === 'ORPHAN'))) {
        const fref = `escrow:${dep.seatId}:finalize`;
        const fin = byRef.get(fref);
        if (fin && (fin.phase === 'DONE' || fin.phase === 'SENT')) continue;
        if (!dep.releaseAt || dep.releaseAt * 1000 > now) { out.skipped += 1; continue; }
        // An orphan is finalized only once its 0/0 attestation is on chain.
        if (dep.phase === 'ORPHAN' && status(`escrow:${dep.seatId}:attest:0-0`)?.phase !== 'DONE') { out.skipped += 1; continue; }
        if (started >= max) { out.skipped += 1; continue; }
        started += 1;
        try {
          const r = await write(opClient, 'finalize', [dep.escrowId], { ref: fref, kind: 'FINALIZE', seatId: dep.seatId, extra: { escrowId: dep.escrowId } });
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
    } finally {
      sweeping = false;
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
    status: () => ({ enabled, address, ...state, mode: mode().mode, operator: operator?.address || null, attester: attester?.address || null, tailMs, reviewMs, halted: halted()?.message || null }),
    ledger,
  };
}
