/**
 * CREATOR BOUNTY — verifier pipeline (playback-bound).
 *
 * Samples frames INSIDE clip playback windows (not evenly across a session),
 * checks each for the code that was bound to that clip, and produces a count
 * of VERIFIED CLIP PLAYBACKS plus their verified duration. That is the payout
 * unit now — airtime alone is not evidence that a fan's clip aired.
 *
 * Both external edges stay interfaces. Run A/patch ships only the mocks,
 * fixture-driven so pass / fail / partial / ambiguous / too-small are
 * deterministic.
 */

import fs from 'fs';
import { bountyConfig, platformProfile } from './bounty-claim.config.js';
import {
  calibrateTimeline, describeCalibration, CALIBRATION_STATES,
} from './bounty-timeline-calibration.js';
import * as store from './bounty-store.js';

// ── Interfaces ──────────────────────────────────────────────────────────────

/** @typedef {{ ref:string, ts:number, clipId:string, playbackId:string, platform:string, handle:string }} FrameRef */

export class FrameSource {
  /** @returns {Promise<FrameRef[]>} */
  async getFrames(_platform, _handle, _timestamps) { throw new Error('not implemented'); }
}

/**
 * CONTRACT FOR RUN B — measurement is REQUIRED, not optional.
 *
 * findCode must return, alongside `found` and `confidence`:
 *   pixelHeight — the measured rendered height of the code glyphs in the
 *                 CAPTURED FRAME (not the source page), or a bounding box
 *                 from which height can be derived.
 *
 * This is the real legibility enforcement. A page cannot observe its own OBS
 * scene transform, so the overlay's own size check catches only a small
 * browser-source resolution; a source scaled down in the scene looks normal
 * to the page and arrives here as an unreadably small code. A sample whose
 * pixelHeight is below bountyConfig.minCodePixelHeight FAILS even when the
 * checker technically found the code.
 *
 * @returns {Promise<{found:boolean, confidence:number, pixelHeight?:number, bbox?:{w:number,h:number}}>}
 */
export class CodeChecker {
  async findCode(_frameRef, _expectedCodes) { throw new Error('not implemented'); }
}

// ── Real implementations: NOT in this run ───────────────────────────────────

/**
 * TODO(run-b): real platform frame retrieval. Needs registered apps +
 * credentials and the actual VOD/clip endpoint shapes, plus a decision on VOD
 * segments (delayed, reliable) vs live HLS (immediate, lossy). Do NOT guess.
 */
// The REAL implementations live in their own modules now:
//   frame-sources.js — TwitchFrameSource / KickFrameSource (VOD-first, the
//     extractor isolated behind resolveMediaUrl, typed unavailability)
//   bounty-ocr.js — the deterministic matrix decoder
//   ocr-frame-checker.js — the adapter binding it to THIS findCode contract
// The open question above resolved itself: neither whole-frame OCR nor a
// position crop — the badge carries a registration ring, so the reader FINDS
// it anywhere in the frame at any scale. Repositioning the source is free.

// ── Mocks ───────────────────────────────────────────────────────────────────

export function loadFixture(pathOrObject) {
  if (!pathOrObject) return null;
  if (typeof pathOrObject === 'object') return pathOrObject;
  try { return JSON.parse(fs.readFileSync(pathOrObject, 'utf8')); } catch { return null; }
}

export class MockFrameSource extends FrameSource {
  constructor(fixture = null) { super(); this.fixture = fixture || {}; }
  async getFrames(platform, handle, timestamps) {
    const out = [];
    for (const t of timestamps) {
      const ts = typeof t === 'object' ? t.ts : t;
      const clipId = typeof t === 'object' ? t.clipId : null;
      const playbackId = typeof t === 'object' ? t.playbackId : null;
      const per = this.fixture.frames?.[String(ts)];
      const available = per ? per.available !== false : this.fixture.defaultAvailable !== false;
      if (!available) continue;
      out.push({ ref: `mock://${platform}/${handle}/${ts}`, ts, clipId, playbackId, platform, handle });
    }
    return out;
  }
}

export class MockCodeChecker extends CodeChecker {
  constructor(fixture = null) { super(); this.fixture = fixture || {}; this.cursor = 0; }
  async findCode(_frameRef, _expectedCodes) {
    const s = this.fixture.checks?.[this.cursor];
    this.cursor += 1;
    const d = s || this.fixture.defaultCheck || { found: false, confidence: 0.2 };
    return {
      found: !!d.found,
      confidence: Number(d.confidence ?? 0),
      // Default comfortably above the floor so existing fixtures behave; a
      // fixture opts into the too-small path by setting pixelHeight.
      pixelHeight: Number(d.pixelHeight ?? 40),
    };
  }
}

