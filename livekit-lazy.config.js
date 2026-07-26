/**
 * LAZY CONNECT — every tunable in one place.
 *
 * Why this exists: the OBS overlay used to open a LiveKit subscriber
 * connection on page load and never close it (see LIVEKIT-AUDIT.md). LiveKit
 * bills per CONNECTED PARTICIPANT-minute regardless of whether that
 * participant publishes or subscribes anything, so an overlay sitting in OBS
 * burned ~43,200 min/month per streamer against a 5,000-minute tier — with
 * zero guests. This module governs the replacement: the overlay stays
 * disconnected until a seat is actually being bought, and hangs up after a
 * grace window.
 *
 * FLAG: LAZY_CONNECT=0 restores the old always-connected behavior exactly.
 * Default is ON — the leak is a live cost bug, so the fix is the default and
 * the escape hatch is the env var.
 */

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export const lazyConfig = {
  /** Master flag. LAZY_CONNECT=0 → today's exact behavior (connect on mount). */
  enabled: process.env.LAZY_CONNECT !== '0',

  /**
   * How long the overlay stays connected after the LAST seat empties.
   * Prevents connect/disconnect thrash between back-to-back joiners — the one
   * failure mode that would genuinely look broken on a live broadcast.
   * Minimum 60s per spec; never fires while anyone is mid-pay-flow.
   */
  graceMs: num(process.env.LAZY_GRACE_MS, 60_000),

  /**
   * Earliest credible signal of intent. Descriptive only — nothing reads this
   * value; it documents the actual call site (join-page.ts, onJoinButtonClick
   * idle branch: fires before wallet-connect, before payment, on the FIRST
   * "Join Stream" click). There is no separate "join sheet" step in this UI —
   * the join form is already inline on the page — so 'join-click' is the
   * accurate name, not 'join-sheet-open' (a holdover from the spec's phrasing
   * that this codebase never had).
   * Alternatives: 'payment-confirm' (tighter, riskier), 'camera-live' (too late).
   */
  prewarmTrigger: process.env.LAZY_PREWARM_TRIGGER || 'join-click',

  /**
   * Backstop for a prewarm that never converts. This is NOT the abandon path
   * anymore — see abandonMs below. It only catches a hold whose client
   * vanished so completely that even the heartbeat stopped.
   */
  prewarmTtlMs: num(process.env.LAZY_PREWARM_TTL_MS, 5 * 60_000),

  /**
   * ABANDON CAP — the fix for the pinned finding.
   *
   * The old release path was leaveStream(), which a guest who bails
   * mid-wallet-connect never reaches, so an abandoned prewarm rode the full
   * 5-minute prewarmTtlMs. That is the same failure shape as the original
   * leak: a teardown that depends on an action the abandoning user by
   * definition never takes.
   *
   * A prewarm that stops making progress is released after this instead.
   * Deliberately separate from graceMs: grace protects a REAL guest's
   * back-to-back handoff, abandon protects against someone who was never
   * going to pay.
   */
  abandonMs: num(process.env.LAZY_ABANDON_MS, 90_000),

  /**
   * "Actively progressing" — what RESETS the abandon timer. Stated here
   * because the definition is the whole safety property: too narrow and a
   * slow-but-real join gets clipped mid-payment, which is worse than the
   * burn it prevents.
   *
   * A prewarm is progressing when the client reports ANY of these stages,
   * in any order, each of which is a real forward step in the join flow:
   *   'sheet-open'      — the join click that created the prewarm
   *   'wallet-connect'  — wallet UI opened / account connected
   *   'wallet-approve'  — user approved in the wallet (slowest human step)
   *   'tx-pending'      — payment submitted, waiting on chain
   *   'seat-granted'    — server granted the seat (progress becomes moot)
   *   'camera-stage'    — camera preview up
   * Each report restarts the clock. Silence for abandonMs across ALL of them
   * is what counts as abandonment.
   */
  progressStages: [
    'sheet-open', 'wallet-connect', 'wallet-approve',
    'tx-pending', 'seat-granted', 'camera-stage',
  ],

  /** Overlay → server liveness ping cadence. */
  heartbeatIntervalMs: num(process.env.LAZY_HEARTBEAT_MS, 15_000),

  /** No heartbeat within this → overlay marked unhealthy; new paid joins warn. */
  heartbeatStaleMs: num(process.env.LAZY_HEARTBEAT_STALE_MS, 45_000),

  /** Any single LiveKit session open longer than this logs a loud warning. */
  longSessionWarnMs: num(process.env.LAZY_LONG_SESSION_MS, 60 * 60_000),

  /** Room hygiene. Not a cost lever (empty rooms bill nothing) — see audit. */
  emptyTimeoutS: num(process.env.LAZY_EMPTY_TIMEOUT_S, 60),
  departureTimeoutS: num(process.env.LAZY_DEPARTURE_TIMEOUT_S, 20),

  /** Signal-channel fallback polling interval when the WS path is dead. */
  signalPollMs: num(process.env.LAZY_SIGNAL_POLL_MS, 4_000),

  /** Overlay LiveKit connect retry backoff. */
  connectRetryBaseMs: num(process.env.LAZY_RETRY_BASE_MS, 500),
  connectRetryMaxMs: num(process.env.LAZY_RETRY_MAX_MS, 15_000),

  /**
   * Per-room knob, NOT the default: connect while the streamer is broadcasting
   * rather than while a seat is occupied. ~6x better than always-on, but a
   * 4h/day streamer still burns ~7,200 min/month, so it does not get under the
   * free tier alone. Ship it for a nervous streamer who wants zero pop-in risk.
   * Room config field: `lazyConnectScope: 'seat' | 'broadcast'`.
   */
  defaultScope: process.env.LAZY_DEFAULT_SCOPE || 'seat',
};

/** Client-safe subset — shipped to the overlay via /api/config. */
export function lazyClientConfig(scope) {
  return {
    enabled: lazyConfig.enabled,
    scope: scope || lazyConfig.defaultScope,
    heartbeatIntervalMs: lazyConfig.heartbeatIntervalMs,
    signalPollMs: lazyConfig.signalPollMs,
    connectRetryBaseMs: lazyConfig.connectRetryBaseMs,
    connectRetryMaxMs: lazyConfig.connectRetryMaxMs,
  };
}

export default lazyConfig;
