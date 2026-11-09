/**
 * CREATOR BOUNTY — escrow state machine.
 *
 * ⚠ NO FUNDS MOVE IN THIS FILE. This is a state machine over an append-only
 * ledger. Every `settlement?.release` / `settlement?.refund` below reaches
 * the facade in bounty-settlement.js: the record-only stub in ledger-only
 * mode, or bounty-money.js in real-money mode (BOUNTY_FUNDING=1), which
 * records intents on the app's one money door (settlement.js). This module
 * never names a wallet, a key or a chain.
 *
 * Design contract:
 *  - Transitions are validated against ALLOWED_TRANSITIONS. An illegal
 *    transition THROWS an IllegalTransition and writes NOTHING — it must not
 *    silently no-op, because a silent no-op in escrow reads as success to a
 *    caller and diverges the ledger from reality.
 *  - Every legal transition appends exactly one ledger row.
 *  - Anything that could double-release takes an idempotency key. The ledger
 *    dedupes on it, so a retried release is a no-op that returns the ORIGINAL
 *    row rather than a second payout.
 */

import { bountyConfig } from './bounty-claim.config.js';
import * as store from './bounty-store.js';
import * as capture from './bounty-capture.js';
import * as clips from './bounty-clips.js';

export const STATES = [
  'ACCUMULATING',
  'RESERVED',
  'CLAIM_PENDING',
  'CLAIM_VERIFIED',
  'AWAITING_AIRTIME',
  'VERIFYING',
  'PARTIALLY_RELEASED',
  'RELEASED',
  // terminals
  'EXPIRED',
  'REFUNDED',
  'DISPUTED',
  'VOID',
];

/**
 * The single source of truth for legal movement. Read this table before
 * changing any flow — if a transition isn't listed, it cannot happen.
 */
export const ALLOWED_TRANSITIONS = {
  ACCUMULATING:       ['RESERVED', 'EXPIRED', 'VOID'],
  RESERVED:           ['CLAIM_PENDING', 'EXPIRED', 'VOID'],
  CLAIM_PENDING:      ['CLAIM_VERIFIED', 'RESERVED', 'EXPIRED', 'VOID'],
  CLAIM_VERIFIED:     ['AWAITING_AIRTIME', 'DISPUTED', 'VOID'],
  // PARTIALLY_RELEASED straight from AWAITING_AIRTIME: the yellow-tier
  // release (liveness.js) pays on a finished broadcast with no badge
  // verification pass, so there is no VERIFYING step to go through.
  AWAITING_AIRTIME:   ['VERIFYING', 'PARTIALLY_RELEASED', 'EXPIRED', 'DISPUTED', 'VOID'],
  VERIFYING:          ['PARTIALLY_RELEASED', 'AWAITING_AIRTIME', 'DISPUTED', 'VOID'],
  PARTIALLY_RELEASED: ['VERIFYING', 'RELEASED', 'DISPUTED', 'VOID'],
  RELEASED:           ['DISPUTED'],           // only a dispute reopens a release
  // terminals
  EXPIRED:            ['REFUNDED', 'VOID'],
  REFUNDED:           [],
  DISPUTED:           ['VERIFYING', 'REFUNDED', 'VOID'],
  VOID:               [],
};

export class IllegalTransition extends Error {
  constructor(from, to) {
    super(`Illegal escrow transition: ${from} → ${to}`);
    this.name = 'IllegalTransition';
    this.code = 'illegal_transition';
    this.from = from;
    this.to = to;
  }
}

export class BountyDisabled extends Error {
  constructor() {
    super('Creator bounty is disabled (BOUNTY_CLAIM is not 1)');
    this.name = 'BountyDisabled';
    this.code = 'bounty_disabled';
  }
}

function assertEnabled() {
  if (!bountyConfig.enabled) throw new BountyDisabled();
}

export function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

/**
 * Move a reserved handle's escrow state. Throws IllegalTransition (writing
 * nothing) when the move isn't in the table.
 */
export function transition({
  handleKey, to, actor, reason = null, claimId = null,
  airSessionId = null, amount = '0', bucket = 'contributor',
  idempotencyKey = null, meta = null,
}) {
  assertEnabled();
  const rec = store.getReservedHandleByKey(handleKey);
  if (!rec) throw new Error(`No reserved handle ${handleKey}`);
  const from = rec.claimStatus;

  if (!STATES.includes(to)) throw new IllegalTransition(from, to);
  if (!canTransition(from, to)) {
    // Deliberately BEFORE any write: an illegal transition leaves zero trace.
    throw new IllegalTransition(from, to);
  }

  // Idempotent replays short-circuit without a second state write.
  if (idempotencyKey) {
    const dup = store.findByIdempotencyKey(idempotencyKey);
    if (dup) return { row: dup, deduped: true, state: rec.claimStatus };
  }

  const { row, deduped } = store.appendLedger({
    handleKey, claimId, airSessionId,
    type: 'TRANSITION', fromState: from, toState: to,
    amount, bucket, actor, reason, idempotencyKey, meta,
  });
  if (!deduped) store.updateReservedHandle(handleKey, { claimStatus: to });
  return { row, deduped, state: to };
}

/** Reserve a handle so fans can start contributing against it. */
export function reserve({ platform, handle, reservedBy = null, actor = 'system' }) {
  assertEnabled();
  const rec = store.reserveHandle({
    platform, handle, reservedBy, ttlMs: bountyConfig.reservationTtlMs,
  });
  // Fresh reservations begin ACCUMULATING; ledger records the origin.
  store.appendLedger({
    handleKey: rec.key, type: 'RESERVE', toState: rec.claimStatus,
    actor, reason: 'handle reserved',
  });
  return rec;
}

/** A fan's recorded MegaChat becomes a contribution against the pool. */
export function contribute({ platform, handle, contributor, amount, letterRef, actor = 'viewer' }) {
  assertEnabled();
  const key = store.handleKey(platform, handle);
  if (!key) throw new Error('Invalid platform/handle');
  if (!store.getReservedHandleByKey(key)) {
    store.reserveHandle({ platform, handle, ttlMs: bountyConfig.reservationTtlMs });
  }
  const c = store.addContribution({ handleKey: key, contributor, amount, letterRef });
  store.appendLedger({
    handleKey: key, type: 'CONTRIBUTION', amount, bucket: 'contributor',
    actor, reason: 'megachat recorded for unclaimed handle', meta: { contributionId: c.id },
  });
  return c;
}

/**
 * A PLEDGE: one escrow, offered across up to `pledgeMaxTargets` streamers.
 * $100 across three streamers escrows $100 — the single Contribution row
 * lives on the ANCHOR (first target); the pledge record is what makes the
 * same money visible, as contested, on the others. First claim takes it.
 *
 * Targets are deduped and capped here rather than trusted from the client,
 * because "how many pools can one dollar appear in" is a money-display
 * invariant, not a UI preference.
 */
