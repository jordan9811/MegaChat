/**
 * GATE — obs-websocket v5 conformance, against a mock that speaks the real
 * protocol.
 *
 * The mock implements the genuine handshake INCLUDING the auth math, computed
 * here with node:crypto — a second, independent implementation. The client
 * computes it with crypto.subtle. If either side is off by a byte, Identify is
 * rejected and everything below fails; that cross-check is the point.
 *
 * What is asserted:
 *   - computeAuth byte-exactness against known vectors + the independent impl
 *   - the EXACT request sequence and payloads Add to OBS sends (the settings
 *     table is a promise to streamers' money; the gate holds it)
 *   - the misconfiguration-killer: a hand-shrunk existing source is REPAIRED
 *   - name collision in another scene → adopted via CreateSceneItem, no error
 *   - wrong password → AUTH_FAILED (close 4009), named distinctly
 *   - OBS absent → NOT_REACHABLE, named distinctly
 *   - the password never appears in any frame after the handshake
 *
 * Real OBS is deliberately NOT here: that is the owner's five-minute checklist
 * (docs/obs-oneclick-checklist.md). Zero external network, zero spend.
 */
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { ObsClient, computeAuth, OBS_ERRORS } from './web/lib/obs-client.mjs';
import { addOverlayToObs, verifyOverlayInObs, OVERLAY_INPUT_NAME, MONITOR } from './web/lib/obs-oneclick.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};

const b64sha = (s) => createHash('sha256').update(s, 'utf8').digest('base64');
const nodeAuth = (password, salt, challenge) => b64sha(b64sha(password + salt) + challenge);

// ── 1. the auth math, byte-exact ──────────────────────────────────────────
{
  // Independent implementations must agree on arbitrary inputs, including
  // unicode and empty strings.
  const vectors = [
    ['supersecret', 'salt123', 'challenge456'],
    ['', 'AAAA', 'BBBB'],
    ['pässwörd☂', 'c2FsdA==', 'Y2hhbGxlbmdl'],
    ['a'.repeat(200), 'x', 'y'],
  ];
  let all = true;
  for (const [p, s, c] of vectors) {
    const ours = await computeAuth(p, s, c);
    const theirs = nodeAuth(p, s, c);
    if (ours !== theirs) { all = false; console.error(`    mismatch for ${JSON.stringify([p.slice(0, 12), s, c])}: ${ours} != ${theirs}`); }
  }
  ok('computeAuth matches an independent node:crypto implementation byte-exactly', all,
    `${vectors.length} vectors incl. unicode + empty`);
}

// ── the mock obs-websocket server ─────────────────────────────────────────
const PASSWORD = 'gate-obs-password';

