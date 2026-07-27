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
  CLIP_NEVER_UPLOADED: {
    full: false,
    text: 'contribution was paid but no recording was ever uploaded',
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
 * ⚠ NO REAL FUNDS MOVE. `settlement.refund` is a stub that records intent.
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

  for (const c of targets) {
    const { row, deduped } = store.appendLedger({
      handleKey, type: 'REFUND', amount: c.amount, bucket: 'contributor',
      actor, reason: note ? `${spec.text} — ${note}` : spec.text,
      idempotencyKey: `refund:${c.id}`,
      meta: {
        contributionId: c.id, contributor: c.contributor,
        refundReason: reason, reference,
      },
    });
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
      // TODO(run-b): real settlement. Stub records intent only.
      settlement?.refund({ to: c.contributor, amount: c.amount, ref: c.id });
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
  return refund({ handleKey, reason: 'HANDLE_EXPIRED', actor, settlement });
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
}) {
  assertEnabled();
  if (!idempotencyKey) throw new Error('release requires an idempotencyKey');

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

  const { row: contribRow } = store.appendLedger({
    handleKey, claimId, airSessionId,
    type: 'RELEASE', amount, bucket: 'contributor', actor,
    reason: `verified ${verifiedClips} clip playback(s), ${verifiedClipSeconds}s (confidence ${confidence})`,
    idempotencyKey,
    meta: { verifiedClips, verifiedClipSeconds, confidence, disputeWindowEndsAt: finalAt, final: false },
  });
  // Separate row, separate bucket — never blended into the contributor pool.
  const { row: matchRow } = store.appendLedger({
    handleKey, claimId, airSessionId,
    type: 'RELEASE', amount: matchAmount, bucket: 'platform_match', actor,
    reason: `platform match @ ${bountyConfig.platformMatchFraction}`,
    idempotencyKey: `${idempotencyKey}:match`,
    meta: { verifiedClips, verifiedClipSeconds, confidence, disputeWindowEndsAt: finalAt, final: false },
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
