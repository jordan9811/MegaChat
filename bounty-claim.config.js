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

  // ── Watermark ───────────────────────────────────────────────────────────
  /** How often the on-air code rotates. */
  codeRotateMs: num(process.env.BOUNTY_CODE_ROTATE_MS, 60_000),
  /** How long a code stays valid for verification after issue. Slightly
   *  longer than the rotation so a frame sampled at a boundary still checks
   *  against the code that was actually on screen. */
  codeValidityMs: num(process.env.BOUNTY_CODE_VALIDITY_MS, 75_000),
  /** Code length (excluding the session namespace prefix). */
  codeLength: num(process.env.BOUNTY_CODE_LENGTH, 4),

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

  // ── Payout ──────────────────────────────────────────────────────────────
  /** Pool fraction released per verified on-air minute. */
  releaseRatePerMinute: Number(process.env.BOUNTY_RELEASE_RATE_PER_MIN || 0.05),
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
    releaseRatePerMinute: bountyConfig.releaseRatePerMinute,
  };
}

export default bountyConfig;
