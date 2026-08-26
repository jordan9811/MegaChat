/**
 * CREATOR BOUNTY — the EVIDENCE log.
 *
 * ── Why this exists (revising my own earlier risk call) ────────────────────
 * I previously filed the mutable store as "much smaller risk than the ledger
 * was." That was wrong, and the reasoning was sloppy: I weighed it as
 * bookkeeping when it is actually PROOF.
 *
 * The ledger records what was PAID. This records what was OBSERVED — the
 * watermark codes issued during each playback, and what the verifier found.
 * A payout is decided by counting verified playbacks, so a silently truncated
 * evidence file does not lose bookkeeping: it makes a verifier count FEWER
 * playbacks than actually aired and underpay a streamer, with no error
 * anywhere. That is the same class of failure as a corrupt ledger, pointed at
 * the other half of the transaction, and the ledger cannot rebuild it by
 * design (it is append-only over payments, not over observations).
 *
 * So evidence gets the same treatment: append-only JSONL, per-record sequence
 * and checksum, chain validated on load, refuse to start on interior damage,
 * recover a torn final record loudly.
 *
 * ── The split ─────────────────────────────────────────────────────────────
 * IMMUTABLE EVIDENCE (this file, authoritative):
 *   AIR_SESSION_OPENED, PLAYBACK_STARTED, CODE_ISSUED, PLAYBACK_ENDED,
 *   VIOLATION, VERIFICATION
 * MUTABLE STATE (bounty.json, rewritten, legitimately changes):
 *   reserved-handle claimStatus, claim verificationState, review state and
 *   assignee, air-session status/badgeTooSmall and the DERIVED verified counts
 *
 * The rule: anything a payout is computed FROM is evidence. Anything that
 * merely records where a workflow got to is state.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { createLedger, LedgerCorrupt } from './bounty-ledger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const EVIDENCE_PATH = path.join(DATA_DIR, 'bounty-evidence.jsonl');

export const EVIDENCE_TYPES = {
  AIR_SESSION_OPENED: 'AIR_SESSION_OPENED',
  PLAYBACK_STARTED: 'PLAYBACK_STARTED',
  CODE_ISSUED: 'CODE_ISSUED',
  PLAYBACK_ENDED: 'PLAYBACK_ENDED',
  VIOLATION: 'VIOLATION',
  CAPTURE_FROZEN: 'CAPTURE_FROZEN',
  /** Concurrent viewer count sampled at clip playback. Payout-relevant and
   *  IMPOSSIBLE to backfill: once the broadcast ends, the count at a given
   *  instant is gone forever, so it is captured the moment it exists. */
  VIEWER_SAMPLE: 'VIEWER_SAMPLE',
  /**
   * Two CLIENT-REPORTED signals, kept in the chain for the same reason the
   * viewer sample is: they are about a moment that is gone once the broadcast
   * ends, so there is no backfilling them later.
   *
   * They are recorded as evidence but they are NOT proof, and the distinction
   * is load-bearing. Both come from software on the streamer's own machine
   * reporting on itself. They decide whether a HUMAN LOOKS at a verification
   * (bounty-confidence.js); they never decide a payout on their own, and a
   * streamer who cannot produce them at all is not penalised.
   */
  OBS_SCENE_SAMPLE: 'OBS_SCENE_SAMPLE',
  OVERLAY_ENV: 'OVERLAY_ENV',
  VERIFICATION: 'VERIFICATION',
};

let log = null;
/** Set once validation has run and passed (or recovered). */
let validated = false;
let lastValidationError = null;

function evidence() {
  if (!log) log = createLedger({ filePath: EVIDENCE_PATH, kind: 'evidence' });
  return log;
}

/**
 * Validate the evidence chain. Throws LedgerCorrupt on interior damage.
 * Call at boot — before anything can be released against this evidence.
 */
export function verifyEvidenceIntegrity() {
  try {
    const r = evidence().load();
    validated = true;
    lastValidationError = null;
    return r;
  } catch (e) {
    validated = false;
    lastValidationError = e.message;
    throw e;
  }
}

/**
 * Has the evidence chain been validated this boot?
 * A release MUST consult this: paying out against evidence we cannot vouch
 * for is exactly the failure this module exists to prevent.
 */
export function evidenceIsTrustworthy() {
  return { ok: validated, error: lastValidationError };
}

/** Test seam. */
export function _reset() {
  if (log) log._reset();
  log = null;
  validated = false;
  lastValidationError = null;
}

function append(type, payload) {
  return evidence().append({ type, at: Date.now(), ...payload });
}

// ── Writers (mirrors of the store's evidence-bearing mutations) ─────────────

export const recordAirSessionOpened = (airSessionId, claimId, roomId, platform) =>
  append(EVIDENCE_TYPES.AIR_SESSION_OPENED, { airSessionId, claimId, roomId, platform });

export const recordPlaybackStarted = (airSessionId, win) =>
  append(EVIDENCE_TYPES.PLAYBACK_STARTED, {
    airSessionId, playbackId: win.playbackId, clipId: win.clipId,
    startedAt: win.startedAt, endsAt: win.endsAt,
    durationS: win.durationS, belowSamplingFloor: win.belowSamplingFloor,
  });

export const recordCodeIssued = (airSessionId, code) =>
  append(EVIDENCE_TYPES.CODE_ISSUED, {
    airSessionId, playbackId: code.playbackId, clipId: code.clipId,
    code: code.code, issuedAt: code.issuedAt, expiresAt: code.expiresAt,
  });

