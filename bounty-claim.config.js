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

  // ── Stream-context enforcement (pass/fail, NOT payout scaling) ──────────
  /**
   * The requirement is that the streamer genuinely went live and played the
   * clips as part of a real broadcast — not that they went live at 4am,
   * dumped everything to nobody, and ended the stream.
   *
   * This is a GATE, not a dial. Payout stays exactly as it is: verified
   * playbacks release against the pledge, UNWEIGHTED. The bounty amount is
   * already a derivative of the streamer's audience (fans pledge more to
   * bigger streamers), so weighting payout by viewers charges for the same
   * thing twice and penalises exactly the mid-size streamers most likely to
   * onboard. Deliberately absent: any viewer-count threshold under any name,
   * and any playback-spacing rule — streamers run their segment how they like.
   */
  /** No playback counts inside the first N ms of the broadcast. Primary
   *  check: a farmer must sit live for ten minutes before collecting. */
  streamWarmupMs: num(process.env.BOUNTY_STREAM_WARMUP_MS, 10 * 60_000),
  /** The stream must continue at least this long past the last counted
   *  playback. Lower importance; closes the dump-and-quit exit. */
  streamTailMs: num(process.env.BOUNTY_STREAM_TAIL_MS, 60_000),

  // ── Stream quality floor (told, not shorted) ────────────────────────────
  /**
   * Below the verifier's pixel floor a legitimate streamer is not rejected —
   * they are quietly docked for samples that failed to read, which is the
   * worst failure mode this system has. Frames measured under this are
   * flagged explicitly so a shortfall never masquerades as normal partial
   * verification. Derived from the same floor the verifier enforces.
   */
  qualityWarnRatio: Number(process.env.BOUNTY_QUALITY_WARN_RATIO || 1.35),
  /**
   * The lowest broadcast height we have MEASURED as reliably verifiable.
   * From the synthetic corpus: 1080p 100%, 720p 100%, 480p 92% (median badge
   * height 12.3px against a 12px floor — i.e. sitting on the line). A 480p
   * streamer is not blocked; they are TOLD, up front and again on any
   * affected verification, because underpaying someone who did the work is
   * the worst failure this system has.
   */
  minVerifiableHeightPx: num(process.env.BOUNTY_MIN_VERIFIABLE_HEIGHT, 720),
  /**
   * How far the public live stream lags the encoder. A live frame grab returns
   * the head of the HLS playlist, not "now" — measured at roughly 12-25s on a
   * real Twitch broadcast, against a 4s code rotation. Codes visible in a live
   * frame are therefore several rotations stale, and the verifier widens its
   * accepted window by this much for live frames only. Generous on purpose:
   * being wrong here costs a streamer their payout, and the anti-fraud
   * property (codes bound to one playback instance by nonce) does not depend
   * on this number.
   */
  liveBroadcastDelayMs: num(process.env.BOUNTY_LIVE_DELAY_MS, 45_000),
  /**
   * How far a Twitch VOD's media timeline sits behind our wall clock.
   *
   * MEASURED, not guessed: on the first real broadcast (VOD 2832201336) the
   * frame we seeked to for wall-clock T showed the badge from T-16.7s and
   * T-15.0s on two independent samples. The VOD's `created_at` is only ~5s
   * after the stream start, so created_at anchoring alone does not explain it
   * — the ingest/transcode pipeline shifts the rest.
   *
   * Against a 4s code rotation that is ~4 rotations of error, which is why
   * every clip read a badge at a legible 28px and still verified nothing. The
   * seek is shifted by this, and the accepted-code window widened to absorb
   * the residual.
   *
   * ONE broadcast is one sample. Treat the value as provisional until more
   * VODs are measured; the widened acceptance window is what keeps a wrong
   * constant from costing a streamer their payout.
   */
  vodTimelineSkewMs: num(process.env.BOUNTY_VOD_SKEW_MS, 16_000),
  /**
   * Residual timeline error absorbed by the accepted-code window when the skew
   * was NOT measured — i.e. the fallback path only. When calibration runs, the
   * window is derived from what the measurement actually leaves behind (see
   * bounty-timeline-calibration.js), which is far tighter than this. Bounded by
   * the clip's own code list either way, so widening can never let one clip's
   * code satisfy a different clip.
   */
  mediaSkewToleranceMs: num(process.env.BOUNTY_MEDIA_SKEW_TOLERANCE_MS, 20_000),

  // ── Per-broadcast timeline calibration ──────────────────────────────────
  /**
   * The skew is MEASURED per VOD rather than assumed: probe frames, decode to
   * see which code is actually on screen, and recover the offset from the
   * content. vodTimelineSkewMs above is only the opening guess and the
   * fallback. See bounty-timeline-calibration.js for the derivation.
   */
  /** How many playback windows to probe, spread across the session. */
  calibrationMaxProbes: num(process.env.BOUNTY_CALIBRATION_PROBES, 6),
  /** One decode could be luck. Require agreement across at least this many. */
  calibrationMinPoints: num(process.env.BOUNTY_CALIBRATION_MIN_POINTS, 3),
  /**
   * Disagreement past this is a FINDING, not something to average away: the
   * timeline is non-linear or the VOD is unreliable, and it routes to review.
   * Set above one point's quantization (±codeValidityMs/2) so ordinary
   * measurement noise is not mistaken for a broken timeline.
   */
  calibrationMaxSpreadMs: num(process.env.BOUNTY_CALIBRATION_MAX_SPREAD_MS, 6_000),
  /** Extra slack on the derived acceptance window, over quantization+spread. */
  calibrationResidualMarginMs: num(process.env.BOUNTY_CALIBRATION_MARGIN_MS, 1_500),
  /**
   * Hard ceiling on frame grabs, so a bad VOD cannot cost unbounded time.
   * Generous on purpose: the happy path spends ~1 grab per probe because the
   * first success seeds every later probe, so this ceiling is only reached on a
   * timeline that is already suspect — and cutting the search short there used
   * to yield a confident answer built from whichever probes agreed.
   */
  calibrationMaxGrabs: num(process.env.BOUNTY_CALIBRATION_MAX_GRABS, 36),
  /** Codes offered per probe, nearest-in-time first. See the note on cost. */
  calibrationCandidateCap: num(process.env.BOUNTY_CALIBRATION_CANDIDATES, 8),
  /**
   * The probe ladder is DERIVED, not a hand-written list.
   *
   * A probe can only decode when its hypothesis puts the badge on screen, and a
   * badge is only up for codeValidityMs. So rungs must be spaced no wider than
   * that visibility window or a true offset landing BETWEEN two rungs is
   * unreachable — which is exactly what a hand-written ladder did: it had a 6s
   * gap and a 30s offset fell into it and measured nothing at all, while 4s,
   * 16s, 24s and 40s (all of them rungs) measured perfectly. A list that only
   * finds the values it happens to contain is not a search.
   */
  /** Rung spacing. Under one badge's visibility, with margin. */
  calibrationLadderStepMs: num(process.env.BOUNTY_CALIBRATION_LADDER_STEP_MS,
    Math.round(num(process.env.BOUNTY_CODE_VALIDITY_MS, 5_000) * 0.7)),
  /** Highest delay worth hypothesising. Past the worst yet measured (25s). */
  calibrationLadderMaxMs: num(process.env.BOUNTY_CALIBRATION_LADDER_MAX_MS, 48_000),

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
/**
 * How verification actually behaves per platform — ONE source of truth for
 * the verifier's sampling density and for the words a streamer reads before
 * they rely on it.
 *
 * Twitch keeps VODs, so a live read that fails can be retried against the
 * archive: a missed frame costs nothing. Kick publishes no VOD listing API,
 * so the live pass is the ONLY pass. That is a materially different bargain
 * and a Kick streamer is entitled to know it BEFORE they go live, not after
 * an unpaid bounty. We compensate with double the sampling density; we do not
 * pretend the difference away.
 */
