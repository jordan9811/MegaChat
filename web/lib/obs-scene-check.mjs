/**
 * OBS SCENE-ITEM VISIBILITY — was the overlay actually on screen?
 *
 * `verifyOverlayInObs` answers "is this set up correctly", once, at setup
 * time. This answers "is it on screen right now", repeatedly, while the
 * streamer is live — which is a different question with a different answer
 * five minutes later, after somebody switches scenes.
 *
 * ── WHAT THIS SIGNAL IS WORTH ─────────────────────────────────────────────
 *
 * It runs in the STREAMER'S OWN BROWSER against the STREAMER'S OWN OBS and
 * posts the result to us. So it is CORROBORATION, not proof: someone
 * determined to cheat can post whatever they like, and no amount of care in
 * this file changes that.
 *
 * Its real value is against ACCIDENT. The overlay left in a scene the
 * streamer switched away from, the source someone unticked and forgot, the
 * item dragged to 1px in a crowded scene collection — all silent, all
 * expensive, all invisible to the streamer until an unpaid bounty. That is
 * the failure this catches, and it is by far the most common one.
 *
 * It also converts "we found no badge" from a mystery into a diagnosis. That
 * matters for support more than for fraud: "your overlay was hidden from
 * 20:14" is actionable, "verification failed" is a ticket.
 *
 * Therefore: NEVER a hard gate. A streamer on the manual-paste path has no
 * obs-websocket connection at all and must not be penalised one inch for it —
 * `NO_CONNECTION` is a normal, blameless outcome, not a warning.
 */

export const SCENE_STATE = {
  VISIBLE: 'VISIBLE',
  HIDDEN: 'HIDDEN',              // in the scene, eye ticked off
  NOT_IN_SCENE: 'NOT_IN_SCENE',  // exists as an input, not in the PROGRAM scene
  ZERO_AREA: 'ZERO_AREA',        // on screen, sized to nothing
  OFF_CANVAS: 'OFF_CANVAS',      // sized fine, positioned entirely off the canvas
  NO_CONNECTION: 'NO_CONNECTION',// no obs-websocket — blameless, not a warning
  ERROR: 'ERROR',                // OBS answered, but not with something we understand
};

/** Below this many pixels on a side the overlay cannot carry a readable badge. */
const MIN_SIDE_PX = 8;

/**
 * Effective on-canvas rectangle of a scene item.
 *
 * OBS reports `width`/`height` as the FINAL rendered size (scale and crop
 * already applied), which is exactly what we want — but older builds and some
 * bounds modes have left it at 0 while the item rendered fine. So fall back to
 * deriving it, and only call it zero when BOTH agree it is zero. Guessing
 * generously here costs a false OVERLAY_NOT_VISIBLE on an honest streamer.
 */
export function effectiveRect(t = {}) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const derivedW = Math.max(0, n(t.sourceWidth) - n(t.cropLeft) - n(t.cropRight)) * Math.abs(n(t.scaleX));
  const derivedH = Math.max(0, n(t.sourceHeight) - n(t.cropTop) - n(t.cropBottom)) * Math.abs(n(t.scaleY));
  // boundsType BOUNDS_NONE means the bounds fields are meaningless; any other
  // value means OBS is fitting the item into boundsWidth × boundsHeight.
  const bounded = t.boundsType && t.boundsType !== 'OBS_BOUNDS_NONE';
  const boundsW = bounded ? n(t.boundsWidth) : 0;
  const boundsH = bounded ? n(t.boundsHeight) : 0;

  const width = Math.max(n(t.width), derivedW, boundsW);
  const height = Math.max(n(t.height), derivedH, boundsH);
  return { x: n(t.positionX), y: n(t.positionY), width, height };
}

/** Is the rect entirely outside a canvas of baseWidth × baseHeight? */
export function isOffCanvas(rect, baseWidth, baseHeight) {
  if (!baseWidth || !baseHeight) return false; // no canvas known — do not guess
  // alignment can put positionX at the item's centre or right edge, so treat
  // the rect as spanning ±width around its anchor. Deliberately forgiving.
  const left = rect.x - rect.width;
  const right = rect.x + rect.width;
  const top = rect.y - rect.height;
  const bottom = rect.y + rect.height;
  return right <= 0 || bottom <= 0 || left >= baseWidth || top >= baseHeight;
}

