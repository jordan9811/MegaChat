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
import * as ev from './bounty-evidence.js';
import { canvasLooksWrong } from './bounty-confidence.js';

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
/**
 * Which window does a "this clip ended" call mean?
 *
 * Prefer an explicit playbackId; otherwise the most recent STILL-OPEN window
 * for this clip. Never `.find()` by clipId alone — that returns the FIRST
 * window and would close (or write into) a previous airing of the same clip.
 *
 * Exported because the freeze needs the same answer the close does: naming a
 * capture after the clip when the evidence row names it after the playback
 * left the two unable to find each other, and the verifier could not tell
 * which window a capture covered.
 */
export function openWindowFor(airSessionId, { clipId, playbackId, now = Date.now() } = {}) {
  const s = store.getAirSession(airSessionId);
  if (!s) return null;
  const wins = s.playbackWindows || [];
  return (playbackId
    ? wins.find((w) => w.playbackId === playbackId)
    // GRACE AT THE BOUNDARY. `endsAt > now` looks right and quietly fails the
    // most ordinary case there is: a clip that plays for exactly its declared
    // duration arrives here with endsAt == now, so the window "already ended"
    // and no playbackId resolves. The capture is then filed under the clip id
    // instead of the playback id, and the frame source — which routes a probe
    // to its capture BY playback id — falls back to nearest-by-time and can
    // hand calibration the wrong window's file. Observed on Kick: only 3 of 5
    // windows were measurable.
    //
    // The grace is one clip-rotation wide, which cannot collide with a later
    // airing of the same clip: `reverse()` already takes the most recent, and
    // a re-airing would have to start inside that window to be confused with
    // this one — which the playback-bound design forbids outright.
    : [...wins].reverse().find((w) => w.clipId === clipId
        && w.endsAt > now - bountyConfig.codeRotateMs)) || null;
}

export function endClipPlayback(airSessionId, { clipId, playbackId, now = Date.now() } = {}) {
  const s = store.getAirSession(airSessionId);
  if (!s) return null;
  const win = openWindowFor(airSessionId, { clipId, playbackId, now });
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

/**
 * Attribute a client-reported sample to the playback window covering it.
 *
 * SERVER-SIDE ON PURPOSE. If the client named its own playbackId it could
 * claim a "visible" sample covers a playback during which the overlay was
 * hidden, which is the one thing this signal must not let it do cheaply.
 * The client supplies a timestamp; we decide what it covers.
 *
 * Timestamps are clamped to now — a clock-skewed or hand-edited client cannot
 * post samples into the future to cover playbacks that have not happened.
 */
function playbackIdAt(session, at) {
  const t = Math.min(Number(at) || 0, Date.now());
  // The window's end field is `endsAt` — set to the clip's scheduled end at
  // start and TRUNCATED to the real end when the playback closes. Reading a
  // field that does not exist made every window look open, so every sample
  // attributed to the FIRST clip of the session regardless of when it arrived.
  const w = (session.playbackWindows || []).find(
    (win) => t >= win.startedAt && t <= win.endsAt,
  );
  return w ? w.playbackId : null;
}

/** Keep the session record readable; evidence holds the full history. */
const SAMPLE_TAIL = 50;

/**
 * Record one OBS scene-item visibility sample.
 *
 * Records, and does not judge. A NOT_VISIBLE sample is not a violation and
 * must never read as one: the streamer may be mid scene-switch, or between
 * clips, or running a starting-soon screen. Whether it MATTERS is decided at
 * verification time, against the playbacks that actually earned money.
 */
export function recordObsScene(airSessionId, sample = {}) {
  const s = store.getAirSession(airSessionId);
  if (!s) throw new Error(`No air session ${airSessionId}`);
  const at = Math.min(Number(sample.at) || Date.now(), Date.now());
  const rec = {
    at,
    playbackId: playbackIdAt(s, at),
    state: String(sample.state || 'ERROR'),
    visible: !!sample.visible,
    checked: !!sample.checked,
    sceneName: sample.sceneName || null,
    detail: sample.detail || null,
    rect: sample.rect || null,
  };
  const tail = [...(s.obsSceneSamples || []), rec].slice(-SAMPLE_TAIL);
  store.updateAirSession(airSessionId, {
    obsSceneSamples: tail,
    obsSceneLast: { at: rec.at, state: rec.state, visible: rec.visible, detail: rec.detail },
  });
  ev.recordObsSceneSample(airSessionId, rec);
  return rec;
}

/**
 * Record the overlay page's own view of its render environment: the canvas it
 * was handed, and whether the document was hidden.
 *
 * `document.visibilityState` in an OBS browser source is 'visible' whenever
 * the source is rendering, INCLUDING while it sits in a non-active scene with
 * shutdown-when-not-visible off — which is how we configure it. So 'hidden'
 * here means something quite specific (the source was stopped, or the overlay
 * is open in a background browser tab rather than in OBS at all) and is worth
 * a look; 'visible' proves considerably less than it sounds like it does.
 */
export function recordOverlayEnv(airSessionId, env = {}) {
  const s = store.getAirSession(airSessionId);
  if (!s) throw new Error(`No air session ${airSessionId}`);
  const at = Math.min(Number(env.at) || Date.now(), Date.now());
  const { anomaly, detail } = canvasLooksWrong({ width: env.width, height: env.height });
  const rec = {
    at,
    playbackId: playbackIdAt(s, at),
    width: Number(env.width) || null,
    height: Number(env.height) || null,
    visibilityState: env.visibilityState === 'hidden' ? 'hidden' : 'visible',
    canvasAnomaly: anomaly,
    detail,
  };
  const tail = [...(s.overlayEnvSamples || []), rec].slice(-SAMPLE_TAIL);
  store.updateAirSession(airSessionId, {
    overlayEnvSamples: tail,
    overlayEnvLast: {
      at: rec.at, width: rec.width, height: rec.height,
      visibilityState: rec.visibilityState, canvasAnomaly: rec.canvasAnomaly,
    },
  });
  ev.recordOverlayEnv(airSessionId, rec);
  return rec;
}

export function clearBadgeViolation(airSessionId) {
  const s = store.getAirSession(airSessionId);
  if (!s) throw new Error(`No air session ${airSessionId}`);
  store.updateAirSession(airSessionId, { badgeTooSmall: false });
  return store.getAirSession(airSessionId);
}
