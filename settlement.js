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
 * and it is one intent; flush twice and it is one transfer. An outbound
 * transfer is SIGNED LOCALLY and its hash recorded (SENT) BEFORE the raw
 * transaction leaves (SIGN_AHEAD_OUT, money-3): kill the process mid-send, or
 * lose the node's answer, and the SENT row is reconciled by that hash's
 * receipt rather than sent again or marked failed. Amounts arrive from the
 * seat ledger, the letters queue and the rewards meter as ledger-derived
 * numbers — nothing here reads a live balance to decide what to move.
 *
 * ── Slots and accounts ────────────────────────────────────────────────────
 * PULL   `SELLER_PRIVATE_KEY` — the spender the viewer approved. A direct
 *        seat's tick pulls viewer → the streamer's payout address, never the
 *        platform wallet (Session 2; server.js `tickPasskeyStreamSeat`); an
 *        escrow seat's tick is a ledger row, not a pull. Already live before
 *        this module existed.
 * PAYOUT `PLATFORM_SETTLEMENT_KEY` — moves money OUT of the platform wallet:
 *        streamer shares, holdback releases, refunds, clawbacks, campaign
 *        payouts. Unset, outbound intents are recorded and stay PENDING;
 *        nothing is lost, and the first flush after the key lands pays it.
 *        server.js enables it only when it resolves to SELLER_WALLET_ADDRESS
 *        (campaign budgets are pulled there) — and a direct pull works only
 *        when SELLER_PRIVATE_KEY is that same address. So in any working
 *        configuration PULL and PAYOUT are ONE ACCOUNT with ONE nonce
 *        stream (money-7): every send here takes that ACCOUNT's lock, not the
 *        slot's, from prepare to send.
 * REWARD `REWARD_POOL_PRIVATE_KEY` — a separate wallet. The door refuses to use
 *        it (hasSigner false, logged by name) when it resolves to the platform
 *        wallet or another slot's account: an open reward faucet must never
 *        reach the platform wallet (N4).
 *
 * ── When a money ledger is damaged ────────────────────────────────────────
 * The ledger latches (bounty-ledger.js). If this door's own ledger, the seat
 * ledger or the escrow ledger in the same data directory is latched, the door
 * sends, pulls and settles nothing, says so once, and /api/health shows why.
 *
 * ── Row types in data/settlement.jsonl ────────────────────────────────────
 *   INTENT          an outbound transfer is owed (kind, signer, token, to, amount, ref)
 *   RETAINED        nothing to move: the payee IS the platform wallet, the amount
 *                   is zero, or the token has no address (off-chain credit, points)
 *   SENT            signed, hash (and nonce) recorded, then sent; receipt not yet
 *                   seen. signedAhead rows were written BEFORE the send.
 *   DONE            a receipt FOR THAT HASH seen, success
 *   FAILED          receipt reverted; or refused before anything was signed
 *                   (preSend: true); or 'dropped': the account's mined nonce
 *                   passed ours and no node knows the hash, a TTL after the send.
 *                   Terminal for automation.
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
import { createLedger, corruptMoneyLedger } from './bounty-ledger.js';
import { toAtomic, sameAddress as same } from './token-utils.js';

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
 * Outbound slots whose transfer is signed locally and recorded SENT (with its
 * hash and nonce) BEFORE the raw transaction is sent (money-3, 2026-10-24).
 * Before this, flush recorded SENT only after writeContract returned: a lost
 * answer was recorded FAILED for money that moved, and a redeploy mid-send
 * paid the same ref twice. Undo: [] (DECISIONS.md) — the adapter then falls
 * back to writeContract and the old order. The tick pull (`pull`) stays on
 * writeContract until sign-ahead has been seen on chain (OPEN-ISSUES N18).
 */
export const SIGN_AHEAD_OUT = ['platform', 'rewardPool'];
/**
 * After a send the node accepted with nonce n, the next signed-ahead send
 * from that ACCOUNT signs with at least n + 1 for this long, even if the node
 * it reaches (a load-balanced RPC) has not seen n yet. Past it the chain's
 * pending count decides alone, so a transaction the mempool dropped cannot
 * leave a permanent gap. Also the age after which a signed-ahead SENT row
 * with no receipt may be judged dropped.
 */