/**
 * A PLEDGE AMOUNT IS ONE PLAIN DECIMAL (UX sweep bo-amount-parse). This was
 * `parseFloat(amount) > 0`, which read "1,000" as 1, "5 USDC" as 5 and "1e3"
 * as 1000 and then STORED the typed string: the pool booked one number, My
 * bounties printed another, and on real money the wallet step (token-utils
 * toAtomic) refused the string only after the pledge was written, leaving a
 * pledge that could never fund. Digits, at most one '.', at most 6 places
 * (USDC's), no leading zeros, more than zero — refused here, before any write.
 */
const CANONICAL_AMOUNT_RE = /^(0|[1-9]\d{0,11})(\.\d{1,6})?$/;
export const AMOUNT_ERROR = 'Amount must be a plain number like 5 or 12.5 (digits and one ".", up to 6 decimal places).';
export function isCanonicalAmount(amount) {
  if (typeof amount !== 'string' && typeof amount !== 'number') return false;
  const s = String(amount);
  return CANONICAL_AMOUNT_RE.test(s) && Number(s) > 0;
}

export function pledge({ targets, contributor, amount, expiresInMs, actor = 'fan', displayName = null, minTier = 'green' }) {
  assertEnabled();
  if (!store.PLEDGE_TIERS.includes(minTier)) throw new Error(`minTier must be one of ${store.PLEDGE_TIERS.join(', ')}`);
  // `contributor` is now the ACCOUNT key (provider:platformId) supplied by the
  // route from the sealed identity — never a client string, because strikes
  // attach to it. Refuse rather than silently accept an anonymous pledge: the
  // FAN tier should have stopped this, and a fallback here would quietly
  // restore the free-reset hole it exists to close.
  if (!contributor) throw new Error('A pledge requires a signed-in account');
  const seen = new Set();
  const clean = [];
  for (const t of targets || []) {
    const key = store.handleKey(t.platform, t.handle);
    if (!key) throw new Error(`Invalid target ${t.platform}/${t.handle}`);
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push({ ...t, key });
  }
  if (!clean.length) throw new Error('A pledge needs at least one target streamer');
  if (clean.length > bountyConfig.pledgeMaxTargets) {
    throw new Error(`A pledge may target at most ${bountyConfig.pledgeMaxTargets} streamers`);
  }
  if (!isCanonicalAmount(amount)) throw new Error(AMOUNT_ERROR);

  const ttl = Math.min(
    bountyConfig.pledgeMaxExpiryMs,
    Math.max(bountyConfig.pledgeMinExpiryMs, Number(expiresInMs) || bountyConfig.pledgeDefaultExpiryMs),
  );

  for (const t of clean) {
    if (!store.getReservedHandleByKey(t.key)) {
      store.reserveHandle({ platform: t.platform, handle: t.handle, ttlMs: bountyConfig.reservationTtlMs });
    }
  }

  const anchor = clean[0].key;
  // REAL MONEY (BOUNTY_FUNDING=1): the pledge is UNFUNDED until the fan's
  // wallet funds it through bounty-money.js, and the CONTRIBUTION ledger row
  // — money in — is written by markPledgeFunded when the pull's receipt is
  // seen. Until then it counts in no pool and can take no clip. Ledger-only
  // mode writes the row now, exactly as before. A seeded (`seed:`) pledge is
  // ledger-only in either mode: the demo board never has money behind it.
  const requiresFunding = bountyConfig.fundingEnabled && !String(contributor).startsWith('seed:');
  const c = store.addContribution({ handleKey: anchor, contributor, amount, status: requiresFunding ? 'UNFUNDED' : 'HELD', minTier });
  const p = store.addPledge({
    contributor, amount, targets: clean.map((t) => t.key),
    contributionId: c.id, expiresAt: Date.now() + ttl,
    status: requiresFunding ? 'UNFUNDED' : 'OPEN',
    minTier,
  });
  store.updateContribution(c.id, { pledgeId: p.id });
  if (!requiresFunding) {
    store.appendLedger({
      handleKey: anchor, type: 'CONTRIBUTION', amount, bucket: 'contributor',
      actor,
      reason: clean.length === 1
        ? 'pledge for unclaimed handle'
        : `pledge contested across ${clean.length} handles — first claim takes it`,
      meta: { contributionId: c.id, pledgeId: p.id, targets: clean.map((t) => t.key), minTier },
    });
  }
  return { pledge: p, contribution: c, requiresFunding };
}

/**
 * Real money landed for an UNFUNDED pledge: the pull's receipt showed the
 * amount arrive in the platform wallet (bounty-money.js settleFunding). The
 * contribution becomes HELD and the CONTRIBUTION row — money in — is written
 * now, naming the funding. Idempotent: an OPEN pledge is returned as is.
 */
export function markPledgeFunded(pledgeId, { funding, actor = 'fan' } = {}) {
  assertEnabled();
  const p = store.getPledge(pledgeId);
  if (!p) throw new Error(`No pledge ${pledgeId}`);
  if (p.status !== 'UNFUNDED') return { pledge: p, contribution: store.getContribution(p.contributionId), deduped: true };
  if (!funding || funding.state !== 'confirmed' || !funding.ref) throw new Error('markPledgeFunded needs a confirmed funding record');
  const c = store.getContribution(p.contributionId);
  if (!c) throw new Error(`Pledge ${pledgeId} has no contribution`);
  const { row, deduped } = store.appendLedger({
    handleKey: c.handleKey, type: 'CONTRIBUTION', amount: c.amount, bucket: 'contributor',
    actor,
    reason: p.targets.length === 1
      ? 'pledge for unclaimed handle — funded'
      : `pledge contested across ${p.targets.length} handles — first claim takes it — funded`,
    idempotencyKey: `fund:${p.id}`,
    meta: { contributionId: c.id, pledgeId: p.id, targets: [...p.targets], minTier: store.tierOf(c), funding: { ref: funding.ref, txHash: funding.txHash || null, wallet: funding.wallet || null, atomic: funding.atomic || null } },
  });
  store.updateContribution(c.id, { status: 'HELD' });
  const pledge = store.updatePledge(p.id, { status: 'OPEN', funding, fundedAt: Date.now() });
  return { pledge, contribution: store.getContribution(c.id), row, deduped };
}

/**
 * An UNFUNDED pledge the fan never funded. Nothing came in, so nothing is
 * refunded: the records close and the recording, if one was uploaded, goes.
 * Never while a pull is in flight (bounty-money.js keeps `funding` on the
 * pledge from the moment it is attempted): money that may yet land is not
 * abandoned by a timer.
 */
