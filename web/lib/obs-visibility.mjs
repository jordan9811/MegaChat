/**
 * OVERLAY VISIBILITY — is the overlay actually on screen, right now, and big
 * enough to be read?
 *
 * `checkOverlayVisible` (obs-scene-check.mjs) already answers four of the five
 * ways an overlay goes missing: wrong scene, eye ticked off, sized to nothing,
 * dragged off canvas. This adds the two the smoke test found and that check
 * cannot see:
 *
 *   COVERED — another scene item sits above it in z-order with a bounding box
 *             over it. A streamer who drops a full-screen "BRB" image on top
 *             has an overlay that is enabled, on canvas, correctly sized, and
 *             reaching nobody.
 *   SCALED  — the source is scaled below 100%, which shrinks the bounty badge
 *             with it. Below the verifier's pixel floor a clip that genuinely
 *             aired reads as unverifiable. This is a SEPARATE signal from
 *             hidden, because it means something different: the overlay IS on
 *             screen and the streamer is still not earning.
 *
 * WHAT THIS IS FOR. Accident detection, not anti-cheat. It runs in the
 * streamer's own browser against the streamer's own OBS, so anyone determined
 * can post whatever they like. It catches the honest streamer who switched
 * scenes and forgot — by far the most common failure — and it turns "no badge
 * found" from a mystery into a diagnosis. Broadcast capture remains the payout
 * authority. Nothing here gates a payout on its own.
 *
 * WHICH WAY BIAS RUNS. Every estimate here is deliberately conservative
 * AGAINST reporting a problem:
 *   - our own rect is over-estimated (effectiveRect's existing bias), because
 *     a false "not visible" accuses an honest streamer;
 *   - an OCCLUDER's rect is UNDER-estimated, for the same reason in the other
 *     direction — over-estimating an occluder over-reports coverage. The two
 *     biases are opposite on purpose, which is why effectiveRect is NOT reused
 *     for occluders;
 *   - coverage must exceed COVER_FRACTION of our own area before it counts, so
 *     a chat box overlapping a corner is not called a bury;
 *   - if z-order cannot be established, the answer is `unknown`, never
 *     `covered`.
 *
 * THE Z-ORDER ASSUMPTION, stated because it is not verifiable from this repo.
 * obs-websocket v5 returns `sceneItemIndex` per item; this module treats a
 * HIGHER index as nearer the viewer (drawn later, on top). The shared gate
 * mock returns no index at all and its own comment contradicts its
 * implementation about ordering, so the mock cannot settle it. Consequence if
 * the direction is backwards: we would inspect the items below instead of
 * above and report `visible` where we should have said `covered` — a MISSED
 * detection, never a false accusation, and never a payout difference. One real
 * OBS session settles it; that is the same session the outstanding list
 * already tracks as B1. Every raw index and rect is emitted in the sample so
 * it can be settled after the fact.
 */
import { SCENE_STATE, checkOverlayVisible, effectiveRect } from './obs-scene-check.mjs';

export const VISIBILITY = {
  VISIBLE: 'overlay_visible',
  HIDDEN: 'overlay_hidden',
  SCALED: 'overlay_scaled_below_floor',
  DISCONNECTED: 'obs_disconnected',
};

/** Why an overlay is not on screen. The spec names these four exactly. */
export const HIDDEN_REASON = {
  SCENE: 'scene',        // not in the program scene
  DISABLED: 'disabled',  // in the scene, eye off
  OFFCANVAS: 'offcanvas', // off the canvas, or sized to nothing
  COVERED: 'covered',    // another item is over it
};

/** A higher sceneItemIndex is nearer the viewer. See the header. */
export const HIGHER_INDEX_IS_ON_TOP = true;

/** How much of our rect another item must cover before it counts as a bury. */
export const COVER_FRACTION = 0.6;

/**
 * An occluder's rect, UNDER-estimated.
 *
 * effectiveRect takes the MAX of the reported, derived and bounds sizes so an
 * honest overlay is never called zero-area. For something claiming to cover
 * us, that bias is backwards, so this takes the reported size when OBS gives
 * one and only derives when it does not.
 */
export function occluderRect(t = {}) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const reportedW = n(t.width);
  const reportedH = n(t.height);
  const derivedW = Math.max(0, n(t.sourceWidth) - n(t.cropLeft) - n(t.cropRight)) * Math.abs(n(t.scaleX));
  const derivedH = Math.max(0, n(t.sourceHeight) - n(t.cropTop) - n(t.cropBottom)) * Math.abs(n(t.scaleY));
  return {
    x: n(t.positionX),
    y: n(t.positionY),
    width: reportedW > 0 ? reportedW : derivedW,
    height: reportedH > 0 ? reportedH : derivedH,
  };
}

/** Fraction of `target` covered by `other`. Plain rectangle intersection —
 *  deliberately NOT isOffCanvas's ±width convention, which doubles both boxes
 *  and would report coverage between items that do not touch. */