export const PLATFORM_PROFILES = {
  twitch: {
    platform: 'twitch',
    vodRetry: true,
    samplingMultiplier: 1,
    notice: 'Twitch keeps a VOD, so if a live check misses a code we re-check '
      + 'the archive afterwards. A dropped frame during the stream costs you nothing.',
  },
  kick: {
    platform: 'kick',
    vodRetry: false,
    samplingMultiplier: 2,
    notice: 'Kick has no VOD we can read, so the live check is the only check — '
      + 'there is no second look after the stream. We sample twice as often to '
      + 'make up for it, but keep the badge unobstructed the whole time a MegaChat '
      + 'is playing. If a check is inconclusive it goes to a person, never to a denial.',
  },
};
export const platformProfile = (p) => PLATFORM_PROFILES[String(p || '').toLowerCase()] || null;

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
    minVerifiableHeightPx: bountyConfig.minVerifiableHeightPx,
    platformProfiles: PLATFORM_PROFILES,
    /**
     * OBS one-click (Add to OBS via obs-websocket). Flag-gated: the UI renders
     * nothing without it, and the manual copy-the-URL path stays the default.
     * The badge CSS height feeds the verify step's legibility arithmetic
     * (DOT=4 → 28px glyphs, same constant the overlay draws with).
     */
    obsOneClick: process.env.OBS_ONECLICK === '1',
    badgeCssPx: num(process.env.BOUNTY_BADGE_CSS_PX, 28),
  };
}

export default bountyConfig;