export function abandonPledge(pledgeId, { actor = 'system', why = 'never funded' } = {}) {
  assertEnabled();
  const p = store.getPledge(pledgeId);
  if (!p) throw new Error(`No pledge ${pledgeId}`);
  if (p.status !== 'UNFUNDED') return { pledge: p, deduped: true };
  if (p.funding && p.funding.state !== 'failed') throw new Error(`pledge ${pledgeId} has a funding attempt in flight (${p.funding.state}) — not abandoned`);
  const c = store.getContribution(p.contributionId);
  if (c && c.status === 'UNFUNDED') {
    store.updateContribution(c.id, { status: 'ABANDONED' });
    try { clips.purgeForContribution(c.id, 'pledge_abandoned'); } catch { /* sweeper catches */ }
  }
  store.appendLedger({
    handleKey: c?.handleKey || p.targets[0], type: 'PLEDGE_ABANDONED', amount: '0', bucket: 'contributor',
    actor, reason: why, idempotencyKey: `abandon:${p.id}`,
    meta: { pledgeId: p.id, contributionId: c?.id || null },
  });
  return { pledge: store.updatePledge(p.id, { status: 'ABANDONED', abandonedAt: Date.now() }), deduped: false };
}

/** Abandon every UNFUNDED pledge older than `olderThanMs` with no pull in flight. */
export function sweepUnfundedPledges({ now = Date.now(), olderThanMs = bountyConfig.fundingAbandonMs, actor = 'system' } = {}) {
  assertEnabled();
  const out = [];
  for (const p of store.listPledges({ status: 'UNFUNDED' })) {
    if (now - p.createdAt < olderThanMs) continue;
    if (p.funding && p.funding.state !== 'failed') continue;
    abandonPledge(p.id, { actor, why: `not funded within ${Math.round(olderThanMs / 60_000)} min` });
    out.push({ pledgeId: p.id, amount: p.amount, contributor: p.contributor });
  }
  return out;
}

/**
 * The moment a handle's claim is approved, every open pledge naming it
 * resolves: winner takes the escrow, the other targets are slashed.
 *
 * SYNCHRONOUS BY DESIGN — there is deliberately no await anywhere between
 * reading OPEN and writing CLAIMED. Node runs a synchronous function to
 * completion, so two claim requests racing through the HTTP layer cannot
 * interleave inside this resolution: whoever's continuation lands first wins
 * every shared pledge whole, and the loser's call finds nothing OPEN.
 * Introducing an await in here reopens the race — do not.
 */
export function claimPledges(handleKey, { actor = 'claimant' } = {}) {
  assertEnabled();
  const now = Date.now();
  const open = store.listPledges({ status: 'OPEN', handleKey });
  const won = [];
  for (const p of open) {
    if (now > p.expiresAt) continue; // lapsed — the sweeper refunds it, a claim never revives it
    store.updatePledge(p.id, { status: 'CLAIMED', winner: handleKey, claimedAt: now });
    const c = store.getContribution(p.contributionId);
    if (c && c.status === 'HELD' && c.handleKey !== handleKey) {
      // updateContribution mutates the SAME object `c` points at, so the
      // origin key must be captured before the move or every read below
      // silently sees the winner.
      const fromKey = c.handleKey;
      // The escrow row moves from the anchor to the winner, with both sides
      // written to the ledger so the anchor's history explains where the
      // contested stake went.
      store.appendLedger({
        handleKey: fromKey, type: 'PLEDGE_SLASH', amount: c.amount, bucket: 'contributor',
        actor, reason: `contested pledge claimed by ${handleKey} — stake leaves this pool`,
        idempotencyKey: `pledge-slash:${p.id}`,
        meta: { pledgeId: p.id, contributionId: c.id, wonBy: handleKey },
      });
      store.appendLedger({
        handleKey, type: 'PLEDGE_WIN', amount: c.amount, bucket: 'contributor',
        actor, reason: `contested pledge won — stake lands in this pool`,
        idempotencyKey: `pledge-win:${p.id}`,
        meta: { pledgeId: p.id, contributionId: c.id, from: fromKey },
      });
      store.updateContribution(c.id, { handleKey });
      // The recording follows the money.
      const clip = clips.listClips().find((x) => x.contributionId === c.id);
      if (clip) clips.reassignClip(clip.clipId, handleKey, { pledgeId: p.id });
    }
    won.push({ pledgeId: p.id, amount: p.amount, contested: p.targets.length > 1 });
  }
  return won;
}

/**
 * Pool DISPLAY math. The raw pool (getPool) counts every HELD row on the
 * handle — which, for a multi-target pledge, sits on the anchor and may yet
 * be won by someone else. A streamer must see what is exclusively theirs
 * FIRST and contested money second, labelled with how many rivals are racing
 * for it. Never a blended headline: a claimant who finds most of "their"
 * pool gone learns about restaking from the worst possible teacher.
 */
export function poolView(key) {
  const pool = store.getPool(key);
  const now = Date.now();
  const openHere = store.listPledges({ status: 'OPEN', handleKey: key })
    .filter((p) => p.expiresAt > now);
  let contestedIn = 0;      // multi-target pledges naming this handle
  let contestedAnchored = 0; // the subset whose escrow row sits HERE (inside pool total)
  const contested = [];
  for (const p of openHere) {
    if (p.targets.length === 1) continue;
    const amt = parseFloat(p.amount);
    contestedIn += amt;
    if (p.targets[0] === key) contestedAnchored += amt;
    contested.push({
      pledgeId: p.id, amount: +amt.toFixed(6),
      rivals: p.targets.length - 1, expiresAt: p.expiresAt,
    });
  }
  const guaranteed = Math.max(0, pool.totalContributed - contestedAnchored);
  // What each liveness tier can release (liveness.js): HELD money whose
  // backers require the badge only, and HELD money whose backers also allowed
  // the yellow (overlay-check) tier. Both drawn from what is still held.
  const bal = store.poolBalances(key);
  let greenOnly = 0;
  let yellowOk = 0;
  for (const [id, left] of bal.left) {
    if (store.tierOf(store.getContribution(id)) === 'yellow') yellowOk += left; else greenOnly += left;
  }
  const yellowReleased = store.listLedger({ handleKey: key, type: 'RELEASE' })
    .filter((r) => r.bucket === 'contributor' && r.meta?.tier === 'yellow')
    .reduce((a, r) => a + parseFloat(r.amount || '0'), 0);
  return {
    ...pool,
    guaranteed: +guaranteed.toFixed(6),
    contestedTotal: +contestedIn.toFixed(6),
    contested,
    openPledges: openHere.length,
    tiers: { greenOnly: store.fromMicros(greenOnly), yellowOk: store.fromMicros(yellowOk), yellowReleased: +yellowReleased.toFixed(6) },
  };
}

/**
 * Refund every OPEN pledge past its expiry. Money and recording go back
 * together via the enumerated PLEDGE_EXPIRED reason. Called on an interval
 * and exposed on an admin route so gates can trigger it deterministically.
 */