// ── Pipeline ────────────────────────────────────────────────────────────────

/**
 * Pick sample instants INSIDE a clip's window. Mid-code rather than at the
 * issue boundary, so a frame lands where the code is definitely on screen.
 *
 * KEPT CLEAR OF THE WINDOW EDGES BY THE SEEK'S OWN UNCERTAINTY. Mid-code is
 * the right instant in a world with no seek error; with one, the first code's
 * midpoint sits only codeValidityMs/2 (2.5s) into the clip, and a residual
 * larger than that lands the frame BEFORE the clip began.
 *
 * MEASURED on Kick run #4, whose calibration reported residualMs 6521: the
 * first sample of two separate clips landed in the previous playback's tail
 * and read a perfectly legible 28px badge carrying the NEIGHBOURING window's
 * code. The verifier scored both as misses, which is correct — window scoping
 * is what stops one clip's code satisfying another, and seeing it bite is
 * reassuring — but they were OUR seek error being charged to the streamer's
 * detection rate, dragging it from 10/13 to 8/13.
 *
 * The instant is SHIFTED, never dropped. Dropping unseekable samples would
 * shrink the denominator, and detectionRate is a release gate — anything that
 * lets the measurement choose its own denominator is a fraud surface. Shifting
 * keeps the sample count, the evidentiary weight and the arithmetic identical,
 * and only asks for a frame at a moment we can actually land on.
 *
 * The clamp never leaves the code's own validity: if the window is too tight
 * for the residual to fit, mid-code is still the best instant available and is
 * used unchanged. A residual that wide is a calibration problem, and the
 * calibration states are where it belongs — not smuggled in here.
 */
export function sampleInstantsForWindow(win, perClip, residualMs = 0) {
  const usable = win.codes.filter((c) => c.expiresAt > c.issuedAt);
  if (usable.length === 0) return [];
  const guard = Math.max(0, Number(residualMs) || 0);
  const safeFrom = Number.isFinite(win.startedAt) ? win.startedAt + guard : -Infinity;
  const safeTo = Number.isFinite(win.endsAt) ? win.endsAt - guard : Infinity;
  const picks = [];
  const step = Math.max(1, Math.floor(usable.length / perClip));
  for (let i = 0; i < usable.length && picks.length < perClip; i += step) {
    const c = usable[i];
    const from = c.issuedAt;
    const to = Math.min(c.expiresAt, c.issuedAt + bountyConfig.codeValidityMs);
    const mid = Math.floor((from + to) / 2);
    // Pull toward the middle of the clip, but never outside THIS code's
    // validity — a shifted instant that no longer has a valid code would be
    // dropped by the caller, which is the denominator change this avoids.
    //
    // AN INVERTED SAFE INTERVAL MEANS THE GUARD DOES NOT FIT, NOT THAT THERE
    // IS NOTHING TO DO. When the residual is at least half the window,
    // safeFrom runs past safeTo and the expression below starts pulling toward
    // an EDGE. Two property-test rounds over generated windows pinned this
    // down: giving up and returning mid-code fixed 30,022 wrong-way cases and
    // left 10,115, because mid-code can itself sit OUTSIDE the window while a
    // guardless clamp would have pulled it in. So the fallback is the same
    // clamp with the guard dropped — always at least as good as no shift.
    const lo = safeFrom <= safeTo ? safeFrom : win.startedAt;
    const hi = safeFrom <= safeTo ? safeTo : win.endsAt;
    const ts = Math.min(Math.max(mid, Math.min(lo, to)), Math.max(hi, from));
    picks.push({
      ts: Math.min(Math.max(ts, from), to),
      clipId: win.clipId, playbackId: win.playbackId,
    });
  }
  return picks;
}

/**
 * Verify one air session.
 *
 * Result shape carries the NEW payout units:
 *   verifiedClips        — clips proven to have aired
 *   verifiedClipSeconds  — their combined duration
 * `verifiedMinutes` is retained only as a derived convenience for display.
 */
