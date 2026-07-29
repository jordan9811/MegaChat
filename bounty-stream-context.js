/**
 * STREAM-CONTEXT ENFORCEMENT — did this playback happen inside a real
 * broadcast, or was it a 4am dump?
 *
 * A GATE, NOT A DIAL. Two pass/fail conditions per verified playback:
 *
 *  1. WARMUP — no playback counts inside the first `streamWarmupMs` of the
 *     broadcast. This is the primary check and does most of the work: a
 *     farmer has to sit live for ten minutes before collecting anything.
 *  2. TAIL — the stream must continue at least `streamTailMs` past the last
 *     counted playback. Lower importance; closes the dump-and-quit exit.
 *
 * DELIBERATELY NOT HERE, and not to be reintroduced under another name:
 *  - No viewer-count threshold, absolute or relative. Payout is already a
 *    derivative of audience because fans pledge more to bigger streamers;
 *    gating on viewers charges twice and hits mid-size streamers hardest.
 *    Median-relative was considered and rejected: a newly onboarded streamer
 *    has no history at the moment it would matter, Twitch exposes current
 *    concurrents but not historical averages, and polling a baseline is not
 *    free to run or maintain.
 *  - No playback-spacing or minimum-gap rule. Streamers run their segment
 *    however they want.
 *
 * FAILURES ROUTE TO HUMAN REVIEW, NEVER AUTO-DENIAL. Every threshold has a
 * cliff and a legitimately odd broadcast must not be silently refused. Each
 * failure names the exact condition so a reviewer can act in seconds.
 */
import { bountyConfig } from './bounty-claim.config.js';

export const CONTEXT_FAILURES = {
  INSIDE_WARMUP: 'INSIDE_WARMUP',
  STREAM_ENDED_TOO_SOON: 'STREAM_ENDED_TOO_SOON',
  NO_BROADCAST_START: 'NO_BROADCAST_START',
};

/**
 * @param {object} a
 * @param {number} a.broadcastStartedAt when the CHANNEL went live (platform
 *   truth — Helix/Kick started_at — not when our air session opened, which a
 *   farmer controls).
 * @param {number|null} a.broadcastEndedAt null while still live.
 * @param {{clipId:string, playbackId:string, startedAt:number}[]} a.playbacks
 *   the playbacks the verifier PROVED aired.
 * @returns {{counted:[], rejected:[], warnings:[], needsReview:boolean}}
 */
export function evaluateStreamContext({
  broadcastStartedAt,
  broadcastEndedAt = null,
  playbacks = [],
  now = Date.now(),
  warmupMs = bountyConfig.streamWarmupMs,
  tailMs = bountyConfig.streamTailMs,
  observable = true,
} = {}) {
  const counted = [];
  const rejected = [];

  // NO PLATFORM API CONFIGURED = NO CHECK, NOT A FAILED CHECK.
  //
  // Without credentials the broadcast start can never be observed, so every
  // single session would land in review — the queue floods, real reviewers
  // stop reading it, and the check that was supposed to catch farming becomes
  // noise that hides it. That is worse than not having the check.
  //
  // This is deliberately NOT the same as "credentials exist but the start is
  // missing", which stays a review condition below: that one is a broadcast
  // we could have observed and didn't, which is exactly what a farmer looks
  // like. This one is a deployment fact the streamer has no control over.
  // It is reported as notEvaluated rather than OK so it can never read as a
  // check that passed.
  if (!broadcastStartedAt && !observable) {
    return {
      counted: playbacks,
      rejected: [],
      warnings: [],
      needsReview: false,
      notEvaluated: true,
      warmupMs,
      tailMs,
    };
  }

  if (!broadcastStartedAt) {
    // We could not establish when the broadcast began, so we cannot judge
    // warmup at all. That is a REVIEW condition, never a silent pass and
    // never a silent denial — the same "could not look" discipline the
    // frame sources use.
    return {
      counted: [],
      rejected: playbacks.map((p) => ({ ...p, failure: CONTEXT_FAILURES.NO_BROADCAST_START })),
      warnings: [],
      needsReview: playbacks.length > 0,
      warmupMs,
      tailMs,
    };
  }

  const warmupEndsAt = broadcastStartedAt + warmupMs;
  for (const p of playbacks) {
    if (p.startedAt < warmupEndsAt) {
      rejected.push({
        ...p,
        failure: CONTEXT_FAILURES.INSIDE_WARMUP,
        detail: `played ${Math.round((p.startedAt - broadcastStartedAt) / 1000)}s into the broadcast; `
          + `the first ${Math.round(warmupMs / 60_000)} minutes do not count`,
      });
    } else {
      counted.push(p);
    }
  }

  // Tail check applies to the LAST counted playback only — an early clip
  // followed by hours of streaming is obviously fine.
  const warnings = [];
  if (counted.length) {
    const last = counted.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
    const streamEnd = broadcastEndedAt ?? now;
    const tail = streamEnd - last.startedAt;
    if (broadcastEndedAt !== null && tail < tailMs) {
      // Do NOT silently uncount it — the streamer did play the clip. Flag for
      // a human, who can see in one line that the stream ended too abruptly.
      warnings.push({
        failure: CONTEXT_FAILURES.STREAM_ENDED_TOO_SOON,
        playbackId: last.playbackId,
        detail: `stream ended ${Math.round(tail / 1000)}s after the last counted playback; `
          + `${Math.round(tailMs / 1000)}s required`,
      });
    }
  }

  return {
    counted,
    rejected,
    warnings,
    // Anything that failed a condition goes to a person, not to auto-denial.
    needsReview: rejected.length > 0 || warnings.length > 0,
    warmupMs,
    tailMs,
    warmupEndsAt,
  };
}

/** One-line reviewer summary — the specific condition, not "failed checks". */
export function describeContext(ctx) {
  if (ctx.notEvaluated) return 'stream context not evaluated — no platform API configured';
  const bits = [];
  if (ctx.rejected.length) {
    const inWarmup = ctx.rejected.filter((r) => r.failure === CONTEXT_FAILURES.INSIDE_WARMUP).length;
    const noStart = ctx.rejected.filter((r) => r.failure === CONTEXT_FAILURES.NO_BROADCAST_START).length;
    if (inWarmup) bits.push(`${inWarmup} playback(s) inside the ${Math.round(ctx.warmupMs / 60_000)}-minute warmup`);
    if (noStart) bits.push(`${noStart} playback(s) with no known broadcast start`);
  }
  for (const w of ctx.warnings) bits.push(w.detail);
  return bits.join('; ') || 'stream context OK';
}
