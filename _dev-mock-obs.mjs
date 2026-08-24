/**
 * DEV-ONLY mock obs-websocket — see the one-click flow without running OBS.
 *
 * NOT a gate. _gate-obs-protocol.mjs and _gate-obs-ui.mjs own the assertions;
 * this exists so the UI can be clicked through by hand (demos, copy review,
 * screenshots) on a machine where OBS is closed.
 *
 *   node _dev-mock-obs.mjs          # password: demo-obs-password
 *   MOCK_OBS_PASSWORD=xyz node _dev-mock-obs.mjs
 *
 * ⚠ IT SQUATS PORT 4455, WHICH IS OBS'S OWN PORT. On Windows this binds
 * 127.0.0.1:4455 while a running OBS holds [::]:4455 — both "succeed", and the
 * loopback binding wins for ws://127.0.0.1. The symptom is your REAL OBS
 * password being rejected as wrong, which is maximally confusing. Kill this
 * before testing against real OBS:
 *
 *   powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 4455 -State Listen | ForEach-Object { (Get-CimInstance Win32_Process -Filter \"ProcessId=$($_.OwningProcess)\").Name }"
 */
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
const PASSWORD = process.env.MOCK_OBS_PASSWORD || 'demo-obs-password';
const b64 = (s) => createHash('sha256').update(s, 'utf8').digest('base64');
const st = { scenes: { 'Main Scene': [] }, inputs: {}, next: 1 };
new WebSocketServer({ host: '127.0.0.1', port: 4455 }).on('connection', (sock) => {
  const salt = 'c2FsdA==', challenge = 'Y2hhbA==';
  const expect = b64(b64(PASSWORD + salt) + challenge);
  sock.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.5.2', rpcVersion: 1, authentication: { challenge, salt } } }));
  sock.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.op === 1) {
      if (m.d?.authentication !== expect) return sock.close(4009, 'auth');
      console.log('[mock-obs] client identified');
      return sock.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
    }
    if (m.op !== 6) return;
    const { requestType: t, requestId, requestData: d = {} } = m.d;
    console.log('[mock-obs] →', t);
    const rep = (ok, data, code = 100) => sock.send(JSON.stringify({ op: 7, d: { requestType: t, requestId, requestStatus: { result: ok, code }, ...(data ? { responseData: data } : {}) } }));
    const sc = st.scenes['Main Scene'];
    if (t === 'GetVersion') return rep(true, { obsVersion: '30.2.3', obsWebSocketVersion: '5.5.2' });
    if (t === 'GetVideoSettings') return rep(true, { baseWidth: 1920, baseHeight: 1080 });
    if (t === 'GetCurrentProgramScene') return rep(true, { currentProgramSceneName: 'Main Scene' });
    if (t === 'GetInputDefaultSettings') return rep(true, { defaultInputSettings: { url: '', width: 800, height: 600, fps: 30, fps_custom: false, shutdown: false, restart_when_active: false, webpage_control_level: 1, css: '', reroute_audio: false } });
    if (t === 'GetSceneItemId') { const i = sc.find((x) => x.sourceName === d.sourceName); return i ? rep(true, { sceneItemId: i.sceneItemId }) : rep(false, null, 600); }
    if (t === 'CreateInput') { st.inputs[d.inputName] = { settings: { ...d.inputSettings } }; const i = { sceneItemId: st.next++, sourceName: d.inputName, transform: { positionX: 0, positionY: 0, scaleX: 1, scaleY: 1, boundsType: 'OBS_BOUNDS_NONE' } }; sc.push(i); return rep(true, { sceneItemId: i.sceneItemId }); }
    if (t === 'SetInputSettings') { Object.assign(st.inputs[d.inputName].settings, d.inputSettings); return rep(true); }
    if (t === 'GetInputSettings') { const i = st.inputs[d.inputName]; return i ? rep(true, { inputSettings: i.settings }) : rep(false, null, 600); }
    if (t === 'SetSceneItemTransform') { const i = sc.find((x) => x.sceneItemId === d.sceneItemId); if (i) Object.assign(i.transform, d.sceneItemTransform); return rep(true); }
    if (t === 'GetSceneItemTransform') { const i = sc.find((x) => x.sceneItemId === d.sceneItemId); return rep(true, { sceneItemTransform: i.transform }); }
    if (t === 'GetSceneItemEnabled') return rep(true, { sceneItemEnabled: true });
    if (t === 'SetSceneItemEnabled' || t === 'SetInputAudioMonitorType') return rep(true);
    return rep(false, null, 204);
  });
});
console.log(`[mock-obs] listening on 127.0.0.1:4455 — password: ${PASSWORD}`);
