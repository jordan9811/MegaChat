/**
 * OBS AUDIO CHECK — is OBS set up so the streamer's guests reach the stream,
 * and (Through OBS) so the streamer hears them? Read through the obs-websocket
 * connection the dashboard already has (the password "Add to OBS" stored); a
 * streamer without one gets no check and no nag.
 *
 * This tab: the booth plays the guests, and they reach the stream only if OBS
 * records what Chrome plays. It says something ONLY on positive evidence that
 * nothing does — any plausible route (Desktop Audio or another output capture,
 * a per-app capture of the browser, a window/game capture with its audio, a
 * virtual cable or mixer bus) means silence, because a wrong "your guests
 * aren't on stream" with a fix that unmutes Desktop Audio would put every
 * sound on the PC on stream twice. And a one-click fix is offered only where
 * it cannot do that.
 *
 * Through OBS: the MegaChat overlay plays the guests into OBS; the streamer
 * hears them only if that source is monitored ("Monitor and Output"), and they
 * reach the stream only if it is not "Monitor Only" or muted.
 *
 * Pure: `request(type, data)` is obs-client's request, so a gate drives this
 * with a fake OBS. Each problem has an `id` (one per source) and may carry the
 * ONE request that fixes it — the booth sends it only when the streamer clicks.
 */
export const MONITOR_AND_OUTPUT = 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT';
const MONITOR_ONLY = 'OBS_MONITORING_TYPE_MONITOR_ONLY';
const OUTPUT_CAPTURE = new Set(['wasapi_output_capture', 'coreaudio_output_capture', 'sck_audio_capture', 'pulse_output_capture']);
const INPUT_CAPTURE = new Set(['wasapi_input_capture', 'coreaudio_input_capture', 'pulse_input_capture']);
const BROWSER_EXE = /(chrome|msedge|brave|opera|vivaldi|arc)\.exe/i;
// An input device that is really a loopback or a mixer bus, which can carry
// the browser into OBS as an "input".
const LOOPBACK_DEVICE = /cable|voicemeeter|vb-audio|stereo mix|what u hear|loopback|wave link|virtual|goxlr|stream mix|broadcast|obs/i;

/** Is this browser-source URL the room's MegaChat overlay? */
export function isRoomOverlay(url, { roomId, handle }) {
  let u;
  try { u = new URL(String(url || '')); } catch { return false; }
  const path = u.pathname.replace(/\/+$/, '').toLowerCase();
  const h = handle ? String(handle).toLowerCase() : null;
  if (roomId && path === '/overlay' && (u.searchParams.get('room') === roomId || u.searchParams.get('bountyRoom') === roomId)) return true;
  if (h && (path === `/${h}/overlay` || path === `/r/${h}/overlay`)) return true;
  return false;
}

const kindOf = (i) => i.unversionedInputKind || i.inputKind;

/**
 * @param {(type: string, data?: object) => Promise<any>} request
 * @param {{ mode: 'tab'|'system', roomId: string, handle?: string|null }} opts
 */