export const recordPlaybackEnded = (airSessionId, playbackId, endsAt) =>
  append(EVIDENCE_TYPES.PLAYBACK_ENDED, { airSessionId, playbackId, endsAt });

export const recordViewerSample = (airSessionId, sample) =>
  append(EVIDENCE_TYPES.VIEWER_SAMPLE, {
    airSessionId, playbackId: sample.playbackId || null, clipId: sample.clipId || null,
    handle: sample.handle, platform: sample.platform || 'twitch',
    live: sample.live, viewerCount: sample.viewerCount,
  });

/**
 * A frozen self-capture. Payouts are computed from frames read out of these,
 * so by this project's own rule — anything a payout is computed FROM is
 * evidence — the capture has to be in the chain, not just on disk.
 */
export const recordCaptureFrozen = (airSessionId, rec) =>
  append(EVIDENCE_TYPES.CAPTURE_FROZEN, {
    airSessionId, playbackId: rec.playbackId, clipId: rec.clipId,
    file: rec.file, bytes: rec.bytes, segments: rec.segments, spanMs: rec.spanMs,
    // Wall clock of the window's first segment, when the platform stamped one
    // (pump.fun does, per segment). This is what lets verification SKIP
    // timeline calibration: the offset is known, not measured.
    firstPdtMs: rec.firstPdtMs ?? null,
  });

/**
 * One obs-websocket visibility sample from the streamer's claim page.
 * `playbackId` is attributed server-side from the sample's timestamp, so a
 * client cannot claim its sample covers a playback it does not.
 */
export const recordObsSceneSample = (airSessionId, sample) =>
  append(EVIDENCE_TYPES.OBS_SCENE_SAMPLE, {
    airSessionId, playbackId: sample.playbackId || null,
    state: sample.state, visible: !!sample.visible, checked: !!sample.checked,
    sceneName: sample.sceneName || null, detail: sample.detail || null,
    rect: sample.rect || null, at: sample.at,
  });

/** The overlay page describing its own render environment. */
export const recordOverlayEnv = (airSessionId, env) =>
  append(EVIDENCE_TYPES.OVERLAY_ENV, {
    airSessionId, playbackId: env.playbackId || null,
    width: env.width ?? null, height: env.height ?? null,
    visibilityState: env.visibilityState || null,
    canvasAnomaly: !!env.canvasAnomaly, detail: env.detail || null, at: env.at,
  });

export const recordViolation = (airSessionId, violation) =>
  append(EVIDENCE_TYPES.VIOLATION, { airSessionId, ...violation });

export const recordVerificationEvidence = (attempt) =>
  append(EVIDENCE_TYPES.VERIFICATION, {
    airSessionId: attempt.airSessionId, verificationId: attempt.id,
    result: attempt.result, confidence: attempt.confidence,
    verifiedClips: attempt.verifiedClips, verifiedClipSeconds: attempt.verifiedClipSeconds,
    checker: attempt.checker,
  });

// ── Readers ────────────────────────────────────────────────────────────────

export function allEvidence() {
  return evidence().all();
}

export function evidenceFor(airSessionId) {
  return evidence().all().filter((r) => r.airSessionId === airSessionId);
}

/**
 * Rebuild an air session's playback windows + codes PURELY from evidence.
 * This is the authoritative view; the mutable store's copy is a convenience
 * cache. If the two ever disagree, evidence wins — and `reconcileWindows`
 * below is how that disagreement gets noticed instead of silently paid.
 */
export function rebuildWindows(airSessionId) {
  const rows = evidenceFor(airSessionId);
  const byPlayback = new Map();
  for (const r of rows) {
    if (r.type === EVIDENCE_TYPES.PLAYBACK_STARTED) {
      byPlayback.set(r.playbackId, {
        clipId: r.clipId, playbackId: r.playbackId,
        startedAt: r.startedAt, endsAt: r.endsAt,
        durationS: r.durationS, belowSamplingFloor: r.belowSamplingFloor,
        codes: [],
      });
    } else if (r.type === EVIDENCE_TYPES.CODE_ISSUED) {
      const w = byPlayback.get(r.playbackId);
      if (w) w.codes.push({ code: r.code, clipId: r.clipId, playbackId: r.playbackId, issuedAt: r.issuedAt, expiresAt: r.expiresAt });
    } else if (r.type === EVIDENCE_TYPES.PLAYBACK_ENDED) {
      const w = byPlayback.get(r.playbackId);
      if (w) {
        w.endsAt = r.endsAt;
        w.codes = w.codes.map((c) => ({ ...c, expiresAt: Math.min(c.expiresAt, r.endsAt) }));
      }
    }
  }
  return [...byPlayback.values()];
}

/**
 * Compare the mutable store's cached windows against the evidence log.
 * Divergence means the cache was damaged (or tampered with) — the caller
 * should refuse to pay rather than trust the cache.
 */
export function reconcileWindows(airSessionId, cachedWindows = []) {
  const truth = rebuildWindows(airSessionId);
  const codeCount = (ws) => ws.reduce((a, w) => a + (w.codes?.length || 0), 0);
  const diverged =
    truth.length !== cachedWindows.length || codeCount(truth) !== codeCount(cachedWindows);
  return {
    diverged,
    evidenceWindows: truth.length,
    cachedWindows: cachedWindows.length,
    evidenceCodes: codeCount(truth),
    cachedCodes: codeCount(cachedWindows),
  };
}

export { LedgerCorrupt };
