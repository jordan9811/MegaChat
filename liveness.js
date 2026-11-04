/**
 * LIVENESS TIERS — how protected is money that rides on a broadcast?
 *
 * The owner's idea (OPEN-ISSUES O, built 2026-11-04): badge verification is
 * the adversarial proof that a clip aired, but it runs only while a clip
 * plays. Between clips, before the first one, and for a streamer who claimed
 * a pool and then forgot the overlay, nothing said anything. A tier is a
 * label on which check stands behind the money RIGHT NOW, read from signals
 * the server already has; it is not a new verification.
 *
 *   off     not live.
 *   red     the channel is live (Twitch says so, or an airing is open) but the
 *           room's KEYED overlay is not on the broadcast: nothing can air,
 *           nothing counts. "Naked."
 *   yellow  the room is on air and its keyed overlay is connected (or was in
 *           the last ten minutes). Hollers air; campaigns count; a pledge
 *           whose backer allowed the yellow tier can release on a finished
 *           broadcast that kept the overlay up for BOUNTY_YELLOW_MIN_MS
 *           (bounty-escrow.js release, tier 'yellow'). Cheap, continuous,
 *           and it protects against FORGETTING, not against fraud: an
 *           overlay loaded in a browser tab that is not on the stream looks
 *           the same. "Half-baked."
 *   green   on air, overlay connected, and a bounty air session is open for
 *           the room: the badge is being issued and read off the real
 *           frames. "Bounty-grade."
 *
 * Pure. server.js composes the signals (overlayKeyState, openAiringFor, the
 * follow loop, the bounty air sessions) and samples the overlay into the
 * open airing every LIVENESS_SAMPLE_MS (airings-store.js
 * recordOverlaySample); the yellow release reads that record when the
 * broadcast ends.
 */

export const TIERS = ['off', 'red', 'yellow', 'green'];
export const TIER_LABEL = { off: 'Offline', red: 'Live, no overlay', yellow: 'Overlay up', green: 'Badge-verified' };
/** The tiers a backer can require of their pledge (green = badge only, the default; yellow = overlay check or better). */
export const BACKER_TIERS = ['green', 'yellow'];

export function tierRank(t) { return Math.max(0, TIERS.indexOf(t)); }
/** Does `actual` satisfy a backer's `required` minimum? */
export function meetsTier(actual, required) { return tierRank(actual) >= tierRank(required); }

/**
 * The tier from the signals. `overlayRecent`: a keyed overlay was connected
 * in the last ten minutes (OBS reconnecting is not a bury); `verifying`: a
 * bounty air session is open for the room.
 */
export function classify({ channelLive = false, onAir = false, overlayConnected = false, overlayRecent = false, verifying = false } = {}) {
  if (!channelLive && !onAir) return 'off';
  if (onAir && overlayConnected && verifying) return 'green';
  if (onAir && (overlayConnected || overlayRecent)) return 'yellow';
  return 'red';
}

/**
 * Fold one overlay sample into an airing's overlay record. Conservative on
 * purpose: a gap counts as connected only when BOTH ends of it saw the keyed
 * overlay, and never more than `maxGapMs` (a missed tick, a restart) — so
 * the record can under-credit a flapping overlay and never over-credits one
 * that was gone.
 */
export function accumulate(overlay, { connected, at, maxGapMs }) {
  const o = overlay || { connectedMs: 0, sampledMs: 0, samples: 0, lastSampleAt: null, lastConnected: false };
  if (o.lastSampleAt != null) {
    const gap = Math.min(Math.max(0, at - o.lastSampleAt), Math.max(0, maxGapMs));
    o.sampledMs += gap;
    if (connected && o.lastConnected) o.connectedMs += gap;
  }
  o.lastSampleAt = at;
  o.lastConnected = !!connected;
  o.samples += 1;
  return o;
}

/** A compact, public view of a liveness reading (what cards and pages show). */
export function publicLiveness(l) {
  if (!l) return null;
  return {
    tier: l.tier, label: TIER_LABEL[l.tier] || l.tier,
    onAir: !!l.onAir, channelLive: !!l.channelLive, overlayConnected: !!l.overlayConnected, overlayRecent: !!l.overlayRecent, verifying: !!l.verifying,
    overlayConnectedMs: l.overlayConnectedMs ?? null, sampledMs: l.sampledMs ?? null,
  };
}