export const NONCE_FLOOR_TTL_MS = 120_000;
/** The env var each slot's key comes from, for logs that must name it. Names only. */
const SLOT_ENV = { pull: 'SELLER_PRIVATE_KEY', platform: 'PLATFORM_SETTLEMENT_KEY', rewardPool: 'REWARD_POOL_PRIVATE_KEY', campaignPull: 'CAMPAIGN_SPENDER_KEY' };

const big = (v) => BigInt(v ?? 0);
/** Tag an error thrown before any transaction was signed for sending: it provably moved nothing. */
const markPreSend = (e) => { const err = e instanceof Error ? e : new Error(String(e)); try { err.preSend = true; } catch { /* frozen */ } return err; };
const errText = (e) => e?.shortMessage || e?.message || String(e);

/**
 * The production chain adapter: viem wallet clients per signer slot, one
 * public client for receipts and nonces. Every on-chain write the server
 * makes is one of the methods below.
 */
export function viemChainAdapter({ pull = null, platform = null, rewardPool = null, campaignPull = null, publicClient = null, receiptTimeoutMs = 60_000, signAheadSlots = SIGN_AHEAD_SLOTS, signAheadOut = SIGN_AHEAD_OUT } = {}) {
  const wallets = { pull, platform, rewardPool, campaignPull };
  const ahead = new Set([...signAheadSlots, ...signAheadOut]);

  /**
   * Prepare and sign LOCALLY, returning the hash before anything is broadcast,
   * so the door can record it first and a send that throws after reaching the
   * node can never lose it. Exactly the steps writeContract takes for a local
   * account (prepare → sign → sendRawTransaction), split where the hash is
   * known; the hash is keccak256 of the signed envelope, which is what the
   * node returns (_gate-campaigns C10.N and _gate-money R5 check both against
   * a node stand-in). The fee token is the token moved (E38/E49).
   */
  async function signAhead(w, { tokenAddress, data, minNonce }) {
    // The door's nonce floor: the pending count on the node this call
    // reaches, but never below the floor. No floor → viem reads the pending
    // count as before.
    let nonce;
    if (minNonce != null) {
      const pending = await getTransactionCount(w, { address: w.account.address, blockTag: 'pending' });
      nonce = Math.max(Number(pending), Number(minNonce));
    }
    const request = await w.prepareTransactionRequest({
      account: w.account, chain: w.chain, to: tokenAddress, data, feeToken: tokenAddress,
      ...(nonce != null ? { nonce } : {}),
    });
    const serializedTransaction = await w.signTransaction({ ...request, account: w.account, chain: w.chain });
    return {
      txHash: keccak256(serializedTransaction),
      // The nonce it was signed with (and Tempo's nonce key, when viem chose a
      // 2D / expiring nonce): what makes "this transaction can no longer land"
      // decidable later (the dropped verdict, campaign-engine.js droppedPullVerdict).
      nonce: typeof request.nonce === 'number' ? request.nonce : null,
      nonceKey: request.nonceKey != null ? String(request.nonceKey) : null,
      send: () => w.sendRawTransaction({ serializedTransaction }),
    };
  }
  const canSignAhead = (slot) => ahead.has(slot) && !!wallets[slot]?.account?.signTransaction;

  return {
    has(slot) { return !!wallets[slot]; },
    /** The address a slot signs as, or null. What the door locks and compares by. */
    address(slot) { return wallets[slot]?.account?.address || null; },
    /** A transferFrom signed ahead (PULL_SENT), or null when the slot does not sign ahead: the caller falls back to transferFrom. */
    async prepareTransferFrom({ signer = 'pull', token, from, to, amountAtomic, minNonce = null }) {
      if (!PULL_SIGNERS.has(signer)) throw new Error(`unknown pull signer: ${signer}`);
      const w = wallets[signer];
      if (!w) throw new Error(`no ${signer} signer`);
      if (!canSignAhead(signer)) return null;
      return signAhead(w, { tokenAddress: token.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transferFrom', args: [from, to, big(amountAtomic)] }), minNonce });
    },
    /** An outbound transfer signed ahead (SENT before the send), or null: the caller falls back to transfer. */
    async prepareTransfer({ signer, token, to, amountAtomic, minNonce = null }) {
      const w = wallets[signer];
      if (!w) throw new Error(`no ${signer} signer`);
      if (!canSignAhead(signer)) return null;
      return signAhead(w, { tokenAddress: token.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, big(amountAtomic)] }), minNonce });
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
    /**
     * The receipt FOR THIS HASH, or null (not mined, unknown, unreachable).
     * viem's replacement check is OFF and the hash must match (money-6, the
     * campaign confirmer's cold review B1): with it on, a different
     * transaction from the same account that took our nonce came back as OUR
     * success, and a transfer that never mined was recorded DONE.
     * `wait: false` asks once instead of waiting: the reconcile pass must not
     * spend receiptTimeoutMs on every stuck row before anything new is sent.
     */
    async receipt(txHash, { wait = true } = {}) {
      if (!publicClient) return null;
      try {
        const r = wait
          ? await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: receiptTimeoutMs, checkReplacement: false })
          : await publicClient.getTransactionReceipt({ hash: txHash });
        if (!r || !same(r.transactionHash, txHash)) return null;
        return { status: r.status === 'success' ? 'success' : 'reverted', blockNumber: r.blockNumber?.toString?.() ?? null };
      } catch {
        return null; // not yet mined, or unreachable — try again next flush
      }
    },
    /** The slot account's MINED nonce count (blockTag latest). Throws when it cannot tell. */
    async minedNonce(slot) {
      const a = wallets[slot]?.account?.address;
      if (!publicClient || !a) throw new Error(`no public client or no ${slot} signer`);
      return Number(await publicClient.getTransactionCount({ address: a, blockTag: 'latest' }));
    },
    /** Whether the node knows a transaction at all (mined or pending). Throws when it cannot tell. */
    async txKnown(txHash) {
      if (!publicClient) throw new Error('no public client');
      try { return !!(await publicClient.getTransaction({ hash: txHash })); }
      catch (e) { if (e?.name === 'TransactionNotFoundError') return false; throw e; }
    },
  };
}

