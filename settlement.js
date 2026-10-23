/**
 * SETTLEMENT — the single door money leaves through.
 *
 * ⚠ REAL FUNDS MOVE HERE, AND ONLY HERE. Every transfer-shaped call the server
 * makes with a key it holds lives in this module: the per-tick pull that
 * meters a live seat, seat and MegaChat refunds, reward payouts, holdback
 * releases, clawbacks, and the MPP channel settle. Gate H (Tier 1) scans every
 * other server-side module for those calls and fails on the first one it finds.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 * A transfer executes only against a RECORDED INTENT, keyed by `ref`. The
 * intent is appended to this module's own append-only ledger BEFORE anything
 * is signed, and the ref is the idempotency key: enqueue the same ref twice
 * and it is one intent; flush twice and it is one transfer; kill the process
 * between the send and the receipt, restart, and the SENT row is reconciled
 * by transaction hash rather than sent again. Amounts arrive from the seat
 * ledger, the letters queue and the rewards meter as ledger-derived numbers —
 * nothing here reads a live balance to decide what to move.
 *
 * ── Two keys, on purpose ──────────────────────────────────────────────────
 * PULL   `SELLER_PRIVATE_KEY` — the spender the viewer approved, pulls ticks
 *        into the platform wallet. Already live before this module existed.
 * PAYOUT `PLATFORM_SETTLEMENT_KEY` — moves money OUT of the platform wallet:
 *        streamer shares, holdback releases, refunds, clawbacks, reward pool
 *        payouts. Unset by default. Until it is set, outbound intents are
 *        recorded and stay PENDING; nothing is lost, the ledger says exactly
 *        who is owed what, and the first flush after the key lands pays it.
 *        It must resolve to the same address the pulls land in, and boot
 *        refuses to enable payouts otherwise — money would be sent from a
 *        wallet that does not hold it.
 * REWARD `REWARD_POOL_PRIVATE_KEY` — a separate wallet; same intent rule.
 *
 * ── Row types in data/settlement.jsonl ────────────────────────────────────
 *   INTENT          an outbound transfer is owed (kind, signer, token, to, amount, ref)
 *   RETAINED        nothing to move: the payee IS the platform wallet, the amount
 *                   is zero, or the token has no address (off-chain credit, points)
 *   SENT            submitted, with txHash; receipt not yet seen
 *   DONE            receipt seen, success
 *   FAILED          receipt reverted, or the send threw — terminal for automation
 *   PULL_SENT       a transferFrom signed locally, its hash AND the nonce it was
 *                   signed with recorded BEFORE the raw transaction is sent
 *                   (SIGN_AHEAD_SLOTS); a PULL follows once the node accepts it.
 *                   A PULL_SENT with no PULL is reconciled by that hash's
 *                   receipt and is never re-sent.
 *   PULL            a transferFrom, recorded after it was sent (or dry). For a
 *                   signed-ahead pull its txHash is the SIGNED hash, never the
 *                   node's answer (kept as nodeHash when it differs).
 *   CHANNEL_SETTLE  an MPP channel settle, recorded with its txHash
 *
 * ── What this is not ─────────────────────────────────────────────────────
 * Not the bounty settlement. `bounty-settlement.js` stays the stub, so the
 * legacy Gate H section — "the bounty feature is inert" — keeps meaning what
 * it always meant. Not a client-side door: money a viewer signs in their own
 * wallet (the session-cap approve, the channel open) never passes through
 * here, and Gate H Tier 3 pins those call sites rather than pretending to
 * mediate them.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { erc20Abi, encodeFunctionData, keccak256 } from 'viem';
import { getTransactionCount } from 'viem/actions';
import { tempo as mppTempo } from 'mppx/server';
import { createLedger } from './bounty-ledger.js';
import { toAtomic } from './token-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

export const INTENT_KINDS = new Set(['release', 'refund']);
export const SIGNERS = new Set(['platform', 'rewardPool']);
/**
 * Who may PULL (transferFrom into the platform wallet): the seat key, and a
 * dedicated campaign spender. Two keys, two spenders, so an allowance granted
 * to one can never be spent by the other path (campaign-engine.js pullSigner).
 */
