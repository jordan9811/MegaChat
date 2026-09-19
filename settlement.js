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
 *   PULL            a per-tick transferFrom, recorded after it landed (or dry)
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
import { erc20Abi } from 'viem';
import { tempo as mppTempo } from 'mppx/server';
import { createLedger } from './bounty-ledger.js';
import { toAtomic } from './token-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

export const INTENT_KINDS = new Set(['release', 'refund']);
export const SIGNERS = new Set(['platform', 'rewardPool']);

const big = (v) => BigInt(v ?? 0);
const same = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

/**
 * The production chain adapter: viem wallet clients per signer slot, one
 * public client for receipts. Everything on-chain the server ever does is
 * one of the four methods below.
 */
export function viemChainAdapter({ pull = null, platform = null, rewardPool = null, publicClient = null, receiptTimeoutMs = 60_000 } = {}) {
  const wallets = { pull, platform, rewardPool };
  return {
    has(slot) { return !!wallets[slot]; },
    // The fee token is explicit on both transfers and is the token being
    // moved. Our wallets hold USDC.e and no pathUSD; a transfer that left the
    // fee token to the chain's default failed on mainnet with "insufficient
    // funds … have 0" (Session 2). The wallet clients must be built on viem's
    // Tempo chain for the field to reach the wire — server.js does that.
    async transferFrom({ token, from, to, amountAtomic }) {
      if (!wallets.pull) throw new Error('no pull signer');
      return wallets.pull.writeContract({
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
      if (r.type === 'PULL') { rec.status = r.dry ? 'PULLED_DRY' : 'PULLED'; rec.txHash = r.txHash; rec.kind = 'pull'; rec.amountAtomic = r.amountAtomic; }
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
  async function pull({ from, to, token, amountAtomic, ref, meta = null }) {
    if (!ref) throw new Error('a pull requires a ref');
    const existing = status(ref);
    if (existing) return { row: existing.rows[0], deduped: true, txHash: existing.txHash || null, dry: existing.status === 'PULLED_DRY' };
    if (!hasSigner('pull')) {
      const row = ledger.append({ type: 'PULL', ref, from, to, token, amountAtomic: big(amountAtomic).toString(), txHash: null, dry: true, meta, at: Date.now() });
      return { row, deduped: false, txHash: null, dry: true };
    }
    const txHash = await chain.transferFrom({ token, from, to, amountAtomic: big(amountAtomic) });
    const row = ledger.append({ type: 'PULL', ref, from, to, token, amountAtomic: big(amountAtomic).toString(), txHash, dry: false, meta, at: Date.now() });
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
    return { counts, signers: { pull: hasSigner('pull'), platform: hasSigner('platform'), rewardPool: hasSigner('rewardPool') }, platformAddress };
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
