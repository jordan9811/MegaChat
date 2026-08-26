/**
 * VERIFICATION CONFIDENCE TIERS — does a human need to look?
 *
 * NOT PAYOUT SCALING. Every tier that passes pays exactly the same amount. The
 * tier decides whether a verified playback auto-verifies or routes to review,
 * and nothing else. Weighting payout by evidence quality would charge a
 * streamer for our own ability to observe them, which is the same mistake as
 * weighting by viewer count.
 *
 * ── WHAT EACH SIGNAL ACTUALLY PROVES ──────────────────────────────────────
 *
 * This matters more than the ordering, because two of these signals are
 * routinely described as proving more than they do.
 *
 * EXTERNAL CAPTURE (platform VOD / live HLS) — server-side read of the
 *   PLATFORM'S OWN copy. Proves the code aired publicly, and stays
 *   independently retrievable by someone who is not us. Highest, because it is
 *   auditable without trusting MegaChat.
 *
 * SELF-CAPTURE — server-side read of the PUBLIC stream (bounty-capture.js
 *   resolves the channel page, not the overlay). So it also proves the code
 *   aired publicly. It is a tier lower only because the artifact is OUR
 *   recording: an auditor has to trust that we recorded what we say we did.
 *
 *   ⚠ A NOTE ON A COMMON MISREADING: self-capture is sometimes described as
 *   "proves the overlay rendered, not that it was visible on the broadcast."
 *   That is true of capturing the overlay page. It is NOT true here. A source
 *   loaded but not in the active scene never reaches the public stream, so the
 *   badge simply would not be in the capture and the playback would not
 *   verify. The obvious cheat is already closed by where we read from.
 *
 * OBS SCENE CHECK — CLIENT-REPORTED, and therefore corroboration rather than
 *   proof. It comes from the streamer's own browser talking to their own OBS;
 *   a determined cheat can post whatever it likes. Its real value is against
 *   ACCIDENT, not fraud: it catches the honest streamer whose source is hidden
 *   or zero-area, and it turns "no badge found" from a mystery into a
 *   diagnosis. It can raise confidence; it must never be the only thing
 *   holding a verification up.
 *
 * OVERLAY ENVIRONMENT (canvas size, visibilityState) — same character:
 *   self-reported diagnostics. They distinguish "misconfigured" from "we could
 *   not look", which routes the streamer to the right outcome.
 *
 * The honest summary: tiers 1-3 all prove the clip aired. They differ in how
 * independently that can be checked later, and tier 4 is the case where the
 * evidence disagrees with itself.
 */
import { bountyConfig } from './bounty-claim.config.js';

export const TIER = {
  EXTERNAL: 1,       // platform's own copy carried the code
  OBS_CORROBORATED: 2, // self-capture carried it AND OBS said the source was live on screen
  SELF_CAPTURE: 3,   // self-capture carried it, nothing corroborating
  WARNED: 4,         // carried it, but a signal disagrees — a person looks
};

export const TIER_LABEL = {
  1: 'external capture (platform copy)',
  2: 'self-capture + OBS scene confirmed',
  3: 'self-capture',
  4: 'self-capture with warnings',
};

/** Reasons a playback drops to tier 4. Named so a reviewer acts in seconds. */
export const WARNINGS = {
  OVERLAY_NOT_VISIBLE: 'OVERLAY_NOT_VISIBLE',   // OBS: hidden, absent, or zero-area
  CANVAS_ANOMALY: 'CANVAS_ANOMALY',             // overlay rendered at an implausible size
  BELOW_QUALITY_FLOOR: 'BELOW_QUALITY_FLOOR',   // badge read but marginal
};

