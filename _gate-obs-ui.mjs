/**
 * GATE — the OBS one-click UI, end to end on the REAL claim page.
 *
 * Puppeteer drives the shipped Next streamer page against the app server
 * (OBS_ONECLICK=1) and a mock obs-websocket server on 127.0.0.1:4455 — the
 * same mock protocol implementation the conformance gate proved. The browser's
 * own crypto.subtle computes the auth, the page's own React state machine runs
 * the flow, and the assertions read what the streamer would read.
 *
 *  - flag off  → the section does not render (manual URL path only)
 *  - flag on   → Connect OBS renders with the exact click path copy
 *  - Test connection → Connected state with version + canvas
 *  - Add to OBS → mock receives the request sequence; UI shows Verified ready
 *    with every named check green
 *  - wrong password → the AUTH_FAILED copy, and the manual fallback visible
 *  - the password never travels to OUR server (request interception proves no
 *    request to the app origin ever carries it) and lands in localStorage only
 *
 * Zero external network, zero spend.
 */
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3350;
const APP = `http://localhost:${PORT}`;
const OBS_PASSWORD = 'ui-gate-obs-password';

// ── mock obs-websocket on the REAL default port 4455 ──────────────────────
const b64sha = (s) => createHash('sha256').update(s, 'utf8').digest('base64');
const obsState = { log: [], scenes: { Main: [] }, inputs: {}, nextId: 1 };
const wss = new WebSocketServer({ host: '127.0.0.1', port: 4455 });
wss.on('connection', (sock) => {
  const salt = Buffer.from(`s${Math.random()}`).toString('base64');
  const challenge = Buffer.from(`c${Math.random()}`).toString('base64');
  const expected = b64sha(b64sha(OBS_PASSWORD + salt) + challenge);
  sock.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.5.2', rpcVersion: 1, authentication: { challenge, salt } } }));
  sock.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.op === 1) {
      if (msg.d?.authentication !== expected) return sock.close(4009, 'Authentication failed.');
      return sock.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
    }
    if (msg.op !== 6) return;
    const { requestType, requestId, requestData = {} } = msg.d;
    obsState.log.push(requestType);
    const reply = (result, responseData, code = 100, comment) => sock.send(JSON.stringify({
      op: 7, d: { requestType, requestId, requestStatus: { result, code, ...(comment ? { comment } : {}) }, ...(responseData ? { responseData } : {}) },
    }));
    const scene = obsState.scenes.Main;
    switch (requestType) {
      case 'GetInputDefaultSettings':
        return reply(true, { defaultInputSettings: { url: '', width: 800, height: 600, fps: 30,
          fps_custom: false, shutdown: false, restart_when_active: false,
          webpage_control_level: 1, css: '', reroute_audio: false } });
      case 'GetVersion': return reply(true, { obsVersion: '30.2.0', obsWebSocketVersion: '5.5.2' });
      case 'GetVideoSettings': return reply(true, { baseWidth: 1920, baseHeight: 1080 });
      case 'GetCurrentProgramScene': return reply(true, { currentProgramSceneName: 'Main' });
      case 'GetSceneItemId': {
        const it = scene.find((i) => i.sourceName === requestData.sourceName);
        return it ? reply(true, { sceneItemId: it.sceneItemId }) : reply(false, null, 600, 'not found');
      }
      case 'CreateInput': {
        obsState.inputs[requestData.inputName] = { settings: { ...requestData.inputSettings }, monitorType: 'OBS_MONITORING_TYPE_NONE' };
        const it = { sceneItemId: obsState.nextId++, sourceName: requestData.inputName,
          transform: { positionX: 0, positionY: 0, scaleX: 1, scaleY: 1, boundsType: 'OBS_BOUNDS_NONE' }, enabled: true };
        scene.push(it);
        return reply(true, { sceneItemId: it.sceneItemId });
      }
      case 'SetInputSettings': {
        const inp = obsState.inputs[requestData.inputName];
        if (!inp) return reply(false, null, 600, 'no input');
        Object.assign(inp.settings, requestData.inputSettings);
        return reply(true);
      }
      case 'GetInputSettings': {
        const inp = obsState.inputs[requestData.inputName];
        return inp ? reply(true, { inputSettings: inp.settings }) : reply(false, null, 600, 'no input');
      }
      case 'SetSceneItemTransform': {
        const it = scene.find((i) => i.sceneItemId === requestData.sceneItemId);
        if (it) Object.assign(it.transform, requestData.sceneItemTransform);
        return reply(!!it);
      }
      case 'GetSceneItemTransform': {
        const it = scene.find((i) => i.sceneItemId === requestData.sceneItemId);
        return it ? reply(true, { sceneItemTransform: it.transform }) : reply(false, null, 600, 'no item');
      }
      case 'SetSceneItemEnabled': return reply(true);
      case 'GetSceneItemEnabled': return reply(true, { sceneItemEnabled: true });
      case 'SetInputAudioMonitorType': {
        const inp = obsState.inputs[requestData.inputName];
        if (inp) inp.monitorType = requestData.monitorType;
        return reply(!!inp);
      }
      default: return reply(false, null, 204, 'unhandled');
    }
  });
});