export const PULL_SIGNERS = new Set(['pull', 'campaignPull']);
/**
 * Pull slots whose transferFrom is signed locally and its hash recorded
 * (PULL_SENT) BEFORE the raw transaction is sent. Only the campaign spender
 * for now: a campaign budget is one large pull whose loss would double-charge
 * a creator on retry, and that path is not live until CAMPAIGN_FUNDING=1. The
 * seat tick pull (live, small, one ref per tick, never retried) keeps
 * writeContract until this path has been seen on chain (DECISIONS.md).
 */
export const SIGN_AHEAD_SLOTS = ['campaignPull'];
/**
 * Pull slots that run ONE pull at a time (cold review B1, 2026-10-23): prepare
 * (which reads the spender's nonce), PULL_SENT and the send happen under a
 * per-slot lock, so two campaign funds can never sign the same nonce. Only the
 * campaign spender: the `pull` slot is the live seat meter's, whose per-tick
 * pulls keep their existing behaviour (writeContract, not serialized here).
 */
export const SERIAL_PULL_SLOTS = ['campaignPull'];
/**
 * After a send the node accepted with nonce n, the next pull on that slot signs
 * with at least n + 1 for this long, even if the node it reaches (a load-
 * balanced RPC) has not seen n yet. Past it the chain's pending count decides
 * alone, so a transaction the mempool dropped cannot leave a permanent gap.
 */
export const NONCE_FLOOR_TTL_MS = 120_000;

const big = (v) => BigInt(v ?? 0);
/** Tag an error thrown before any transaction was signed for sending: it provably moved nothing. */
const markPreSend = (e) => { const err = e instanceof Error ? e : new Error(String(e)); try { err.preSend = true; } catch { /* frozen */ } return err; };
const same =(a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

/**
 * The production chain adapter: viem wallet clients per signer slot, one
 * public client for receipts. Everything on-chain the server ever does is
 * one of the four methods below.
 */
export function viemChainAdapter({ pull = null, platform = null, rewardPool = null, campaignPull = null, publicClient = null, receiptTimeoutMs = 60_000, signAheadSlots = SIGN_AHEAD_SLOTS } = {}) {
  const wallets = { pull, platform, rewardPool, campaignPull };
  const ahead = new Set(signAheadSlots);
  return {
    has(slot) { return !!wallets[slot]; },
    /**
     * Sign a transferFrom LOCALLY and hand back its hash before anything is
     * broadcast, so the door can record the hash first (PULL_SENT) and a send
     * that throws after reaching the node can never lose it. Exactly the
     * steps writeContract takes for a local account (prepare → sign →
     * sendRawTransaction), split at the point the hash is known; the hash is
     * keccak256 of the signed envelope, which is what the node returns
     * (_gate-campaigns C10.N checks both against a node stand-in). null when
     * this slot does not sign ahead: the caller falls back to transferFrom.
     */
    async prepareTransferFrom({ signer = 'pull', token, from, to, amountAtomic, minNonce = null }) {
      if (!PULL_SIGNERS.has(signer)) throw new Error(`unknown pull signer: ${signer}`);
      const w = wallets[signer];
      if (!w) throw new Error(`no ${signer} signer`);
      if (!ahead.has(signer) || !w.account?.signTransaction) return null;
      // The door's nonce floor (one past the last nonce a node accepted from
      // this slot): the pending count on the node this call reaches, but never
      // below the floor. No floor → viem reads the pending count as before.
      let nonce;
      if (minNonce != null) {
        const pending = await getTransactionCount(w, { address: w.account.address, blockTag: 'pending' });
        nonce = Math.max(Number(pending), Number(minNonce));
      }
      const request = await w.prepareTransactionRequest({
        account: w.account, chain: w.chain, to: token.address,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'transferFrom', args: [from, to, big(amountAtomic)] }),
        feeToken: token.address,
        ...(nonce != null ? { nonce } : {}),
      });
      const serializedTransaction = await w.signTransaction({ ...request, account: w.account, chain: w.chain });
      return {
        txHash: keccak256(serializedTransaction),
        // The nonce it was signed with (and Tempo's nonce key, when viem chose a
        // 2D / expiring nonce): what makes "this transaction can no longer land"
        // decidable later (campaign-engine.js droppedPullVerdict).
        nonce: typeof request.nonce === 'number' ? request.nonce : null,
        nonceKey: request.nonceKey != null ? String(request.nonceKey) : null,
        send: () => w.sendRawTransaction({ serializedTransaction }),
      };
    },
    // The fee token is explicit on both transfers and is the token being
    // moved. Our wallets hold USDC.e and no pathUSD; a transfer that left the
    // fee token to the chain's default failed on mainnet with "insufficient
    // funds … have 0" (Session 2). The wallet clients must be built on viem's
    // Tempo chain for the field to reach the wire — server.js does that.
    async transferFrom({ signer = 'pull', token, from, to, amountAtomic }) {
      if (!PULL_SIGNERS.has(signer)) throw new Error(`unknown pull signer: ${signer}`);
      const w = wallets[signer];
      if (!w) throw new Error(`no ${signer} signer`);
      return w.writeContract({
        address: token.address, abi: erc20Abi, functionName: 'transferFrom',
        args: [from, to, big(amountAtomic)], feeToken: token.address,
      });
    },
    async transfer({ signer, token, to, amountAtomic }) {
      const w = wallets[signer];
      if (!w) throw new Error(`no ${signer} signer`);
      return w.writeContract({
        address: token.address, abi: erc20Abi, functionName: 'transfer',
        args: [to, big(amountAtomic)], feeToken: token.address,
      });
    },
    async settleChannel({ store, walletClient, channelId, account, feeToken }) {
      // feeToken must be explicit: the method-level feeToken only covers
      // SCHEDULED settlements, and the resolver otherwise prefers the chain
      // default fee token, which this account may not hold (mainnet lesson).
      return mppTempo.session.settle(store, walletClient, channelId, { account, feeToken });
    },
    async receipt(txHash) {
      if (!publicClient) return null;
      try {
        const r = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: receiptTimeoutMs });
        return { status: r.status === 'success' ? 'success' : 'reverted', blockNumber: r.blockNumber?.toString?.() ?? null };
      } catch {
        return null; // not yet mined, or unreachable — try again next flush
      }
    },
  };
}