/**
 * `otherSigners` maps an env var NAME to the address its key resolves to
 * (token-utils.js signerAddress), for keys this door does not hold — the
 * escrow operator and attester — so the reward-pool guard can see them too.
 */
export function createSettlement({ dataDir = DEFAULT_DATA_DIR, chain = null, platformAddress = null, otherSigners = {}, log = console } = {}) {
  const ledger = createLedger({ filePath: path.join(dataDir, 'settlement.jsonl'), kind: 'settlement', log });
  let busy = false;

  // ── the folded view, advanced incrementally (stores-4) ────────────────────
  // This door is the only writer of its ledger and the ledger only grows, so
  // each row is folded once. A reloaded ledger is a new rows array: refold.
  // Before this, every status() — so every enqueue, every tick pull — walked
  // the whole ledger: 21 ms at 100k rows, one row per paid seat-second.
  let view = null; // { rows, through, byRef, open: {PENDING, SENT}, counts }
  function applyRow(v, r) {
    if (!r.ref) return;
    let rec = v.byRef.get(r.ref);
    if (!rec) { rec = { ref: r.ref, status: null, rows: [] }; v.byRef.set(r.ref, rec); }
    const was = rec.status;
    rec.rows.push(r);
    if (r.type === 'INTENT') { Object.assign(rec, { kind: r.kind, signer: r.signer, token: r.token, to: r.to, amountAtomic: r.amountAtomic, meta: r.meta || null, intendedAt: r.at }); rec.status = 'PENDING'; }
    if (r.type === 'RETAINED') rec.status = 'RETAINED';
    if (r.type === 'SENT') { rec.status = 'SENT'; rec.txHash = r.txHash; rec.sentAt = r.at; rec.nonce = r.nonce ?? null; rec.nonceKey = r.nonceKey ?? null; rec.signedAhead = !!r.signedAhead; }
    if (r.type === 'DONE') { rec.status = 'DONE'; rec.txHash = r.txHash; rec.doneAt = r.at; }
    if (r.type === 'FAILED') { rec.status = 'FAILED'; rec.error = r.error; }
    if (r.type === 'PULL_SENT') { rec.status = 'PULL_SENT'; rec.txHash = r.txHash; rec.kind = 'pull'; rec.amountAtomic = r.amountAtomic; rec.sentAt = r.at; rec.signer = r.signer; rec.nonce = r.nonce ?? null; rec.nonceKey = r.nonceKey ?? null; }
    // The hash WE signed stays the record's hash: a PULL row's txHash is the
    // signed hash (cold review B5); what the node answered is nodeHash only.
    if (r.type === 'PULL') { rec.status = r.dry ? 'PULLED_DRY' : 'PULLED'; rec.txHash = r.signedHash || r.txHash || rec.txHash || null; rec.kind = 'pull'; rec.amountAtomic = r.amountAtomic; rec.signer = r.signer; if (r.nodeHash) rec.nodeHash = r.nodeHash; }
    if (r.type === 'CHANNEL_SETTLE') { rec.status = 'DONE'; rec.txHash = r.txHash; rec.kind = 'channel-settle'; }
    if (was !== rec.status) {
      if (was) { v.counts[was] -= 1; v.open[was]?.delete(rec.ref); }
      if (rec.status) { v.counts[rec.status] = (v.counts[rec.status] || 0) + 1; v.open[rec.status]?.add(rec.ref); }
    }
  }
  function sync() {
    const rows = ledger.all();
    if (!view || view.rows !== rows || rows.length < view.through) {
      view = { rows, through: 0, byRef: new Map(), open: { PENDING: new Set(), SENT: new Set() }, counts: {} };
    }
    for (; view.through < rows.length; view.through++) applyRow(view, rows[view.through]);
    return view;
  }
  // Callers get a copy of a record's fields as of the call (a full fold used
  // to hand out a fresh object); its rows array is shared and only grows.
  const copy = (rec) => (rec ? { ...rec } : null);
  const status = (ref) => copy(sync().byRef.get(ref));
  const records = (refs) => [...refs].map((ref) => view.byRef.get(ref));

  // ── what may not sign ─────────────────────────────────────────────────────
  // N4: the reward pool is an open faucet by design (watch-to-earn). If its key
  // resolves to the platform wallet or another slot's account, it would pay
  // rewards out of seat money and campaign budgets. Refused here, by name, so
  // the server still boots and every other slot still works.
  const disabled = new Set();
  {
    const pool = chain?.address?.('rewardPool');
    if (pool) {
      const others = {
        SELLER_WALLET_ADDRESS: platformAddress,
        [SLOT_ENV.pull]: chain.address('pull'),
        [SLOT_ENV.platform]: chain.address('platform'),
        [SLOT_ENV.campaignPull]: chain.address('campaignPull'),
        ...otherSigners,
      };
      const clash = Object.entries(others).filter(([, a]) => same(a, pool)).map(([n]) => n);
      if (clash.length) {
        disabled.add('rewardPool');
        log.error?.(`[settlement] ${SLOT_ENV.rewardPool} resolves to the same address as ${clash.join(', ')} — reward payouts DISABLED: the reward pool must be its own wallet`);
      }
    }
  }
  const hasSigner = (slot) => !disabled.has(slot) && !!(chain && chain.has && chain.has(slot));

  /**
   * Why this door must not move money right now, or null: its own ledger, or
   * the seat or escrow ledger beside it, is latched corrupt. Said once.
   */
  let haltSaid = false;
  function halted() {
    const err = ledger.corrupt || corruptMoneyLedger(dataDir);
    if (err && !haltSaid) { haltSaid = true; log.error?.(`[settlement] door HALTED — nothing is sent, pulled or settled until a person repairs the ledger: ${err.message}`); }
    return err || null;
  }
  const haltError = (err) => markPreSend(Object.assign(new Error(`settlement door halted: a money ledger is corrupt (${err.message})`), { code: 'money_halted' }));

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

  // ── one send at a time per ACCOUNT (money-7) ──────────────────────────────
  // The pull, payout and (through meter-mpp.js) channel-settle slots are one
  // account in production, so a lock per slot let a tick and a payout sign the
  // same nonce: the node refused one, a refused tick ended the viewer's seat
  // as out_of_funds and a refused payout went FAILED. Every write here takes
  // its account's lock from prepare through send (never through a receipt
  // wait), so a tick queues behind a payout by at most one send.
  const accountKey = (slot) => String(chain?.address?.(slot) || `slot:${slot}`).toLowerCase();
  const tails = new Map();
  async function withLock(key, fn) {
    const prev = tails.get(key) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const tail = prev.then(() => mine);
    tails.set(key, tail);
    await prev;
    try { return await fn(); } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  }
  // Per-account nonce floor {nonce, at}: one past the last nonce a node
  // ACCEPTED from it (a send that threw does not move it). Seeded from the
  // ledger's newest accepted PULL_SENT for the account, so a restart inside
  // the TTL keeps it; outbound sends move it in memory.
  const nonceFloors = new Map();
  function nonceFloor(key) {
    if (!nonceFloors.has(key)) {
      let seed = null;
      const rows = ledger.all();
      const accepted = new Set(rows.filter((x) => x.type === 'PULL' && accountKey(x.signer) === key).map((x) => x.ref));
      for (const r of rows) {
        if (r.type !== 'PULL_SENT' || accountKey(r.signer) !== key || typeof r.nonce !== 'number' || r.nonceKey || !accepted.has(r.ref)) continue;
        if (!seed || r.nonce + 1 > seed.nonce) seed = { nonce: r.nonce + 1, at: r.at };
      }
      nonceFloors.set(key, seed);
    }
    const f = nonceFloors.get(key);
    return f && Date.now() - f.at < NONCE_FLOOR_TTL_MS ? f.nonce : null;
  }
  function accepted(key, prepared) {
    if (typeof prepared.nonce === 'number' && !prepared.nonceKey) nonceFloors.set(key, { nonce: prepared.nonce + 1, at: Date.now() });
  }
  // The record keeps the hash WE signed (cold review B5): a node or proxy
  // answering with another transaction's hash must not make that
  // transaction's receipt decide it. The answer is kept beside it.
  function nodeHashOf(ref, sent, signed) {
    const nodeHash = sent && !same(sent, signed) ? String(sent) : null;
    if (nodeHash) log.error?.(`[settlement] ${ref}: the node returned ${nodeHash} for a transaction signed as ${signed} — the signed hash is the one on record`);
    return nodeHash;
  }

  /**
   * A pull by the allowance the payer approved, to the `to` the caller names:
   * a direct seat's tick goes viewer → streamer, a campaign budget
   * (`campaignPull`) creator → platform wallet. Executes immediately (the tick
   * loop awaits it) and records one row after the fact, or a DRY row when no
   * pull signer is configured — the same shape the meter has always had
   * without a key.
   */
  async function pull(args) {
    const err = halted();
    if (err) throw haltError(err);
    return withLock(accountKey(args?.signer || 'pull'), () => pullNow(args));
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
    const key = accountKey(signer);
    if (typeof chain.prepareTransferFrom === 'function') {
      const minNonce = nonceFloor(key);
      try { prepared = await chain.prepareTransferFrom({ signer, token, from, to, amountAtomic: big(amountAtomic), ...(minNonce != null ? { minNonce } : {}) }); }
      catch (e) { throw markPreSend(e); }
    }
    if (prepared?.txHash) {
      const nonce = typeof prepared.nonce === 'number' ? prepared.nonce : null;
      ledger.append({ type: 'PULL_SENT', ref, signer, from, to, token, amountAtomic: big(amountAtomic).toString(), txHash: prepared.txHash, nonce, nonceKey: prepared.nonceKey ?? null, meta, at: Date.now() });
      const sent = await prepared.send();   // a throw here leaves PULL_SENT: reconciled by receipt, never re-sent
      accepted(key, prepared);
      const nodeHash = nodeHashOf(ref, sent, prepared.txHash);
      const txHash = prepared.txHash;
      const row = ledger.append({ type: 'PULL', ref, signer, from, to, token, amountAtomic: big(amountAtomic).toString(), txHash, signedHash: prepared.txHash, ...(nodeHash ? { nodeHash } : {}), nonce, dry: false, meta, at: Date.now() });
      return { row, deduped: false, txHash, dry: false };
    }
    const txHash = await chain.transferFrom({ signer, token, from, to, amountAtomic: big(amountAtomic) });
    const row = ledger.append({ type: 'PULL', ref, signer, from, to, token, amountAtomic: big(amountAtomic).toString(), txHash, dry: false, meta, at: Date.now() });
    return { row, deduped: false, txHash, dry: false };
  }

  /** The MPP channel settle. Idempotent on ref; the SDK does the signing, under the account's lock. */
  async function settleChannel({ channelId, ref, store, walletClient, account, feeToken, meta = null }) {
    if (!ref) throw new Error('a channel settle requires a ref');
    const existing = status(ref);
    if (existing) return { row: existing.rows[0], deduped: true, txHash: existing.txHash || null };
    if (!chain?.settleChannel) throw new Error('no chain adapter for channel settlement');
    const err = halted();
    if (err) throw haltError(err);
    const key = account?.address ? String(account.address).toLowerCase() : 'slot:pull';
    const txHash = await withLock(key, () => chain.settleChannel({ store, walletClient, channelId, account, feeToken }));
    const row = ledger.append({ type: 'CHANNEL_SETTLE', ref, channelId, txHash: txHash || null, meta, at: Date.now() });
    return { row, deduped: false, txHash };
  }

  /**
   * A signed-ahead SENT row with no receipt is DROPPED when, a TTL after the
   * send, the account's mined nonce has passed ours and no node knows the
   * hash: nothing with that nonce can land any more (money-6). An expiring
   * (nonce-key) transaction is never decided this way; it stays SENT for a
   * person (N23). Any doubt, including an RPC that cannot answer, leaves it SENT.
   */
  async function droppedVerdict(rec) {
    if (!rec.signedAhead || rec.nonce == null || rec.nonceKey || !chain?.minedNonce || !chain?.txKnown) return false;
    if (Date.now() - (rec.sentAt || 0) < NONCE_FLOOR_TTL_MS) return false;
    try {
      if ((await chain.minedNonce(rec.signer)) <= rec.nonce) return false;
      return !(await chain.txKnown(rec.txHash));
    } catch { return false; }
  }

  /**
   * One outbound send. Under the account's lock: prepare and sign, record SENT
   * with the hash, then send (sign-ahead), or the legacy writeContract order
   * when the slot does not sign ahead. Returns what happened; the receipt wait
   * is the caller's, outside the lock.
   */
  function sendOne(rec) {
    const key = accountKey(rec.signer);
    return withLock(key, async () => {
      const args = { signer: rec.signer, token: rec.token, to: rec.to, amountAtomic: big(rec.amountAtomic) };
      let prepared = null;
      if (typeof chain.prepareTransfer === 'function') {
        const minNonce = nonceFloor(key);
        try { prepared = await chain.prepareTransfer({ ...args, ...(minNonce != null ? { minNonce } : {}) }); }
        catch (e) { return { failed: markPreSend(e) }; }
      }
      if (prepared?.txHash) {
        ledger.append({ type: 'SENT', ref: rec.ref, txHash: prepared.txHash, nonce: prepared.nonce ?? null, nonceKey: prepared.nonceKey ?? null, signedAhead: true, at: Date.now() });
        let sent;
        try { sent = await prepared.send(); }
        catch (e) { return { txHash: prepared.txHash, sendError: e }; } // stays SENT: the receipt decides, never re-sent
        accepted(key, prepared);
        const nodeHash = nodeHashOf(rec.ref, sent, prepared.txHash);
        return { txHash: prepared.txHash, nodeHash };
      }
      // Legacy order, for a slot that does not sign ahead: a throw here may
      // have reached the node, and is recorded FAILED as it always was.
      let txHash;
      try { txHash = await chain.transfer(args); } catch (e) { return { failed: e }; }
      ledger.append({ type: 'SENT', ref: rec.ref, txHash, at: Date.now() });
      return { txHash };
    });
  }

  /**
   * Execute what is owed. Sends go one at a time, never two in flight from
   * one account. A SENT row is reconciled by ITS receipt, one lookup per row
   * per flush, and is never re-sent. Missing signer: the intent stays PENDING.
   *
   * Pending intents are taken PER SIGNER, oldest first within each, up to
   * `max` each, and interleaved (money-10, N2). Taking the 50 oldest overall
   * let 50 unpayable reward intents (no key) starve every refund behind them
   * forever, and let a reward flood push a viewer's refund back 13 flushes.
   */
  async function flush({ max = 50 } = {}) {
    const out = { sent: [], done: [], failed: [], skipped: 0, reconciled: 0 };
    if (busy) return { ...out, busy: true };
    const stop = halted();
    if (stop) return { ...out, halted: stop.message };
    busy = true;
    try {
      const v = sync();
      // 1. reconcile anything submitted but not yet confirmed
      for (const rec of records(v.open.SENT)) {
        const rcpt = chain?.receipt ? await chain.receipt(rec.txHash, { wait: false }) : null;
        if (rcpt?.status === 'success') {
          ledger.append({ type: 'DONE', ref: rec.ref, txHash: rec.txHash, blockNumber: rcpt.blockNumber ?? null, at: Date.now() });
          out.done.push(rec.ref); out.reconciled += 1;
        } else if (rcpt) {
          ledger.append({ type: 'FAILED', ref: rec.ref, txHash: rec.txHash, error: 'reverted', at: Date.now() });
          out.failed.push(rec.ref); out.reconciled += 1;
        } else if (await droppedVerdict(rec)) {
          ledger.append({ type: 'FAILED', ref: rec.ref, txHash: rec.txHash, error: 'dropped', nonce: rec.nonce, at: Date.now() });
          out.failed.push(rec.ref); out.reconciled += 1;
          log.warn?.(`[settlement] ${rec.ref}: transaction ${rec.txHash} was dropped (nonce ${rec.nonce} is used and no node knows it) — not paid; a person re-issues it`);
        }
      }
      // 2. send what is pending: per signer, oldest first, interleaved
      const lanes = new Map();
      for (const rec of records(v.open.PENDING)) {
        if (!hasSigner(rec.signer)) { out.skipped += 1; continue; }
        if (!lanes.has(rec.signer)) lanes.set(rec.signer, []);
        lanes.get(rec.signer).push(rec);
      }
      const queues = [...lanes.values()].map((l) => l.sort((a, b) => a.intendedAt - b.intendedAt).slice(0, max));
      const order = [];
      for (let i = 0; queues.some((q) => i < q.length); i++) for (const q of queues) if (i < q.length) order.push(q[i]);
      for (const rec of order) {
        const r = await sendOne(rec);
        if (r.failed) {
          ledger.append({ type: 'FAILED', ref: rec.ref, error: errText(r.failed), ...(r.failed.preSend ? { preSend: true } : {}), at: Date.now() });
          out.failed.push(rec.ref);
          log.warn?.(`[settlement] ${rec.ref}: send failed${r.failed.preSend ? ' before signing (nothing sent)' : ''} — ${errText(r.failed)}`);
          continue;
        }
        out.sent.push(rec.ref);
        if (r.sendError) {
          log.warn?.(`[settlement] ${rec.ref}: the send of ${r.txHash} threw (${errText(r.sendError)}) — it may have reached the node; its receipt decides, it is never re-sent`);
          continue;
        }
        log.log?.(`[settlement] ${rec.ref}: sent ${rec.amountAtomic} atomic → ${rec.to} (tx ${r.txHash})`);
        const rcpt = chain?.receipt ? await chain.receipt(r.txHash) : null;
        if (rcpt?.status === 'success') { ledger.append({ type: 'DONE', ref: rec.ref, txHash: r.txHash, blockNumber: rcpt.blockNumber ?? null, at: Date.now() }); out.done.push(rec.ref); }
        else if (rcpt?.status === 'reverted') { ledger.append({ type: 'FAILED', ref: rec.ref, txHash: r.txHash, error: 'reverted', at: Date.now() }); out.failed.push(rec.ref); }
        // no receipt yet: stays SENT, reconciled next flush
      }
    } finally {
      busy = false;
    }
    return out;
  }

  function summary() {
    const counts = Object.fromEntries(Object.entries(sync().counts).filter(([, n]) => n > 0));
    return { counts, signers: { pull: hasSigner('pull'), campaignPull: hasSigner('campaignPull'), platform: hasSigner('platform'), rewardPool: hasSigner('rewardPool') }, platformAddress, halted: halted()?.message || null };
  }

  // Validate at construction (boot) so a damaged ledger latches, and is
  // logged and reported, before the first send rather than at it.
  try { ledger.load(); } catch { /* latched: halted() and ledgerHealth() say so */ }

  return {
    enqueue, release, refund, pull, settleChannel, flush,
    status, hasSigner, summary,
    pending: () => records(sync().open.PENDING).map(copy),
    all: () => [...sync().byRef.values()].map(copy),
    intentsFor: (prefix) => [...sync().byRef.values()].filter((r) => r.ref.startsWith(prefix)).map(copy),
    _ledger: ledger,
    _resetForTests() { ledger._reset(); view = null; busy = false; },
  };
}
