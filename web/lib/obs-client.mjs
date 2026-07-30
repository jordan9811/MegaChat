/**
 * obs-websocket v5 client — dependency-free, browser AND Node.
 *
 * ONE FILE ON PURPOSE. The Next UI drives real OBS with it; the conformance
 * gate drives a mock obs-websocket server with the SAME bytes. Two
 * implementations would let the tested one and the shipped one drift, which is
 * this codebase's most reliably fatal pattern (see the badge writer/reader
 * sharing code-matrix.cjs for the same reason).
 *
 * Plain JS, `globalThis.WebSocket` (native in browsers and Node >= 22) and
 * `globalThis.crypto.subtle` (ditto) — no `ws`, no `obs-websocket-js`. The
 * protocol surface we need is a handshake and one request/response opcode; a
 * dependency has not earned its place.
 *
 * THE PASSWORD NEVER LEAVES THE CALLER'S MACHINE. This module talks only to
 * the WebSocket URL it is given (loopback in practice) and does no other I/O.
 * Storage policy lives with the UI; nothing here logs or forwards secrets.
 *
 * Protocol (https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md):
 *   server → Hello       (op 0)  rpcVersion + optional auth challenge/salt
 *   client → Identify    (op 1)  rpcVersion, auth string when challenged
 *   server → Identified  (op 2)  negotiated rpcVersion
 *   client → Request     (op 6)  requestType, requestId, requestData
 *   server → Response    (op 7)  requestId-matched, requestStatus + responseData
 * Auth failure is a close with code 4009 before Identified ever arrives.
 */

/** Distinguishable failure kinds — the UI routes each to different copy. */
export const OBS_ERRORS = {
  /** No WebSocket in this environment (ancient browser). */
  UNSUPPORTED: 'UNSUPPORTED',
  /** Connection refused / dropped before Hello: OBS not running, or the
   *  WebSocket server is disabled, or the port is wrong. */
  NOT_REACHABLE: 'NOT_REACHABLE',
  /** Server closed during auth (4009): wrong password. */
  AUTH_FAILED: 'AUTH_FAILED',
  /** Identified never arrived for another reason (unsupported rpc, etc.). */
  HANDSHAKE_FAILED: 'HANDSHAKE_FAILED',
  /** A request came back with requestStatus.result === false. */
  REQUEST_FAILED: 'REQUEST_FAILED',
  /** The socket died mid-session. */
  DISCONNECTED: 'DISCONNECTED',
};

export class ObsError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'ObsError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const te = new TextEncoder();

