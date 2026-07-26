/**
 * CREATOR BOUNTY — playback-bound watermark issuance.
 *
 * ── The model (revised) ───────────────────────────────────────────────────
 * Codes exist ONLY while a clip is playing, and every code is bound to the
 * specific clip that was on screen when it was issued. A frame containing
 * code X therefore proves clip Y aired at that timestamp, because X only ever
 * existed inside Y's playback window.
 *
 * This collapses two artifacts into one. The rejected alternative — counting
 * airtime and separately trusting a "a clip played" event — would have put
 * the money on the unverifiable half of a pair that can disagree. Same trust
 * shape as a client-reported session ledger, which this codebase has already
 * paid to learn about.
 *
 * Consequences that fall out of it, all deliberate:
 *  - A parked overlay with nothing playing issues NO codes, so it renders
 *    nothing verifiable and accrues nothing.
 *  - Rotation is per-clip and fast (~4s), because MegaChat tiles live ~10s.
 *    The old 60s wall-clock rotation would have left most clips carrying no
 *    code at all and failed honest streamers.
 *  - Validity is CLAMPED to the clip's own end, so windows for different
 *    clips can never overlap and one sampled frame can never satisfy two.
 *  - A clip too short to host a samplable code is recorded as
 *    BELOW_SAMPLING_FLOOR and pays nothing, rather than being paid for on
 *    evidence we cannot actually check.
 */

import { randomInt, createHash, randomUUID } from 'crypto';
import { bountyConfig } from './bounty-claim.config.js';
import * as store from './bounty-store.js';

/** No 0/O, 1/I/L, 5/S, 8/B, 2/Z — unambiguous when downscaled. */
const ALPHABET = '34679ACDEFGHJKMNPQRTUVWXY';

function randomBody(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[randomInt(0, ALPHABET.length)];
  return s;
}

/**
 * PLAYBACK-scoped namespace, derived server-side from
 * (airSessionId, playbackId) where playbackId = clipId + a per-playback nonce.
 *
 * Why not clip-scoped: the same clip can legitimately air twice in one
 * session. Keying on clipId alone made the second airing indistinguishable
 * from the first — same namespace, and (before this fix) the second playback
 * wrote into the FIRST playback's already-closed window and issued no codes at
 * all, so an honest streamer replaying a clip earned nothing for it. Keying on
 * the playback instance makes each airing independently attestable.
 */
export function namespaceFor(airSessionId, playbackId) {
  const h = createHash('sha256').update(`${airSessionId}:${playbackId}`).digest('hex').toUpperCase();
  let ns = '';
  for (const ch of h) {
    if (ALPHABET.includes(ch)) ns += ch;
    if (ns.length === 2) break;
  }
  while (ns.length < 2) ns += ALPHABET[randomInt(0, ALPHABET.length)];
  return ns;
}

/** The clip window currently open on this session, or null. */
export function activeWindow(airSessionId, { now = Date.now() } = {}) {
  const s = store.getAirSession(airSessionId);
  if (!s) return null;
  const w = (s.playbackWindows || []).find((x) => x.startedAt <= now && now < x.endsAt);
  return w || null;
}

/**
 * A clip started playing. Opens its playback window and issues the first
 * code immediately (issue on clip-start, never on a wall-clock tick).
 *
 * Returns { window, code } — or { window, code: null } when the clip is below
 * the sampling floor, which is recorded rather than silently paid.
 */
export function startClipPlayback(airSessionId, { clipId, durationS, now = Date.now() }) {
  const s = store.getAirSession(airSessionId);
  if (!s) throw new Error(`No air session ${airSessionId}`);
  if (s.status !== 'OPEN') return null;

  const durMs = Math.max(0, Number(durationS) || 0) * 1000;
  const belowFloor = (durMs / 1000) < bountyConfig.minClipSeconds;

  // Per-playback identity. Two airings of the same clip are two separate
  // pieces of evidence and must never share a code space.
  const playbackId = `${clipId}#${randomUUID().slice(0, 8)}`;

  const win = {
    clipId,
    playbackId,
    startedAt: now,
    endsAt: now + durMs,
    durationS: durMs / 1000,
    belowSamplingFloor: belowFloor,
    codes: [],
  };
  store.pushPlaybackWindow(airSessionId, win);

  if (belowFloor) {
    store.pushAirSessionViolation(airSessionId, {
      type: 'BELOW_SAMPLING_FLOOR',
      at: now,
      detail: { clipId, playbackId, durationS: durMs / 1000, floorS: bountyConfig.minClipSeconds },
    });
    return { window: win, playbackId, code: null, reason: 'BELOW_SAMPLING_FLOOR' };
  }

  const code = issueCodeForWindow(airSessionId, playbackId, { now });
  return { window: win, playbackId, code };
}