/**
 * One visibility sample. Never throws — a check that throws would take down
 * the claim page's poll loop, and this signal is not important enough to cost
 * a streamer their setup screen.
 *
 * @param {import('./obs-client.mjs').ObsClient|null} client connected client,
 *   or null/disconnected for the manual-paste streamer.
 */
export async function checkOverlayVisible(client, {
  inputName = 'MegaChat Overlay',
  now = Date.now(),
} = {}) {
  const base = { at: now, inputName, checked: false, visible: false };
  if (!client) {
    return { ...base, state: SCENE_STATE.NO_CONNECTION, detail: 'no obs-websocket connection' };
  }
  try {
    const video = await client.request('GetVideoSettings');
    const sceneRes = await client.request('GetCurrentProgramScene');
    // obs-websocket renamed this field across 5.x point releases; accept both
    // rather than reporting NOT_IN_SCENE on an OBS version we simply misread.
    const sceneName = sceneRes.currentProgramSceneName ?? sceneRes.sceneName;
    const baseWidth = Number(video?.baseWidth) || 0;
    const baseHeight = Number(video?.baseHeight) || 0;
    const ctx = { ...base, checked: true, sceneName, baseWidth, baseHeight };

    let sceneItemId;
    try {
      ({ sceneItemId } = await client.request('GetSceneItemId', { sceneName, sourceName: inputName }));
    } catch {
      // The overlay is not an item of the scene that is ON AIR. It may be
      // sitting in another scene, fully configured, rendering happily — and
      // reaching precisely nobody.
      return {
        ...ctx,
        state: SCENE_STATE.NOT_IN_SCENE,
        detail: `"${inputName}" is not in the active scene ("${sceneName}")`,
      };
    }

    const { sceneItemEnabled } = await client.request('GetSceneItemEnabled', { sceneName, sceneItemId });
    const { sceneItemTransform: t } = await client.request('GetSceneItemTransform', { sceneName, sceneItemId });
    const rect = effectiveRect(t || {});
    const out = { ...ctx, sceneItemId, enabled: !!sceneItemEnabled, rect };

    if (!sceneItemEnabled) {
      return { ...out, state: SCENE_STATE.HIDDEN, detail: `"${inputName}" is hidden in "${sceneName}"` };
    }
    if (rect.width < MIN_SIDE_PX || rect.height < MIN_SIDE_PX) {
      return {
        ...out,
        state: SCENE_STATE.ZERO_AREA,
        detail: `"${inputName}" renders at ${Math.round(rect.width)}×${Math.round(rect.height)}px`,
      };
    }
    if (isOffCanvas(rect, baseWidth, baseHeight)) {
      return {
        ...out,
        state: SCENE_STATE.OFF_CANVAS,
        detail: `"${inputName}" sits at ${Math.round(rect.x)},${Math.round(rect.y)} — outside the ${baseWidth}×${baseHeight} canvas`,
      };
    }
    return {
      ...out,
      visible: true,
      state: SCENE_STATE.VISIBLE,
      detail: `visible in "${sceneName}" at ${Math.round(rect.width)}×${Math.round(rect.height)}px`,
    };
  } catch (e) {
    // A dropped socket mid-poll is the ordinary case here (OBS closed, laptop
    // slept). Report it as "we could not look", never as "they hid it".
    const msg = e?.comment || e?.message || String(e);
    const gone = /clos|socket|ECONN|not connected|disconnect/i.test(msg);
    return {
      ...base,
      state: gone ? SCENE_STATE.NO_CONNECTION : SCENE_STATE.ERROR,
      detail: msg,
    };
  }
}

/** Does this state mean "the overlay was not reaching the broadcast"? */
export function stateIsNotVisible(state) {
  return state === SCENE_STATE.HIDDEN
    || state === SCENE_STATE.NOT_IN_SCENE
    || state === SCENE_STATE.ZERO_AREA
    || state === SCENE_STATE.OFF_CANVAS;
}

/** Did we get an answer at all? NO_CONNECTION and ERROR are "we cannot see". */
export function stateIsConclusive(state) {
  return state === SCENE_STATE.VISIBLE || stateIsNotVisible(state);
}