/**
 * A self-capture outlives neither the claim it proves nor the money it proved
 * it for. When a pledge is refunded or swept, the captures taken for that
 * handle's sessions go with it — retention is a promise about video of
 * someone's broadcast, so it has to be executed, not documented.
 */
function purgeCapturesForHandle(handleKey, { log = console } = {}) {
  try {
    const sessions = store.listAirSessions()
      .filter((s) => store.getClaim(s.claimId)?.handleKey === handleKey);
    let files = 0;
    for (const s of sessions) files += capture.purgeCaptures(s.id, { log }).files;
    return files;
  } catch (e) {
    log.warn?.(`[capture] purge for ${handleKey} failed: ${e.message}`);
    return 0;
  }
}

export function sweepExpiredPledges({ actor = 'system', settlement } = {}) {
  assertEnabled();
  const now = Date.now();
  const lapsed = store.listPledges({ status: 'OPEN' }).filter((p) => now > p.expiresAt);
  const out = [];
  for (const p of lapsed) {
    store.updatePledge(p.id, { status: 'EXPIRED' });
    const c = store.getContribution(p.contributionId);
    if (c && c.status === 'HELD') {
      refund({
        handleKey: c.handleKey, reason: 'PLEDGE_EXPIRED', actor,
        contributionIds: [c.id], reference: p.id, settlement,
      });
    }
    out.push({ pledgeId: p.id, amount: p.amount, contributor: p.contributor });
  }
  return out;
}

/**
 * A rejected clip's refund — the incentive fix.
 *
 * Today a rejection refunds in full, so probing the classifier costs nothing
 * and can be repeated forever. Now:
 *  - a streamer declining a CLEAN clip refunds in full, no strike — taste is
 *    not a policy violation, split by reason code;
 *  - the FIRST confirmed policy violation refunds in full but records a
 *    strike;
 *  - later confirmed violations refund at `rejectionRefundFraction`, and the
 *    withheld remainder goes to the TARGET STREAMER'S POOL — never to the
 *    platform, because the platform profiting from its own rejections is a
 *    conflict of interest that will be noticed the first time a rejection is
 *    disputed in public;
 *  - an UNCONFIRMED flag (no human review, confidence under the floor) never
 *    costs money and never strikes. A false positive must be an
 *    inconvenience, not a fee.
 */
export function refundRejectedClip({
  clipId, by, reasonCode, reason = null,
  confidence = null, humanReviewed = false, settlement,
}) {
  assertEnabled();
  if (!['STREAMER_DECLINED', 'POLICY_VIOLATION'].includes(reasonCode)) {
    throw new Error(`reasonCode must be STREAMER_DECLINED or POLICY_VIOLATION, got "${reasonCode}"`);
  }
  const clip = clips.getClipRecord(clipId);
  if (!clip) throw new Error(`No clip ${clipId}`);
  const c = clip.contributionId ? store.getContribution(clip.contributionId) : null;
  if (!c) throw new Error(`Clip ${clipId} has no contribution attached`);
  if (c.status !== 'HELD') {
    // Already refunded (double-click, retry) — report, never double-pay.
    return { deduped: true, contributionId: c.id, status: c.status };
  }

  clips.rejectClip(clipId, { by, reasonCode, reason });

  if (reasonCode === 'STREAMER_DECLINED') {
    const rows = refund({
      handleKey: c.handleKey, reason: 'STREAMER_DECLINED', actor: by,
      contributionIds: [c.id], reference: clipId, note: reason, settlement,
    });
    return { refunded: c.amount, withheld: '0', strike: false, rows };
  }

  const confirmed = humanReviewed
    || (Number.isFinite(confidence) && confidence >= bountyConfig.rejectionConfidenceFloor);
  if (!confirmed) {
    const rows = refund({
      handleKey: c.handleKey, reason: 'POLICY_VIOLATION', actor: by,
      contributionIds: [c.id], reference: clipId,
      note: `${reason || 'flagged'} — UNCONFIRMED (no human review, confidence ${confidence ?? 'n/a'}), full refund, no strike`,
      settlement,
    });
    return { refunded: c.amount, withheld: '0', strike: false, confirmed: false, rows };
  }

  const prior = store.getStrikes(c.contributor).policyRejections;
  store.addStrike(c.contributor, { clipId, reason, confidence, by });

  if (prior === 0) {
    const rows = refund({
      handleKey: c.handleKey, reason: 'POLICY_VIOLATION', actor: by,
      contributionIds: [c.id], reference: clipId,
      note: `${reason || 'policy violation'} — first offence, full refund, strike recorded`,
      settlement,
    });
    return { refunded: c.amount, withheld: '0', strike: true, rows };
  }

  // Graduated: partial refund, remainder forfeits INTO the streamer's pool —
  // both of what the contribution still holds, since a release may already
  // have drawn on it (money-9).
  const balances = store.poolBalances(c.handleKey);
  const amount = store.fromMicros(Math.min(balances.left.get(c.id) ?? store.toMicros(c.amount), Math.max(0, balances.balance)));
  const back = +(amount * bountyConfig.rejectionRefundFraction).toFixed(6);
  const withheld = +(amount - back).toFixed(6);

  const { row, deduped } = store.appendLedger({
    handleKey: c.handleKey, type: 'REFUND', amount: String(back), bucket: 'contributor',
    actor: by,
    reason: `${REFUND_REASONS.POLICY_VIOLATION.text} — repeat offence (${prior} prior), `
      + `${Math.round(bountyConfig.rejectionRefundFraction * 100)}% refund`,
    idempotencyKey: `refund:${c.id}`,
    meta: {
      contributionId: c.id, contributor: c.contributor,
      refundReason: 'POLICY_VIOLATION', reference: clipId,
      fraction: bountyConfig.rejectionRefundFraction,
    },
  });
  if (deduped) return { deduped: true, rows: [row] };

  store.updateContribution(c.id, { status: 'REFUNDED' });
  try { clips.purgeForContribution(c.id, 'refund:POLICY_VIOLATION'); } catch { /* sweeper catches */ }
  // The settlement behind this call is the facade in bounty-settlement.js:
  // the record-only stub in ledger-only mode, the door adapter
  // (bounty-money.js) in real-money mode, which resolves the fan's funding
  // wallet from the contribution and records a settlement intent.
  settlement?.refund({ to: c.contributor, amount: String(back), ref: c.id, contributionId: c.id, pledgeId: c.pledgeId || null, handleKey: c.handleKey, reason: 'POLICY_VIOLATION', ledgerRowId: row.id });

  // The withheld share stays claimable by the TARGET streamer: a fresh HELD
  // row plus a FORFEIT ledger entry saying exactly where it came from.
  const forfeit = store.addContribution({
    handleKey: c.handleKey, contributor: c.contributor, amount: String(withheld),
  });
  store.updateContribution(forfeit.id, { forfeitOfClip: clipId, pledgeId: null });
  store.appendLedger({
    handleKey: c.handleKey, type: 'FORFEIT', amount: String(withheld), bucket: 'contributor',
    actor: by,
    reason: 'withheld share of a repeat policy rejection — stays in the streamer pool, never the platform',
    idempotencyKey: `forfeit:${c.id}`,
    meta: { fromContribution: c.id, clipId, toContribution: forfeit.id },
  });
  return { refunded: String(back), withheld: String(withheld), strike: true, rows: [row] };
}