/** The clip finished (or was cut short). Closes the window at `now`. */
export function endClipPlayback(airSessionId, { clipId, playbackId, now = Date.now() } = {}) {
  const s = store.getAirSession(airSessionId);
  if (!s) return null;
  // Prefer an explicit playbackId; otherwise close the most recent STILL-OPEN
  // window for this clip. Never `.find()` by clipId alone — that returns the
  // first window and would close (or write into) a previous airing.
  const wins = (s.playbackWindows || []);
  const win = playbackId
    ? wins.find((w) => w.playbackId === playbackId)
    : [...wins].reverse().find((w) => w.clipId === clipId && w.endsAt > now);
  if (!win) return null;
  // Truncate the window AND any code validity that ran past the real end —
  // a code must never be checkable after its clip left the screen.
  store.updatePlaybackWindow(airSessionId, win.playbackId, {
    endsAt: now,
    codes: win.codes.map((c) => ({ ...c, expiresAt: Math.min(c.expiresAt, now) })),
  });
  return store.getAirSession(airSessionId);
}

/**
 * Issue a code inside an OPEN clip window. Validity is clamped to the clip's
 * end so windows cannot overlap across clips.
 */
export function issueCodeForWindow(airSessionId, playbackId, { now = Date.now() } = {}) {
  const s = store.getAirSession(airSessionId);
  if (!s || s.status !== 'OPEN') return null;
  if (s.badgeTooSmall) return null; // early-warning halt; see reportBadgeTooSmall

  const win = (s.playbackWindows || []).find((w) => w.playbackId === playbackId);
  if (!win || win.belowSamplingFloor) return null;
  if (now < win.startedAt || now >= win.endsAt) return null;

  const ns = namespaceFor(airSessionId, playbackId);
  const live = new Set(store.allIssuedCodes());
  let code = null;
  for (let i = 0; i < 50; i++) {
    const candidate = `${ns}-${randomBody(bountyConfig.codeLength)}`;
    if (!live.has(candidate)) { code = candidate; break; }
  }
  if (!code) throw new Error('Could not allocate a unique watermark code');

  const rec = {
    code,
    clipId: win.clipId,
    playbackId,
    issuedAt: now,
    // Clamped: never valid past the airing it belongs to.
    expiresAt: Math.min(now + bountyConfig.codeValidityMs, win.endsAt),
  };
  store.pushWindowCode(airSessionId, playbackId, rec);
  return rec;
}

/**
 * What the overlay should render right now. Returns null when no clip is
 * playing — which is the whole point: a parked overlay shows nothing.
 */
export function currentOrRotate(airSessionId, { now = Date.now() } = {}) {
  const s = store.getAirSession(airSessionId);
  if (!s || s.status !== 'OPEN' || s.badgeTooSmall) return null;
  const win = activeWindow(airSessionId, { now });
  if (!win || win.belowSamplingFloor) return null;

  const last = win.codes[win.codes.length - 1];
  if (!last || now - last.issuedAt >= bountyConfig.codeRotateMs) {
    return issueCodeForWindow(airSessionId, win.playbackId, { now });
  }
  return last;
}

/** Codes valid at an instant. Used by the verifier to check a sampled frame. */
export function codesValidAt(airSessionId, ts) {
  const s = store.getAirSession(airSessionId);
  if (!s) return [];
  const out = [];
  for (const w of s.playbackWindows || []) {
    for (const c of w.codes) {
      if (c.issuedAt <= ts && c.expiresAt > ts) out.push(c);
    }
  }
  return out;
}

/** Every code issued in this session, flattened. */
export function allSessionCodes(airSessionId) {
  const s = store.getAirSession(airSessionId);
  if (!s) return [];
  return (s.playbackWindows || []).flatMap((w) => w.codes);
}

/**
 * Overlay self-report that its badge is too small to read.
 *
 * This is an EARLY WARNING for an honest streamer, not enforcement. A page
 * cannot observe its own OBS scene transform, so this catches a small
 * browser-source resolution and nothing else. Real enforcement is the
 * verifier's measured-height check (bountyConfig.minCodePixelHeight), which
 * runs on the actual broadcast frame where the money is decided.
 */
export function reportBadgeTooSmall(airSessionId, detail) {
  const s = store.getAirSession(airSessionId);
  if (!s) throw new Error(`No air session ${airSessionId}`);
  store.pushAirSessionViolation(airSessionId, {
    type: 'BADGE_TOO_SMALL_SELF_REPORT',
    at: Date.now(),
    detail: detail || null,
  });
  store.updateAirSession(airSessionId, { badgeTooSmall: true });
  return store.getAirSession(airSessionId);
}

export function clearBadgeViolation(airSessionId) {
  const s = store.getAirSession(airSessionId);
  if (!s) throw new Error(`No air session ${airSessionId}`);
  store.updateAirSession(airSessionId, { badgeTooSmall: false });
  return store.getAirSession(airSessionId);
}
