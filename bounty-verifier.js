/**
 * CREATOR BOUNTY — verifier pipeline.
 *
 * Samples an air session's issued codes, asks a FrameSource for public stream
 * frames at those timestamps, asks a CodeChecker whether the expected code is
 * visible, and folds the results into verified-minutes + a confidence score.
 *
 * Both external edges are interfaces. Run A ships ONLY the mock
 * implementations, driven by a fixture so pass / fail / partial / ambiguous
 * are deterministic. The real implementations are deliberately empty: I have
 * not seen Twitch's or Kick's clip/VOD APIs in this codebase and guessing at
 * their shape would mean building three things on top of an invented
 * contract. See OPEN-ISSUES.md.
 */

import fs from 'fs';
import { bountyConfig } from './bounty-claim.config.js';
import * as store from './bounty-store.js';

// ── Interfaces ──────────────────────────────────────────────────────────────

/**
 * @typedef {{ ref:string, ts:number, platform:string, handle:string }} FrameRef
 */

export class FrameSource {
  /**
   * @param {string} _platform @param {string} _handle @param {number[]} _timestamps
   * @returns {Promise<FrameRef[]>}
   */
  async getFrames(_platform, _handle, _timestamps) { throw new Error('not implemented'); }
}

export class CodeChecker {
  /**
   * @param {FrameRef} _frameRef @param {string[]} _expectedCodes
   * @returns {Promise<{found:boolean, confidence:number}>}
   */
  async findCode(_frameRef, _expectedCodes) { throw new Error('not implemented'); }
}

// ── Real implementations: NOT in Run A ──────────────────────────────────────

/**
 * TODO(run-b): implement against the real platform APIs.
 * Needs: a registered app + credentials per platform, the actual VOD/clip
 * endpoint shapes, and a decision on whether frames come from VOD segments
 * (delayed, reliable) or live HLS (immediate, lossy). Do NOT guess — a wrong
 * assumption here invalidates every verification built on top of it.
 */
export class TwitchFrameSource extends FrameSource {}
/** TODO(run-b): same, for Kick. No public API contract confirmed. */
export class KickFrameSource extends FrameSource {}
/**
 * TODO(run-b): real OCR / template match against the badge region.
 * Open question logged in OPEN-ISSUES.md: whether to OCR the whole frame or
 * crop to the badge's expected position (faster, but breaks if the streamer
 * repositions the browser source, which they are allowed to do).
 */
export class OcrCodeChecker extends CodeChecker {}

// ── Mocks (Run A) ───────────────────────────────────────────────────────────

/**
 * Fixture shape:
 * {
 *   "frames": { "<ts>": { "available": true } },      // optional per-timestamp
 *   "defaultAvailable": true,
 *   "checks": [ { "found": true, "confidence": 0.95 }, ... ]  // consumed in order
 *   "defaultCheck": { "found": false, "confidence": 0.2 }
 * }
 */
export function loadFixture(pathOrObject) {
  if (!pathOrObject) return null;
  if (typeof pathOrObject === 'object') return pathOrObject;
  try {
    return JSON.parse(fs.readFileSync(pathOrObject, 'utf8'));
  } catch {
    return null;
  }
}

export class MockFrameSource extends FrameSource {
  constructor(fixture = null) { super(); this.fixture = fixture || {}; }
  async getFrames(platform, handle, timestamps) {
    const out = [];
    for (const ts of timestamps) {
      const perTs = this.fixture.frames?.[String(ts)];
      const available = perTs ? perTs.available !== false : this.fixture.defaultAvailable !== false;
      if (!available) continue; // frame genuinely unavailable (stream gap, VOD trimmed)
      out.push({ ref: `mock://${platform}/${handle}/${ts}`, ts, platform, handle });
    }
    return out;
  }
}

export class MockCodeChecker extends CodeChecker {
  constructor(fixture = null) {
    super();
    this.fixture = fixture || {};
    this.cursor = 0;
  }
  async findCode(_frameRef, _expectedCodes) {
    const scripted = this.fixture.checks?.[this.cursor];
    this.cursor += 1;
    if (scripted) return { found: !!scripted.found, confidence: Number(scripted.confidence ?? 0) };
    const d = this.fixture.defaultCheck || { found: false, confidence: 0.2 };
    return { found: !!d.found, confidence: Number(d.confidence ?? 0) };
  }
}