/**
 * Every reason money can go back to a contributor. Refunds are enumerated
 * rather than free-text because "why was this refunded" is a question the
 * ledger has to answer years later, and a typo'd string is not an answer.
 *
 * `full` means the reason refunds the handle's entire remaining hold and
 * retires the reservation; the rest are per-contribution.
 */
export const REFUND_REASONS = {
  HANDLE_EXPIRED: {
    full: true,
    text: 'handle never claimed before expiry',
  },
  UNVERIFIABLE_CLIP: {
    full: false,
    text: 'clip could not be verified as aired',
  },
  BANKED_CLIP_EXPIRED: {
    full: false,
    text: 'clip was banked for replay while the overlay was hidden, and the stream ended before it could air',
  },
  CLIP_NEVER_UPLOADED: {
    full: false,
    text: 'contribution was paid but no recording was ever uploaded',
  },
  PLEDGE_EXPIRED: {
    full: false,
    text: 'pledge expired before any streamer claimed it',
  },
  STREAMER_DECLINED: {
    full: false,
    text: 'streamer declined a clean clip — full refund, no strike',
  },
  POLICY_VIOLATION: {
    full: false,
    text: 'clip rejected for a policy violation',
  },
  DISPUTE_RESOLVED: {
    full: false,
    text: 'refunded by dispute resolution',
  },
  ADMIN_ACTION: {
    full: false,
    text: 'manual refund by operator',
  },
};

/**
 * The one way money goes back. Every reason routes through here so there is a
 * single place where a refund is written, a single idempotency rule, and a
 * single settlement call site.
 *
 * IDEMPOTENCY IS PER CONTRIBUTION, NOT PER (CONTRIBUTION, REASON). A given
 * contribution can be refunded exactly once no matter how many reasons arrive
 * for it — a dispute landing on a clip that already refunded as unverifiable
 * must not pay the contributor twice. The second call returns the original
 * row and reports `deduped`.
 *
 * `settlement.refund` is the facade (bounty-settlement.js): the stub records
 * intent; in real-money mode bounty-money.js records a door intent to the
 * fan's funding wallet.
 *
 * @param {object}   a
 * @param {string}   a.handleKey
 * @param {keyof typeof REFUND_REASONS} a.reason
 * @param {string}   a.actor       who initiated (operator id, or 'system')
 * @param {string[]} [a.contributionIds] specific contributions; omit for all HELD
 * @param {string}   [a.reference] external ref — dispute id, air session id, ticket
 * @param {string}   [a.note]      free text ALONGSIDE the enum, never instead of it
 */
export function refund({
  handleKey, reason, actor = 'system', contributionIds, reference = null,
  note = null, settlement,
}) {
  assertEnabled();
  const spec = REFUND_REASONS[reason];
  if (!spec) {
    throw new Error(
      `Unknown refund reason "${reason}". Must be one of: ${Object.keys(REFUND_REASONS).join(', ')}`,
    );
  }
  if (!actor) throw new Error('Refunds require an actor — who did this is part of the record');

  const rec = store.getReservedHandleByKey(handleKey);
  if (!rec) throw new Error(`No reserved handle ${handleKey}`);

  // Already fully refunded — a retry (cron re-run, admin double-click) is a
  // no-op that returns what was refunded, NOT an error. The money was already
  // safe via per-contribution idempotency keys; this makes the API honest
  // about "already done" instead of throwing REFUNDED → EXPIRED at the caller.
  if (spec.full && rec.claimStatus === 'REFUNDED') {
    return store.listLedger({ handleKey }).filter((r) => r.type === 'REFUND');
  }

  if (spec.full && rec.claimStatus !== 'EXPIRED') {
    transition({ handleKey, to: 'EXPIRED', actor, reason: 'reservation ttl elapsed' });
  }

  const all = store.listContributions(handleKey);
  const wanted = contributionIds?.length
    ? all.filter((c) => contributionIds.includes(c.id))
    : all;
  if (contributionIds?.length) {
    const missing = contributionIds.filter((id) => !all.some((c) => c.id === id));
    if (missing.length) throw new Error(`Contributions not on ${handleKey}: ${missing.join(', ')}`);
  }
  // Only HELD money can come back. RELEASED money is already the claimant's
  // and is out of this path's reach — see the clawback note in HANDOFF.
  const targets = wanted.filter((c) => c.status === 'HELD');

  // A contribution that is ALREADY refunded is reported back with its original
  // row rather than silently omitted. Returning an empty array there would
  // read as "nothing to do" to a caller who asked a direct question about a
  // specific contribution, which is how a second refund attempt gets retried
  // forever. The money is safe either way; the answer has to be honest too.
  const refunds = [];
  if (contributionIds?.length) {
    const priorRows = store.listLedger({ handleKey }).filter((r) => r.type === 'REFUND');
    for (const c of wanted) {
      if (c.status !== 'REFUNDED') continue;
      const prior = priorRows.find((r) => r.meta?.contributionId === c.id);
      if (prior) refunds.push(prior);
    }
  }

  // What each one still holds: a release drew on them pro rata, and only the
  // unreleased remainder comes back — never more than the pool holds (money-9).
  const balances = store.poolBalances(handleKey);
  let poolLeft = Math.max(0, balances.balance);
  for (const c of targets) {
    const back = Math.min(balances.left.get(c.id) ?? store.toMicros(c.amount), poolLeft);
    // Untouched by any release: the amount exactly as it was contributed.
    const amount = back === store.toMicros(c.amount) ? c.amount : String(store.fromMicros(back));
    const { row, deduped } = store.appendLedger({
      handleKey, type: 'REFUND', amount, bucket: 'contributor',
      actor, reason: note ? `${spec.text} — ${note}` : spec.text,
      idempotencyKey: `refund:${c.id}`,
      meta: {
        contributionId: c.id, contributor: c.contributor,
        refundReason: reason, reference,
        // Set only when a release already drew on it: what it was, and what is left.
        ...(back !== store.toMicros(c.amount) ? { contributed: c.amount } : {}),
      },
    });
    if (!deduped) poolLeft -= back;
    if (!deduped) {
      store.updateContribution(c.id, { status: 'REFUNDED' });
      // The fan's money and the fan's recording go back together. Leaving the
      // clip behind would mean a streamer could still be handed something
      // nobody is paying for, and it would hold volume space forever.
      try {
        clips.purgeForContribution(c.id, `refund:${reason}`);
      } catch (e) {
        // Never let storage cleanup block a refund — the money is the part
        // that matters, and an orphaned clip is caught by the sweeper.
        console.warn(`[bounty] clip purge failed for contribution ${c.id}: ${e.message}`);
      }
      // Stub (ledger-only) or door adapter (real money): bounty-settlement.js.
      settlement?.refund({ to: c.contributor, amount, ref: c.id, contributionId: c.id, pledgeId: c.pledgeId || null, handleKey, reason, ledgerRowId: row.id });
    }
    refunds.push(row);
  }

  // Retire the reservation only once nothing is left held against it — a
  // partial refund must not mark a live pool as fully refunded.
  const stillHeld = store.listContributions(handleKey).some((c) => c.status === 'HELD');
  if (spec.full || (!stillHeld && rec.claimStatus === 'EXPIRED')) {
    transition({ handleKey, to: 'REFUNDED', actor, reason: `refunded ${refunds.length} contribution(s)` });
  }
  return refunds;
}