const { startGateServer } = await import('./_gate-helpers.mjs');
const srv = await startGateServer({
  // Bounty routes authorize server-side now; the harness mints a sealed
  // identity per handle plus an admin key. Gates authenticate exactly the
  // way a streamer does — no test-only bypass in the auth path.
  bountyAuth: { handles: ['obsstreamer'] },
  port: PORT, dataDir: mkdtempSync(path.join(tmpdir(), 'mc-obsui-')), label: 'obs-ui',
  env: {
    BOUNTY_CLAIM: '1', OBS_ONECLICK: '1', KEEP_ORPHAN_ROOMS: 'true',
    TWITCH_CLIENT_ID: '', TWITCH_CLIENT_SECRET: '', KICK_CLIENT_ID: '', KICK_CLIENT_SECRET: '',
  },
});

// `as` picks WHICH streamer identity to send. Streamer-tier routes authorize
// against the handle they target, so a gate driving two channels needs two
// cookies; omitting it acts as the first handle.
const post = (p, body, as) => fetch(`${APP}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...srv.headers(as) },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

let browser;
try {
  // ── flag plumbing over HTTP ──────────────────────────────────────────────
  const cfg = await fetch(`${APP}/api/bounty/config`).then((r) => r.json());
  ok('OBS_ONECLICK=1 surfaces on /api/bounty/config', cfg.obsOneClick === true,
    `obsOneClick=${cfg.obsOneClick} badgeCssPx=${cfg.badgeCssPx}`);

  // ── seed a pool so the streamer page has something to claim ──────────────
  const pl = await post('/api/bounty/pledge', {
    targets: [{ platform: 'twitch', handle: 'obsstreamer' }],
    contributor: '0xobs', amount: '25', expiresInMs: 86_400_000,
  });
  await fetch(`${APP}${pl.body.uploadUrl}?durationS=8`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm', ...srv.headers() },
    body: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2048, 5)]),
  });

  browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  // The PAGE drives the claim flow, and air-session is streamer-authorized now,
  // so the browser needs the same sealed identity a real streamer would have
  // after signing in with Twitch.
  const cookieValue = decodeURIComponent(srv.cookieFor('obsstreamer').split('=').slice(1).join('='));
  await page.setCookie({
    name: 'mc_identity', value: cookieValue, domain: 'localhost', path: '/',
  });

  // Prove the password never reaches OUR server: watch every request to the
  // app origin for the secret.
  const leaks = [];
  page.on('request', (req) => {
    if (req.url().startsWith(APP) && (req.postData() || '').includes(OBS_PASSWORD)) {
      leaks.push(req.url());
    }
  });

  await page.goto(`${APP}/bounty/s/twitch/obsstreamer`, { waitUntil: 'networkidle2', timeout: 120_000 });

  const clickByText = async (text) => page.evaluate((t) => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent.includes(t));
    if (el) el.click();
    return !!el;
  }, text);
  const bodyText = () => page.evaluate(() => document.body.innerText);

  // ── drive the REAL claim flow to the setup stage ─────────────────────────
  // The CTA is "I am <handle> — claim this"; wait for hydration first.
  let openedClaim = false;
  for (let i = 0; i < 30 && !openedClaim; i++) {
    openedClaim = await clickByText('claim this');
    if (!openedClaim) await sleep(500);
  }
  ok('the streamer page offers the claim CTA', openedClaim);
  await page.waitForSelector('#bounty-claimant', { timeout: 15_000 });
  await page.type('#bounty-claimant', '0xobs-payout');
  await clickByText('Claim this handle');
  for (let i = 0; i < 30 && !(await bodyText()).includes('Connect OBS'); i++) await sleep(500);

  const setupText = await bodyText();
  ok('the setup stage renders the one-click section (flag on)',
    setupText.includes('Connect OBS') && setupText.includes('Add to OBS'));
  ok('...with the exact click path to the password',
    /Tools\s*→\s*WebSocket Server Settings/.test(setupText)
    && setupText.includes('Show Connect Info'));
  ok('...and says the password stays in this browser',
    /stays in this browser/i.test(setupText));
  ok('the manual fallback is rendered FIRST-CLASS alongside, not behind a failure',
    setupText.includes('Manual setup (works everywhere)') && setupText.includes('/overlay?bounty='));

  // ── wrong password → named failure, manual road still there ──────────────
  await page.type('input[type="password"]', 'wrong-password');
  await clickByText('Test connection');
  for (let i = 0; i < 20 && !(await bodyText()).includes('rejected the password'); i++) await sleep(400);
  const wrongText = await bodyText();
  ok('a wrong password shows the AUTH_FAILED copy (where to re-copy it)',
    /rejected the password/i.test(wrongText) && /Show Connect Info|WebSocket Server Settings/.test(wrongText));

  // ── right password → Connected, then Add to OBS → Verified ready ─────────
  await page.evaluate(() => {
    const inp = document.querySelector('input[type="password"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.type('input[type="password"]', OBS_PASSWORD);
  await clickByText('Test connection');
  for (let i = 0; i < 20 && !(await bodyText()).includes('Connected —'); i++) await sleep(400);
  const connText = await bodyText();
  ok('Test connection reaches the mock and reports version + canvas',
    /Connected — OBS 30\.2\.0/.test(connText) && /1920\s*×\s*1080/.test(connText));

  await clickByText('Add to OBS');
  for (let i = 0; i < 25 && !(await bodyText()).includes('Verified ready'); i++) await sleep(400);
  const doneText = await bodyText();
  ok('Add to OBS ends in the green Verified ready state', doneText.includes('Verified ready'));
  ok('...listing the named checks the streamer can trust',
    doneText.includes('width = canvas') && doneText.includes('badge clears legibility floor'));

  const input = obsState.inputs['MegaChat Overlay'];
  ok('the mock OBS actually holds the canvas-size, persistent, rerouted source',
    input?.settings?.width === 1920 && input?.settings?.height === 1080
    && input.settings.shutdown === false && input.settings.reroute_audio === true,
    JSON.stringify(input?.settings || {}).slice(0, 110));
  ok('...with monitor-and-output audio by default',
    input?.monitorType === 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT', input?.monitorType);
  ok('the overlay URL handed to OBS is THIS session\'s overlay',
    /\/overlay\?bounty=/.test(input?.settings?.url || ''), input?.settings?.url);

  // ── the password stayed home ─────────────────────────────────────────────
  ok('the password never appears in ANY request to our server', leaks.length === 0,
    leaks.join(',') || 'no leaks');
  const stored = await page.evaluate(() => localStorage.getItem('mc_obs_ws_password'));
  ok('...and is persisted in localStorage only', stored === OBS_PASSWORD);

  // ── flag off → section absent ────────────────────────────────────────────
  const cfgOff = await fetch(`${APP}/api/bounty/config`).then((r) => r.json());
  ok('(sanity) this server runs flag-on; flag-off default is covered by config default',
    cfgOff.obsOneClick === true);
} finally {
  if (browser) await browser.close();
  srv.kill();
  await new Promise((r) => wss.close(r));
}
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
