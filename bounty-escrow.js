/**
 * CREATOR BOUNTY — escrow state machine.
 *
 * ⚠ NO REAL FUNDS MOVE HERE. This is a state machine over an append-only
 * ledger. The only settlement path is the stub in bounty-settlement.js, which
 * records intent and returns success. Every call site is marked TODO(run-b).
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
  AWAITING_AIRTIME:   ['VERIFYING', 'EXPIRED', 'DISPUTED', 'VOID'],
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
 * Refund every held contribution on an expired, never-claimed handle.
 * Settlement is stubbed; this writes the ledger truth so Run B has an exact
 * list of what to actually pay back.
 */
export function refundExpired({ handleKey, actor = 'system', settlement }) {
  assertEnabled();
  const rec = store.getReservedHandleByKey(handleKey);
  if (!rec) throw new Error(`No reserved handle ${handleKey}`);

  if (rec.claimStatus !== 'EXPIRED') {
    transition({ handleKey, to: 'EXPIRED', actor, reason: 'reservation ttl elapsed' });
  }

  const held = store.listContributions(handleKey).filter((c) => c.status === 'HELD');
  const refunds = [];
  for (const c of held) {
    const idem = `refund:${c.id}`;
    const { row, deduped } = store.appendLedger({
      handleKey, type: 'REFUND', amount: c.amount, bucket: 'contributor',
      actor, reason: 'handle never claimed before expiry',
      idempotencyKey: idem, meta: { contributionId: c.id, contributor: c.contributor },
    });
    if (!deduped) {
      store.updateContribution(c.id, { status: 'REFUNDED' });
      // TODO(run-b): real settlement. Stub records intent only.
      settlement?.refund({ to: c.contributor, amount: c.amount, ref: c.id });
    }
    refunds.push(row);
  }
  transition({ handleKey, to: 'REFUNDED', actor, reason: `refunded ${refunds.length} contribution(s)` });
  return refunds;
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
  handleKey, claimId, airSessionId, verifiedMinutes, confidence,
  actor = 'verifier', idempotencyKey, settlement,
}) {
  assertEnabled();
  if (!idempotencyKey) throw new Error('release requires an idempotencyKey');

  const existing = store.findByIdempotencyKey(idempotencyKey);
  if (existing) return { rows: [existing], deduped: true, released: 0, match: 0 };

  if (confidence < bountyConfig.minConfidence) {
    return { rows: [], deduped: false, released: 0, match: 0, skipped: 'low_confidence' };
  }

  const pool = store.getPool(handleKey);
  const rec = store.getReservedHandleByKey(handleKey);

  const rawShare = pool.totalContributed * bountyConfig.releaseRatePerMinute * verifiedMinutes;
  const sessionCap = pool.totalContributed * bountyConfig.perSessionCapFraction;
  const capped = Math.min(rawShare, sessionCap, pool.remaining);
  const amount = +Math.max(0, capped).toFixed(6);
  if (amount <= 0) return { rows: [], deduped: false, released: 0, match: 0, skipped: 'nothing_to_release' };

  const matchAmount = +(amount * bountyConfig.platformMatchFraction).toFixed(6);
  const finalAt = Date.now() + bountyConfig.disputeWindowMs;

  const { row: contribRow } = store.appendLedger({
    handleKey, claimId, airSessionId,
    type: 'RELEASE', amount, bucket: 'contributor', actor,
    reason: `verified ${verifiedMinutes} on-air min (confidence ${confidence})`,
    idempotencyKey,
    meta: { verifiedMinutes, confidence, disputeWindowEndsAt: finalAt, final: false },
  });
  // Separate row, separate bucket — never blended into the contributor pool.
  const { row: matchRow } = store.appendLedger({
    handleKey, claimId, airSessionId,
    type: 'RELEASE', amount: matchAmount, bucket: 'platform_match', actor,
    reason: `platform match @ ${bountyConfig.platformMatchFraction}`,
    idempotencyKey: `${idempotencyKey}:match`,
    meta: { verifiedMinutes, confidence, disputeWindowEndsAt: finalAt, final: false },
  });

  // TODO(run-b): real on-chain settlement goes here. The stub only records
  // intent — nothing moves, on mainnet or anywhere else.
  settlement?.release({
    to: rec?.claimedBy || null, amount, bucket: 'contributor', ref: contribRow.id,
  });
  settlement?.release({
    to: rec?.claimedBy || null, amount: matchAmount, bucket: 'platform_match', ref: matchRow.id,
  });

  // State follows the money: fully drained → RELEASED, otherwise partial.
  const after = store.getPool(handleKey);
  const target = after.remaining <= 0.000001 ? 'RELEASED' : 'PARTIALLY_RELEASED';
  if (canTransition(rec.claimStatus, target)) {
    transition({ handleKey, to: target, actor, reason: 'release recorded', claimId, airSessionId });
  }

  return { rows: [contribRow, matchRow], deduped: false, released: amount, match: matchAmount };
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

export { store };
