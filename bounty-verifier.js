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
import { bountyConfig } from './bounty-claim.config.js';
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
 */
function sampleInstantsForWindow(win, perClip) {
  const usable = win.codes.filter((c) => c.expiresAt > c.issuedAt);
  if (usable.length === 0) return [];
  const picks = [];
  const step = Math.max(1, Math.floor(usable.length / perClip));
  for (let i = 0; i < usable.length && picks.length < perClip; i += step) {
    const c = usable[i];
    picks.push({
      ts: Math.floor((c.issuedAt + Math.min(c.expiresAt, c.issuedAt + bountyConfig.codeValidityMs)) / 2),
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
export async function verifyAirSession(airSessionId, { frameSource, codeChecker } = {}) {
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

  const perClip = Math.max(1, Math.floor(bountyConfig.sampleSize / windows.length));
  const checks = [];
  const clipVerdicts = [];

  for (const win of windows) {
    const instants = sampleInstantsForWindow(win, perClip);
    let frames;
    try {
      frames = await fs_.getFrames(session.platform, session.handle || '', instants);
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

    for (const frame of frames) {
      // Only codes bound to THIS clip and valid at this instant are accepted.
      const expected = win.codes
        .filter((c) => c.issuedAt <= frame.ts && c.expiresAt > frame.ts)
        .map((c) => c.code);
      if (expected.length === 0) continue;

      const res = await cc.findCode(frame, expected);
      const px = Number(res.pixelHeight ?? res.bbox?.h ?? 0);
      // Legibility enforcement: found but unreadably small is NOT a pass.
      const legible = px >= bountyConfig.minCodePixelHeight;
      const counted = !!res.found && legible;
      if (!legible && res.found) tooSmall += 1;

      clipChecks += 1;
      clipConf += Number(res.confidence || 0);
      if (counted) clipHits += 1;
      checks.push({
        ts: frame.ts, ref: frame.ref, clipId: win.clipId, playbackId: win.playbackId,
        found: !!res.found, confidence: res.confidence, pixelHeight: px,
        legible, counted,
      });
    }

    const conf = clipChecks ? clipConf / clipChecks : 0;
    // A clip counts as verified when at least one legible sample found its code.
    const verified = clipHits > 0;
    clipVerdicts.push({
      clipId: win.clipId, playbackId: win.playbackId, verified, samples: clipChecks, hits: clipHits,
      confidence: +conf.toFixed(3), tooSmall, durationS: win.durationS,
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
  const avgConfidence = checks.length
    ? checks.reduce((a, c) => a + (c.confidence || 0), 0) / checks.length
    : 0;
  const hitRate = clipVerdicts.length ? verifiedClips / clipVerdicts.length : 0;

  let result;
  if (checks.length === 0) result = 'NO_FRAMES';
  else if (verifiedClips === 0 && checks.some((c) => c.found && !c.legible)) result = 'FAIL_TOO_SMALL';
  else if (verifiedClips === 0) result = 'FAIL';
  else if (avgConfidence < bountyConfig.minConfidence) result = 'AMBIGUOUS';
  else if (hitRate >= 0.999) result = 'PASS';
  else result = 'PARTIAL';

  const attempt = store.recordVerification({
    airSessionId, checker: checkerName,
    evidenceRef: checks.map((c) => c.ref).join(',') || null,
    result, confidence: +avgConfidence.toFixed(3),
    verifiedMinutes: +(verifiedClipSeconds / 60).toFixed(3),
    verifiedClips, verifiedClipSeconds,
  });
  store.updateAirSession(airSessionId, {
    verifiedClips, verifiedClipSeconds,
    verifiedMinutes: +(verifiedClipSeconds / 60).toFixed(3),
  });

  return {
    result, confidence: +avgConfidence.toFixed(3),
    verifiedClips, verifiedClipSeconds,
    verifiedMinutes: +(verifiedClipSeconds / 60).toFixed(3),
    hitRate, attempt, checks, clipVerdicts,
    skippedBelowFloor: skippedShort.length,
  };
}
