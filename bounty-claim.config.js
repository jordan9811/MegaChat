/**
 * CREATOR BOUNTY (Run A) — every tunable in one place.
 *
 * The mechanic: fans record MegaChats addressed to a streamer who is not on
 * the platform yet. Those accumulate as a bounty pool against a RESERVED
 * handle. When that streamer claims the handle, sets up the overlay, goes
 * live, and plays the recorded MegaChats on their broadcast, they earn the
 * bounty and MegaChat matches part of it.
 *
 * Proof-of-broadcast without becoming a video host: the server issues a
 * rotating code per air session, the overlay renders it, and a verifier
 * checks public stream frames for that code at the timestamps it was issued.
 *
 * FLAG: BOUNTY_CLAIM=1 enables. Default OFF — this is a money-adjacent
 * mechanic on a mainnet app, so it stays dark until explicitly switched on
 * (the inverse of LAZY_CONNECT, which defaults ON because it fixes a live
 * cost bug).
 *
 * ⚠ NO REAL FUNDS MOVE IN RUN A. Escrow is a state machine plus an
 * append-only ledger. Settlement is an interface whose only implementation
 * records intent and returns success. See bounty-settlement.js.
 */

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export const bountyConfig = {
  /** Master flag. OFF unless BOUNTY_CLAIM=1. */
  enabled: process.env.BOUNTY_CLAIM === '1',

  // ── Reservation / expiry ────────────────────────────────────────────────
  /** An unclaimed reserved handle expires after this; contributions refund. */
  reservationTtlMs: num(process.env.BOUNTY_RESERVATION_TTL_MS, 90 * 24 * 60 * 60_000),
  /** A started claim must complete verification inside this window. */
  claimTtlMs: num(process.env.BOUNTY_CLAIM_TTL_MS, 14 * 24 * 60 * 60_000),

  // ── Watermark (PLAYBACK-BOUND) ──────────────────────────────────────────
  /**
   * Codes exist ONLY while a clip is playing and are bound to that clip id.
   * A frame carrying code X therefore proves clip Y was on screen at that
   * timestamp, because X only ever existed inside Y's playback window.
   * Playback proof and airtime proof are the same artifact — there is no
   * second, self-reported "a clip played" event that could disagree.
   *
   * Rotation is per-clip, not wall-clock: MegaChat tiles live ~10s, so the
   * old 60s rotation would have left most clips carrying no code at all.
   */
  codeRotateMs: num(process.env.BOUNTY_CODE_ROTATE_MS, 4_000),
  /**
   * Validity after issue. Always additionally CLAMPED to the clip's own end,
   * so two clips' windows can never overlap and one sampled frame can never
   * satisfy two clips.
   */
  codeValidityMs: num(process.env.BOUNTY_CODE_VALIDITY_MS, 5_000),
  /** Code length (excluding the clip namespace prefix). */
  codeLength: num(process.env.BOUNTY_CODE_LENGTH, 4),
  /**
   * Sampling floor. A clip shorter than this cannot host a code long enough
   * to be reliably sampled from a re-encoded stream. Such clips are recorded
   * as BELOW_SAMPLING_FLOOR and pay NOTHING — stated explicitly rather than
   * silently paid for on unverifiable evidence.
   */
  minClipSeconds: Number(process.env.BOUNTY_MIN_CLIP_SECONDS || 3),

  // ── Clip storage (bounty-clips.js) ──────────────────────────────────────
  /**
   * The bounty mechanic promises a streamer that clips recorded for them will
   * still be there when they claim their handle — up to `reservationTtlMs`,
   * i.e. 90 days. That promise needs actual storage, which has actual limits.
   *
   * These are REJECTION thresholds, never truncation: a fan is charged for a
   * clip, so storing a partial one is worse than refusing it up front.
   */
  /** Per clip. Matches the 25MB ceiling letters.js already enforces. */
  clipMaxBytes: num(process.env.BOUNTY_CLIP_MAX_BYTES, 25 * 1024 * 1024),
  /**
   * Whole store. Default ~2GB: at the 25MB worst case that is only ~80 clips,
   * at realistic 5-8MB sizes several hundred. Sized for early onboarding on a
   * Railway volume, NOT for scale — see docs/decisions/bounty-clip-storage.md
   * for the object-store swap.
   */
  clipStoreMaxBytes: num(process.env.BOUNTY_CLIP_STORE_MAX_BYTES, 2 * 1024 * 1024 * 1024),
  /** Per handle, so one popular streamer cannot consume the whole volume. */
  clipsPerHandleMax: num(process.env.BOUNTY_CLIPS_PER_HANDLE, 200),
  /** How long a contribution may sit with no clip uploaded before it is
   *  refundable as never-delivered. */
  clipUploadGraceMs: num(process.env.BOUNTY_CLIP_UPLOAD_GRACE_MS, 10 * 60_000),

  // ── Pledges (fan-facing program) ────────────────────────────────────────
  /**
   * One pledge may be offered across several streamers — first to claim takes
   * it, the rest are slashed. Capped so a whale cannot smear one pledge across
   * the whole directory and make every pool read as contested noise.
   */
  pledgeMaxTargets: num(process.env.BOUNTY_PLEDGE_MAX_TARGETS, 3),
  /** Contributor-set expiry, bounded. Nothing is ever locked indefinitely. */
  pledgeDefaultExpiryMs: num(process.env.BOUNTY_PLEDGE_DEFAULT_EXPIRY_MS, 7 * 24 * 60 * 60_000),
  pledgeMinExpiryMs: num(process.env.BOUNTY_PLEDGE_MIN_EXPIRY_MS, 24 * 60 * 60_000),
  pledgeMaxExpiryMs: num(process.env.BOUNTY_PLEDGE_MAX_EXPIRY_MS, 30 * 24 * 60 * 60_000),
  /** How often the expiry sweeper looks for lapsed pledges. */
  pledgeSweepMs: num(process.env.BOUNTY_PLEDGE_SWEEP_MS, 10 * 60_000),

  // ── Rejection reputation ────────────────────────────────────────────────
  /**
   * A rejected clip used to refund in full, so probing the classifier was
   * free and unlimited. First POLICY rejection still refunds in full;
   * subsequent ones refund at this fraction. A streamer declining a clean
   * clip is NOT a policy rejection and always refunds in full.
   */
  rejectionRefundFraction: Number(process.env.BOUNTY_REJECTION_REFUND_FRACTION || 0.5),
  /**
   * A strike requires a CONFIRMED rejection: human-reviewed, or classifier
   * confidence at/above this. A raw flag must never cost anyone money.
   */
  rejectionConfidenceFloor: Number(process.env.BOUNTY_REJECTION_CONFIDENCE_FLOOR || 0.9),

  // ── Moderation grading (bounty clips) ───────────────────────────────────
  /** Below this top-category score a clip is CLEAN. */
  moderationBorderlineFloor: Number(process.env.BOUNTY_MOD_BORDERLINE_FLOOR || 0.4),
  /** At/above this it is a VIOLATION; between the two it is BORDERLINE. */
  moderationViolationFloor: Number(process.env.BOUNTY_MOD_VIOLATION_FLOOR || 0.7),

  // ── Anti-malicious-compliance ───────────────────────────────────────────
  /**
   * Minimum badge height as a fraction of canvas height. Below this the
   * overlay STOPS rendering codes and the session records BADGE_TOO_SMALL.
   * Detection is the payout trigger, so shrinking the source zeroes the
   * streamer's own money rather than cheating the check.
   */
  badgeMinHeightRatio: Number(process.env.BOUNTY_BADGE_MIN_RATIO || 0.030),
  /** Absolute floor in CSS px, for very small canvases. */
  badgeMinHeightPx: num(process.env.BOUNTY_BADGE_MIN_PX, 18),

  // ── Payout (UNIT: verified CLIP PLAYBACKS, not on-air minutes) ──────────
  /**
   * The unit changed with the watermark redesign. Paying per on-air minute
   * paid for airtime; the fans contributed to have their clips PLAYED, and a
   * verified clip playback is now the thing we can actually prove.
   *
   * amount = pool × (ratePerClip × verifiedClips
   *                  + ratePerClipSecond × verifiedClipSeconds)
   */
  releaseRatePerClip: Number(process.env.BOUNTY_RELEASE_RATE_PER_CLIP || 0.04),
  /** Small duration component so a 30s clip beats a 5s one. */
  releaseRatePerClipSecond: Number(process.env.BOUNTY_RELEASE_RATE_PER_CLIP_SECOND || 0.001),
  /** Max fraction of the pool releasable from a single air session. */
  perSessionCapFraction: Number(process.env.BOUNTY_PER_SESSION_CAP || 0.25),
  /** Platform match as a fraction of the contributor pool. Tracked as a
   *  SEPARATE ledger entry — never blended into contributor money. */
  platformMatchFraction: Number(process.env.BOUNTY_PLATFORM_MATCH || 0.25),
  /** Minimum verifier confidence for a release to count. */
  minConfidence: Number(process.env.BOUNTY_MIN_CONFIDENCE || 0.6),
  /** Dispute window before a release becomes final. */
  disputeWindowMs: num(process.env.BOUNTY_DISPUTE_WINDOW_MS, 72 * 60 * 60_000),

  // ── Verifier ────────────────────────────────────────────────────────────
  /** Max codes sampled per verification pass. */
  sampleSize: num(process.env.BOUNTY_SAMPLE_SIZE, 10),
  /**
   * Minimum rendered code height, in captured-frame pixels, for a sample to
   * count. THIS is the real legibility enforcement: a page cannot observe its
   * own OBS scene transform, so the overlay's own size check catches only a
   * small browser-source resolution. A code scaled to a smear in the final
   * broadcast is caught here, at verification time, where the money is.
   */
  minCodePixelHeight: num(process.env.BOUNTY_MIN_CODE_PX, 12),

  // ── Ambiguous-result review ─────────────────────────────────────────────
  /** How long a review may sit before admin flags it loudly. */
  reviewSlaMs: num(process.env.BOUNTY_REVIEW_SLA_MS, 24 * 60 * 60_000),
  /** Fixture file driving MockFrameSource / MockCodeChecker. */
  fixturePath: process.env.BOUNTY_FIXTURE_PATH || '',

  /** Identity verification is STUBBED in Run A (real OAuth is Run B). */
  identityStubAutoApprove: process.env.BOUNTY_IDENTITY_STUB !== '0',

  /** Display currency for pools. No real transfer happens in Run A. */
  currency: process.env.BOUNTY_CURRENCY || 'USDC',
};

/** Client-safe subset (bounty board, claim pages, overlay). */
export function bountyClientConfig() {
  return {
    enabled: bountyConfig.enabled,
    currency: bountyConfig.currency,
    codeRotateMs: bountyConfig.codeRotateMs,
    badgeMinHeightRatio: bountyConfig.badgeMinHeightRatio,
    badgeMinHeightPx: bountyConfig.badgeMinHeightPx,
    disputeWindowMs: bountyConfig.disputeWindowMs,
    releaseRatePerClip: bountyConfig.releaseRatePerClip,
    minClipSeconds: bountyConfig.minClipSeconds,
  };
}

export default bountyConfig;