export async function checkObsAudio(request, { mode, roomId, handle = null }) {
  const problems = [];
  const all = (await request('GetInputList').catch(() => null))?.inputs;
  if (!Array.isArray(all)) return problems; // cannot see the setup: say nothing
  const settingsOf = async (name) => (await request('GetInputSettings', { inputName: name }).catch(() => null))?.inputSettings || null;
  // Heard on stream: not muted, not all the way down, not "Monitor Only".
  // Any request that fails counts as unknown — never as fine, never as broken.
  const levelOf = async (name) => {
    const m = await request('GetInputMute', { inputName: name }).catch(() => null);
    const v = await request('GetInputVolume', { inputName: name }).catch(() => null);
    const t = await request('GetInputAudioMonitorType', { inputName: name }).catch(() => null);
    if (!m || !v || !t) return null;
    return { muted: !!m.inputMuted, mul: Number(v.inputVolumeMul ?? 1), monitorOnly: t.monitorType === MONITOR_ONLY };
  };
  const onStream = (l) => !!l && !l.muted && l.mul > 0.05 && !l.monitorOnly;

  if (mode === 'tab') {
    const special = await request('GetSpecialInputs').catch(() => null);
    if (!special) return problems;
    const desk = special.desktop1 || null;
    const mics = new Set([special.mic1, special.mic2, special.mic3, special.mic4].filter(Boolean));
    let browserCaptureOff = null;
    let perApp = 0;
    for (const i of all) {
      const kind = kindOf(i);
      if (OUTPUT_CAPTURE.has(kind)) {
        const l = await levelOf(i.inputName);
        if (l === null || onStream(l)) return problems; // a route (or unknown)
      } else if (kind === 'wasapi_process_output_capture') {
        perApp++;
        const s = await settingsOf(i.inputName);
        if (!s) return problems;
        if (!BROWSER_EXE.test(String(s.window || ''))) continue;
        const l = await levelOf(i.inputName);
        const a = await request('GetSourceActive', { sourceName: i.inputName }).catch(() => null);
        if (l === null || !a) return problems;
        if (onStream(l) && a.videoActive) return problems;
        browserCaptureOff = i.inputName;
      } else if (kind === 'window_capture' || kind === 'game_capture') {
        const s = await settingsOf(i.inputName);
        if (!s || s.capture_audio === true) return problems; // its audio may be the browser's
      } else if (INPUT_CAPTURE.has(kind) && !mics.has(i.inputName)) {
        const s = await settingsOf(i.inputName);
        const items = await request('GetInputPropertiesListPropertyItems', { inputName: i.inputName, propertyName: 'device_id' }).catch(() => null);
        const dev = s && items ? (items.propertyItems || []).find((x) => x.itemValue === (s.device_id || 'default')) : null;
        if (!dev) return problems; // cannot tell what it records
        if (LOOPBACK_DEVICE.test(String(dev.itemName || ''))) {
          const l = await levelOf(i.inputName);
          if (l === null || onStream(l)) return problems;
        }
      }
    }
    // Positive evidence: nothing that records the browser is on stream.
    if (browserCaptureOff) {
      problems.push({ id: `app-capture-off:${browserCaptureOff}`, code: 'app-capture-off', fix: null,
        text: `Your browser audio capture in OBS (“${browserCaptureOff}”) is muted, turned down, or not in your live scene, so your guests aren’t on your stream.` });
    } else if (desk) {
      const l = await levelOf(desk);
      if (!l) return problems;
      if (perApp > 0) {
        // A per-app setup that mutes Desktop Audio on purpose: unmuting it
        // would put every app on stream twice.
        problems.push({ id: 'no-browser-capture', code: 'no-browser-capture', fix: null,
          text: 'OBS records your apps one by one, but not Chrome, so your guests aren’t on your stream. Add an Application Audio Capture of Chrome.' });
      } else if (l.muted) {
        problems.push({ id: 'desktop-muted', code: 'desktop-muted', text: 'OBS has Desktop Audio muted, so your guests aren’t on your stream.',
          fix: { label: 'Unmute Desktop Audio', requestType: 'SetInputMute', requestData: { inputName: desk, inputMuted: false } } });
      } else if (l.monitorOnly) {
        problems.push({ id: 'desktop-monitor-only', code: 'desktop-monitor-only', text: 'OBS has Desktop Audio set to “Monitor Only”, so your guests aren’t on your stream.',
          fix: { label: 'Send it to the stream', requestType: 'SetInputAudioMonitorType', requestData: { inputName: desk, monitorType: 'OBS_MONITORING_TYPE_NONE' } } });
      } else if (l.mul <= 0.001) {
        problems.push({ id: 'desktop-silent', code: 'desktop-silent', text: 'OBS has Desktop Audio turned all the way down, so your guests aren’t on your stream.',
          fix: { label: 'Turn Desktop Audio up', requestType: 'SetInputVolume', requestData: { inputName: desk, inputVolumeMul: 1 } } });
      } else {
        problems.push({ id: 'desktop-low', code: 'desktop-low', fix: null,
          text: 'OBS has Desktop Audio very low, so your guests will be hard to hear on stream.' });
      }
    } else {
      problems.push(perApp > 0
        ? { id: 'no-browser-capture', code: 'no-browser-capture', fix: null,
          text: 'OBS records your apps one by one, but not Chrome, so your guests aren’t on your stream. Add an Application Audio Capture of Chrome.' }
        : { id: 'desktop-missing', code: 'desktop-missing', fix: null,
          text: 'OBS isn’t recording your desktop sound, so your guests aren’t on your stream. In OBS: Settings → Audio → Desktop Audio → Default.' });
    }
  } else if (mode === 'system') {
    const overlays = [];
    for (const i of all) {
      if (kindOf(i) !== 'browser_source') continue;
      const s = await settingsOf(i.inputName);
      if (s && isRoomOverlay(s.url, { roomId, handle })) overlays.push({ name: i.inputName, settings: s });
    }
    if (!overlays.length) {
      problems.push({ id: 'overlay-missing', code: 'overlay-missing', fix: null,
        text: 'Your MegaChat overlay isn’t in OBS, so you won’t hear your guests. Add it with “Add to OBS”.' });
      return problems;
    }
    const live = [];
    for (const o of overlays) {
      const a = await request('GetSourceActive', { sourceName: o.name }).catch(() => null);
      if (a?.videoActive) live.push(o);
    }
    if (live.length > 1) {
      problems.push({ id: 'overlay-doubled', code: 'overlay-doubled', fix: null,
        text: `${live.length} MegaChat overlays are live in OBS (${live.map((o) => `“${o.name}”`).join(', ')}), so your guests play more than once. Keep one.` });
    }
    for (const o of live) {
      // "Control audio via OBS" off: Windows plays it, OBS never sees it.
      if (o.settings.reroute_audio !== true) continue;
      const l = await levelOf(o.name);
      if (!l) continue;
      const t = await request('GetInputAudioMonitorType', { inputName: o.name }).catch(() => null);
      if (t?.monitorType === MONITOR_ONLY) {
        problems.push({ id: `overlay-monitor-only:${o.name}`, code: 'overlay-monitor-only', text: `OBS has “${o.name}” on “Monitor Only”, so your guests aren’t on your stream.`,
          fix: { label: 'Put them on stream', requestType: 'SetInputAudioMonitorType', requestData: { inputName: o.name, monitorType: MONITOR_AND_OUTPUT } } });
      } else if (t && t.monitorType !== MONITOR_AND_OUTPUT) {
        problems.push({ id: `overlay-monitor:${o.name}`, code: 'overlay-monitor', text: `OBS isn’t playing “${o.name}” to you, so you won’t hear your guests.`,
          fix: { label: 'Let me hear it', requestType: 'SetInputAudioMonitorType', requestData: { inputName: o.name, monitorType: MONITOR_AND_OUTPUT } } });
      }
      if (l.muted) {
        problems.push({ id: `overlay-muted:${o.name}`, code: 'overlay-muted', text: `“${o.name}” is muted in OBS, so your guests aren’t on your stream.`,
          fix: { label: 'Unmute it', requestType: 'SetInputMute', requestData: { inputName: o.name, inputMuted: false } } });
      } else if (l.mul <= 0.001) {
        problems.push({ id: `overlay-silent:${o.name}`, code: 'overlay-silent', text: `“${o.name}” is turned all the way down in OBS, so your guests aren’t on your stream.`,
          fix: { label: 'Turn it up', requestType: 'SetInputVolume', requestData: { inputName: o.name, inputVolumeMul: 1 } } });
      }
    }
  }
  return problems;
}