async function sha256b64(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', te.encode(text));
  let bin = '';
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * The v5 auth string, byte-exact:
 *   base64(sha256(base64(sha256(password + salt)) + challenge))
 * Exported on its own so the conformance gate can assert the bytes against an
 * independent Node-crypto computation.
 */
export async function computeAuth(password, salt, challenge) {
  const secret = await sha256b64(password + salt);
  return sha256b64(secret + challenge);
}

export class ObsClient {
  constructor({ url = 'ws://127.0.0.1:4455', password = '' } = {}) {
    this.url = url;
    this.password = password;
    this.ws = null;
    this.rpcVersion = null;
    this._pending = new Map(); // requestId → {resolve, reject}
    this._seq = 0;
    this._closedByUs = false;
  }

  /** Full handshake through Identified. Throws ObsError with a `kind`. */
  connect({ timeoutMs = 6000 } = {}) {
    if (typeof globalThis.WebSocket !== 'function') {
      return Promise.reject(new ObsError(OBS_ERRORS.UNSUPPORTED,
        'This browser cannot open WebSocket connections.'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } };
      const timer = setTimeout(() => {
        try { this.ws?.close(); } catch { /* already dead */ }
        fail(new ObsError(OBS_ERRORS.NOT_REACHABLE,
          'OBS did not answer in time. Is OBS running with the WebSocket server enabled?'));
      }, timeoutMs);

      let ws;
      try {
        ws = new globalThis.WebSocket(this.url, 'obswebsocket.json');
      } catch (e) {
        return fail(new ObsError(OBS_ERRORS.NOT_REACHABLE, `Could not open ${this.url}: ${e.message}`));
      }
      this.ws = ws;
      let sawHello = false;

      ws.onerror = () => {
        // Browsers hide the reason on purpose; the close handler carries what
        // little the platform allows. NOT_REACHABLE is decided there.
      };
      ws.onclose = (ev) => {
        for (const p of this._pending.values()) {
          p.reject(new ObsError(OBS_ERRORS.DISCONNECTED, 'OBS connection closed.'));
        }
        this._pending.clear();
        if (settled || this._closedByUs) return;
        // 4009 = authentication failed — the one code worth naming to a user.
        if (ev?.code === 4009 || (sawHello && this.password === '' && ev?.code === 4008)) {
          fail(new ObsError(OBS_ERRORS.AUTH_FAILED,
            'OBS rejected the password. Re-copy it from Tools → WebSocket Server Settings → Show Connect Info.',
            { closeCode: ev?.code }));
        } else if (!sawHello) {
          fail(new ObsError(OBS_ERRORS.NOT_REACHABLE,
            'Could not reach OBS. Check that OBS is running and the WebSocket server is enabled (Tools → WebSocket Server Settings).',
            { closeCode: ev?.code }));
        } else {
          fail(new ObsError(OBS_ERRORS.HANDSHAKE_FAILED,
            `OBS closed the connection during the handshake (code ${ev?.code}).`,
            { closeCode: ev?.code }));
        }
      };
      ws.onmessage = async (ev) => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); }
        catch { return; }
        if (msg.op === 0) { // Hello
          sawHello = true;
          const d = msg.d || {};
          const identify = { rpcVersion: d.rpcVersion ?? 1, eventSubscriptions: 0 };
          if (d.authentication) {
            identify.authentication = await computeAuth(
              this.password, d.authentication.salt, d.authentication.challenge);
          }
          ws.send(JSON.stringify({ op: 1, d: identify }));
        } else if (msg.op === 2) { // Identified
          this.rpcVersion = msg.d?.negotiatedRpcVersion ?? null;
          ws.onmessage = (e2) => this._onMessage(e2);
          settled = true;
          clearTimeout(timer);
          resolve(this);
        }
      };
    });
  }

  _onMessage(ev) {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); }
    catch { return; }
    if (msg.op !== 7) return; // events are unsubscribed; only responses matter
    const d = msg.d || {};
    const pending = this._pending.get(d.requestId);
    if (!pending) return;
    this._pending.delete(d.requestId);
    if (d.requestStatus?.result) {
      pending.resolve(d.responseData ?? {});
    } else {
      pending.reject(new ObsError(OBS_ERRORS.REQUEST_FAILED,
        `${d.requestType} failed: ${d.requestStatus?.comment || `code ${d.requestStatus?.code}`}`,
        { requestType: d.requestType, code: d.requestStatus?.code, comment: d.requestStatus?.comment }));
    }
  }

  /** op 6 → matched op 7. Rejects ObsError(REQUEST_FAILED) with the OBS code. */
  request(requestType, requestData = undefined, { timeoutMs = 8000 } = {}) {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new ObsError(OBS_ERRORS.DISCONNECTED, 'Not connected to OBS.'));
    }
    const requestId = `mc-${++this._seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(requestId);
        reject(new ObsError(OBS_ERRORS.DISCONNECTED, `${requestType} timed out.`));
      }, timeoutMs);
      this._pending.set(requestId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      const d = { requestType, requestId };
      if (requestData !== undefined) d.requestData = requestData;
      this.ws.send(JSON.stringify({ op: 6, d }));
    });
  }

  close() {
    this._closedByUs = true;
    try { this.ws?.close(1000); } catch { /* already dead */ }
    this.ws = null;
  }
}

export default ObsClient;
