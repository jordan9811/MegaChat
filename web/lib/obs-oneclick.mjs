/**
 * "Add to OBS" — the flow behind the button.
 *
 * A CORRECTNESS FEATURE WEARING A CONVENIENCE COSTUME. The overlay renders the
 * bounty badge at fixed pixel size assuming it fills the canvas; a hand-made
 * browser source that is smaller or scaled shrinks the badge under the
 * verifier's legibility floor and an honest streamer silently is not paid.
 * Everything this module sets exists to make that misconfiguration impossible:
 *
 *   setting                      value            why
 *   ─────────────────────────────────────────────────────────────────────────
 *   width / height               canvas base size badge renders 1:1 with the
 *                                                 page; matching canvas is what
 *                                                 makes the legibility floor
 *                                                 un-screw-uppable
 *   position                     0,0              no crop of the badge corner
 *   scale                        1,1              any scale re-sizes the badge
 *   boundsType                   OBS_BOUNDS_NONE  bounds silently re-scale too
 *   shutdown                     false            page must persist across
 *                                                 scene switches or it misses
 *                                                 lazy-connect wake events
 *   restart_when_active          false            same reason — never reload
 *   reroute_audio                true             overlay gets its own mixer
 *                                                 channel with a visible meter
 *                                                 instead of ghost-mixing into
 *                                                 desktop audio
 *   monitor type (default)       MONITOR_AND_OUTPUT  the streamer must HEAR the
 *                                                 join sound to react to it;
 *                                                 toggleable because some
 *                                                 monitoring setups echo
 *
 * Find-or-update, never error: an input with our name is adopted and
 * corrected, not duplicated and not a failure. Re-clicking the button is the
 * repair path.
 */
import { ObsError, OBS_ERRORS } from './obs-client.mjs';

export const OVERLAY_INPUT_NAME = 'MegaChat Overlay';

/**
 * Every browser_source setting this flow writes. Verified against obs-browser's
 * own browser_source_get_defaults, and — more importantly — re-verified at
 * RUNTIME against whatever OBS the streamer is actually running (see the
 * schemaless note in verifyOverlayInObs).
 */
export const MANAGED_SETTING_KEYS = [
  'url', 'width', 'height', 'shutdown', 'restart_when_active', 'reroute_audio',
];

/** obs-websocket v5 RequestStatus codes we branch on. */
const CODE_RESOURCE_NOT_FOUND = 600;
const CODE_RESOURCE_EXISTS = 601;

export const MONITOR = {
  HEAR: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT', // streamer hears + audience hears
  MUTE_LOCAL: 'OBS_MONITORING_TYPE_NONE',         // audience hears, streamer does not
};

const isCode = (e, code) => e instanceof ObsError
  && e.kind === OBS_ERRORS.REQUEST_FAILED && e.code === code;

/**
 * Create-or-adopt the overlay browser source, sized to the canvas, in the
 * current program scene. Returns everything the verify step needs.
 */