export function coveredFraction(target, other) {
  const area = Math.max(0, target.width) * Math.max(0, target.height);
  if (area <= 0) return 0;
  const x = Math.max(0, Math.min(target.x + target.width, other.x + other.width) - Math.max(target.x, other.x));
  const y = Math.max(0, Math.min(target.y + target.height, other.y + other.height) - Math.max(target.y, other.y));
  return (x * y) / area;
}

/**
 * The scale the source is actually rendered at.
 *
 * Prefers the effective rendered height over the reported scaleY, because a
 * bounds mode fits the source into a box and leaves scaleY describing
 * something else. Falls back to scaleY when the source height is unknown.
 */
export function effectiveScale(t = {}, rect) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const sourceH = n(t.sourceHeight);
  const sourceW = n(t.sourceWidth);
  const scaleY = sourceH > 0 && rect?.height > 0 ? rect.height / sourceH : Math.abs(n(t.scaleY)) || null;
  const scaleX = sourceW > 0 && rect?.width > 0 ? rect.width / sourceW : Math.abs(n(t.scaleX)) || null;
  return { scaleX, scaleY, sourceWidth: sourceW || null, sourceHeight: sourceH || null };
}

/**
 * One observation of the overlay's visibility.
 *
 * Returns RAW MEASUREMENTS plus a state. It deliberately does NOT decide
 * whether the badge is below the verifier's floor: that threshold is
 * `minCodePixelHeight`, it is the number a payout turns on, and it is server
 * side on purpose. The client reports what it measured; the server derives.
 */
export async function checkOverlayVisibility(client, { inputName = 'MegaChat Overlay', now = Date.now() } = {}) {
  const base = await checkOverlayVisible(client, { inputName, now });

  // Not reachable, or not on screen for a reason the base check already named.
  if (!base.checked) {
    return { ...base, signal: VISIBILITY.DISCONNECTED, reason: null, occlusion: null, scale: null };
  }
  if (base.state === SCENE_STATE.NOT_IN_SCENE) return { ...base, signal: VISIBILITY.HIDDEN, reason: HIDDEN_REASON.SCENE };
  if (base.state === SCENE_STATE.HIDDEN) return { ...base, signal: VISIBILITY.HIDDEN, reason: HIDDEN_REASON.DISABLED };
  if (base.state === SCENE_STATE.ZERO_AREA || base.state === SCENE_STATE.OFF_CANVAS) {
    return { ...base, signal: VISIBILITY.HIDDEN, reason: HIDDEN_REASON.OFFCANVAS };
  }
  if (base.state !== SCENE_STATE.VISIBLE) {
    return { ...base, signal: VISIBILITY.DISCONNECTED, reason: null, occlusion: null, scale: null };
  }

  // On screen. Now the two questions the base check cannot answer.
  let occlusion = { checked: false, covered: false, by: null, fraction: 0, note: 'not checked' };
  let items = [];
  try {
    const list = await client.request('GetSceneItemList', { sceneName: base.sceneName });
    items = Array.isArray(list?.sceneItems) ? list.sceneItems : [];
  } catch (e) {
    occlusion = { checked: false, covered: false, by: null, fraction: 0, note: `GetSceneItemList unavailable: ${e?.comment || e?.message || e}` };
  }

  if (items.length) {
    const mine = items.find((i) => i.sceneItemId === base.sceneItemId);
    const myIndex = mine?.sceneItemIndex;
    if (!Number.isFinite(myIndex)) {
      // No index means no z-order. Say so rather than guessing a direction.
      occlusion = {
        checked: false, covered: false, by: null, fraction: 0,
        note: 'no sceneItemIndex in GetSceneItemList — z-order unknown, occlusion not assessed',
        items: items.map((i) => ({ id: i.sceneItemId, name: i.sourceName, enabled: i.sceneItemEnabled })),
      };
    } else {
      const above = items.filter((i) => {
        if (i.sceneItemId === base.sceneItemId) return false;
        if (i.sceneItemEnabled === false) return false;
        if (!Number.isFinite(i.sceneItemIndex)) return false;
        return HIGHER_INDEX_IS_ON_TOP ? i.sceneItemIndex > myIndex : i.sceneItemIndex < myIndex;
      });
      let worst = { fraction: 0, by: null };
      for (const it of above) {
        const f = coveredFraction(base.rect, occluderRect(it.sceneItemTransform || {}));
        if (f > worst.fraction) worst = { fraction: f, by: it.sourceName || `item ${it.sceneItemId}` };
      }
      occlusion = {
        checked: true,
        covered: worst.fraction >= COVER_FRACTION,
        by: worst.by,
        fraction: Math.round(worst.fraction * 1000) / 1000,
        above: above.length,
        myIndex,
        note: null,
      };
    }
  }

  const scale = effectiveScale(base.transform || {}, base.rect);

  if (occlusion.covered) {
    return {
      ...base,
      visible: false,
      signal: VISIBILITY.HIDDEN,
      reason: HIDDEN_REASON.COVERED,
      detail: `"${occlusion.by}" covers ${Math.round(occlusion.fraction * 100)}% of the overlay`,
      occlusion,
      scale,
    };
  }
  return { ...base, signal: VISIBILITY.VISIBLE, reason: null, occlusion, scale };
}