/**
 * Refund every held contribution on an expired, never-claimed handle.
 * Thin wrapper over refund() — kept because the expiry sweeper and its gate
 * cases call it by name.
 */
export function refundExpired({ handleKey, actor = 'system', settlement }) {
  // PURGE ONLY AFTER THE REFUND ACTUALLY HAPPENS. Purging first meant a refund
  // that then threw — an illegal transition, say, because the claim was mid
  // verification — had already destroyed the captures that prove the airtime.
  // The gate caught this: evidence must not be deleted for a state change that
  // did not occur.
  const out = refund({ handleKey, reason: 'HANDLE_EXPIRED', actor, settlement });
  purgeCapturesForHandle(handleKey);
  return out;
}

/**
 * ONE PAYABLE AIRING PER PLEDGE (Pass C Part 3a).
 *
 * Evidence stays per PLAYBACK: two airings of one clip are two windows, two
 * code namespaces, two verdicts (gate K). Payout is per PLEDGE: a fan paid
 * once for their clip to air once, and a clip that aired twice — because it
 * was banked while the overlay was hidden and then replayed, or because the
 * streamer simply played it again — is one paid airing, not two. Before this,
 * release() paid `verifiedClips` as handed to it, so a banked clip whose
 * original playback later turned out to have aired would have paid twice.
 *
 * The unit is the contribution the clip belongs to. A clip with no
 * contribution (a letter id, a rehearsal id) is its own unit, so the
 * rehearsal harnesses and gate K keep their meaning.
 */
export function payablePlaybacks(verifiedPlaybacks = []) {
  const units = new Map();
  const raw = [];
  for (const p of verifiedPlaybacks || []) {
    if (!p || p.verified === false) continue;
    raw.push(p);
    const clip = p.clipId ? clips.getClipRecord(p.clipId) : null;
    const unit = clip?.contributionId ? `contribution:${clip.contributionId}` : `clip:${p.clipId}`;
    const durationS = Number(p.durationS) || 0;
    if (!units.has(unit)) {
      units.set(unit, { unit, contributionId: clip?.contributionId || null, clipId: p.clipId, playbackId: p.playbackId, durationS, alsoVerified: [] });
    } else {
      units.get(unit).alsoVerified.push(p.playbackId);
    }
  }
  const list = [...units.values()];
  return {
    payableClips: list.length,
    payableClipSeconds: +list.reduce((a, u) => a + u.durationS, 0).toFixed(3),
    rawVerifiedClips: raw.length,
    rawVerifiedClipSeconds: +raw.reduce((a, p) => a + (Number(p.durationS) || 0), 0).toFixed(3),
    units: list,
    // Which playbacks verified but do not pay, and which one paid in their
    // place — so a status surface can say "aired twice, paid once" instead of
    // showing a number that disagrees with the evidence.
    collapsed: list.filter((u) => u.alsoVerified.length)
      .map((u) => ({ unit: u.unit, paid: u.playbackId, notPaid: u.alsoVerified })),
  };
}

/**
 * Split `amountMicros` across the HELD contributions in proportion to what
 * each still holds (`left`: contributionId → micro-units), largest remainder
 * first, so the parts sum to the amount exactly and none exceeds what its
 * contribution holds. Returns `[{ contributionId, amount }]`, amounts in
 * dollars at 6 places, for the RELEASE row (money-9).
 */
export function allocateRelease(left, amountMicros) {
  const entries = [...left].filter(([, m]) => m > 0);
  const total = entries.reduce((a, [, m]) => a + BigInt(m), 0n);
  let want = BigInt(Math.max(0, amountMicros));
  if (want > total) want = total;
  if (want === 0n) return [];
  const parts = entries.map(([id, m]) => {
    const exact = want * BigInt(m);
    return { id, cap: BigInt(m), got: exact / total, rem: exact % total };
  });
  let rest = want - parts.reduce((a, p) => a + p.got, 0n);
  // The micro-units the floors left over go to the largest remainders; ties
  // by id, so the same pool always splits the same way.
  for (const p of [...parts].sort((x, y) => (y.rem > x.rem ? 1 : y.rem < x.rem ? -1 : x.id < y.id ? -1 : 1))) {
    if (rest === 0n) break;
    if (p.got < p.cap) { p.got += 1n; rest -= 1n; }
  }
  return parts.filter((p) => p.got > 0n).map((p) => ({ contributionId: p.id, amount: store.fromMicros(Number(p.got)) }));
}

/**
 * Release a slice of the pool for verified airtime.
 *
 * Proportional, not lump-sum: `verifiedMinutes × releaseRatePerMinute` of the
 * ORIGINAL pool, capped per session. The platform match is written as its own
 * ledger row in the `platform_match` bucket so contributor money and platform
 * money never blend.
 */