/**
 * The channel this session is broadcasting to.
 *
 * Air sessions do NOT carry a handle — they carry a claimId, and the handle
 * lives on the reserved handle the claim points at. Reading `session.handle`
 * yielded undefined for every session ever created, so the real frame sources
 * built `https://www.twitch.tv/` with nothing after the slash and yt-dlp
 * rejected it as an unsupported URL. Live grabs and VOD discovery were both
 * dead on arrival, for everyone.
 *
 * Nothing caught it because every gate drives the verifier with fixtures,
 * which never touch this argument. It took an actual broadcast, which is the
 * whole reason the rehearsal exists.
 */
function sessionHandle(session) {
  if (session.handle) return session.handle; // honoured if ever set explicitly
  const claim = session.claimId ? store.getClaim(session.claimId) : null;
  const reserved = claim?.handleKey ? store.getReservedHandleByKey(claim.handleKey) : null;
  return reserved?.handle || '';
}

export async function verifyAirSession(airSessionId, { frameSource, codeChecker, log = console } = {}) {
  const session = store.getAirSession(airSessionId);
  if (!session) throw new Error(`No air session ${airSessionId}`);

  const fx = loadFixture(bountyConfig.fixturePath);
  const fs_ = frameSource || new MockFrameSource(fx);
  const cc = codeChecker || new MockCodeChecker(fx);
  const checkerName = cc.constructor.name;

  const windows = (session.playbackWindows || []).filter((w) => !w.belowSamplingFloor && w.codes.length > 0);
  const skippedShort = (session.playbackWindows || []).filter((w) => w.belowSamplingFloor);

  // No clip ever played (or none long enough) ⇒ nothing verifiable, and
  // critically nothing payable. A parked overlay lands here.
  if (windows.length === 0) {
    const rec = store.recordVerification({
      airSessionId, checker: checkerName, evidenceRef: null,
      result: 'NO_PLAYBACK', confidence: 0, verifiedMinutes: 0,
      verifiedClips: 0, verifiedClipSeconds: 0,
    });
    store.updateAirSession(airSessionId, { verifiedClips: 0, verifiedClipSeconds: 0, verifiedMinutes: 0 });
    return {
      result: 'NO_PLAYBACK', confidence: 0, verifiedClips: 0, verifiedClipSeconds: 0,
      verifiedMinutes: 0, hitRate: 0, attempt: rec, checks: [],
      skippedBelowFloor: skippedShort.length,
    };
  }

  // KICK HAS NO SECOND CHANCE. Twitch verification can re-run against the
  // archive; Kick's official API exposes no VOD listing, so a live spot-check
  // is the only shot. Equal density there is accidental parity, not a
  // decision — Kick samples 2x so a single unlucky frame cannot decide a
  // payout that can never be re-checked.
  // Read from the shared profile, so the density the verifier applies and the
  // density a streamer is told about cannot drift apart.
  const densityMultiplier = platformProfile(session.platform)?.samplingMultiplier || 1;
  const perClip = Math.max(1,
    Math.floor((bountyConfig.sampleSize * densityMultiplier) / windows.length));
  const checks = [];
  const clipVerdicts = [];

  // ── CALIBRATE BEFORE SCORING ────────────────────────────────────────────
  // Measure this broadcast's wall-clock-to-media offset from its own content
  // instead of trusting a constant fitted to one earlier VOD. Everything below
  // then seeks with the measured value, and the accepted-code window is sized
  // from what that measurement actually leaves behind.
  const handleForSource = sessionHandle(session);
  const calibration = await calibrateTimeline({
    frameSource: fs_, codeChecker: cc, session,
    platform: session.platform, handle: handleForSource, log,
  });
  if (calibration.state === CALIBRATION_STATES.INSUFFICIENT_POINTS) {
    // "We could not measure the timeline" is a could-not-look, not a verdict
    // against the streamer. Forcing an offset here would score a real session
    // on a guess and dock someone for our own blind spot.
    const rec = store.recordVerification({
      airSessionId, checker: checkerName, evidenceRef: null,
      result: 'SOURCE_UNAVAILABLE', confidence: 0, verifiedMinutes: 0,
    });
    return {
      airSessionId, result: 'SOURCE_UNAVAILABLE',
      // Prefer the underlying source state when the source itself was the
      // problem; TIMELINE_UNCALIBRATED only means "the source was readable but
      // its timeline could not be measured".
      sourceState: calibration.sourceState || 'TIMELINE_UNCALIBRATED',
      sourceDetail: calibration.sourceDetail || calibration.detail,
      confidence: 0, verifiedClips: 0, verifiedClipSeconds: 0,
      checks: [], clipVerdicts: [], attempt: rec, calibration,
    };
  }
  if (calibration.fellBack) {
    // Loud on purpose: a systematic calibration failure must be visible, not
    // absorbed into a plausible-looking pass.
    log.warn?.(`[verifier] TIMELINE NOT CALIBRATED for session ${airSessionId} — `
      + `falling back to the documented ${bountyConfig.vodTimelineSkewMs}ms constant. `
      + `${describeCalibration(calibration)}`);
  }
  // DISAGREEMENT is not forced into an offset and not scored away. Best-effort
  // scoring continues with the median so a reviewer can see what evidence
  // exists, but the session is flagged so a human decides regardless of the
  // score — a timeline this inconsistent means the seek cannot be trusted, and
  // silently passing or failing on it would both be wrong.
  const timelineNeedsReview = calibration.state === CALIBRATION_STATES.DISAGREEMENT;
  if (timelineNeedsReview) log.warn?.(`[verifier] ${describeCalibration(calibration)}`);
  const seekOpts = { skewMs: calibration.skewMs };

  for (const win of windows) {
    const instants = sampleInstantsForWindow(win, perClip, calibration.residualMs);
    let frames;
    try {
      frames = await fs_.getFrames(session.platform, handleForSource, instants, seekOpts);
    } catch (e) {
      if (e?.code === 'frame_source_unavailable') {
        // "We could not look" is a DISTINCT verdict from "we looked and it
        // was not there". A deleted VOD, a sub-only archive, or a missing
        // extractor must never read as FAIL — that would cost the streamer
        // money over our access problem. Surfaced as its own result and
        // routed to the review queue like AMBIGUOUS.
        return {
          airSessionId, result: 'SOURCE_UNAVAILABLE', sourceState: e.state,
          sourceDetail: e.detail, confidence: 0, verifiedClips: 0,
          verifiedClipSeconds: 0, checks: [], clipVerdicts: [],
        };
      }
      throw e;
    }
    let clipHits = 0, clipChecks = 0, clipConf = 0, tooSmall = 0;
    const clipSamples = [];

    for (const frame of frames) {
      // Only codes bound to THIS clip and valid at this instant are accepted.
      //
      // LIVE FRAMES ARE OLDER THAN THE CLOCK THAT REQUESTED THEM. A live grab
      // returns whatever is at the head of the public HLS playlist, which runs
      // well behind the encoder — measured at roughly 12-25s on a real Twitch
      // broadcast. Codes rotate every 4s by default, so the code actually
      // visible in that frame expired several rotations before `frame.ts` and
      // this filter removed the only code that could ever have matched. The
      // live spot-check could not verify anything, for anyone, and on Kick —
      // which has no VOD and therefore no second attempt — that meant live
      // verification could never pay out at all.
      //
      // So live frames accept any code from this playback still within the
      // broadcast-delay allowance. The property that stops fraud is unchanged:
      // codes are bound to THIS playback instance by nonce, so displaying one
      // still requires having run this server's overlay for this clip. What is
      // deliberately given up is millisecond-exact "on screen at this instant",
      // which the public HLS cannot witness anyway.
      // VOD frames: the seek was corrected by a MEASURED offset, so this window
      // only has to absorb the residual that measurement leaves behind —
      // quantization plus point spread, computed per session rather than a flat
      // constant wide enough to hide the error it was absorbing. The ±1.5s
      // tolerance this replaced assumed an alignment that does not exist.
      const delay = frame.live
        ? bountyConfig.liveBroadcastDelayMs
        : calibration.residualMs;
      const expected = win.codes
        .filter((c) => c.issuedAt <= frame.ts + delay && c.expiresAt > frame.ts - delay)
        .map((c) => c.code);
      if (expected.length === 0) continue;

      const res = await cc.findCode(frame, expected);
      const px = Number(res.pixelHeight ?? res.bbox?.h ?? 0);
      // Legibility enforcement: found but unreadably small is NOT a pass.
      const legible = px >= bountyConfig.minCodePixelHeight;
      const counted = !!res.found && legible;
      if (!legible && res.found) tooSmall += 1;

      clipChecks += 1;
      // READ QUALITY ACCUMULATES ONLY FROM READS. On a miss, bounty-ocr.js
      // returns 0.2 x the decoder's own opinion of a JUNK ring hypothesis —
      // a number about our locator's noise floor, not about the streamer.
      // Averaging it with a glyph-match margin is a unit error; see the
      // reckoning above avgConfidence below. The miss is NOT discarded: it
      // stays in clipChecks and is held against the session by detectionRate.
      if (counted) { clipHits += 1; clipConf += Number(res.confidence || 0); }
      const sample = {
        ts: frame.ts, ref: frame.ref, clipId: win.clipId, playbackId: win.playbackId,
        found: !!res.found, confidence: res.confidence, pixelHeight: px,
        legible, counted,
      };
      checks.push(sample);
      clipSamples.push(sample);
    }

    const conf = clipHits ? clipConf / clipHits : 0;
    // A clip counts as verified when at least one legible sample found its code.
    const verified = clipHits > 0;
    // BELOW-FLOOR QUALITY, SURFACED NOT SWALLOWED. A 480p streamer is not
    // rejected — they are silently docked for samples that failed to read,
    // and underpaying someone who did the work is the worst failure this
    // system has. Count reads that LANDED but sat close to the floor, so the
    // shortfall is attributable to stream quality instead of looking like
    // ordinary partial verification.
    //
    // MEASURED ONLY WHERE A BADGE WAS ACTUALLY MEASURED. A miss reports the
    // pixelHeight of whatever junk hypothesis scored best, which on real Kick
    // captures is 4.1px — GLYPH_H(7) x the locator's minimum pitch, i.e. the
    // size of the background it was staring at. Letting those into the median
    // makes a clip sampled [4.1, 4.1, 28] median to 4.1, trip the floor, and
    // tell an honest streamer their badge was 4.1px against a 12px minimum.
    // That is an accusation built from frames containing no badge.
    //
    // `found`, NOT `counted`. This filtered on `counted` for one revision, and
    // `counted` is `found && legible` — so it excluded exactly the samples
    // this block exists to notice. A badge that WAS read and was merely too
    // small is a real measurement of a real badge, and it is the entire
    // quality signal. With `counted`, a broadcast whose badge was legibly
    // located but below the floor in EVERY sample left `reads` empty,
    // medianPx 0, and `belowQualityFloor` false (it requires medianPx > 0) —
    // no quality flag raised, from the one scenario the flag is for.
    const reads = clipSamples.filter((c) => c.found);
    const marginal = reads.filter((c) =>
      c.pixelHeight > 0
      && c.pixelHeight < bountyConfig.minCodePixelHeight * bountyConfig.qualityWarnRatio).length;
    const medianPx = (() => {
      const hs = reads.map((c) => c.pixelHeight).filter((h) => h > 0).sort((a, b) => a - b);
      return hs.length ? hs[Math.floor(hs.length / 2)] : 0;
    })();
    clipVerdicts.push({
      clipId: win.clipId, playbackId: win.playbackId, verified, samples: clipChecks, hits: clipHits,
      confidence: +conf.toFixed(3), tooSmall, durationS: win.durationS,
      marginalQuality: marginal, medianPixelHeight: medianPx,
      belowQualityFloor: medianPx > 0 && medianPx < bountyConfig.minCodePixelHeight * bountyConfig.qualityWarnRatio,
    });
    if (tooSmall > 0) {
      store.pushAirSessionViolation(airSessionId, {
        type: 'CODE_TOO_SMALL_IN_FRAME',
        at: Date.now(),
        detail: { clipId: win.clipId, playbackId: win.playbackId, samples: tooSmall, floorPx: bountyConfig.minCodePixelHeight },
      });
    }
  }

  // Unit is the verified PLAYBACK, not the distinct clip: airing the same
  // clip twice is two pieces of evidence and pays twice, provided each airing
  // is separately evidenced by its own code set.
  const verifiedClips = clipVerdicts.filter((c) => c.verified).length;
  const verifiedClipSeconds = +clipVerdicts
    .filter((c) => c.verified)
    .reduce((a, c) => a + (c.durationS || 0), 0)
    .toFixed(3);
  /**
   * CONFIDENCE IS READ QUALITY. DETECTION RATE IS PRESENCE. THEY ARE NOT THE
   * SAME NUMBER, AND THIS USED TO MULTIPLY THEM TOGETHER BY ACCIDENT.
   *
   * This was `sum(confidence) / checks.length` over EVERY sample, found or
   * not. bounty-ocr.js returns two incommensurable quantities under one name:
   * a glyph-match margin on a read, and 0.2 x a junk ring decode on a miss.
   * Averaging them makes the result identically
   *
   *     mean  =  q*d + m*(1-d)          q = read quality, d = detection rate,
   *                                     m = the meaningless miss score (0.2)
   *
   * which was then compared against minConfidence — a threshold calibrated
   * purely as a LEGIBILITY number (the fixtures are all-found, so their means
   * never carry a detection rate at all).
   *
   * MEASURED on Kick run #4, reproduced exactly from its own capture files:
   *     13 samples, 8 reads, 5 misses
   *     q = 0.8430   m = 0.2000   d = 0.6154
   *     q*d + m*(1-d) = 0.5957  ->  reported 0.596, vs a 0.6 bar
   * A streamer who genuinely aired all five clips, every badge read at 28px,
   * was ruled AMBIGUOUS and paid NOTHING — because 84% read quality was
   * multiplied by 62% presence behind our backs.
   *
   * Splitting them is NOT a loosening. Dropping the misses from the mean
   * WITHOUT gating presence separately would be: flash the badge for one
   * sampled frame per clip, miss every other, and read q = 0.9. That is why
   * detectionRate is computed here and gated in BOTH this ladder and
   * bounty-escrow.js. Every sample in its denominator was taken inside a clip
   * window at an instant when one of that clip's codes was valid — frames
   * with no valid code `continue` above and never reach checks — so a miss
   * here is real evidence, and correct silence is never punished.
   */
  const readSamples = checks.filter((c) => c.counted);
  const avgConfidence = readSamples.length
    ? readSamples.reduce((a, c) => a + (c.confidence || 0), 0) / readSamples.length
    : 0;
  const detectionRate = checks.length ? readSamples.length / checks.length : 0;
  const hitRate = clipVerdicts.length ? verifiedClips / clipVerdicts.length : 0;

  let result;
  if (checks.length === 0) result = 'NO_FRAMES';
  else if (verifiedClips === 0 && checks.some((c) => c.found && !c.legible)) result = 'FAIL_TOO_SMALL';
  else if (verifiedClips === 0) result = 'FAIL';
  else if (avgConfidence < bountyConfig.minConfidence) result = 'AMBIGUOUS';
  // The presence half, now that confidence no longer carries it silently.
  else if (detectionRate < bountyConfig.minDetectionRate) result = 'AMBIGUOUS';
  else if (hitRate >= 0.999) result = 'PASS';
  else result = 'PARTIAL';

  const measuredPx = clipVerdicts.map((c) => c.medianPixelHeight)
    .filter((h) => Number.isFinite(h) && h > 0);
  const attempt = store.recordVerification({
    airSessionId, checker: checkerName,
    evidenceRef: checks.map((c) => c.ref).join(',') || null,
    result, confidence: +avgConfidence.toFixed(3),
    detectionRate: +detectionRate.toFixed(3),
    verifiedMinutes: +(verifiedClipSeconds / 60).toFixed(3),
    verifiedClips, verifiedClipSeconds,
    belowQualityFloorClips: clipVerdicts.filter((c) => c.belowQualityFloor).length,
    smallestBadgePx: measuredPx.length ? Math.min(...measuredPx) : null,
    samplingDensity: perClip,
    // How this session's timeline was established. A payout computed from
    // frames seeked by a measured offset should carry that measurement.
    timelineSkewMs: calibration.skewMs,
    timelineState: calibration.state,
    timelineSpreadMs: calibration.spreadMs,
    timelineResidualMs: calibration.residualMs,
    timelineFellBack: !!calibration.fellBack,
  });
  store.updateAirSession(airSessionId, {
    verifiedClips, verifiedClipSeconds,
    verifiedMinutes: +(verifiedClipSeconds / 60).toFixed(3),
  });

  return {
    result, confidence: +avgConfidence.toFixed(3),
    detectionRate: +detectionRate.toFixed(3),
    verifiedClips, verifiedClipSeconds,
    verifiedMinutes: +(verifiedClipSeconds / 60).toFixed(3),
    hitRate, attempt, checks, clipVerdicts,
    // Aggregates the release path and the review queue both read.
    belowQualityFloorClips: clipVerdicts.filter((c) => c.belowQualityFloor).length,
    samplingDensity: perClip,
    skippedBelowFloor: skippedShort.length,
    // How the timeline was established, so routes and reviewers can see it.
    calibration,
    timelineNeedsReview,
    timelineSummary: describeCalibration(calibration),
  };
}
