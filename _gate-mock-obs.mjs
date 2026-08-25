/**
 * MOCK obs-websocket v5 SERVER — shared by every gate that needs one.
 *
 * Extracted from _gate-obs-protocol.mjs so the scene-visibility gate drives
 * the SAME mock the protocol gate proved correct, rather than a second one
 * that could drift into agreeing with whatever it is meant to test.
 *
 * ⚠ It speaks the real wire protocol — Hello/Identify/Identified, the real
 * auth hash, real request/response ops — so a client cannot tell it apart
 * from OBS by shape. What it deliberately does NOT do is render anything, so
 * it can answer "is this scene item enabled" but never "was it on screen".
 *
 * ⚠ PORTS: never use 4455 here. That is OBS's own port, and on Windows a mock
 * bound to 127.0.0.1 wins over a running OBS holding [::], so the symptom is
 * your REAL OBS password being rejected as wrong. Gates use 44xx.
 */
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';

// The v5 auth hash, server side. The protocol gate keeps its OWN copy as the
// independent reference — two implementations that must agree is the point.
const b64sha = (s) => createHash('sha256').update(s, 'utf8').digest('base64');
const nodeAuth = (password, salt, challenge) => b64sha(b64sha(password + salt) + challenge);

// ── the mock obs-websocket server ─────────────────────────────────────────
export const PASSWORD = 'gate-obs-password';