export function createSettlement({ dataDir = DEFAULT_DATA_DIR, chain = null, platformAddress = null, log = console } = {}) {
  const ledger = createLedger({ filePath: path.join(dataDir, 'settlement.jsonl'), kind: 'settlement' });
  let busy = false;

  function fold() {
    const byRef = new Map();
    for (const r of ledger.all()) {
      if (!r.ref) continue;
      let rec = byRef.get(r.ref);
      if (!rec) { rec = { ref: r.ref, status: null, rows: [] }; byRef.set(r.ref, rec); }
      rec.rows.push(r);
      if (r.type === 'INTENT') { Object.assign(rec, { kind: r.kind, signer: r.signer, token: r.token, to: r.to, amountAtomic: r.amountAtomic, meta: r.meta || null, intendedAt: r.at }); rec.status = 'PENDING'; }
      if (r.type === 'RETAINED') rec.status = 'RETAINED';
      if (r.type === 'SENT') { rec.status = 'SENT'; rec.txHash = r.txHash; rec.sentAt = r.at; }
      if (r.type === 'DONE') { rec.status = 'DONE'; rec.txHash = r.txHash; rec.doneAt = r.at; }
      if (r.type === 'FAILED') { rec.status = 'FAILED'; rec.error = r.error; }
      if (r.type === 'PULL_SENT') { rec.status = 'PULL_SENT'; rec.txHash = r.txHash; rec.kind = 'pull'; rec.amountAtomic = r.amountAtomic; rec.sentAt = r.at; rec.signer = r.signer; rec.nonce = r.nonce ?? null; rec.nonceKey = r.nonceKey ?? null; }
      // The hash WE signed stays the record's hash: a PULL row's txHash is the
      // signed hash (cold review B5); what the node answered is nodeHash only.
      if (r.type === 'PULL') { rec.status = r.dry ? 'PULLED_DRY' : 'PULLED'; rec.txHash = r.signedHash || r.txHash || rec.txHash || null; rec.kind = 'pull'; rec.amountAtomic = r.amountAtomic; rec.signer = r.signer; if (r.nodeHash) rec.nodeHash = r.nodeHash; }
      if (r.type === 'CHANNEL_SETTLE') { rec.status = 'DONE'; rec.txHash = r.txHash; rec.kind = 'channel-settle'; }
    }
    return byRef;
  }

  const status = (ref) => fold().get(ref) || null;
  const hasSigner = (slot) => !!(chain && chain.has && chain.has(slot));

  /**
   * Record that an outbound transfer is owed. Synchronous and idempotent on
   * `ref`. A payee that IS the platform wallet retains the money instead —
   * a room with no payout address is paid by not moving anything.
   */
  function enqueue({ kind, signer = 'platform', token, to, amountAtomic, amount, ref, meta = null }) {
    if (!INTENT_KINDS.has(kind)) throw new Error(`unknown intent kind: ${kind}`);
    if (!SIGNERS.has(signer)) throw new Error(`unknown signer: ${signer}`);
    if (!ref) throw new Error('an intent requires a ref — a transfer with no ref is a transfer nobody can account for');
    if (!token || token.decimals == null) throw new Error(`intent ${ref} has no token`);
    const atomic = amountAtomic != null ? big(amountAtomic) : toAtomic(String(amount), token.decimals);
    const existing = status(ref);
    if (existing) return { row: existing.rows[0], deduped: true, retained: existing.status === 'RETAINED', status: existing.status };
    if (atomic <= 0n) {
      const row = ledger.append({ type: 'RETAINED', ref, kind, signer, why: 'zero amount', at: Date.now() });
      return { row, deduped: false, retained: true, status: 'RETAINED' };
    }
    // E43 — a token with no address is off-chain credit (earned USDC credit or
    // points): nothing in the platform wallet backs it, so the intent is
    // recorded and retained, never signed.
    if (!token.address) {
      const row = ledger.append({ type: 'RETAINED', ref, kind, signer, token: { address: null, decimals: token.decimals, symbol: token.symbol || null }, to: to || null, amountAtomic: atomic.toString(), why: 'off-chain credit — no token address, nothing in the platform wallet to move', meta, at: Date.now() });
      return { row, deduped: false, retained: true, status: 'RETAINED' };
    }
    if (!to || (signer === 'platform' && same(to, platformAddress))) {
      const row = ledger.append({ type: 'RETAINED', ref, kind, signer, token, to: to || null, amountAtomic: atomic.toString(), why: to ? 'payee is the platform wallet' : 'no payee', meta, at: Date.now() });
      return { row, deduped: false, retained: true, status: 'RETAINED' };
    }
    const row = ledger.append({ type: 'INTENT', ref, kind, signer, token: { address: token.address, decimals: token.decimals, symbol: token.symbol || null }, to, amountAtomic: atomic.toString(), meta, at: Date.now() });
    return { row, deduped: false, retained: false, status: 'PENDING' };
  }

  /** StubSettlement-compatible names, so seat-escrow needs no branching. */
  function release({ to, amount, amountAtomic, bucket = 'streamer', ref, token, signer = 'platform', meta = null }) {
    return enqueue({ kind: 'release', signer, token, to, amount, amountAtomic, ref, meta: { ...(meta || {}), bucket } });
  }
  function refund({ to, amount, amountAtomic, ref, token, signer = 'platform', meta = null }) {
    return enqueue({ kind: 'refund', signer, token, to, amount, amountAtomic, ref, meta });
  }

  /**
   * The per-tick pull: viewer → platform wallet, by the allowance the viewer
   * approved. Executes immediately (the tick loop awaits it) and records one
   * row after the fact, or a DRY row when no pull signer is configured — the
   * same shape the meter has always had without a key.
   */
  // One in-flight pull per SERIAL_PULL_SLOTS slot: the tail of a promise chain.
  const slotTails = new Map();
  async function withSlotLock(slot, fn) {
    const prev = slotTails.get(slot) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const tail = prev.then(() => mine);
    slotTails.set(slot, tail);
    await prev;
    try { return await fn(); } finally {
      release();
      if (slotTails.get(slot) === tail) slotTails.delete(slot);
    }
  }
  // Per-slot nonce floor {nonce, at}: one past the last nonce a node ACCEPTED
  // (a send that threw does not move it). Seeded from the ledger's newest
  // PULL_SENT for the slot, so a restart inside the TTL keeps it.
  const nonceFloors = new Map();
  function nonceFloor(slot) {
    if (!nonceFloors.has(slot)) {
      let seed = null;
      const rows = ledger.all();
      const accepted = new Set(rows.filter((x) => x.type === 'PULL' && x.signer === slot).map((x) => x.ref));
      for (const r of rows) {
        if (r.type !== 'PULL_SENT' || r.signer !== slot || typeof r.nonce !== 'number' || r.nonceKey || !accepted.has(r.ref)) continue;
        if (!seed || r.nonce + 1 > seed.nonce) seed = { nonce: r.nonce + 1, at: r.at };
      }
      nonceFloors.set(slot, seed);
    }
    const f = nonceFloors.get(slot);
    return f && Date.now() - f.at < NONCE_FLOOR_TTL_MS ? f.nonce : null;
  }

  async function pull(args) {
    const signer = args?.signer || 'pull';
    if (SERIAL_PULL_SLOTS.includes(signer)) return withSlotLock(signer, () => pullNow(args));
    return pullNow(args);
  }

  async function pullNow({ from, to, token, amountAtomic, ref, signer = 'pull', meta = null }) {
    if (!ref) throw new Error('a pull requires a ref');
    if (!PULL_SIGNERS.has(signer)) throw new Error(`unknown pull signer: ${signer}`);
    const existing = status(ref);
    if (existing) return { row: existing.rows[0], deduped: true, txHash: existing.txHash || null, dry: existing.status === 'PULLED_DRY' };
    if (!hasSigner(signer)) {
      const row = ledger.append({ type: 'PULL', ref, signer, from, to, token, amountAtomic: big(amountAtomic).toString(), txHash: null, dry: true, meta, at: Date.now() });
      return { row, deduped: false, txHash: null, dry: true };
    }
    // Sign ahead where the adapter can: the hash is on the ledger (PULL_SENT)
    // before the raw transaction leaves, so a send that times out AFTER the
    // node took it still leaves `status(ref).txHash`, and the receipt decides.
    // Anything thrown before that row is written is pre-send (preSend: true):
    // nothing was signed for the chain, nothing can land.
    let prepared = null;
    const serial = SERIAL_PULL_SLOTS.includes(signer);
    if (typeof chain.prepareTransferFrom === 'function') {
      const minNonce = serial ? nonceFloor(signer) : null;
      try { prepared = await chain.prepareTransferFrom({ signer, token, from, to, amountAtomic: big(amountAtomic), ...(minNonce != null ? { minNonce } : {}) }); }
      catch (e) { throw markPreSend(e); }
    }
    if (prepared?.txHash) {
      const nonce = typeof prepared.nonce === 'number' ? prepared.nonce : null;
      ledger.append({ type: 'PULL_SENT', ref, signer, from, to, token, amountAtomic: big(amountAtomic).toString(), txHash: prepared.txHash, nonce, nonceKey: prepared.nonceKey ?? null, meta, at: Date.now() });
      const sent = await prepared.send();   // a throw here leaves PULL_SENT: reconciled by receipt, never re-sent
      if (serial && nonce != null && !prepared.nonceKey) nonceFloors.set(signer, { nonce: nonce + 1, at: Date.now() });
      // The record keeps the hash WE signed (cold review B5): a node or proxy
      // answering with another transaction's hash must not make that
      // transaction's receipt decide this pull. The answer is kept beside it.
      const nodeHash = sent && String(sent).toLowerCase() !== String(prepared.txHash).toLowerCase() ? String(sent) : null;
      if (nodeHash) log.error?.(`[settlement] ${ref}: the node returned ${nodeHash} for a transaction signed as ${prepared.txHash} — the signed hash is the one on record`);
      const txHash = prepared.txHash;
      const row = ledger.append({ type: 'PULL', ref, signer, from, to, token, amountAtomic: big(amountAtomic).toString(), txHash, signedHash: prepared.txHash, ...(nodeHash ? { nodeHash } : {}), nonce, dry: false, meta, at: Date.now() });
      return { row, deduped: false, txHash, dry: false };
    }
    const txHash = await chain.transferFrom({ signer, token, from, to, amountAtomic: big(amountAtomic) });
    const row = ledger.append({ type: 'PULL', ref, signer, from, to, token, amountAtomic: big(amountAtomic).toString(), txHash, dry: false, meta, at: Date.now() });
    return { row, deduped: false, txHash, dry: false };
  }

  /** The MPP channel settle. Idempotent on ref; the SDK does the signing. */
  async function settleChannel({ channelId, ref, store, walletClient, account, feeToken, meta = null }) {
    if (!ref) throw new Error('a channel settle requires a ref');
    const existing = status(ref);
    if (existing) return { row: existing.rows[0], deduped: true, txHash: existing.txHash || null };
    if (!chain?.settleChannel) throw new Error('no chain adapter for channel settlement');
    const txHash = await chain.settleChannel({ store, walletClient, channelId, account, feeToken });
    const row = ledger.append({ type: 'CHANNEL_SETTLE', ref, channelId, txHash: txHash || null, meta, at: Date.now() });
    return { row, deduped: false, txHash };
  }

  /**
   * Execute what is owed. One intent at a time, never two in flight — one
   * nonce stream per signer. A SENT row with no DONE is reconciled by receipt
   * first and is never re-sent. Missing signer: the intent stays PENDING.
   */
  async function flush({ max = 50 } = {}) {
    const out = { sent: [], done: [], failed: [], skipped: 0, reconciled: 0 };
    if (busy) return { ...out, busy: true };
    busy = true;
    try {
      const recs = [...fold().values()];
      // 1. reconcile anything submitted but not yet confirmed
      for (const rec of recs.filter((r) => r.status === 'SENT')) {
        const rcpt = chain?.receipt ? await chain.receipt(rec.txHash) : null;
        if (!rcpt) continue;
        if (rcpt.status === 'success') {
          ledger.append({ type: 'DONE', ref: rec.ref, txHash: rec.txHash, blockNumber: rcpt.blockNumber ?? null, at: Date.now() });
          out.done.push(rec.ref); out.reconciled += 1;
        } else {
          ledger.append({ type: 'FAILED', ref: rec.ref, txHash: rec.txHash, error: 'reverted', at: Date.now() });
          out.failed.push(rec.ref); out.reconciled += 1;
        }
      }
      // 2. send what is pending, oldest first
      const pending = recs.filter((r) => r.status === 'PENDING').sort((a, b) => a.intendedAt - b.intendedAt).slice(0, max);
      for (const rec of pending) {
        if (!hasSigner(rec.signer)) { out.skipped += 1; continue; }
        let txHash;
        try {
          txHash = await chain.transfer({ signer: rec.signer, token: rec.token, to: rec.to, amountAtomic: big(rec.amountAtomic) });
        } catch (e) {
          ledger.append({ type: 'FAILED', ref: rec.ref, error: e?.shortMessage || e?.message || String(e), at: Date.now() });
          out.failed.push(rec.ref);
          log.warn?.(`[settlement] ${rec.ref}: send failed — ${e?.shortMessage || e?.message}`);
          continue;
        }
        ledger.append({ type: 'SENT', ref: rec.ref, txHash, at: Date.now() });
        out.sent.push(rec.ref);
        log.log?.(`[settlement] ${rec.ref}: sent ${rec.amountAtomic} atomic → ${rec.to} (tx ${txHash})`);
        const rcpt = chain?.receipt ? await chain.receipt(txHash) : null;
        if (rcpt?.status === 'success') { ledger.append({ type: 'DONE', ref: rec.ref, txHash, blockNumber: rcpt.blockNumber ?? null, at: Date.now() }); out.done.push(rec.ref); }
        else if (rcpt?.status === 'reverted') { ledger.append({ type: 'FAILED', ref: rec.ref, txHash, error: 'reverted', at: Date.now() }); out.failed.push(rec.ref); }
        // no receipt yet: stays SENT, reconciled next flush
      }
    } finally {
      busy = false;
    }
    return out;
  }

  function summary() {
    const counts = {};
    for (const rec of fold().values()) counts[rec.status] = (counts[rec.status] || 0) + 1;
    return { counts, signers: { pull: hasSigner('pull'), campaignPull: hasSigner('campaignPull'), platform: hasSigner('platform'), rewardPool: hasSigner('rewardPool') }, platformAddress };
  }

  return {
    enqueue, release, refund, pull, settleChannel, flush,
    status, hasSigner, summary,
    pending: () => [...fold().values()].filter((r) => r.status === 'PENDING'),
    all: () => [...fold().values()],
    intentsFor: (prefix) => [...fold().values()].filter((r) => r.ref.startsWith(prefix)),
    /** StubSettlement compatibility for callers that inspect intents. */
    pending_: () => ledger.all().filter((r) => r.type === 'INTENT'),
    _ledger: ledger,
    _resetForTests() { ledger._reset(); busy = false; },
  };
}