export function release({
  handleKey, claimId, airSessionId, verifiedClips = 0, verifiedClipSeconds = 0,
  confidence, actor = 'verifier', idempotencyKey, settlement,
  // Fraction of code-valid sampled frames that actually read the code. Split
  // out of `confidence`, which used to carry it silently — see the gate below
  // and the reckoning above avgConfidence in bounty-verifier.js. null means
  // the caller has no detection rate (fixture-driven call sites), which
  // leaves their behaviour exactly as it was.
  detectionRate = null,
  // Which confidence tier allowed this release to happen unattended (1-3), or
  // null when no tier applies (fixture-driven verifications). AUDIT ONLY: it
  // is recorded on the ledger row and must never touch the amount — every
  // tier that passes pays exactly the same.
  confidenceTier = null,
  // The verified playbacks themselves — { clipId, playbackId, durationS }.
  // When present, verifiedClips/verifiedClipSeconds are DERIVED from them
  // with one payable airing per pledge (payablePlaybacks). Callers that only
  // have counts (fixtures) keep their behaviour exactly as it was.
  verifiedPlaybacks = null,
  // LIVENESS TIER (liveness.js). 'green' (default): this is badge-verified
  // airtime, gated and priced exactly as before. 'yellow': a finished
  // broadcast on which the claimant's keyed overlay stayed connected for at
  // least bountyConfig.yellowMinMs (`overlayConnectedMs`, read from the
  // airing's sampled record), which releases a slice of ONLY the money whose
  // backers allowed the yellow tier. No badge evidence is involved, so the
  // evidence and confidence gates do not apply; the pool caps still do.
  tier = 'green',
  airingId = null,
  overlayConnectedMs = null,
  broadcastMs = null,
}) {
  assertEnabled();
  if (!idempotencyKey) throw new Error('release requires an idempotencyKey');
  if (tier === 'yellow') return releaseYellow({ handleKey, claimId, airSessionId, airingId, overlayConnectedMs, broadcastMs, actor, idempotencyKey, settlement });
  if (tier !== 'green') throw new Error(`unknown release tier ${tier}`);

  let payable = null;
  if (Array.isArray(verifiedPlaybacks)) {
    payable = payablePlaybacks(verifiedPlaybacks);
    verifiedClips = payable.payableClips;
    verifiedClipSeconds = payable.payableClipSeconds;
  }

  const existing = store.findByIdempotencyKey(idempotencyKey);
  if (existing) return { rows: [existing], deduped: true, released: 0, match: 0 };

  // EVIDENCE GATE. A payout is computed from issued watermark codes, so we
  // must be able to vouch for them. Two independent checks:
  //   1. the evidence chain validated at boot (no interior corruption)
  //   2. this session's cached windows match the evidence log
  // Failing either means paying against proof we cannot stand behind, which
  // is precisely what the evidence log exists to prevent.
  const trust = store.evidenceIsTrustworthy();
  if (!trust.ok) {
    return {
      rows: [], deduped: false, released: 0, match: 0,
      skipped: 'evidence_unverified', detail: trust.error,
    };
  }
  if (airSessionId) {
    const rec = store.reconcileSessionEvidence(airSessionId);
    if (rec.diverged) {
      return {
        rows: [], deduped: false, released: 0, match: 0,
        skipped: 'evidence_diverged', detail: rec,
      };
    }
  }

  // A session awaiting human review does not pay until a reviewer resolves it.
  // Ambiguous evidence must never silently become a payout OR a silent denial.
  if (airSessionId && store.hasOpenReview(airSessionId)) {
    return { rows: [], deduped: false, released: 0, match: 0, skipped: 'pending_review' };
  }

  if (confidence < bountyConfig.minConfidence) {
    return { rows: [], deduped: false, released: 0, match: 0, skipped: 'low_confidence' };
  }

  // PRESENCE, GATED SEPARATELY FROM LEGIBILITY. `confidence` above is now
  // read quality only; it says how cleanly we decoded the badges we found and
  // says nothing about how often the badge was there. Without this second
  // gate the split would be a real loosening: flash the badge for one sampled
  // frame per clip, miss every other sample, and score 0.9 read quality on
  // the strength of that one frame. Both halves of the old accidental
  // product must still have to clear a bar.
  if (detectionRate != null && detectionRate < bountyConfig.minDetectionRate) {
    return { rows: [], deduped: false, released: 0, match: 0, skipped: 'low_detection_rate' };
  }

  const pool = store.getPool(handleKey);
  const rec = store.getReservedHandleByKey(handleKey);

  // Payout unit is VERIFIED CLIP PLAYBACKS (+ a small duration component),
  // not on-air minutes — airtime alone never proved a fan's clip aired.
  const rawShare = pool.totalContributed * (
    bountyConfig.releaseRatePerClip * verifiedClips
    + bountyConfig.releaseRatePerClipSecond * verifiedClipSeconds
  );
  const sessionCap = pool.totalContributed * bountyConfig.perSessionCapFraction;
  const capped = Math.min(rawShare, sessionCap, pool.remaining);
  const amount = +Math.max(0, capped).toFixed(6);
  if (amount <= 0) return { rows: [], deduped: false, released: 0, match: 0, skipped: 'nothing_to_release' };

  const matchAmount = +(amount * bountyConfig.platformMatchFraction).toFixed(6);
  const finalAt = Date.now() + bountyConfig.disputeWindowMs;
  // Drawn from the contributions pro rata, and the row says from which: a
  // refund afterwards returns only what a contribution still holds (money-9).
  const allocations = allocateRelease(store.poolBalances(handleKey).left, store.toMicros(amount));

  const { row: contribRow } = store.appendLedger({
    handleKey, claimId, airSessionId,
    type: 'RELEASE', amount, bucket: 'contributor', actor,
    reason: `verified ${verifiedClips} clip playback(s), ${verifiedClipSeconds}s (confidence ${confidence}`
      + `${confidenceTier != null ? `, tier ${confidenceTier}` : ''})`,
    idempotencyKey,
    meta: {
      tier: 'green',
      verifiedClips, verifiedClipSeconds, confidence, confidenceTier, disputeWindowEndsAt: finalAt, final: false,
      // Evidence count vs paid count. Equal unless a pledge aired more than
      // once; when they differ, `collapsed` names which playback paid.
      rawVerifiedClips: payable?.rawVerifiedClips ?? verifiedClips,
      payableClips: verifiedClips,
      collapsed: payable?.collapsed?.length ? payable.collapsed : null,
      allocations,
    },
  });
  // Separate row, separate bucket — never blended into the contributor pool.
  const { row: matchRow } = store.appendLedger({
    handleKey, claimId, airSessionId,
    type: 'RELEASE', amount: matchAmount, bucket: 'platform_match', actor,
    reason: `platform match @ ${bountyConfig.platformMatchFraction}`,
    idempotencyKey: `${idempotencyKey}:match`,
    meta: { verifiedClips, verifiedClipSeconds, confidence, disputeWindowEndsAt: finalAt, final: false },
  });

  // Ledger-only mode: the stub records the intent and nothing moves. Real
  // money (BOUNTY_FUNDING=1): bounty-money.js resolves the verified owner's
  // payout wallet (claimedByAccount, set by the claim route) and records a
  // settlement intent per row; a claimant with no wallet yet is OWED and paid
  // the moment they set one (bounty-money.js payOwed).
  const payee = { to: rec?.claimedBy || null, payeeAccount: rec?.claimedByAccount || null, handleKey, claimId, airSessionId, tier: 'green' };
  settlement?.release({ ...payee, amount, bucket: 'contributor', ref: contribRow.id, ledgerRowId: contribRow.id });
  settlement?.release({ ...payee, amount: matchAmount, bucket: 'platform_match', ref: matchRow.id, ledgerRowId: matchRow.id });

  // State follows the money: fully drained → RELEASED, otherwise partial.
  const after = store.getPool(handleKey);
  const target = after.remaining <= 0.000001 ? 'RELEASED' : 'PARTIALLY_RELEASED';
  if (canTransition(rec.claimStatus, target)) {
    transition({ handleKey, to: target, actor, reason: 'release recorded', claimId, airSessionId });
  }

  return { rows: [contribRow, matchRow], deduped: false, released: amount, match: matchAmount, payable };
}

