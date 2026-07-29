/**
 * PER-BROADCAST TIMELINE CALIBRATION — measure the skew, do not assume it.
 *
 * THE PROBLEM. A VOD's media timeline runs behind our wall clock. Verification
 * seeks to an offset computed from playback timestamps, so if that offset is
 * wrong the badge is still right there at a legible size and the code is simply
 * the wrong one. Codes rotate every 4s, so a few seconds of error misses by
 * whole rotations. The first real broadcast measured ~15-17s of skew; a fixed
 * constant fits that one VOD and silently mis-seeks the next, because the delay
 * depends on ingest path, transcode queue, and created_at granularity — none of
 * which are ours.
 *
 * THE MEASUREMENT. Seeking with a hypothesised skew `s` to target wall-clock
 * `ts` lands on content whose true wall-clock time is `ts + s - Δ`, for the
 * unknown true skew Δ. Decode that frame, find which code C is actually on
 * screen, and C was only ever displayed during [C.issuedAt, C.expiresAt). So
 *
 *     Δ ∈ ( ts + s - C.expiresAt , ts + s - C.issuedAt ]
 *
 * and the point estimate is `ts + s - midpoint(C)`, uncertain by ±validity/2.
 * That is a real measurement of the platform's own pipeline, recovered from the
 * content, needing no constant.
 *
 * RESOLUTION IS QUANTIZED BY CODE VALIDITY, and saying so matters. A single
 * point can only place Δ within ±validity/2 (±2.5s at the shipped 5s validity),
 * because any moment inside a code's window looks identical. This is exactly
 * why the two real-broadcast samples read -16.7s and -15.0s: a 1.7s difference
 * that is INSIDE one point's uncertainty and therefore cannot distinguish
 * "constant skew" from "slow drift". Several points and the median narrow it;
 * the spread across points is reported so the ambiguity stays visible instead
 * of being rounded into a confident-looking number.
 *
 * CONSTANT, NOT DRIFTING — for now, on evidence. Both real samples sit inside
 * a single point's uncertainty, so the data does not support modelling drift,
 * and inventing a slope from two quantized points would be the same mistake as
 * the one-code corpus. Treated as constant per VOD, with the spread checked
 * against a threshold so a genuinely non-linear timeline is caught and routed
 * to a human rather than silently averaged.
 *
 * FAILURE IS NEVER A SILENT MISS. Too few decodes is "we could not measure"
 * (SOURCE_UNAVAILABLE-class), disagreement past the threshold is its own review
 * reason, and the documented constant is a fallback that logs loudly — a
 * systematic calibration failure must be visible, not quietly absorbed.
 */
import { bountyConfig } from './bounty-claim.config.js';