export async function addOverlayToObs(client, {
  overlayUrl,
  inputName = OVERLAY_INPUT_NAME,
  monitorType = MONITOR.HEAR,
} = {}) {
  const { baseWidth, baseHeight } = await client.request('GetVideoSettings');
  const sceneRes = await client.request('GetCurrentProgramScene');
  const sceneName = sceneRes.currentProgramSceneName ?? sceneRes.sceneName;

  const inputSettings = {
    url: overlayUrl,
    width: baseWidth,
    height: baseHeight,
    shutdown: false,
    restart_when_active: false,
    reroute_audio: true,
  };

  let sceneItemId = null;
  try {
    // Fast path: our input already sits in the program scene → adopt it.
    ({ sceneItemId } = await client.request('GetSceneItemId', { sceneName, sourceName: inputName }));
    await client.request('SetInputSettings', { inputName, inputSettings, overlay: true });
  } catch (e) {
    if (!isCode(e, CODE_RESOURCE_NOT_FOUND)) throw e;
    try {
      ({ sceneItemId } = await client.request('CreateInput', {
        sceneName, inputName, inputKind: 'browser_source', inputSettings,
      }));
    } catch (e2) {
      if (!isCode(e2, CODE_RESOURCE_EXISTS)) throw e2;
      // The input exists but lives in some other scene: correct its settings
      // and add a reference into the program scene. Never an error.
      await client.request('SetInputSettings', { inputName, inputSettings, overlay: true });
      ({ sceneItemId } = await client.request('CreateSceneItem', { sceneName, sourceName: inputName }));
    }
  }

  await client.request('SetSceneItemTransform', {
    sceneName, sceneItemId,
    sceneItemTransform: {
      positionX: 0, positionY: 0, scaleX: 1, scaleY: 1,
      boundsType: 'OBS_BOUNDS_NONE',
    },
  });
  await client.request('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: true });
  await client.request('SetInputAudioMonitorType', { inputName, monitorType });

  return { sceneName, sceneItemId, baseWidth, baseHeight, inputName };
}

/**
 * Verify, then say so. Reads everything back and returns named checks the UI
 * renders as the green "verified-ready" state — an assertion, not a vibe.
 *
 * `badgeMinHeightPx` is the overlay's own legibility floor (from
 * /api/bounty/config). With the source at canvas size and scale 1 the badge
 * renders at its CSS pixel size, so the implied on-stream badge height is
 * badgeCssPx × scaleY; the check makes the arithmetic explicit rather than
 * trusting "we just set it".
 */
export async function verifyOverlayInObs(client, {
  inputName = OVERLAY_INPUT_NAME,
  overlayUrl,
  badgeMinHeightPx = 18,
  badgeCssPx = 28,
} = {}) {
  const checks = [];
  const push = (name, ok, got, want) => checks.push({ name, ok, got: String(got), want: String(want) });

  const { baseWidth, baseHeight } = await client.request('GetVideoSettings');
  const sceneRes = await client.request('GetCurrentProgramScene');
  const sceneName = sceneRes.currentProgramSceneName ?? sceneRes.sceneName;

  let settings = null;
  try {
    ({ inputSettings: settings } = await client.request('GetInputSettings', { inputName }));
  } catch {
    push('source exists', false, 'missing', inputName);
    return { ok: false, checks, sceneName, baseWidth, baseHeight };
  }
  push('source exists', true, inputName, inputName);

  // OBS'S SETTINGS STORE IS SCHEMALESS, so reading our own values back proves
  // only that we sent them. obs_data accepts and echoes ANY key: mistype
  // `reroute_audio`, or ship against an OBS that renamed it, and OBS silently
  // ignores the setting while every check below still reads green — a verify
  // that lies, on the one thing that decides whether a streamer gets paid.
  //
  // So ask OBS which keys the browser_source kind actually DECLARES, and
  // assert ours are among them. This is the only readback that cannot be
  // satisfied by our own input, and it re-verifies on the streamer's real OBS
  // version rather than trusting a constant checked once against upstream.
  try {
    const defaults = await client.request('GetInputDefaultSettings', { inputKind: 'browser_source' });
    const known = new Set(Object.keys(defaults?.defaultInputSettings || {}));
    const unknown = MANAGED_SETTING_KEYS.filter((k) => !known.has(k));
    push('OBS recognises every setting we write', known.size > 0 && unknown.length === 0,
      unknown.length ? `unknown to this OBS: ${unknown.join(', ')}` : `${MANAGED_SETTING_KEYS.length} keys known`,
      'all recognised');
  } catch (e) {
    // Older obs-websocket without GetInputDefaultSettings: say so rather than
    // quietly claiming the stronger guarantee.
    push('OBS recognises every setting we write', false,
      `could not ask (${e?.comment || e?.message || 'unsupported'})`, 'all recognised');
  }
  push('overlay URL', settings.url === overlayUrl, settings.url, overlayUrl);
  push('width = canvas', settings.width === baseWidth, settings.width, baseWidth);
  push('height = canvas', settings.height === baseHeight, settings.height, baseHeight);
  push('persists across scenes (shutdown off)', settings.shutdown === false, settings.shutdown, false);
  push('never reloads on activate', settings.restart_when_active === false, settings.restart_when_active, false);
  push('own mixer channel (reroute audio)', settings.reroute_audio === true, settings.reroute_audio, true);

  let inScene = false; let transformOk = false; let enabled = false;
  let impliedBadgePx = 0;
  try {
    const { sceneItemId } = await client.request('GetSceneItemId', { sceneName, sourceName: inputName });
    inScene = true;
    const { sceneItemTransform: t } = await client.request('GetSceneItemTransform', { sceneName, sceneItemId });
    transformOk = t.positionX === 0 && t.positionY === 0
      && Math.abs(t.scaleX - 1) < 1e-6 && Math.abs(t.scaleY - 1) < 1e-6;
    push('position 0,0 / scale 1', transformOk,
      `${t.positionX},${t.positionY} ×${t.scaleX}`, '0,0 ×1');
    impliedBadgePx = badgeCssPx * (t.scaleY || 0);
    ({ sceneItemEnabled: enabled } = await client.request('GetSceneItemEnabled', { sceneName, sceneItemId }));
    push('visible in program scene', enabled, enabled, true);
  } catch {
    push('in program scene', false, 'not in scene', sceneName);
  }
  if (inScene) {
    push('badge clears legibility floor',
      impliedBadgePx >= badgeMinHeightPx,
      `${impliedBadgePx}px`, `>=${badgeMinHeightPx}px`);
  }

  return { ok: checks.every((c) => c.ok), checks, sceneName, baseWidth, baseHeight };
}