/**
 * THE YELLOW-TIER RELEASE (liveness.js). A broadcast ended; the server
 * sampled the claimant's keyed overlay on it every LIVENESS_SAMPLE_MS and
 * it was connected for `overlayConnectedMs`. If that clears
 * bountyConfig.yellowMinMs, release `yellowReleaseFraction` of the money
 * whose backers allowed this tier: drawn from those contributions only,
 * capped by the per-session cap of that money and by what it still holds.
 * Green-only money is never touched here. Idempotent per airing and handle.
 */
function releaseYellow({ handleKey, claimId = null, airSessionId = null, airingId, overlayConnectedMs, broadcastMs = null, actor = 'liveness', idempotencyKey, settlement }) {
  const existing = store.findByIdempotencyKey(idempotencyKey);
  if (existing) return { rows: [existing], deduped: true, released: 0, match: 0, tier: 'yellow' };
  const ms = Number(overlayConnectedMs) || 0;
  if (ms < bountyConfig.yellowMinMs) return { rows: [], deduped: false, released: 0, match: 0, tier: 'yellow', skipped: 'too_short', detail: { overlayConnectedMs: ms, needMs: bountyConfig.yellowMinMs } };
  const rec = store.getReservedHandleByKey(handleKey);
  if (!rec) throw new Error(`No reserved handle ${handleKey}`);
  const bal = store.poolBalances(handleKey);
  const yellowLeft = new Map();
  let yellowHeldTotal = 0; // original amounts of the yellow-allowed HELD money
  for (const [id, left] of bal.left) {
    const c = store.getContribution(id);
    if (store.tierOf(c) !== 'yellow') continue;
    yellowLeft.set(id, left);
    yellowHeldTotal += store.toMicros(c.amount);
  }
  const stillHeld = [...yellowLeft.values()].reduce((a, m) => a + m, 0);
  const raw = Math.round(yellowHeldTotal * bountyConfig.yellowReleaseFraction);
  const cap = Math.round(yellowHeldTotal * bountyConfig.perSessionCapFraction);
  const micros = Math.max(0, Math.min(raw, cap, stillHeld, Math.max(0, bal.balance)));
  if (micros <= 0) return { rows: [], deduped: false, released: 0, match: 0, tier: 'yellow', skipped: 'nothing_to_release' };
  const amount = store.fromMicros(micros);
  const matchAmount = +(amount * bountyConfig.platformMatchFraction).toFixed(6);
  const finalAt = Date.now() + bountyConfig.disputeWindowMs;
  const allocations = allocateRelease(yellowLeft, micros);
  const minutes = Math.round(ms / 60_000);
  const { row: contribRow } = store.appendLedger({
    handleKey, claimId, airSessionId,
    type: 'RELEASE', amount, bucket: 'contributor', actor,
    reason: `yellow tier: keyed overlay on the broadcast ${minutes} min (airing ${airingId})`,
    idempotencyKey,
    meta: { tier: 'yellow', airingId, overlayConnectedMs: ms, broadcastMs, disputeWindowEndsAt: finalAt, final: false, allocations },
  });
  const { row: matchRow } = store.appendLedger({
    handleKey, claimId, airSessionId,
    type: 'RELEASE', amount: matchAmount, bucket: 'platform_match', actor,
    reason: `platform match @ ${bountyConfig.platformMatchFraction} (yellow tier)`,
    idempotencyKey: `${idempotencyKey}:match`,
    meta: { tier: 'yellow', airingId, overlayConnectedMs: ms, disputeWindowEndsAt: finalAt, final: false },
  });
  const payee = { to: rec.claimedBy || null, payeeAccount: rec.claimedByAccount || null, handleKey, claimId, airSessionId, tier: 'yellow' };
  settlement?.release({ ...payee, amount, bucket: 'contributor', ref: contribRow.id, ledgerRowId: contribRow.id });
  settlement?.release({ ...payee, amount: matchAmount, bucket: 'platform_match', ref: matchRow.id, ledgerRowId: matchRow.id });
  const after = store.getPool(handleKey);
  const target = after.remaining <= 0.000001 ? 'RELEASED' : 'PARTIALLY_RELEASED';
  if (canTransition(rec.claimStatus, target)) {
    transition({ handleKey, to: target, actor, reason: 'yellow-tier release recorded', claimId, airSessionId });
  }
  return { rows: [contribRow, matchRow], deduped: false, released: amount, match: matchAmount, tier: 'yellow' };
}

/** Handle states in which a claimed pool can release on airtime. */
const RELEASABLE = new Set(['AWAITING_AIRTIME', 'VERIFYING', 'PARTIALLY_RELEASED']);

/**
 * A broadcast ended on a room (airings-store.js closeAiring, from the follow
 * loop): every pool the room's OWNER has claimed gets its yellow-tier release
 * from the airing's overlay record. Nothing for an unclaimed pool, a room
 * nobody owns, or an airing nobody sampled.
 */
export function releaseYellowForAiring({ airing, ownerKey, settlement }) {
  assertEnabled();
  const out = [];
  if (!airing?.id || !ownerKey) return out;
  const ms = Number(airing.overlay?.connectedMs) || 0;
  const broadcastMs = airing.endedAt && airing.startedAt ? Math.max(0, airing.endedAt - airing.startedAt) : null;
  for (const rec of store.listReservedHandles()) {
    if (rec.claimedByAccount !== ownerKey || !RELEASABLE.has(rec.claimStatus)) continue;
    const r = release({
      handleKey: rec.key, tier: 'yellow', airingId: airing.id, overlayConnectedMs: ms, broadcastMs,
      actor: 'liveness', idempotencyKey: `release:yellow:${airing.id}:${rec.key}`, settlement,
    });
    out.push({ handleKey: rec.key, ...r });
  }
  return out;
}

/** Manual admin override — reason is REQUIRED and lands in the ledger. */
export function adminOverride({ handleKey, to, actor, reason, claimId = null, airSessionId = null }) {
  assertEnabled();
  if (!reason || !String(reason).trim()) {
    throw new Error('adminOverride requires a reason');
  }
  return transition({
    handleKey, to, actor, claimId, airSessionId,
    reason: `ADMIN OVERRIDE: ${reason}`,
    meta: { override: true },
  });
}