export const CALIBRATION_STATES = {
  /** Skew measured from the content itself. */
  MEASURED: 'MEASURED',
  /** Not enough frames decoded to measure anything. Could-not-look, not a fail. */
  INSUFFICIENT_POINTS: 'INSUFFICIENT_POINTS',
  /** Points disagree beyond threshold: non-linear timeline or unreliable VOD. */
  DISAGREEMENT: 'DISAGREEMENT',
  /** Source cannot be calibrated at all (live stream, or a fixture source). */
  NOT_APPLICABLE: 'NOT_APPLICABLE',
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** Every code in the session, flattened, with the window it belongs to. */
function allCodes(session) {
  return (session.playbackWindows || [])
    .filter((w) => !w.belowSamplingFloor && (w.codes || []).length)
    .flatMap((w) => w.codes.map((c) => ({ ...c, _win: w })));
}

/**
 * Probe targets: the middle of each usable playback window, spread across the
 * session rather than clustered, because a timeline that drifts would show it
 * as disagreement between distant points and clustered probes would hide that.
 */
function probeTargets(session, max) {
  const wins = (session.playbackWindows || [])
    .filter((w) => !w.belowSamplingFloor && (w.codes || []).length)
    .sort((a, b) => a.startedAt - b.startedAt);
  if (!wins.length) return [];
  const step = Math.max(1, Math.floor(wins.length / max));
  const picked = [];
  for (let i = 0; i < wins.length && picked.length < max; i += step) picked.push(wins[i]);
  return picked.map((w) => {
    const cs = w.codes;
    const first = Math.min(...cs.map((c) => c.issuedAt));
    const last = Math.max(...cs.map((c) => c.expiresAt));
    return { ts: Math.round((first + last) / 2), clipId: w.clipId, playbackId: w.playbackId };
  });
}

/**
 * @returns {Promise<{state, skewMs, residualMs, spreadMs, points, grabs, fellBack, detail}>}
 */
export async function calibrateTimeline({
  frameSource, codeChecker, session, platform, handle,
  log = console, config = bountyConfig,
} = {}) {
  const fallback = {
    state: CALIBRATION_STATES.NOT_APPLICABLE,
    skewMs: config.vodTimelineSkewMs,
    residualMs: config.mediaSkewToleranceMs,
    spreadMs: null, points: [], grabs: 0, fellBack: true, detail: null,
  };
  if (!frameSource?.calibratable) return { ...fallback, detail: 'source is not calibratable' };

  const codes = allCodes(session);
  const targets = probeTargets(session, config.calibrationMaxProbes);
  if (!codes.length || !targets.length) {
    return { ...fallback, state: CALIBRATION_STATES.INSUFFICIENT_POINTS, detail: 'no sampled codes to calibrate against' };
  }

  const validity = Math.max(1, config.codeValidityMs);
  // Ladder BUILT from the badge visibility window, then ordered by likelihood:
  // the documented constant is the best prior we have, so a hit on the first
  // rung costs one frame grab. Spacing is what makes it a search rather than a
  // lookup — see calibrationLadderStepMs for the offset that fell through a
  // hand-written gap.
  const step = Math.max(500, config.calibrationLadderStepMs);
  const rungSet = new Set([config.vodTimelineSkewMs]);
  for (let v = 0; v <= config.calibrationLadderMaxMs; v += step) rungSet.add(v);
  const ladder = [...rungSet]
    .sort((a, b) => Math.abs(a - config.vodTimelineSkewMs) - Math.abs(b - config.vodTimelineSkewMs));

  const points = [];
  let grabs = 0;
  let lastGood = null;
  let probesAttempted = 0;
  let budgetExhausted = false;

  for (const target of targets) {
    probesAttempted += 1;
    // Once one probe succeeds, its skew is the best opening guess for the rest,
    // so later probes usually cost a single grab each.
    const rungs = lastGood === null ? ladder : [lastGood, ...ladder.filter((v) => v !== lastGood)];
    for (const s of rungs) {
      if (grabs >= config.calibrationMaxGrabs) { budgetExhausted = true; break; }
      // Under the hypothesis Δ = s, this seek lands on wall-clock `ts`, so the
      // code valid at `ts` is the most likely thing on screen. Candidates are
      // ordered by temporal proximity to that instant and capped: the ladder
      // already covers gross offset, so a code far outside the hypothesis
      // cannot be the one showing, and offering it only costs decode time.
      // Across rungs the hypothesis moves, so the full set is still reachable.
      const candidates = codes
        .map((c) => ({ c, d: Math.abs((c.issuedAt + c.expiresAt) / 2 - target.ts) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, config.calibrationCandidateCap)
        .map((x) => x.c);
      let frames;
      try {
        frames = await frameSource.getFrames(platform, handle,
          [{ ts: target.ts, clipId: target.clipId, playbackId: target.playbackId }], { skewMs: s });
      } catch (e) {
        // A source that cannot be read at all is the caller's problem to
        // classify; calibration just reports that it could not measure.
        return {
          ...fallback, state: CALIBRATION_STATES.INSUFFICIENT_POINTS, grabs,
          // Carry the DETAIL, not just the state. A bare state name sends the
          // next person hunting for a cause the error already knew.
          detail: `frame source failed during calibration: ${e?.state || e?.message || e}`
            + `${e?.detail ? ` — ${e.detail}` : ''}`,
          // And carry the ROOT CAUSE upward. Calibration merely happens to be
          // the first stage that touches the source, so reporting "could not
          // calibrate" for a missing credential or a deleted VOD would replace
          // a precise, actionable state with the name of the stage that noticed.
          sourceState: e?.state || null,
          sourceDetail: e?.detail || null,
        };
      }
      grabs += 1;
      const frame = frames?.[0];
      if (!frame) continue;
      const res = await codeChecker.findCode(frame, candidates.map((c) => c.code));
      if (!res?.found) continue;
      const hit = candidates.find((c) => c.code === (res.code || res.text));
      if (!hit) continue;
      const mid = (hit.issuedAt + hit.expiresAt) / 2;
      points.push({
        ts: target.ts, probeSkewMs: s, code: hit.code, clipId: hit.clipId,
        issuedAt: hit.issuedAt,
        // Δ estimate: ts + s - midpoint(code on screen).
        estimateMs: Math.round(target.ts + s - mid),
      });
      lastGood = s;
      break; // this probe is measured; move to the next one
    }
    if (grabs >= config.calibrationMaxGrabs) { budgetExhausted = true; break; }
  }

  if (points.length < config.calibrationMinPoints) {
    log.warn?.(`[calibration] only ${points.length} of ${config.calibrationMinPoints} required points`
      + ` decoded after ${grabs} grabs — cannot measure this timeline`);
    return {
      ...fallback, state: CALIBRATION_STATES.INSUFFICIENT_POINTS, points, grabs,
      detail: `${points.length} calibration point(s) decoded, ${config.calibrationMinPoints} required`,
    };
  }

  const estimates = points.map((p) => p.estimateMs);

  // ROBUST TO A MINORITY OF BAD PROBES, because real VODs produce them.
  //
  // Measured on the real broadcast (VOD 2832201336) from a deliberately wrong
  // 0ms prior, the four points came back 13.2s, 13.2s, 14.7s and 23.1s. Three
  // agree to within 1.5s and match the value measured by hand; one is junk —
  // most likely a probe that decoded a neighbouring clip's badge, which is easy
  // on a real broadcast where clips run 30s and codes rotate every 4s. A plain
  // max-minus-min spread let that single outlier condemn the whole VOD to
  // review and fall back to the widest window, which is the same "one sample
  // decides" mistake this project keeps paying for.
  //
  // So: cluster around the median, keep the points that agree within one
  // point's own uncertainty, and require a MAJORITY-SIZED cluster. Disagreement
  // now means the agreeing points are too few — not that one probe misfired.
  const centre = median(estimates);
  const inlierTolMs = Math.round(validity / 2) + config.calibrationResidualMarginMs;
  const inliers = points.filter((p) => Math.abs(p.estimateMs - centre) <= inlierTolMs);
  const outliers = points.filter((p) => !inliers.includes(p));
  const inlierEstimates = inliers.map((p) => p.estimateMs);
  const spreadMs = inlierEstimates.length
    ? Math.max(...inlierEstimates) - Math.min(...inlierEstimates)
    : Math.max(...estimates) - Math.min(...estimates);

  // A TRUNCATED SEARCH IS NOT AGREEMENT.
  //
  // Found by this run's own gate: on a deliberately inconsistent timeline the
  // grab budget ran out while probing the odd half, and what came back was a
  // confident MEASURED derived only from the probes that happened to agree —
  // the disagreement was real and invisible. If the budget stopped the search
  // AND some probes never measured, the honest answer is that we do not know.
  const unmeasured = probesAttempted - points.length;
  if (budgetExhausted && unmeasured > 0) {
    log.warn?.(`[calibration] grab budget (${config.calibrationMaxGrabs}) exhausted with `
      + `${unmeasured} probe(s) unmeasured — refusing to report agreement from the rest`);
    return {
      state: CALIBRATION_STATES.DISAGREEMENT,
      skewMs: centre, residualMs: config.mediaSkewToleranceMs,
      spreadMs, points, outliers: outliers.length, grabs, fellBack: false, probesAttempted,
      detail: `calibration ran out of probe budget with ${unmeasured} of ${probesAttempted} `
        + 'point(s) unmeasured, so the points that did agree cannot be trusted to '
        + 'describe the whole VOD — the timeline may not be consistent',
    };
  }

  if (inliers.length < config.calibrationMinPoints) {
    log.warn?.(`[calibration] only ${inliers.length} of ${points.length} points cluster `
      + `within ±${inlierTolMs}ms: ${estimates.join(', ')}`);
    return {
      state: CALIBRATION_STATES.DISAGREEMENT,
      skewMs: centre, residualMs: config.mediaSkewToleranceMs,
      spreadMs, points, outliers: outliers.length, grabs, fellBack: false, probesAttempted,
      detail: `calibration points disagree: only ${inliers.length} of ${points.length} agree `
        + `within ±${(inlierTolMs / 1000).toFixed(1)}s `
        + `(${estimates.map((e) => (e / 1000).toFixed(1)).join('s, ')}s) — `
        + 'the VOD timeline is not consistent enough to seek by measurement',
    };
  }

  // The acceptance window is now DERIVED, not guessed: what a measured seek
  // actually leaves behind is the per-point quantization (±validity/2, because
  // any instant inside a code's window is indistinguishable) plus whatever the
  // points disagree by, plus a small margin. This replaces the old flat
  // tolerance, which was wide enough to hide the very error it absorbed.
  const residualMs = Math.round(validity / 2) + spreadMs + config.calibrationResidualMarginMs;

  if (outliers.length) {
    log.warn?.(`[calibration] discarded ${outliers.length} outlying point(s) `
      + `(${outliers.map((o) => (o.estimateMs / 1000).toFixed(1)).join('s, ')}s) around a `
      + `${(median(inlierEstimates) / 1000).toFixed(1)}s cluster`);
  }
  return {
    state: CALIBRATION_STATES.MEASURED,
    skewMs: median(inlierEstimates),
    residualMs, spreadMs, points, outliers: outliers.length,
    grabs, fellBack: false, probesAttempted,
    detail: outliers.length
      ? `${outliers.length} outlying probe(s) discarded around a ${inliers.length}-point cluster`
      : null,
  };
}

/** One line a human can act on. */
export function describeCalibration(cal) {
  if (!cal) return 'no calibration';
  switch (cal.state) {
    case CALIBRATION_STATES.MEASURED:
      return `timeline measured at ${(cal.skewMs / 1000).toFixed(1)}s behind wall clock `
        + `from ${cal.points.length - (cal.outliers || 0)} agreeing point(s)`
        + `${cal.outliers ? ` (${cal.outliers} outlier(s) discarded)` : ''}, `
        + `spread ${(cal.spreadMs / 1000).toFixed(1)}s, `
        + `residual window ±${(cal.residualMs / 1000).toFixed(1)}s`;
    case CALIBRATION_STATES.DISAGREEMENT:
      return cal.detail;
    case CALIBRATION_STATES.INSUFFICIENT_POINTS:
      return `could not measure the timeline: ${cal.detail}`;
    default:
      return `timeline not calibrated (${cal.detail || 'not applicable'}); `
        + `using the documented ${(cal.skewMs / 1000).toFixed(1)}s fallback`;
  }
}