/**
 * DELIBERATELY NOT A WARNING: document.visibilityState.
 *
 * It is recorded — it is genuine evidence, and it is the kind that cannot be
 * reconstructed after the broadcast — but it does not route anyone to review,
 * because it is not specific enough to mean anything on its own.
 *
 * MEASURED, not assumed: the hardening gate renders the shipped overlay in
 * headless Chrome and it reports 'hidden' every time. So does a streamer who
 * opens the overlay URL in a background tab to check it, which is a completely
 * ordinary thing to do and harmless. Treating that as a warning sent EVERY
 * session in the gate to human review, including the ones that were perfect.
 *
 * A signal that fires on the good case is not a signal, it is a tax on the
 * honest. Kept in the evidence chain for a human reading a specific case;
 * kept out of the tier.
 */

/**
 * @param {object} a
 * @param {'external'|'capture'|'mixed'|null} a.frameOrigin where the verifying
 *   frames came from.
 * @param {{visible:boolean, checked:boolean, detail?:string}} a.obsScene
 * @param {{canvasAnomaly?:boolean, pageHidden?:boolean, detail?:string}} a.overlayEnv
 * @param {boolean} a.belowQualityFloor
 * @param {boolean} a.streamContextOk stream-context (warmup/tail) passed.
 */
export function evaluateConfidence({
  frameOrigin = null,
  obsScene = { checked: false, visible: false },
  overlayEnv = {},
  belowQualityFloor = false,
  streamContextOk = true,
  config = bountyConfig,
} = {}) {
  const warnings = [];
  if (obsScene.checked && !obsScene.visible) warnings.push(WARNINGS.OVERLAY_NOT_VISIBLE);
  if (overlayEnv.canvasAnomaly) warnings.push(WARNINGS.CANVAS_ANOMALY);
  // overlayEnv.pageHidden is recorded but NOT a warning — see the note above.
  if (belowQualityFloor) warnings.push(WARNINGS.BELOW_QUALITY_FLOOR);

  let tier;
  if (warnings.length) {
    // A signal disagrees with the verification. The clip may well have aired —
    // it is not denied, a person just looks.
    tier = TIER.WARNED;
  } else if (frameOrigin === 'external') {
    tier = TIER.EXTERNAL;
  } else if (frameOrigin === 'capture' && obsScene.checked && obsScene.visible) {
    tier = TIER.OBS_CORROBORATED;
  } else if (frameOrigin === 'capture' || frameOrigin === 'mixed') {
    tier = TIER.SELF_CAPTURE;
  } else {
    // No idea where the frames came from — do not guess in the generous
    // direction on something that decides whether anyone checks.
    tier = TIER.WARNED;
    warnings.push('UNKNOWN_FRAME_ORIGIN');
  }

  // Tier 3 leans on the stream-context rules to do the work OBS would have
  // done, so if context did not pass there is nothing left holding it up.
  const autoVerify = tier === TIER.EXTERNAL
    || tier === TIER.OBS_CORROBORATED
    || (tier === TIER.SELF_CAPTURE && streamContextOk && config.tier3AutoVerify !== false);

  return {
    tier,
    label: TIER_LABEL[tier],
    autoVerify,
    needsReview: !autoVerify,
    warnings,
    summary: describeConfidence({ tier, warnings, autoVerify }),
  };
}

/** One line a reviewer can act on. */
export function describeConfidence({ tier, warnings = [], autoVerify }) {
  const base = `tier ${tier} — ${TIER_LABEL[tier]}`;
  if (!warnings.length) return `${base}; ${autoVerify ? 'auto-verified' : 'needs review'}`;
  return `${base}; needs review: ${warnings.join(', ')}`;
}

/**
 * Was the overlay plausibly full-canvas? The overlay reports its own
 * window.innerWidth/Height, and a browser source shrunk to nothing still
 * renders — it just renders where nobody can read it.
 *
 * Deliberately loose. Streamers run 1080p, 1440p, vertical, ultrawide and
 * odd custom canvases, and a false CANVAS_ANOMALY sends an honest streamer to
 * review for owning a nice monitor. Only the genuinely absurd is flagged.
 */
export function canvasLooksWrong({ width, height, config = bountyConfig } = {}) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (!w || !h) return { anomaly: true, detail: 'overlay reported no dimensions' };
  if (w < config.overlayMinCanvasPx || h < config.overlayMinCanvasPx) {
    return { anomaly: true, detail: `overlay rendered at ${w}x${h}, below the ${config.overlayMinCanvasPx}px floor` };
  }
  return { anomaly: false, detail: `${w}x${h}` };
}