export function makeMockObs({ port, password = PASSWORD, seed = {} } = {}) {
  const state = {
    canvas: { baseWidth: 1920, baseHeight: 1080 },
    programScene: 'Live Scene',
    scenes: { 'Live Scene': [], 'Other Scene': [] }, // sceneName → [{sceneItemId, sourceName, transform, enabled}]
    inputs: {},                                       // inputName → {inputKind, settings, monitorType}
    nextItemId: 1,
    log: [],       // every op-6 the client sent, in order
    frames: [],    // every raw frame, for the password-leak assertion
    ...seed,
  };
  const wss = new WebSocketServer({ port });
  wss.on('connection', (sock) => {
    const salt = Buffer.from(`salt-${Math.random()}`).toString('base64');
    const challenge = Buffer.from(`chal-${Math.random()}`).toString('base64');
    const expectedAuth = nodeAuth(password, salt, challenge);
    sock.send(JSON.stringify({
      op: 0,
      d: {
        obsWebSocketVersion: '5.5.2', rpcVersion: 1,
        authentication: { challenge, salt },
      },
    }));
    sock.on('message', (raw) => {
      const text = raw.toString();
      state.frames.push(text);
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.op === 1) {
        if (msg.d?.authentication !== expectedAuth) return sock.close(4009, 'Authentication failed.');
        if (msg.d?.rpcVersion !== 1) return sock.close(4010, 'Unsupported rpc version');
        return sock.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      }
      if (msg.op !== 6) return;
      const { requestType, requestId, requestData = {} } = msg.d;
      state.log.push({ requestType, requestData });
      const reply = (result, responseData, code = 100, comment) => sock.send(JSON.stringify({
        op: 7,
        d: { requestType, requestId, requestStatus: { result, code, ...(comment ? { comment } : {}) }, ...(responseData ? { responseData } : {}) },
      }));
      const findItem = (scene, name) => (state.scenes[scene] || []).find((i) => i.sourceName === name);
      switch (requestType) {
      case 'GetInputDefaultSettings': {
        // The REAL browser_source defaults (obs-browser browser_source_get_defaults).
        // `seed.declaredKeys` lets a case simulate an OBS that does not know one
        // of our keys, which is the failure the runtime check exists to catch.
        const all = { url: 'https://obsproject.com/browser-source', width: 800, height: 600,
          fps: 30, fps_custom: false, shutdown: false, restart_when_active: false,
          webpage_control_level: 1, css: '', reroute_audio: false };
        const keys = state.declaredKeys || Object.keys(all);
        const out = {};
        for (const k of keys) out[k] = all[k];
        return reply(true, { defaultInputSettings: out });
      }
        case 'GetVersion':
          return reply(true, { obsVersion: '30.2.0', obsWebSocketVersion: '5.5.2', rpcVersion: 1 });
        case 'GetVideoSettings':
          return reply(true, { ...state.canvas, outputWidth: state.canvas.baseWidth, outputHeight: state.canvas.baseHeight });
        case 'GetCurrentProgramScene':
          return reply(true, { currentProgramSceneName: state.programScene, sceneName: state.programScene });
        case 'GetSceneItemId': {
          const item = findItem(requestData.sceneName, requestData.sourceName);
          if (!item) return reply(false, null, 600, 'No scene items were found');
          return reply(true, { sceneItemId: item.sceneItemId });
        }
        case 'CreateInput': {
          if (state.inputs[requestData.inputName]) return reply(false, null, 601, 'A source already exists by that input name');
          state.inputs[requestData.inputName] = {
            inputKind: requestData.inputKind, settings: { ...requestData.inputSettings },
            monitorType: 'OBS_MONITORING_TYPE_NONE',
          };
          const item = { sceneItemId: state.nextItemId++, sourceName: requestData.inputName,
            transform: { positionX: 0, positionY: 0, scaleX: 1, scaleY: 1, boundsType: 'OBS_BOUNDS_NONE' }, enabled: true };
          state.scenes[requestData.sceneName].push(item);
          return reply(true, { sceneItemId: item.sceneItemId });
        }
        case 'CreateSceneItem': {
          if (!state.inputs[requestData.sourceName]) return reply(false, null, 600, 'No source found');
          const item = { sceneItemId: state.nextItemId++, sourceName: requestData.sourceName,
            transform: { positionX: 0, positionY: 0, scaleX: 1, scaleY: 1, boundsType: 'OBS_BOUNDS_NONE' }, enabled: true };
          state.scenes[requestData.sceneName].push(item);
          return reply(true, { sceneItemId: item.sceneItemId });
        }
        case 'SetInputSettings': {
          const input = state.inputs[requestData.inputName];
          if (!input) return reply(false, null, 600, 'No input found');
          input.settings = requestData.overlay === false
            ? { ...requestData.inputSettings }
            : { ...input.settings, ...requestData.inputSettings };
          return reply(true);
        }
        case 'GetInputSettings': {
          const input = state.inputs[requestData.inputName];
          if (!input) return reply(false, null, 600, 'No input found');
          return reply(true, { inputSettings: input.settings, inputKind: input.inputKind });
        }
        case 'SetSceneItemTransform': {
          const item = (state.scenes[requestData.sceneName] || []).find((i) => i.sceneItemId === requestData.sceneItemId);
          if (!item) return reply(false, null, 600, 'No item');
          Object.assign(item.transform, requestData.sceneItemTransform);
          return reply(true);
        }
        case 'GetSceneItemTransform': {
          const item = (state.scenes[requestData.sceneName] || []).find((i) => i.sceneItemId === requestData.sceneItemId);
          if (!item) return reply(false, null, 600, 'No item');
          return reply(true, { sceneItemTransform: item.transform });
        }
        case 'SetSceneItemEnabled': {
          const item = (state.scenes[requestData.sceneName] || []).find((i) => i.sceneItemId === requestData.sceneItemId);
          if (!item) return reply(false, null, 600, 'No item');
          item.enabled = requestData.sceneItemEnabled;
          return reply(true);
        }
        case 'GetSceneItemEnabled': {
          const item = (state.scenes[requestData.sceneName] || []).find((i) => i.sceneItemId === requestData.sceneItemId);
          if (!item) return reply(false, null, 600, 'No item');
          return reply(true, { sceneItemEnabled: item.enabled });
        }
        case 'SetInputAudioMonitorType': {
          const input = state.inputs[requestData.inputName];
          if (!input) return reply(false, null, 600, 'No input found');
          input.monitorType = requestData.monitorType;
          return reply(true);
        }
        default:
          return reply(false, null, 204, `Unhandled request type ${requestType}`);
      }
    });
  });
  return { wss, state, close: () => new Promise((r) => wss.close(r)) };
}