function makeMockObs({ port, password = PASSWORD, seed = {} } = {}) {
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

const OVERLAY_URL = 'https://megachat.fun/overlay?room=gate&bounty=abc123';

// ── 2. happy path: fresh OBS, one click ───────────────────────────────────
{
  const mock = makeMockObs({ port: 4460 });
  const client = new ObsClient({ url: 'ws://127.0.0.1:4460', password: PASSWORD });
  await client.connect();
  ok('handshake completes against the mock (auth accepted)', client.rpcVersion === 1);

  const res = await addOverlayToObs(client, { overlayUrl: OVERLAY_URL });
  ok('the source is created in the program scene at canvas size',
    res.sceneName === 'Live Scene' && res.baseWidth === 1920 && res.baseHeight === 1080,
    JSON.stringify(res));

  const seq = mock.state.log.map((l) => l.requestType);
  const wantSeq = ['GetVideoSettings', 'GetCurrentProgramScene', 'GetSceneItemId',
    'CreateInput', 'SetSceneItemTransform', 'SetSceneItemEnabled', 'SetInputAudioMonitorType'];
  ok('the request sequence is exactly what the table promises',
    JSON.stringify(seq) === JSON.stringify(wantSeq), seq.join(' → '));

  const create = mock.state.log.find((l) => l.requestType === 'CreateInput').requestData;
  ok('inputKind is browser_source and name is ours',
    create.inputKind === 'browser_source' && create.inputName === OVERLAY_INPUT_NAME);
  const s = create.inputSettings;
  ok('settings: url + width/height = canvas exactly',
    s.url === OVERLAY_URL && s.width === 1920 && s.height === 1080,
    `${s.width}x${s.height}`);
  ok('settings: shutdown:false + restart_when_active:false (survives scene switches)',
    s.shutdown === false && s.restart_when_active === false);
  ok('settings: reroute_audio:true (own mixer channel)', s.reroute_audio === true);
  const xf = mock.state.log.find((l) => l.requestType === 'SetSceneItemTransform').requestData.sceneItemTransform;
  ok('transform: 0,0 scale 1, bounds NONE',
    xf.positionX === 0 && xf.positionY === 0 && xf.scaleX === 1 && xf.scaleY === 1
    && xf.boundsType === 'OBS_BOUNDS_NONE', JSON.stringify(xf));
  const mon = mock.state.log.find((l) => l.requestType === 'SetInputAudioMonitorType').requestData;
  ok('audio: monitor-and-output by default (streamer HEARS the join sound)',
    mon.monitorType === MONITOR.HEAR, mon.monitorType);

  const verify = await verifyOverlayInObs(client, { overlayUrl: OVERLAY_URL });
  ok('verify-then-say-so: every check green on the fresh install',
    verify.ok === true, verify.checks.filter((c) => !c.ok).map((c) => c.name).join(',') || 'all green');
  ok('...including the badge legibility arithmetic',
    verify.checks.some((c) => c.name === 'badge clears legibility floor' && c.ok));

  ok('the password never appears in any frame after the handshake',
    !mock.state.frames.some((f) => f.includes(PASSWORD)),
    `${mock.state.frames.length} frames scanned`);

  client.close();
  await mock.close();
}

// ── 3. the misconfiguration-killer: a hand-shrunk source is REPAIRED ──────
{
  const mock = makeMockObs({
    port: 4461,
    seed: {
      inputs: { [OVERLAY_INPUT_NAME]: {
        inputKind: 'browser_source', monitorType: 'OBS_MONITORING_TYPE_NONE',
        // The classic hand-made mistake: small source, scaled down, cropped in.
        settings: { url: 'https://megachat.fun/overlay?room=old', width: 640, height: 360, shutdown: true, restart_when_active: true, reroute_audio: false },
      } },
      scenes: { 'Live Scene': [{ sceneItemId: 7, sourceName: OVERLAY_INPUT_NAME,
        transform: { positionX: 200, positionY: 120, scaleX: 0.4, scaleY: 0.4, boundsType: 'OBS_BOUNDS_NONE' }, enabled: false }], 'Other Scene': [] },
      nextItemId: 8,
    },
  });
  const client = new ObsClient({ url: 'ws://127.0.0.1:4461', password: PASSWORD });
  await client.connect();
  await addOverlayToObs(client, { overlayUrl: OVERLAY_URL });
  const seq = mock.state.log.map((l) => l.requestType);
  ok('an existing hand-shrunk source is ADOPTED, not duplicated and not an error',
    seq.includes('SetInputSettings') && !seq.includes('CreateInput'), seq.join(' → '));
  const input = mock.state.inputs[OVERLAY_INPUT_NAME];
  const item = mock.state.scenes['Live Scene'][0];
  ok('...its size, url, persistence and audio flags are all repaired',
    input.settings.width === 1920 && input.settings.height === 1080
    && input.settings.url === OVERLAY_URL && input.settings.shutdown === false
    && input.settings.restart_when_active === false && input.settings.reroute_audio === true,
    JSON.stringify(input.settings).slice(0, 120));
  ok('...its transform is snapped back to 0,0 scale 1 and re-enabled',
    item.transform.scaleX === 1 && item.transform.positionX === 0 && item.enabled === true,
    JSON.stringify(item.transform));
  const verify = await verifyOverlayInObs(client, { overlayUrl: OVERLAY_URL });
  ok('...and verify reports green after the repair', verify.ok === true);
  client.close();
  await mock.close();
}

// ── 4. name collision: input lives in ANOTHER scene ───────────────────────
{
  const mock = makeMockObs({
    port: 4462,
    seed: {
      inputs: { [OVERLAY_INPUT_NAME]: {
        inputKind: 'browser_source', monitorType: 'OBS_MONITORING_TYPE_NONE',
        settings: { url: OVERLAY_URL, width: 1920, height: 1080, shutdown: false, restart_when_active: false, reroute_audio: true },
      } },
      scenes: { 'Live Scene': [], 'Other Scene': [{ sceneItemId: 3, sourceName: OVERLAY_INPUT_NAME,
        transform: { positionX: 0, positionY: 0, scaleX: 1, scaleY: 1, boundsType: 'OBS_BOUNDS_NONE' }, enabled: true }] },
      nextItemId: 4,
    },
  });
  const client = new ObsClient({ url: 'ws://127.0.0.1:4462', password: PASSWORD });
  await client.connect();
  const res = await addOverlayToObs(client, { overlayUrl: OVERLAY_URL });
  const seq = mock.state.log.map((l) => l.requestType);
  ok('a same-name input in another scene is referenced into the program scene',
    seq.includes('CreateSceneItem') && res.sceneItemId != null
    && mock.state.scenes['Live Scene'].some((i) => i.sourceName === OVERLAY_INPUT_NAME),
    seq.join(' → '));
  client.close();
  await mock.close();
}

// ── 4b. THE VERIFY-THAT-LIES CASE ─────────────────────────────────────────
// An OBS that does not declare `reroute_audio` (renamed, or we mistyped it).
// Every echo-back check still passes, because obs_data stores whatever we
// send — only the declared-keys check can catch it.
{
  const mock = makeMockObs({ port: 4464, seed: {
    declaredKeys: ['url', 'width', 'height', 'fps', 'shutdown', 'restart_when_active', 'css'],
  } });
  const client = new ObsClient({ url: 'ws://127.0.0.1:4464', password: PASSWORD });
  await client.connect();
  await addOverlayToObs(client, { overlayUrl: OVERLAY_URL });
  const verify = await verifyOverlayInObs(client, { overlayUrl: OVERLAY_URL });
  const keyCheck = verify.checks.find((c) => c.name === 'OBS recognises every setting we write');
  ok('an OBS that does not know one of our settings FAILS verification',
    verify.ok === false && keyCheck?.ok === false, keyCheck?.got);
  ok('...and it names the offending key rather than a vague failure',
    /reroute_audio/.test(keyCheck?.got || ''), keyCheck?.got);
  ok('...while the echo-back checks all still pass (proving they cannot catch it)',
    verify.checks.filter((c) => c.name !== 'OBS recognises every setting we write').every((c) => c.ok));
  client.close();
  await mock.close();
}

// ── 5. wrong password → AUTH_FAILED, named ────────────────────────────────
{
  const mock = makeMockObs({ port: 4463 });
  const client = new ObsClient({ url: 'ws://127.0.0.1:4463', password: 'not-the-password' });
  let err = null;
  try { await client.connect(); } catch (e) { err = e; }
  ok('a wrong password is AUTH_FAILED (close 4009), not a generic failure',
    err?.kind === OBS_ERRORS.AUTH_FAILED && err?.closeCode === 4009,
    `${err?.kind} code=${err?.closeCode}`);
  ok('...with copy that tells the streamer where to re-copy the password',
    /WebSocket Server Settings/i.test(err?.message || ''));
  await mock.close();
}

// ── 6. OBS absent → NOT_REACHABLE, named ──────────────────────────────────
{
  const client = new ObsClient({ url: 'ws://127.0.0.1:4499', password: PASSWORD });
  let err = null;
  try { await client.connect({ timeoutMs: 2500 }); } catch (e) { err = e; }
  ok('nothing listening is NOT_REACHABLE (OBS not running), not a hang',
    err?.kind === OBS_ERRORS.NOT_REACHABLE, err?.kind);
  ok('...with copy pointing at Tools → WebSocket Server Settings',
    /WebSocket server/i.test(err?.message || ''));
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