// ── Pipeline ────────────────────────────────────────────────────────────────

/**
 * Evenly sample up to `sampleSize` codes across the session so verification
 * reflects the whole broadcast rather than clustering at the start (a
 * streamer showing the badge for 60s then hiding it must not verify as a
 * full session).
 */
function sampleCodes(codes, sampleSize) {
  if (codes.length <= sampleSize) return [...codes];
  const step = codes.length / sampleSize;
  const out = [];
  for (let i = 0; i < sampleSize; i++) out.push(codes[Math.floor(i * step)]);
  return out;
}

/**
 * Verify one air session.
 *
 * verifiedMinutes is derived from the PROPORTION of sampled codes actually
 * found on screen, applied to the session's wall-clock duration — not from a
 * raw count of hits. A session where 3 of 10 samples pass earns 30% of its
 * elapsed minutes, which is the honest reading of "how much of this broadcast
 * actually carried the badge".
 */
export async function verifyAirSession(airSessionId, { frameSource, codeChecker, now = Date.now() } = {}) {
  const session = store.getAirSession(airSessionId);
  if (!session) throw new Error(`No air session ${airSessionId}`);

  const fs_ = frameSource || new MockFrameSource(loadFixture(bountyConfig.fixturePath));
  const cc = codeChecker || new MockCodeChecker(loadFixture(bountyConfig.fixturePath));
  const checkerName = cc.constructor.name;

  const sampled = sampleCodes(session.codes, bountyConfig.sampleSize);
  if (sampled.length === 0) {
    const rec = store.recordVerification({
      airSessionId, checker: checkerName, evidenceRef: null,
      result: 'NO_CODES', confidence: 0, verifiedMinutes: 0,
    });
    return { result: 'NO_CODES', confidence: 0, verifiedMinutes: 0, attempt: rec, checks: [] };
  }

  // Sample mid-window: a code issued at T is on screen from T onward, so the
  // safest instant to look is shortly after issue, not exactly at it.
  const timestamps = sampled.map((c) => c.issuedAt + Math.min(5_000, bountyConfig.codeRotateMs / 2));
  const frames = await fs_.getFrames(session.platform, session.handle || '', timestamps);

  const checks = [];
  for (const frame of frames) {
    const expected = store.getAirSession(airSessionId).codes
      .filter((c) => c.issuedAt <= frame.ts && c.expiresAt > frame.ts)
      .map((c) => c.code);
    if (expected.length === 0) continue;
    const res = await cc.findCode(frame, expected);
    checks.push({ ts: frame.ts, ref: frame.ref, ...res });
  }

  const attempted = sampled.length;
  const hits = checks.filter((c) => c.found);
  const hitRate = attempted ? hits.length / attempted : 0;
  const avgConfidence = checks.length
    ? checks.reduce((a, c) => a + c.confidence, 0) / checks.length
    : 0;

  const endedAt = session.endedAt || now;
  const elapsedMin = Math.max(0, (endedAt - session.startedAt) / 60_000);
  const verifiedMinutes = +(elapsedMin * hitRate).toFixed(3);

  // Ambiguous: the checker found things but isn't sure. Distinct from a clean
  // fail, because it should route to review rather than silently pay zero.
  let result;
  if (checks.length === 0) result = 'NO_FRAMES';
  else if (hitRate === 0) result = 'FAIL';
  else if (avgConfidence < bountyConfig.minConfidence) result = 'AMBIGUOUS';
  else if (hitRate >= 0.999) result = 'PASS';
  else result = 'PARTIAL';

  const attempt = store.recordVerification({
    airSessionId, checker: checkerName,
    evidenceRef: checks.map((c) => c.ref).join(',') || null,
    result, confidence: +avgConfidence.toFixed(3), verifiedMinutes,
  });
  store.updateAirSession(airSessionId, { verifiedMinutes });

  return { result, confidence: +avgConfidence.toFixed(3), verifiedMinutes, hitRate, attempt, checks };
}