/**
 * Fold visibility samples down to one verdict ABOUT THE PLAYBACKS THAT EARNED
 * MONEY, not about the session as a whole.
 *
 * The distinction is the whole design. A streamer who hides the overlay while
 * chatting between MegaChats has done nothing wrong — the overlay only has to
 * be on screen while a clip is playing, because that is the only time it
 * carries a code. Judging the session would flag the normal case; judging the
 * earning playbacks flags the actual problem.
 *
 * Samples with no playbackId (taken between clips) are therefore counted for
 * coverage but never held against anyone.
 *
 * @param {Array} samples  OBS_SCENE_SAMPLE records, server-attributed.
 * @param {Array<string>} verifiedPlaybackIds playbacks that verified.
 */
export function foldSceneSamples(samples = [], verifiedPlaybackIds = []) {
  const wanted = new Set(verifiedPlaybackIds.filter(Boolean));
  const during = samples.filter((s) => s.playbackId && wanted.has(s.playbackId));
  const conclusive = during.filter((s) => s.checked
    && (s.state === 'VISIBLE' || NOT_VISIBLE_STATES.has(s.state)));

  if (!conclusive.length) {
    // Either no obs-websocket, or it never answered during a paying playback.
    // Blameless: this is the manual-paste streamer's normal state.
    return {
      checked: false,
      visible: false,
      samples: during.length,
      detail: samples.length
        ? 'OBS was connected but gave no conclusive answer during a verified playback'
        : 'no obs-websocket connection (manual setup) — not a warning',
    };
  }
  const bad = conclusive.filter((s) => NOT_VISIBLE_STATES.has(s.state));
  if (bad.length) {
    const byState = {};
    for (const s of bad) byState[s.state] = (byState[s.state] || 0) + 1;
    return {
      checked: true,
      visible: false,
      samples: conclusive.length,
      // Name the state, not just the count. A reviewer seeing NOT_IN_SCENE
      // tells the streamer to drag the source into their live scene; seeing
      // ZERO_AREA tells them to resize it. Those are different support replies.
      detail: `${bad.length}/${conclusive.length} sample(s) during verified playbacks reported `
        + Object.entries(byState).map(([k, n]) => `${k}×${n}`).join(', ')
        + (bad[0].detail ? ` — e.g. ${bad[0].detail}` : ''),
    };
  }
  return {
    checked: true,
    visible: true,
    samples: conclusive.length,
    detail: `${conclusive.length} sample(s) confirmed the overlay on screen during verified playbacks`,
  };
}

const NOT_VISIBLE_STATES = new Set(['HIDDEN', 'NOT_IN_SCENE', 'ZERO_AREA', 'OFF_CANVAS']);

/**
 * Fold overlay self-reports the same way: only what the overlay said while a
 * paying clip was on screen can count against a verification.
 */
export function foldOverlayEnv(samples = [], verifiedPlaybackIds = []) {
  const wanted = new Set(verifiedPlaybackIds.filter(Boolean));
  const during = samples.filter((s) => s.playbackId && wanted.has(s.playbackId));
  if (!during.length) return { checked: false, canvasAnomaly: false, pageHidden: false, detail: 'no overlay self-reports during verified playbacks' };

  const anomalous = during.filter((s) => s.canvasAnomaly);
  const hidden = during.filter((s) => s.visibilityState === 'hidden');
  const bits = [];
  if (anomalous.length) bits.push(`canvas: ${anomalous[0].detail || 'implausible size'} (${anomalous.length}/${during.length})`);
  if (hidden.length) bits.push(`document hidden on ${hidden.length}/${during.length} report(s)`);
  return {
    checked: true,
    canvasAnomaly: anomalous.length > 0,
    pageHidden: hidden.length > 0,
    detail: bits.length ? bits.join('; ') : `${during.length} report(s), nothing anomalous`,
  };
}
