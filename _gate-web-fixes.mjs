/**
 * GATE — the web fix round of 2026-10-24 (audit fix-web), each fix proven
 * where it runs: the letters route at module level, the built artifacts on
 * disk, everything else in a real Chrome against `server.js --prod`.
 *
 *   node _gate-web-fixes.mjs                     every section
 *   node _gate-web-fixes.mjs --only=letters,app  some of them
 *   node _gate-web-fixes.mjs --only=app,lk --root=<dir>
 *        the browser sections against another tree's server.js and web/.next
 *        (a HEAD copy built in a scratch dir): the discriminating cases must
 *        FAIL there. That is the mutation proof for the client-side fixes.
 *
 * SECTIONS
 *   letters  node, no server. letters.js /api/letter/submit with a stub
 *            payment step: a repeated attemptId is answered from the letter
 *            it already paid for, so a retry costs nothing (web-4 server
 *            half). The same run against a copy of the tree with HEAD's
 *            letters.js charges again: it discriminates on its own.
 *   built    node, needs a FRESH build. Font preloads, built CSS (fonts and
 *            fonts lane), and the Privy SDK out of every route's first-load
 *            JS (web-1).
 *   app      Chrome, one server, zero external network (every request off
 *            localhost is aborted), all signer keys blank but a generated
 *            seller key (so the meter exists for free Hollers), the chain RPC
 *            pointed at a dead loopback port:
 *              J1-J3  web-2  GO LIVE while the seat socket is down
 *              J4     web-17 the Add funds copy chip
 *              J5     web-35/37 one /api/auth/me, one /api/config, one socket
 *              J6     web-4  a failed Holler upload retries without paying
 *              J7     a kicked guest gets the setup controls back
 *              R1-R5  web-5/19/34 + bounty handoff: one pledge per take,
 *                     camera off on failure, preview URL revoked, bare mime,
 *                     oversize refused before the pledge
 *              D1-D2  web-6/21 the dashboard's OBS visibility watch (mock OBS
 *                     on 127.0.0.1:4455; skipped, and said so, when a real
 *                     OBS holds that port)
 *              B1     web-22 the booth with site storage blocked
 *              RW1-2  reward defaults inside the server bounds; the refusal shown
 *              A1-A2  the account page reads ?link_error= / ?linked=
 *              W-C*   the campaign screens (campaigns lane)
 *              CSS*   computed styles (fonts and CSS lane)
 *              P1     web-1 a Sign in tap while the Privy chunk downloads
 *   lk       Chrome + a local SFU (tools/livekit-server.exe --dev on :7880,
 *            started here and stopped after when not already running):
 *              K1-K2  web-3  cancelling while the stage starts leaves no
 *                     published seat and no live camera track
 *              K3     NEW-1  the camera is local until GO LIVE
 *
 * Gates authenticate, never bypass: every signed-in page carries a sealed
 * cookie from mintBountyAuth. Spends nothing, touches no chain. Run in the
 * FOREGROUND; every server and the SFU (when started here) are stopped.
 */
import { spawn, spawnSync, execFileSync } from 'child_process';
import {
  mkdtempSync, mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync,
  symlinkSync, lstatSync, rmdirSync, rmSync, readdirSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { once } from 'events';
import { randomBytes, randomUUID, createHash } from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LETTERS_CHILD_FLAG = '--letters-child';
const CAMPAIGN_SCREENS_SEED_FLAG = '--seed-campaign-screens';

// ── child modes: a fresh process, because the stores fix their data dir the
// first time they are imported ──────────────────────────────────────────────
if (process.argv[2] === LETTERS_CHILD_FLAG) {
  await lettersChild(process.argv[3]);
  process.exit(0);
}
if (process.argv[2] === CAMPAIGN_SCREENS_SEED_FLAG) {
  await runCampaignScreensSeed(process.argv.slice(3));
  process.exit(0);
}

const { startGateServer, mintBountyAuth, assertFreshBuild } = await import('./_gate-helpers.mjs');
const { startRpcStandIn, readOnlyTokenNode } = await import('./_gate-rpc-standin.mjs');

const arg = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const ONLY = new Set((arg('only') || 'letters,built,app,lk').split(',').map((s) => s.trim()).filter(Boolean));
const ROOT = arg('root') ? path.resolve(arg('root')) : HERE;
const MUTANT = ROOT !== HERE;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, step = 250) => {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); }
  return v;
};
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

// ═══ letters: one payment per take (web-4, server half) ═════════════════════
async function lettersChild(lettersFile) {
  const dir = path.dirname(lettersFile);
  const imp = (f) => import(pathToFileURL(path.join(dir, f)).href);
  const { default: express } = await import('express');
  const rs = await imp('rooms-store.js');
  const { attachLetters } = await imp(path.basename(lettersFile));
  const paid = rs.createRoom('Gate paid letters', { passkeyTickPrice: '0.001', letters: { enabled: true, price: '0.25', minSeconds: 1, maxSeconds: 10 } });
  const free = rs.createRoom('Gate free letters', { passkeyTickPrice: '0', letters: { enabled: true, price: '0', minSeconds: 1, maxSeconds: 10 } });

  // The stub payment step, shaped like mppx's: a request with no credential
  // is answered 402 with a challenge, the paid retry carries one. It takes a
  // moment, so a second copy of the same take can arrive meanwhile.
  let charges = 0;
  const mppMeter = {
    async handleTick(webReq) {
      if (!webReq.headers.get('authorization')) {
        return { status: 402, respond: (res) => res.status(402).json({ challenge: 'stub' }) };
      }
      await new Promise((r) => setTimeout(r, 150)); // (child mode runs before the module's helpers exist)
      charges += 1;
      return { status: 200, respond: (res, body) => res.json(body) };
    },
  };
  const app = express();
  app.use(express.json());
  attachLetters(app, {
    mppMeter, broadcastToRoom() {}, hasOverlay: () => true, activeSeats: new Map(),
    sellerAddress: `0x${'1'.repeat(40)}`, settlement: null, log: { log() {}, warn() {}, error() {} },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, credential) => fetch(`${base}/api/letter/submit?room=${body.room}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: 'Payment stub' } : {}) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  // A client's whole submit: answered 402, it pays and asks again.
  const send = async (body) => { const a = await post(body, false); return a.status === 402 ? post(body, true) : a; };
  const ADDR = `0x${'a'.repeat(40)}`;
  const take = (extra = {}) => ({ room: paid.id, username: 'gate', address: ADDR, durationS: 3, mime: 'video/webm', ...extra });
  const A = randomUUID(), B = randomUUID(), C = randomUUID(), F = randomUUID();
  const out = {};
  out.r1 = await send(take({ attemptId: A })); out.c1 = charges;
  out.r2 = await send(take({ attemptId: A })); out.c2 = charges;
  const up = await fetch(`${base}${out.r1.body.uploadUrl}`, { method: 'PUT', headers: { 'Content-Type': 'video/webm' }, body: Buffer.alloc(4096, 7) });
  out.up = up.status;
  out.r3 = await send(take({ attemptId: A })); out.c3 = charges;
  out.r4 = await send(take({ attemptId: B })); out.c4 = charges;
  out.r5 = await send(take({ attemptId: A, address: `0x${'b'.repeat(40)}` })); out.c5 = charges;
  out.r6a = await send(take()); out.r6b = await send(take()); out.c6 = charges;
  await post(take({ attemptId: C }), false);
  out.r7 = await Promise.all([post(take({ attemptId: C }), true), post(take({ attemptId: C }), true)]); out.c7 = charges;
  const freeTake = { room: free.id, username: 'gate', durationS: 3, mime: 'video/webm', attemptId: F };
  out.f1 = await send(freeTake); out.f2 = await send(freeTake);
  server.close();
  console.log(JSON.stringify(out));
}

/** A copy of the tracked tree (plus untracked root modules), node_modules junctioned. */
const JUNCTIONS = ['node_modules'];
function treeCopy(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const media = /\.(png|jpe?g|gif|webp|mp4|webm|mov|wav|mp3|ogg|ttf|woff2?|psd|zip|pdf)$/i;
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: HERE }).toString().split('\0');
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: HERE }).toString().split('\0')
    .filter((f) => /\.(m?js|cjs)$/.test(f) && !f.includes('/'));
  for (const f of [...tracked, ...untracked]) {
    if (!f || f.startsWith('web/') || f.startsWith('design-assets/') || f.startsWith('docs/') || media.test(f)) continue;
    const src = path.join(HERE, f);
    if (!existsSync(src)) continue;
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    copyFileSync(src, path.join(dir, f));
  }
  for (const j of JUNCTIONS) symlinkSync(path.join(HERE, j), path.join(dir, j), 'junction');
  return dir;
}
// A recursive delete of a tree that still holds a junction can walk into the
// real node_modules, so each junction goes first (rmdirSync removes only the
// link) and the copy only once every one is verifiably gone.
function removeCopy(dir) {
  for (const j of JUNCTIONS) {
    const p = path.join(dir, j);
    try { if (lstatSync(p).isSymbolicLink()) rmdirSync(p); } catch { /* absent */ }
  }
  if (JUNCTIONS.some((j) => { try { lstatSync(path.join(dir, j)); return true; } catch { return false; } })) {
    console.log(`  (copy LEFT at ${dir}: a junction could not be removed — remove it before the folder)`);
    return;
  }
  rmSync(dir, { recursive: true, force: true });
}

function runLettersChild(lettersFile) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-webfix-letters-'));
  try {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), LETTERS_CHILD_FLAG, lettersFile], {
      cwd: HERE, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, DATA_DIR: dataDir, MODERATION_API_KEY: '', KEEP_ORPHAN_ROOMS: 'true' },
    });
    const line = (r.stdout || '').trim().split('\n').pop();
    try { return JSON.parse(line); } catch { return { error: `${r.stderr || r.stdout}`.slice(-800) }; }
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
}

function lettersChecks(o, label) {
  if (o.error) { ok(`${label} the letters route ran`, false, o.error); return; }
  const id = (r) => r?.body?.letterId;
  ok(`${label} L1. a paid submit charges once and opens an upload slot`, o.r1.status === 200 && !!id(o.r1) && o.c1 === 1, `status ${o.r1.status}, charges ${o.c1}`);
  ok(`${label} L2. the same take again is answered from its letter, free (deduped)`,
    o.r2.status === 200 && id(o.r2) === id(o.r1) && o.r2.body.deduped === true && o.r2.body.uploadUrl === o.r1.body.uploadUrl && o.c2 === 1,
    `same letter: ${id(o.r2) === id(o.r1)}, charges ${o.c2}`);
  ok(`${label} L3. once uploaded, the same take is refused as already sent, free`,
    o.up === 200 && o.r3.status === 409 && o.r3.body.reason === 'already_sent' && o.c3 === 1, `upload ${o.up}, status ${o.r3.status} ${o.r3.body.reason || ''}, charges ${o.c3}`);
  ok(`${label} L4. a new take is a new letter, charged`, o.r4.status === 200 && id(o.r4) !== id(o.r1) && o.c4 === 2, `charges ${o.c4}`);
  ok(`${label} L5. another payer naming the same attempt gets a letter of their own`, o.r5.status === 200 && id(o.r5) !== id(o.r1) && o.c5 === 3, `charges ${o.c5}`);
  ok(`${label} L6. a page that sends no attemptId is never deduped`, id(o.r6a) && id(o.r6b) && id(o.r6a) !== id(o.r6b) && o.c6 === 5, `charges ${o.c6}`);
  const statuses = o.r7.map((r) => r.status).sort();
  ok(`${label} L7. two copies of one take paying at once: one charge, the other refused in flight`,
    statuses.join(',') === '200,409' && o.r7.some((r) => r.body.reason === 'in_flight') && o.c7 === 6, `statuses ${statuses}, charges ${o.c7}`);
  ok(`${label} L8. a free room's repeated take is the same letter`, o.f1.status === 200 && id(o.f2) === id(o.f1) && o.f2.body.deduped === true);
}

async function lettersSection() {
  console.log('\n── letters: one payment per take (web-4, server half) ──');
  lettersChecks(runLettersChild(path.join(HERE, 'letters.js')), 'tree:');
  // DISCRIMINATES: HEAD's letters.js in a copy of the tree must charge again.
  let copy = null;
  try {
    copy = treeCopy('mc-webfix-letters-head-');
    writeFileSync(path.join(copy, 'letters.js'), execFileSync('git', ['show', 'HEAD:letters.js'], { cwd: HERE }));
    const o = runLettersChild(path.join(copy, 'letters.js'));
    if (o.error) ok('HEAD: the letters route ran', false, o.error);
    else {
      const repeatCharged = o.c2 === 2 && o.r2.body.letterId !== o.r1.body.letterId;
      const afterUploadCharged = o.c3 === 3;
      const concurrentCharged = o.r7.every((r) => r.status === 200);
      ok('L-D. DISCRIMINATES: HEAD letters.js charges a repeated take again (L2, L3 and L7 fail there)',
        repeatCharged && afterUploadCharged && concurrentCharged,
        `HEAD: repeat charged ${repeatCharged}, after upload charged ${afterUploadCharged}, both concurrent charged ${concurrentCharged}`);
    }
  } catch (e) {
    ok('L-D. build the HEAD copy', false, e.message.split('\n')[0]);
  } finally { if (copy) removeCopy(copy); }
}

// ═══ built: what the build put on disk ══════════════════════════════════════
async function builtSection() {
  console.log('\n── built artifacts (fresh build) ──');
  const fresh = assertFreshBuild();
  ok('G0. the build under test is newer than every source it renders', MUTANT || fresh.ok, fresh.detail);
  if (MUTANT || fresh.ok) {
    await cssNodeChecks({ ok, repo: ROOT });
    // web-1: the Privy SDK leaves every route's first-load JS.
    const web = path.join(ROOT, 'web');
    const stats = JSON.parse(readFileSync(path.join(web, '.next', 'diagnostics', 'route-bundle-stats.json'), 'utf8'));
    const routes = Array.isArray(stats) ? stats : Object.values(stats);
    const cache = new Map();
    const read = (f) => { if (!cache.has(f)) cache.set(f, readFileSync(path.join(web, f), 'utf8')); return cache.get(f); };
    for (const needle of ['PrivyProvider', 'styled-components']) {
      const on = routes.filter((r) => r.firstLoadChunkPaths.some((f) => read(f).includes(needle)));
      ok(`W1. web-1: "${needle}" is in the first-load JS of no route (HEAD: 21 of 21)`, routes.length > 0 && on.length === 0,
        `${on.length} of ${routes.length}`);
    }
    const all = readdirSync(path.join(web, '.next', 'static', 'chunks')).filter((f) => f.endsWith('.js'));
    ok('W2. web-1 guard: the Privy SDK is still built, as an async chunk', all.some((f) => read(path.join('.next', 'static', 'chunks', f)).includes('PrivyProvider')));
  }
}


/** The env every browser section's server boots with: no real signer, no chain.
 *  startGateServer already starts every live key blank (SENSITIVE_ENV); these
 *  are the stand-ins this gate needs on top of that. */
function quietEnv(rpcUrl, extra = {}) {
  return {
    // A generated, never-funded seller key: the meter exists (free Hollers
    // need it) and nothing can be signed with any real one.
    SELLER_PRIVATE_KEY: `0x${randomBytes(32).toString('hex')}`,
    // A read-only chain stand-in: token reads answer (the dashboard's save
    // validates the payment token), nothing can be sent.
    TEMPO_RPC_URL: rpcUrl,
    KEEP_ORPHAN_ROOMS: 'true',
    TWITCH_CLIENT_ID: '', KICK_CLIENT_ID: '',
    LIVEKIT_URL: 'ws://localhost:7880', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret',
    ...extra,
  };
}

async function launch() {
  const { default: puppeteer } = await import('puppeteer-core');
  return puppeteer.launch({
    executablePath: CHROME, headless: 'new', protocolTimeout: 120000,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
}

/**
 * A page in its own context. Every request off this origin is aborted, so no
 * section reaches vdo.ninja, Twitch, Privy or a CDN; `hold(fn)` lets a section
 * delay or answer a request of its own.
 */
async function newPage(browser, APP, { cookie = null, before = null, hold = null, permissions = ['camera', 'microphone'] } = {}) {
  const ctx = await browser.createBrowserContext();
  await ctx.overridePermissions(APP, permissions);
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 950 });
  page.on('dialog', (d) => void d.accept());
  if (cookie) {
    const eq = cookie.indexOf('=');
    await page.setCookie({ name: cookie.slice(0, eq), value: decodeURIComponent(cookie.slice(eq + 1)), url: APP });
  }
  if (before) await page.evaluateOnNewDocument(before);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (!url.startsWith(APP) && !url.startsWith('data:') && !url.startsWith('blob:')) return void req.abort().catch(() => {});
    if (hold && hold(req)) return; // the section took it
    req.continue().catch(() => {});
  });
  page.__ctx = ctx;
  return page;
}
const closePage = (page) => page.__ctx.close().catch(() => {});

const clickText = (page, sel, txt) => page.evaluate((s, t) => {
  const el = [...document.querySelectorAll(s)].find((b) => (b.textContent || '').includes(t));
  if (!el) return false;
  el.click();
  return true;
}, sel, txt);
const bodyHas = (page, txt) => page.evaluate((t) => document.body.innerText.includes(t), txt);
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent || '', sel);
async function setInput(page, sel, value) {
  await page.evaluate((s, v) => {
    const i = document.querySelector(s);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, v);
    i.dispatchEvent(new Event('input', { bubbles: true }));
  }, sel, value);
}

// Installed before any page script: every WebSocket the page makes is kept in
// window.__sockets, and while window.__wsBlockUntil is in the future a new one
// is pointed at a dead port, so a section can take the seat socket down and
// keep it down for as long as it likes.
function socketHarness() {
  const Real = window.WebSocket;
  window.__sockets = [];
  window.__wsBlockUntil = 0;
  function Wrapped(url, protocols) {
    const target = Date.now() < window.__wsBlockUntil ? 'ws://127.0.0.1:9/' : url;
    const ws = protocols === undefined ? new Real(target) : new Real(target, protocols);
    window.__sockets.push(ws);
    return ws;
  }
  Wrapped.prototype = Real.prototype;
  Object.assign(Wrapped, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Wrapped;
}

// A fake camera and mic whose tracks are all kept in window.__tracks, so a
// section can ask afterwards whether any is still live. `gumDelayMs` holds
// getUserMedia open like a permission prompt does.
function mediaHarness(gumDelayMs) {
  window.__tracks = [];
  window.__gumAsked = false;
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    window.__gumAsked = true;
    if (gumDelayMs) await new Promise((r) => setTimeout(r, gumDelayMs));
    const s = await real(c);
    s.getTracks().forEach((t) => window.__tracks.push(t));
    return s;
  };
}

async function appSections() {
  console.log(`\n── app: browser sections${MUTANT ? ` (server and build from ${ROOT})` : ''} ──`);
  if (!MUTANT) {
    const fresh = assertFreshBuild();
    ok('A0. the build under test is newer than every source it renders', fresh.ok, fresh.detail);
    if (!fresh.ok) return;
  } else if (!existsSync(path.join(ROOT, 'web', '.next', 'BUILD_ID'))) {
    ok('A0. the mutant root has a build', false, ROOT);
    return;
  }
  const PORT = 3366;
  const APP = `http://localhost:${PORT}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-webfix-app-'));
  const FAN = 'webfixfan', OWNER = 'webfixowner', STAR = 'webfixstar';
  const auth = mintBountyAuth({ handles: [FAN, OWNER, CAMPAIGN_SCREENS_HANDLE], dataDir });
  const seeded = seedCampaignScreens({ script: fileURLToPath(import.meta.url), dataDir, ownerAccountId: auth.accountIdFor(CAMPAIGN_SCREENS_HANDLE) });
  let srv = null, browser = null;
  const rpc = await startRpcStandIn(readOnlyTokenNode());
  try {
    srv = await startGateServer({
      port: PORT, dataDir, label: 'web-fixes',
      // cwd picks the tree: its server.js, its web/.next, its .env.
      cwd: ROOT,
      env: { ...auth.env, ...quietEnv(rpc.url, { BOUNTY_CLAIM: '1', OBS_ONECLICK: '1', BOUNTY_MIN_CLIP_SECONDS: '3', ...CAMPAIGN_SCREENS_ENV }) },
    });
    const api = (p, { method = 'GET', body, as } = {}) => fetch(`${APP}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(as ? auth.headers(as) : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    const makeRoom = async (name, config, as = null) => {
      const r = await api('/api/dashboard/create', { method: 'POST', as, body: { name, password: as ? undefined : 'webfix-room', config } });
      if (!r.body.room?.id) throw new Error(`room create failed (${r.status}) ${JSON.stringify(r.body).slice(0, 160)}`);
      return r.body.room;
    };
    browser = await launch();
    const ctx = { ok, browser, APP, api, auth, makeRoom, srv, FAN, OWNER, STAR };

    for (const [name, fn] of Object.entries({
      join: joinSection, holler: hollerSection, record: recordSection, dash: dashboardSection,
      booth: boothSection, rewards: rewardsSection, account: accountSection,
    })) {
      try { await fn(ctx); } catch (e) { ok(`${name} section ran to the end`, false, e.stack?.split('\n').slice(0, 3).join(' | ') || String(e)); }
    }
    try { await campaignScreens({ ok, browser, APP, auth, seeded }); } catch (e) { ok('campaign screens ran to the end', false, String(e)); }
    {
      const page = await newPage(browser, APP);
      for (const [name, fn] of Object.entries(cssBrowserChecks)) {
        // repo is where `git show HEAD:` runs (the guards compare against
        // HEAD's source), so it is this repo even when the tree under test is a copy.
        try { await fn({ ok, page, APP, repo: HERE }); } catch (e) { ok(`css ${name} ran`, false, String(e)); }
      }
      await closePage(page);
    }
    try { await privyLoadingSection(ctx); } catch (e) { ok('privy section ran', false, String(e)); }
  } catch (e) {
    ok('app sections booted', false, e.stack?.split('\n').slice(0, 4).join(' | ') || String(e));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (fail && srv) { console.log('--- server output (tail) ---'); console.log(srv.stderr().slice(-2500)); }
    if (srv) srv.kill();
    await rpc.close();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* a file the stopping server still holds: the OS temp sweep takes it */ }
  }
}

// ── J: the join page ─────────────────────────────────────────────────────────
async function joinSection({ ok, browser, APP, api, makeRoom }) {
  const { default: WebSocket } = await import('ws');
  // A free vdo room: the stage offers GO LIVE after its 5 s fallback, so no
  // camera service is needed.
  const room = await makeRoom('Web fixes join', { passkeyTickPrice: '0', transport: 'vdo', letters: { enabled: false } });
  const watcher = new WebSocket(APP.replace('http', 'ws'));
  const seen = [];
  watcher.on('message', (d) => { try { seen.push(JSON.parse(d.toString())); } catch { /* */ } });
  await once(watcher, 'open');
  watcher.send(JSON.stringify({ type: 'subscribe_room', room: room.id }));

  const page = await newPage(browser, APP, { before: socketHarness });
  try {
    await page.goto(`${APP}/join?room=${room.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#username', { timeout: 30000 });
    await sleep(1200);
    await setInput(page, '#username', 'webfix-guest');
    await page.click('#joinBtn');
    const goLive = await until(() => text(page, '#joinBtn').then((t) => /go live/i.test(t)), 20000);
    ok('J0. the join flow reaches GO LIVE (free room, vdo fallback)', !!goLive, await text(page, '#joinBtn'));
    if (!goLive) return;

    // The seat socket goes down, and stays down for 5 s.
    await page.evaluate(() => {
      window.__wsBlockUntil = Date.now() + 5000;
      for (const s of window.__sockets) { try { s.close(); } catch { /* */ } }
    });
    await sleep(300);
    await page.click('#joinBtn');
    await sleep(500);
    const during = await text(page, '#joinBtn');
    ok('J1. web-2: GO LIVE with the socket down does not claim LIVE (HEAD: "You\'re LIVE" at once)', /going live/i.test(during) && !/you're live/i.test(during), during);
    const added = await until(() => seen.find((m) => m.type === 'seat_added' && m.seat?.username === 'webfix-guest'), 20000);
    ok('J2. web-2: once the socket is back the seat goes live on the server (seat_added; HEAD: never, until the 5-minute camera timeout)', !!added);
    const after = await until(() => text(page, '#joinBtn').then((t) => (/you're live/i.test(t) ? t : null)), 10000);
    ok('J3. web-2: ...and only then does the page say LIVE', !!after, after || await text(page, '#joinBtn'));

    // J7. a kicked guest gets the setup controls back, as after a leave (the
    // page said "Add funds to rejoin" with the button still hidden). The seat
    // is found by name on the room's seat list, so the case also runs where
    // the seat never went live (HEAD, where J2 fails).
    const seat = (await (await fetch(`${APP}/api/seats?room=${encodeURIComponent(room.id)}`)).json()).seats?.find((x) => x.username === 'webfix-guest');
    ok('J7. precondition: the guest holds a seat to be kicked from', !!seat);
    if (seat) {
      await fetch(`${APP}/api/dashboard/rooms/${encodeURIComponent(room.id)}/kick/${encodeURIComponent(seat.id)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Room-Password': 'webfix-room' },
      });
      const unlocked = await until(() => page.evaluate(() => document.getElementById('username')?.readOnly === false && /kicked|removed you/i.test(document.getElementById('message')?.textContent || '')), 10000);
      ok('J7. after a kick the username unlocks and the setup controls return (HEAD: left locked)', !!unlocked,
        await page.evaluate(() => `readOnly=${document.getElementById('username')?.readOnly} message="${(document.getElementById('message')?.textContent || '').slice(0, 60)}"`));
    }
  } finally {
    await closePage(page);
    watcher.close();
  }

  // J4. web-17: the address chip in the Add funds message copies.
  const paid = await makeRoom('Web fixes paid', { passkeyTickPrice: '0.001', transport: 'vdo' });
  const ADDR = '0x00000000000000000000000000000000000000a1';
  // An injected wallet that shares one address and agrees to every chain
  // switch: the MetaMask path, with nothing to sign.
  const p2 = await newPage(browser, APP, {
    permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'],
    before: `window.ethereum = { isMetaMask: true, on() {}, removeListener() {},
      async request({ method }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['${ADDR}'];
        if (method === 'eth_chainId') return '0x1079';
        return null;
      } };`,
  });
  try {
    await p2.goto(`${APP}/join?room=${paid.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p2.waitForSelector('#connectBtn', { timeout: 30000 });
    await sleep(1500);
    await p2.click('#connectBtn');
    await until(() => text(p2, '#connectBtn').then((t) => /connected/i.test(t)), 10000);
    await p2.click('#depositBtn');
    const chip = await until(() => p2.$('#message .addr-copy'), 10000);
    if (!chip) { ok('J4. web-17: the Add funds message carries the address chip', false); }
    else {
      await p2.evaluate(() => document.querySelector('#message .addr-copy').click());
      const icon = await until(() => text(p2, '#message .addr-copy .addr-copy-icon').then((t) => (t === '✓' ? t : null)), 3000);
      ok('J4. web-17: tapping the chip in the Add funds message copies it (icon ✓; HEAD: stays ⧉)', icon === '✓', await text(p2, '#message .addr-copy .addr-copy-icon'));
    }
  } finally { await closePage(p2); }

  // J5. web-35/37: one identity request, one config request, one socket.
  const cfg = (await api('/api/config?room=default')).body;
  for (const route of ['/join?room=default', '/dashboard', '/account']) {
    const counts = { me: 0, config: 0 };
    const page = await newPage(browser, APP, { before: socketHarness });
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (u.pathname === '/api/auth/me') counts.me++;
      if (u.pathname === '/api/config' && u.searchParams.get('room') === 'default') counts.config++;
    });
    try {
      await page.goto(`${APP}${route}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(8000);
      const sockets = await page.evaluate(() => window.__sockets.filter((s) => !/127\.0\.0\.1:9/.test(s.url)).length);
      const wantSockets = route.startsWith('/join') ? (cfg.rewardsEnabled ? 2 : 1) : 0;
      ok(`J5. web-35/37 ${route}: /api/auth/me once, /api/config?room=default once, ${wantSockets} socket(s) (HEAD /join: 5, 3, 2)`,
        counts.me === 1 && counts.config === 1 && sockets === wantSockets, `me ${counts.me}, config ${counts.config}, sockets ${sockets}`);
    } finally { await closePage(page); }
  }
}

// ── J6: a Holler whose upload fails retries the upload, not the payment ─────
async function hollerSection({ ok, browser, APP, makeRoom }) {
  const room = await makeRoom('Web fixes holler', { passkeyTickPrice: '0', transport: 'vdo', letters: { enabled: true, price: '0', minSeconds: 1, maxSeconds: 10 } });
  const submits = [], puts = [];
  let failedOnce = false;
  const page = await newPage(browser, APP, {
    hold: (req) => {
      const u = new URL(req.url());
      if (u.pathname === '/api/letter/submit' && req.method() === 'POST') submits.push(JSON.parse(req.postData() || '{}'));
      if (u.pathname.startsWith('/api/letter/upload/') && req.method() === 'PUT') {
        puts.push(u.pathname);
        if (!failedOnce) { failedOnce = true; req.abort('failed').catch(() => {}); return true; }
      }
      return false;
    },
  });
  try {
    await page.goto(`${APP}/join?room=${room.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#letterBtn', { visible: true, timeout: 30000 });
    await sleep(800);
    await page.click('#letterBtn');
    await page.waitForSelector('#letterRecordBtn', { visible: true, timeout: 15000 });
    await sleep(800);
    await page.click('#letterRecordBtn');
    await sleep(3500);
    await page.click('#letterRecordBtn');
    await page.waitForSelector('#letterSendBtn', { visible: true, timeout: 15000 });
    await page.click('#letterSendBtn');
    await until(() => text(page, '#letterStatus').then((t) => t.includes('❌')), 15000);
    const status = await text(page, '#letterStatus');
    ok('J6a. web-4: the failed upload says Send again only retries the upload', /only retries the upload/.test(status), status);
    await page.click('#letterSendBtn');
    const sent = await until(() => bodyHas(page, 'Holler sent'), 15000);
    ok('J6b. web-4: Send again uploads the same take without a second submit (HEAD: 2 submits, 2 payments)',
      !!sent && submits.length === 1 && puts.length === 2 && puts[0] === puts[1],
      `submits ${submits.length}, PUTs ${puts.length}${puts.length === 2 ? `, same slot: ${puts[0] === puts[1]}` : ''}`);
    ok('J6c. web-4: the submit names its take (attemptId)', /^[0-9a-f-]{36}$/.test(String(submits[0]?.attemptId || '')), String(submits[0]?.attemptId));
  } finally { await closePage(page); }
}

// ── R: the bounty record flow ────────────────────────────────────────────────
async function recordSection({ ok, browser, APP, api, auth, FAN, STAR }) {
  await api('/api/bounty/admin/seed', { method: 'POST', as: FAN, body: { platform: 'twitch', handle: STAR } });
  const cookie = auth.cookieFor(FAN);
  const openRecorder = async (page) => {
    await page.goto(`${APP}/bounty/s/twitch/${STAR}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await until(() => bodyHas(page, `Record a Holler for ${STAR}`), 30000);
    await clickText(page, 'button', `Record a Holler for ${STAR}`);
    await until(() => bodyHas(page, 'minimum'), 10000);
  };
  const recordTake = async (page, ms = 4600) => {
    await clickText(page, 'button', 'Record');
    await sleep(ms);
    await clickText(page, 'button', 'Stop');
  };

  // R1-R2. one pledge per take; the clip goes up under its bare container.
  {
    const pledges = [], clips = [];
    let failedOnce = false;
    const page = await newPage(browser, APP, {
      cookie,
      before: () => {
        window.__urls = { made: 0, revoked: 0 };
        const mk = URL.createObjectURL.bind(URL), rv = URL.revokeObjectURL.bind(URL);
        URL.createObjectURL = (b) => { window.__urls.made++; return mk(b); };
        URL.revokeObjectURL = (u) => { window.__urls.revoked++; return rv(u); };
      },
      hold: (req) => {
        const u = new URL(req.url());
        if (u.pathname === '/api/bounty/pledge' && req.method() === 'POST') pledges.push(JSON.parse(req.postData() || '{}'));
        if (/^\/api\/bounty\/clip\/[^/]+$/.test(u.pathname) && req.method() === 'POST') {
          clips.push({ path: u.pathname, type: req.headers()['content-type'] });
          if (!failedOnce) { failedOnce = true; req.abort('failed').catch(() => {}); return true; }
        }
        return false;
      },
    });
    try {
      await openRecorder(page);
      await recordTake(page);
      await until(() => bodyHas(page, 'Re-record'), 15000);
      // web-34: a re-record replaces the take; its preview URL is let go.
      await clickText(page, 'button', 'Re-record');
      await sleep(300);
      await recordTake(page);
      await until(() => bodyHas(page, 'Looks good'), 15000);
      const urls = await page.evaluate(() => window.__urls);
      ok('R1. web-34: a replaced take\'s preview URL is revoked (HEAD: 0 revokes)', urls.revoked >= 1, JSON.stringify(urls));
      await clickText(page, 'button', 'Looks good');
      await until(() => bodyHas(page, 'Before you pay'), 15000);
      await clickText(page, 'button', '& send');
      const retry = await until(() => page.evaluate(() => [...document.querySelectorAll('button')].some((b) => /Retry upload/.test(b.textContent || ''))), 20000);
      ok('R2a. web-5: a failed upload offers a retry of the upload, terms locked', !!retry
        && await page.evaluate(() => [...document.querySelectorAll('label')].find((l) => /Bounty amount/.test(l.textContent || ''))?.querySelector('input')?.disabled === true));
      await clickText(page, 'button', 'Retry upload');
      const done = await until(() => bodyHas(page, 'Sent'), 25000);
      ok('R2b. web-5: the retry uploads the same take under ONE pledge (HEAD: a second pledge)',
        !!done && pledges.length === 1 && clips.length === 2 && clips[0].path === clips[1].path,
        `pledges ${pledges.length}, clip posts ${clips.length}`);
      ok('R2c. bounty handoff: the pledge names its take (attemptId)', /^[0-9a-f-]{36}$/.test(String(pledges[0]?.attemptId || '')));
      ok('R2d. guard (bounty handoff): the clip still goes up as a bare type, no codec list, now that the recorder asks for one (the route refuses a comma)',
        clips.length > 0 && clips.every((c) => /^video\/(webm|mp4)$/.test(c.type || '')), clips.map((c) => c.type).join(', '));
    } finally { await closePage(page); }
  }

  // R3. web-19: a recorder that cannot be built turns the camera off.
  {
    const page = await newPage(browser, APP, {
      cookie,
      before: () => {
        window.__tracks = [];
        const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (c) => { const s = await real(c); s.getTracks().forEach((t) => window.__tracks.push(t)); return s; };
        const Real = window.MediaRecorder;
        function Throwing() { throw new DOMException('not supported here', 'NotSupportedError'); }
        Throwing.isTypeSupported = (m) => Real.isTypeSupported(m);
        window.MediaRecorder = Throwing;
      },
    });
    try {
      await openRecorder(page);
      await clickText(page, 'button', 'Record');
      await sleep(2500);
      const states = await page.evaluate(() => window.__tracks.map((t) => t.readyState));
      ok('R3. web-19: when MediaRecorder throws, every captured track is ended (HEAD: live)', states.length > 0 && states.every((s) => s === 'ended'), JSON.stringify(states));
    } finally { await closePage(page); }
  }

  // R4. bounty handoff: a take over clipMaxBytes is refused before any pledge.
  {
    const pledges = [];
    const page = await newPage(browser, APP, {
      cookie,
      hold: (req) => {
        const u = new URL(req.url());
        if (u.pathname === '/api/bounty/pledge') pledges.push(1);
        if (u.pathname === '/api/bounty/config' && req.method() === 'GET') {
          // The server's own answer, with a tiny clip limit.
          fetch(req.url(), { headers: req.headers() }).then((r) => r.json()).then((cfg) => req.respond({
            status: 200, contentType: 'application/json', body: JSON.stringify({ ...cfg, clipMaxBytes: 2048 }),
          })).catch(() => req.continue().catch(() => {}));
          return true;
        }
        return false;
      },
    });
    try {
      await openRecorder(page);
      await recordTake(page);
      const refused = await until(() => bodyHas(page, 'over the'), 15000);
      const offered = await bodyHas(page, 'Looks good');
      ok('R4. a take over the clip limit is refused before the pay step (HEAD: offered "Looks good")', !!refused && !offered && pledges.length === 0,
        `refused ${!!refused}, pay step offered ${offered}, pledges ${pledges.length}`);
    } finally { await closePage(page); }
  }
}

// ── D: the dashboard's OBS visibility watch ─────────────────────────────────
async function dashboardSection({ ok, browser, APP, auth, makeRoom, OWNER }) {
  const { WebSocketServer } = await import('ws');
  const OBS_PASSWORD = 'webfix-obs-password';
  const b64sha = (s) => createHash('sha256').update(s, 'utf8').digest('base64');
  let wss;
  try {
    wss = new WebSocketServer({ host: '127.0.0.1', port: 4455 });
    await new Promise((resolve, reject) => { wss.once('listening', resolve); wss.once('error', reject); });
  } catch (e) {
    ok('D0. the mock OBS can take 127.0.0.1:4455', false, `${e.code || e.message}: a real OBS may be running; this section never talks to it`);
    return;
  }
  // An OBS whose program scene has no overlay in it: overlay_hidden, reason scene.
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
      const { requestType, requestId } = msg.d;
      const reply = (result, responseData, code = 100) => sock.send(JSON.stringify({
        op: 7, d: { requestType, requestId, requestStatus: { result, code }, ...(responseData ? { responseData } : {}) },
      }));
      if (requestType === 'GetVersion') return reply(true, { obsVersion: '30.2.0', obsWebSocketVersion: '5.5.2' });
      if (requestType === 'GetVideoSettings') return reply(true, { baseWidth: 1920, baseHeight: 1080 });
      if (requestType === 'GetCurrentProgramScene') return reply(true, { currentProgramSceneName: 'Main' });
      return reply(false, null, 600);
    });
  });
  try {
    const a = await makeRoom('Web fixes OBS A', { passkeyTickPrice: '0', transport: 'vdo' }, OWNER);
    const b = await makeRoom('Web fixes OBS B', { passkeyTickPrice: '0', transport: 'vdo' }, OWNER);
    const posts = [];
    const page = await newPage(browser, APP, {
      cookie: auth.cookieFor(OWNER),
      hold: (req) => {
        const m = new URL(req.url()).pathname.match(/^\/api\/rooms\/([^/]+)\/overlay-visibility$/);
        if (m && req.method() === 'POST') posts.push({ room: decodeURIComponent(m[1]), signal: JSON.parse(req.postData() || '{}').signal });
        return false;
      },
    });
    try {
      await page.goto(`${APP}/dashboard?room=${a.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      // "Connect OBS" is folded shut; open it the way a click on its summary does.
      const opened = await until(() => page.evaluate(() => {
        const s = [...document.querySelectorAll('summary')].find((x) => /Connect OBS/.test(x.textContent || ''));
        if (!s) return false;
        s.parentElement.open = true;
        return !!document.querySelector('input[placeholder="OBS WebSocket password"]');
      }), 30000, 500);
      ok('D0. the dashboard shows the room-mode OBS connect', !!opened);
      if (!opened) return;
      await page.type('input[placeholder="OBS WebSocket password"]', OBS_PASSWORD);
      await clickText(page, 'button', 'Test connection');
      const forA = await until(() => posts.find((p) => p.room === a.id && p.signal === 'overlay_hidden'), 15000);
      ok('D1. web-6: connecting OBS on the dashboard starts the visibility watch with no reload (overlay_hidden posted; HEAD: nothing until a reload)', !!forA, JSON.stringify(posts));
      // web-21: switch to the second room in place.
      await page.select('select[aria-label="Switch room"]', b.id);
      const forB = await until(() => posts.find((p) => p.room === b.id && p.signal === 'overlay_hidden'), 15000);
      ok('D2. web-21: after a room switch the new room\'s state is posted too (HEAD: dropped as a repeat)', !!forB, JSON.stringify(posts));
    } finally { await closePage(page); }
  } finally { wss.close(); }
}

// ── B1: the booth with site storage blocked ─────────────────────────────────
async function boothSection({ ok, browser, APP, auth, makeRoom, OWNER }) {
  const room = await makeRoom('Web fixes booth', { passkeyTickPrice: '0', transport: 'livekit', joinStream: { enabled: true } }, OWNER);
  const page = await newPage(browser, APP, {
    cookie: auth.cookieFor(OWNER),
    before: () => {
      Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } });
    },
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  try {
    await page.goto(`${APP}/dashboard?room=${room.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const booth = await until(() => page.$('#cohost-booth'), 20000);
    await sleep(2000);
    const crashed = await bodyHas(page, 'Application error');
    ok('B1. web-22: with site storage blocked the dashboard renders the booth, no crash (HEAD: Application error)', !!booth && !crashed,
      `booth ${!!booth}, crashed ${crashed}${errors.length ? `, errors: ${errors.slice(0, 2).join(' | ').slice(0, 200)}` : ''}`);
  } finally { await closePage(page); }
}

// ── RW: reward defaults inside the server's bounds; the refusal is shown ────
async function rewardsSection({ ok, browser, APP, auth, makeRoom, FAN, OWNER }) {
  // Switch the Rewards feature on. /dashboard is prerendered, so a click
  // before hydration lands on inert markup: click until the section says it
  // is on.
  const toggleRewards = (page) => until(() => page.evaluate(() => {
    const s = document.querySelector('section.mcc-feature[data-kind="rewards"]');
    if (!s) return false;
    if (s.dataset.enabled === 'true') return true;
    s.querySelector('.mcc-feature-head').click();
    return false;
  }), 20000, 700);
  const value = (page, label) => page.$eval(`input[aria-label="${label}"]`, (e) => e.value).catch(() => null);
  // RW1. a new room's cash reward starts inside the bounds (FAN owns no room,
  // so /dashboard is the create form).
  {
    const page = await newPage(browser, APP, { cookie: auth.cookieFor(FAN) });
    try {
      await page.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await toggleRewards(page);
      const amount = await until(() => value(page, 'Amount per reward'), 10000);
      const cap = await value(page, 'Maximum per viewer');
      ok('RW1. a new cash reward starts at 0.01 per earn and 0.1 per viewer, inside the server bounds (HEAD: 0.1 and 5, refused)',
        amount === '0.01' && cap === '0.1', `amount ${amount}, cap ${cap}`);
    } finally { await closePage(page); }
  }
  // RW2. GUARD: an amount over the bounds is refused, and the dashboard says
  // why in words (rewards_out_of_bounds), not silently.
  {
    const room = await makeRoom('Web fixes rewards', { passkeyTickPrice: '0', transport: 'vdo', rewards: { enabled: false, earnAmount: '0.5', earnCap: '5', rewardType: 'usdc' } }, OWNER);
    const page = await newPage(browser, APP, { cookie: auth.cookieFor(OWNER) });
    try {
      await page.goto(`${APP}/dashboard?room=${room.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await until(() => page.evaluate(() => /Live · taking joins|Paused/.test(document.body.innerText)), 30000);
      await sleep(1500);
      await toggleRewards(page);
      const said = await until(() => page.evaluate(() => {
        const t = document.querySelector('.mcc-status-live small')?.textContent || '';
        return /can be at most/.test(t) ? t : null;
      }), 15000);
      ok('RW2. guard: switching on a reward above the bounds shows the server\'s reason on the dashboard', !!said, said || 'no message');
    } finally { await closePage(page); }
  }
}

// ── A: the account page says what the link flow did ─────────────────────────
async function accountSection({ ok, browser, APP, auth, OWNER }) {
  for (const [query, want, label] of [
    ['link_error=provider_linked', /already has a different login on that platform/, 'A1. a refused link (provider_linked) is said, in words'],
    ['linked=x', /X \(Twitter\) is linked to this account/, 'A2. a completed link (linked=x) is said'],
  ]) {
    const page = await newPage(browser, APP, { cookie: auth.cookieFor(OWNER) });
    try {
      await page.goto(`${APP}/account?${query}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const notice = await until(() => page.$eval('#link-notice', (e) => e.textContent).catch(() => null), 20000);
      const search = await page.evaluate(() => location.search);
      ok(`${label}, then taken off the URL (HEAD: nothing on screen)`, !!notice && want.test(notice) && !/link_error|linked=/.test(search),
        `notice ${JSON.stringify(notice)}, search "${search}"`);
    } finally { await closePage(page); }
  }
}

// ── P1: a Sign in tap while the Privy chunk downloads ───────────────────────
async function privyLoadingSection({ ok, browser, APP, api }) {
  const cfg = (await api('/api/config?room=default')).body;
  if (!cfg.privy?.appId) { console.log('  SKIP  P1. no Privy app id on this server: the lazy bridge has nothing to load'); return; }
  let loaded = false;
  const page = await newPage(browser, APP, {
    hold: (req) => {
      // Every script asked for after the page's own load is a lazy chunk;
      // on /how-it-works that is the Privy bridge.
      if (loaded && req.resourceType() === 'script') { setTimeout(() => req.continue().catch(() => {}), 6000); return true; }
      return false;
    },
  });
  try {
    await page.goto(`${APP}/how-it-works`, { waitUntil: 'load', timeout: 60000 });
    loaded = true;
    await until(() => page.evaluate(() => !!window.MegaWallet), 10000);
    await clickText(page, 'button', 'Sign in');
    await sleep(600);
    const body = await page.evaluate(() => document.body.innerText);
    ok('P1. web-1: Sign in during the Privy download says "still loading", never "unavailable"', /still loading/i.test(body) && !/unavailable on this server/i.test(body),
      (body.match(/Sign-in[^.\n]*\./) || [''])[0]);
  } finally { await closePage(page); }

  // P2. GUARD for the risk web-1 adds: the Privy chunk failing to download
  // must not take the page down (a lazy import that rejects throws in render).
  let after = false;
  const p2 = await newPage(browser, APP, {
    hold: (req) => {
      if (after && req.resourceType() === 'script') { req.abort('failed').catch(() => {}); return true; }
      return false;
    },
  });
  const errors = [];
  p2.on('pageerror', (e) => errors.push(String(e && e.message)));
  try {
    await p2.goto(`${APP}/how-it-works`, { waitUntil: 'load', timeout: 60000 });
    after = true;
    await sleep(4000);
    const crashed = await bodyHas(p2, 'Application error');
    const header = await p2.evaluate(() => [...document.querySelectorAll('button')].some((b) => /Sign in/.test(b.textContent || '')));
    ok('P2. web-1 guard: with the Privy chunk failing, the page stays up and Sign in is still there', !crashed && header,
      `crashed ${crashed}, sign-in ${header}${errors.length ? `, errors: ${errors.slice(0, 2).join(' | ').slice(0, 160)}` : ''}`);
  } finally { await closePage(p2); }
}

// ═══ lk: the LiveKit camera stage on a local SFU ═══════════════════════════
async function livekitSections() {
  console.log('\n── lk: LiveKit camera stage (local SFU) ──');
  if (!MUTANT) {
    const fresh = assertFreshBuild();
    ok('K0. the build under test is newer than every source it renders', fresh.ok, fresh.detail);
    if (!fresh.ok) return;
  }
  const up = async () => (await fetch('http://localhost:7880/').then((r) => r.text()).catch(() => null)) === 'OK';
  let sfu = null;
  if (!(await up())) {
    const exe = path.join(HERE, 'tools', 'livekit-server.exe');
    if (!existsSync(exe)) { ok('K0. a local SFU is available', false, 'tools/livekit-server.exe missing'); return; }
    sfu = spawn(exe, ['--dev'], { stdio: 'ignore', cwd: HERE });
    if (!(await until(up, 20000, 500))) { sfu.kill(); ok('K0. the local SFU started', false); return; }
  }
  const PORT = 3367;
  const APP = `http://localhost:${PORT}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-webfix-lk-'));
  let srv = null, browser = null;
  const rpc = await startRpcStandIn(readOnlyTokenNode());
  try {
    srv = await startGateServer({ port: PORT, dataDir, label: 'web-fixes-lk', cwd: ROOT, env: quietEnv(rpc.url) });
    const { RoomServiceClient } = await import('livekit-server-sdk');
    const svc = new RoomServiceClient('http://localhost:7880', 'devkey', 'secret');
    const seatsOnSfu = async (roomId) => (await svc.listParticipants(`mc-${roomId}`).catch(() => []))
      .filter((p) => p.identity.startsWith('seat:')).map((p) => ({ identity: p.identity, tracks: (p.tracks || []).length }));
    const makeRoom = async (name) => {
      const r = await fetch(`${APP}/api/dashboard/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, password: 'webfix-lk', config: { transport: 'livekit', passkeyTickPrice: '0' } }) }).then((x) => x.json());
      return r.room;
    };
    browser = await launch();
    const join = async (room, { before, hold } = {}) => {
      const page = await newPage(browser, APP, { before, hold });
      await page.goto(`${APP}/join?room=${room.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('#username', { timeout: 30000 });
      await sleep(1200);
      await setInput(page, '#username', `lk-${room.id.slice(0, 4)}`);
      await page.click('#joinBtn');
      return page;
    };
    const tracksLive = (page) => page.evaluate(() => (window.__tracks || []).filter((t) => t.readyState === 'live').length);

    // K1. cancel while the publisher token is on its way back. The server mints
    // it at once (the seat is still held); only the ANSWER is slow, the way a
    // phone network is, so the token is valid when it lands after the cancel.
    {
      const room = await makeRoom('Web fixes K1');
      let tokenAnswered = 0;
      const page = await join(room, {
        before: `(${mediaHarness.toString()})(0)`,
        hold: (req) => {
          if (new URL(req.url()).pathname !== '/api/livekit/token' || req.method() !== 'POST') return false;
          fetch(req.url(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: req.postData() })
            .then(async (r) => { const body = await r.text(); await sleep(1500); await req.respond({ status: r.status, contentType: 'application/json', body }); if (r.ok) tokenAnswered++; })
            .catch(() => req.abort().catch(() => {}));
          return true;
        },
      });
      try {
        const waiting = await until(() => text(page, '#joinBtn').then((t) => /waiting for camera/i.test(t)), 15000);
        await page.click('#joinBtn'); // "Waiting for camera — tap to cancel"
        await sleep(6000);
        const seats = await seatsOnSfu(room.id);
        // Not vacuous: the seat was granted and a valid token DID land after the cancel.
        ok('K1. web-3: cancelling while the token answer is in flight leaves no seat participant on the SFU and no live track (HEAD: connects and publishes anyway)',
          !!waiting && tokenAnswered === 1 && seats.length === 0 && (await tracksLive(page)) === 0,
          `waiting ${!!waiting}, token answered ${tokenAnswered}, seats ${JSON.stringify(seats)}, live tracks ${await tracksLive(page)}`);
      } finally { await closePage(page); }
    }

    // K2. cancel while getUserMedia is still asking (a permission prompt).
    {
      const room = await makeRoom('Web fixes K2');
      const page = await join(room, { before: `(${mediaHarness.toString()})(1500)` });
      try {
        const asked = await until(() => page.evaluate(() => window.__gumAsked), 15000); // connected; the prompt is up
        if (!asked) ok('K2. precondition: the stage reached the camera prompt', false);
        await page.click('#joinBtn');
        await sleep(6000);
        const live = await tracksLive(page);
        ok('K2. web-3: cancelling during the camera prompt ends every captured track (HEAD: left live, unattached)',
          live === 0 && (await page.evaluate(() => (window.__tracks || []).length)) > 0, `live tracks ${live}`);
      } finally { await closePage(page); }
    }

    // K3. NEW-1: nothing is published until GO LIVE.
    {
      const room = await makeRoom('Web fixes K3');
      const page = await join(room, { before: `(${mediaHarness.toString()})(0)` });
      try {
        await until(() => text(page, '#joinBtn').then((t) => /go live/i.test(t)), 20000);
        await sleep(2000);
        const before = await seatsOnSfu(room.id);
        ok('K3a. NEW-1: at "Go Live" the guest is connected but publishes nothing (HEAD: camera and mic published)',
          before.length === 1 && before[0].tracks === 0, JSON.stringify(before));
        await page.click('#joinBtn');
        await until(() => text(page, '#joinBtn').then((t) => /you're live/i.test(t)), 15000);
        const after = await until(async () => { const s = await seatsOnSfu(room.id); return s.length && s[0].tracks >= 2 ? s : null; }, 10000);
        ok('K3b. NEW-1: GO LIVE publishes the camera and mic', !!after, JSON.stringify(after || await seatsOnSfu(room.id)));
      } finally { await closePage(page); }
    }
  } catch (e) {
    ok('lk sections ran to the end', false, e.stack?.split('\n').slice(0, 3).join(' | ') || String(e));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (fail && srv) { console.log('--- server output (tail) ---'); console.log(srv.stderr().slice(-2000)); }
    if (srv) srv.kill();
    if (sfu) sfu.kill();
    await rpc.close();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* a file the stopping server still holds: the OS temp sweep takes it */ }
  }
}

// ═══ CSS and fonts (merged from the fonts and CSS lane) ═══════════════════════
// cssNodeChecks reads web/.next (next-font-manifest + built CSS chunks) and
// product.css; cssBrowserChecks.<name>({ ok, page, APP, repo }) run on the app
// server. Each case says what HEAD shows; the GUARD cases read the same before
// and after on purpose (they prove a deletion or a move changed nothing).

function builtCss(repo) {
  const dir = path.join(repo, 'web', '.next', 'static', 'chunks');
  return readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => readFileSync(path.join(dir, f), 'utf8')).join('\n');
}

/** file -> 'Family wWeight[ stretch …]', read from the built @font-face rules (same method as verify-web/css/fonts.cjs). */
function fontFamilyOf(css, file) {
  const id = file.split('/').pop().split('-')[0];
  const r = css.match(new RegExp('@font-face\\{font-family:([^;]*);font-style:[^;]*;font-weight:([^;]*);(?:font-stretch:([^;]*);)?[^}]*' + id));
  return r ? `${r[1].replace(/['"]/g, '')} w${r[2]}${r[3] ? ' stretch ' + r[3] : ''}` : '?';
}

/** Minimal specificity 'a,b,c': :is/:not/:has take their most specific argument, :where adds nothing. */
const spec = (sel) => specOf(sel).join(',');
function specOf(sel) {
  let a = 0, b = 0, c = 0, s = sel;
  const splitTop = (x) => { const out = []; let d = 0, cur = ''; for (const ch of x) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map((y) => y.trim()).filter(Boolean); };
  const cmp = (x, y) => (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]);
  let m;
  while ((m = s.match(/:(is|not|has|where)\(/))) {
    const start = m.index + m[0].length; let d = 1, i = start;
    for (; i < s.length && d; i++) { if (s[i] === '(') d++; if (s[i] === ')') d--; }
    if (m[1] !== 'where') { let best = [0, 0, 0]; for (const alt of splitTop(s.slice(start, i - 1))) { const x = specOf(alt); if (cmp(x, best) > 0) best = x; } a += best[0]; b += best[1]; c += best[2]; }
    s = s.slice(0, m.index) + ' ' + s.slice(i);
  }
  s = s.replace(/\[[^\]]*\]/g, () => { b++; return ' '; }).replace(/::[\w-]+/g, () => { c++; return ' '; })
    .replace(/#[\w-]+/g, () => { a++; return ' '; }).replace(/\.[\w-]+/g, () => { b++; return ' '; })
    .replace(/:[\w-]+(\([^)]*\))?/g, () => { b++; return ' '; });
  for (const t of s.split(/[\s>+~]+/)) if (/^[a-zA-Z][\w-]*$/.test(t)) c++;
  return [a, b, c];
}

async function cssNodeChecks({ ok, repo }) {
  const manifest = JSON.parse(readFileSync(path.join(repo, 'web', '.next', 'server', 'next-font-manifest.json'), 'utf8'));
  const css = builtCss(repo);
  const routes = Object.entries(manifest.app);
  const fam = Object.fromEntries(routes.map(([r, files]) => [r, files.map((f) => fontFamilyOf(css, f))]));
  const withPacifico = routes.filter(([r]) => fam[r].some((x) => x.startsWith('Pacifico')));
  // HEAD: 21 of 21 routes preload Pacifico (22,296 B each)
  ok('CSS1. web-39: no route preloads Pacifico', routes.length > 0 && withPacifico.length === 0,
    `${withPacifico.length} of ${routes.length} routes${withPacifico.length ? ': ' + withPacifico.map(([r]) => r).join(', ') : ''}`);
  // HEAD: /join, /account, /bounty, /dashboard, /how-it-works, /dashboard/design-system(+/pages) preload a static Archivo 800 (14,436 B)
  const archivo800 = routes.filter(([r]) => fam[r].some((x) => /^Archivo w800\b/.test(x)));
  ok('CSS2. web-12: no route preloads the page-level static Archivo 800', archivo800.length === 0,
    `${archivo800.length} routes${archivo800.length ? ': ' + archivo800.map(([r]) => r).join(', ') : ''}`);
  // HEAD: 5 or 6 files (158,680 B / 173,116 B); after: the root layout's four, 136,384 B everywhere
  const sets = new Set(routes.map(([r]) => [...fam[r]].sort().join(' ; ')));
  ok('CSS3. web-12/39: every route preloads the same four root-layout faces (Jakarta, Archivo variable, Space Mono 400/700)',
    sets.size === 1 && routes.every(([r]) => fam[r].length === 4), [...sets].join(' | '));
  // GUARD (HEAD: true as well): preload:false keeps the face; it only stops the preload
  ok('CSS4. guard: Pacifico still has an @font-face in the built CSS (it loads on use)', /@font-face\{font-family:[^;]*Pacifico/.test(css));
  // HEAD: `.font-mono,.font-sans{font-family:var(--font-ui), sans-serif}`
  const mono = (css.match(/(?:^|[},])([^{}]*\.font-mono\b[^{}]*)\{([^}]*)\}/g) || []).filter((r) => /font-family/.test(r));
  ok('CSS5. web-29: the built .font-mono reads var(--font-code) (Space Mono), not the UI face',
    mono.length > 0 && mono.every((r) => /font-family:var\(--font-code\)/.test(r)), mono.join(' || ').slice(0, 200));
  // HEAD: present (from the tw-animate-css and shadcn/tailwind.css imports)
  const imported = ['.paused{', '.running{', '@property --shimmer-angle', '@property --scroll-fade-t', '@property --tw-enter-opacity', '@property --tw-animation-delay'];
  const left = imported.filter((n) => css.includes(n));
  ok('CSS6. cc step 4: nothing from tw-animate-css / shadcn/tailwind.css is left in the built CSS', left.length === 0, left.join(', '));
  // HEAD: every one of these is in the built CSS
  const dead = ['.join-path-switch', '.mcp-rulelist', '.mch-rails-grid', '.mch-clock-grid', '.mcc-obs-reco', '.mcc-obs-manual', '.text-glow-lime', '.dashed-neon', '.mcl-coordinate', '#leaveBtn', '.mch-rail-icon', 'shimmer-sweep'];
  const still = dead.filter((n) => css.includes(n));
  ok('CSS7. web-48/40: the dead rules are gone from the built CSS', still.length === 0, still.join(', '));
  // GUARD: the two product.css selectors that lost dead alternatives keep HEAD's specificity exactly
  const now = readFileSync(path.join(repo, 'web', 'app', 'product.css'), 'utf8');
  const head = execFileSync('git', ['show', 'HEAD:web/app/product.css'], { cwd: repo, encoding: 'utf8' });
  const sel = (src, re) => { const m = src.match(re); return m ? m[1].trim() : null; };
  const pairs = [
    [/\n(body :is\(\.mcc-progress, \.mcc-preview-note[^{]*)\{/, /\n(body small\.mcc-preview-note)\s*\{/],
    [/\n(body :is\(\.mcb-coordinate[^{]*)\{/, /\n(html body :is\(span\.mcb-coordinate[^{]*)\{/],
  ];
  for (const [hRe, nRe] of pairs) {
    const h = sel(head, hRe), n = sel(now, nRe);
    ok(`CSS8. guard: "${n}" keeps HEAD's specificity`, !!h && !!n && spec(h) === spec(n), `${h ? spec(h) : '?'} -> ${n ? spec(n) : '?'}`);
  }
  // GUARD: no .mc-product theme variable shadows globals any more except --radius
  const block = (now.match(/\n\.mc-product \{([^}]*)\}/) || ['', ''])[1];
  const vars = [...block.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]);
  ok('CSS9. web-30: .mc-product declares only --radius of the theme variables', vars.join(',') === '--radius', vars.join(','));
}

const cssBrowserChecks = {
  // web-29. HEAD: the probe's first family is the Plus Jakarta Sans face (--font-ui).
  async fontMonoIsSpaceMono({ ok, page, APP }) {
    for (const route of ['/dashboard', '/account']) {
      await page.goto(`${APP}${route}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => document.readyState === 'complete', { timeout: 30000 });
      const r = await page.evaluate(() => {
        const first = (v) => String(v).split(',')[0].trim().replace(/['"]/g, '');
        const probe = document.createElement('span');
        probe.className = 'font-mono';
        probe.textContent = '0x1234';
        document.body.appendChild(probe);
        const got = first(getComputedStyle(probe).fontFamily);
        probe.remove();
        const code = first(getComputedStyle(document.documentElement).getPropertyValue('--font-code'));
        const ui = first(getComputedStyle(document.documentElement).getPropertyValue('--font-ui'));
        // and every real .font-mono outside .mc-product (product.css forces the UI face inside it, see NOTES)
        const real = [...document.querySelectorAll('.font-mono')].filter((e) => !e.closest('.mc-product'))
          .map((e) => first(getComputedStyle(e).fontFamily));
        return { got, code, ui, real };
      });
      ok(`CSS10. web-29: font-mono on ${route} renders in Space Mono`, !!r.code && r.got === r.code && r.real.every((f) => f === r.code),
        `probe=${r.got} code=${r.code} ui=${r.ui} real=${JSON.stringify(r.real)}`);
    }
  },

  // web-30. HEAD: rgb(255, 255, 255) (product.css overrode it with #ffffff).
  async productPrimaryForeground({ ok, page, APP }) {
    for (const scheme of ['dark', 'light']) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await page.goto(`${APP}/bounty/mine`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction((s) => document.documentElement.classList.contains(s), { timeout: 30000 }, scheme).catch(() => {});
      const c = await page.evaluate(() => {
        const host = document.querySelector('.mc-product') || Object.assign(document.body.appendChild(document.createElement('div')), { className: 'mc-product' });
        const probe = document.createElement('span');
        probe.style.color = 'var(--primary-foreground)';
        host.appendChild(probe);
        const v = getComputedStyle(probe).color;
        probe.remove();
        return v;
      });
      ok(`CSS11. web-30: --primary-foreground inside .mc-product is the on-strap ink (${scheme})`, c === 'rgb(6, 10, 23)', c);
    }
    await page.emulateMediaFeatures([]);
  },

  // web-49. GUARD: 'none' at HEAD too (the deleted rule was fully overridden).
  async ftDotLightNoEdge({ ok, page, APP }) {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.goto(`${APP}/how-it-works`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.documentElement.classList.contains('light') && document.querySelector('.ft .ft-dot'), { timeout: 30000 }).catch(() => {});
    const shadows = await page.evaluate(() => [...document.querySelectorAll('.ft .ft-dot')].filter((d) => !d.closest('.dark')).map((d) => getComputedStyle(d).boxShadow));
    ok('CSS12. guard web-49: in light every feature-tag dot has no edge (box-shadow none)', shadows.length > 0 && shadows.every((s) => s === 'none'), JSON.stringify([...new Set(shadows)]));
    await page.emulateMediaFeatures([]);
  },

  // product.css :is() rewrite. GUARD: HEAD computes the same (the rule kept its specificity).
  async coordinatesKeepReadout({ ok, page, APP }) {
    for (const [route, sel] of [['/how-it-works', '.mch-coordinate'], ['/account', '.mcc-coordinate']]) {
      await page.goto(`${APP}${route}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector(sel, { timeout: 30000 }).catch(() => {});
      const r = await page.evaluate((s) => {
        const first = (v) => String(v).split(',')[0].trim().replace(/['"]/g, '');
        const code = first(getComputedStyle(document.documentElement).getPropertyValue('--font-code'));
        return { code, els: [...document.querySelectorAll(s)].map((e) => { const cs = getComputedStyle(e); return [first(cs.fontFamily), cs.fontSize, cs.letterSpacing, cs.textTransform, cs.fontWeight].join(' '); }) };
      }, sel);
      const want = `${r.code} 11px 1.54px uppercase 400`;
      ok(`CSS13. guard: ${sel} on ${route} still reads as a HUD readout (Space Mono 11px, .14em, uppercase, 400)`,
        r.els.length > 0 && r.els.every((x) => x === want), `want "${want}" got ${JSON.stringify([...new Set(r.els)])}`);
    }
  },

  // web-39. GUARD: true at HEAD too (preload:false must not lose the face).
  async pacificoStillPaintsOnLegacy({ ok, page, APP }) {
    await page.goto(`${APP}/legacy`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('.font-graffiti', { timeout: 30000 }).catch(() => {});
    const r = await page.evaluate(async () => {
      const first = (v) => String(v).split(',')[0].trim().replace(/['"]/g, '');
      const el = document.querySelector('.font-graffiti');
      const fam = first(getComputedStyle(document.documentElement).getPropertyValue('--font-graffiti'));
      const got = el ? first(getComputedStyle(el).fontFamily) : null;
      await document.fonts.load(`16px "${fam}"`);
      return { fam, got, loaded: document.fonts.check(`16px "${fam}"`) };
    });
    ok('CSS14. guard web-39: the legacy tagline is in Pacifico and the face loads on use', !!r.fam && r.got === r.fam && r.loaded, JSON.stringify(r));
  },

  // cc-27. GUARD: the built page's pre-paint script is byte-identical to HEAD's inline string.
  async bootScriptByteIdentical({ ok, APP, repo }) {
    const head = execFileSync('git', ['show', 'HEAD:web/app/layout.tsx'], { cwd: repo, encoding: 'utf8' });
    const want = JSON.parse(head.match(/__html:\s*\n?\s*("(?:[^"\\]|\\.)*")/)[1]);
    const html = await (await fetch(`${APP}/`)).text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    ok('CSS15. guard cc-27: the rendered boot <script> is byte-identical to the HEAD inline script', scripts.includes(want),
      `${scripts.filter((s) => s.includes('mc-ui-mode')).length} script(s) mention mc-ui-mode`);
  },
};

// ═══ the campaign screens (merged from the campaigns lane) ════════════════════
// web-8, web-10, web-11, web-23, web-46. No gate rendered /dashboard/campaigns/*
// before this one. The creator is minted with mintBountyAuth BEFORE boot, so
// seedCampaignScreens can fund and open campaigns for that account through the
// REAL engine and settlement door against a mock chain, in a child process
// (rooms-store and the campaign store fix their data dir on first import).
// CAMPAIGN_FUNDING stays off on the server under test, so its HTTP routes
// could not fund one. TZ is New York on the server; the web-23 case emulates
// UTC in the browser. TEMPO_USDC_ADDRESS is read from .env like server.js
// does (never printed).
const CAMPAIGN_SCREENS_HANDLE = 'twitch:webfixcreator';
const CAMPAIGN_SCREENS_ENV = { TZ: 'America/New_York' };

/** Parent side, after mintBountyAuth and before startGateServer. */
function seedCampaignScreens({ script, dataDir, ownerAccountId }) {
  const r = spawnSync(process.execPath, [script, CAMPAIGN_SCREENS_SEED_FLAG, dataDir, ownerAccountId], {
    cwd: HERE, encoding: 'utf8', env: { ...process.env, DATA_DIR: dataDir },
  });
  try { return JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { return { error: (r.stderr || r.stdout || '').slice(-600) }; }
}

/** Child side: `node _gate-web-fixes.mjs --seed-campaign-screens <dataDir> <ownerAccountId>`. */
async function runCampaignScreensSeed([dataDir, owner]) {
  const ROOM_HANDLE = 'webfixcamps';
  const imp = (rel) => import(pathToFileURL(path.join(HERE, rel)).href);
  try { process.loadEnvFile(path.join(HERE, '.env')); } catch { /* no .env: the default address */ }
  process.env.CAMPAIGN_FUNDING = '1'; // the SEED funds; the server under test keeps it off
  const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
  const { encodeEventTopics, encodeAbiParameters, erc20Abi } = await import('viem');
  const rs = await imp('rooms-store.js');
  const { createSettlement } = await imp('settlement.js');
  const { createCampaignEngine, fundTypedData } = await imp('campaign-engine.js');
  const usdc = { address: process.env.TEMPO_USDC_ADDRESS || '0x20c000000000000000000000b9537d11c60e8b50', decimals: 6, symbol: 'USDC' };
  const platform = '0x00000000000000000000000000000000000000aa';
  const silent = { log() {}, warn() {}, error() {} };

  const room = rs.createRoom('Web fixes campaigns', { passkeyTickPrice: '0', maxSeats: 3, letters: { enabled: true, price: '0', minSeconds: 1, maxSeconds: 10, autoRefundOnReject: true, moderation: 'auto' } });
  rs.setRoomHandle(room.id, ROOM_HANDLE);
  rs.setRoomOwner(room.id, owner);

  // A chain that does what it is asked: pulls get a hash, and the receipt
  // carries the Transfer log the engine credits a pull from.
  let n = 0;
  const chain = { has: () => true, async transferFrom() { n += 1; return `0x${String(n).padStart(64, 'e')}`; }, async transfer() { throw new Error('the seed never pays'); }, async receipt() { return { status: 'success' }; } };
  const door = createSettlement({ dataDir, chain, platformAddress: platform, log: silent });
  const transferLog = ({ token, from, to, value }) => ({ address: token, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }), data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(value)]) });
  const receiptFor = (hash) => {
    const rec = door.all().find((x) => x.kind === 'pull' && String(x.txHash || '').toLowerCase() === String(hash || '').toLowerCase());
    const row = rec?.rows?.find((x) => x.type === 'PULL' || x.type === 'PULL_SENT');
    return { status: 'success', transactionHash: hash, logs: row ? [transferLog({ token: row.token.address, from: row.from, to: row.to, value: row.amountAtomic })] : [] };
  };
  const approvals = new Map();
  const engine = createCampaignEngine({
    dataDir, settlement: door, platformAddress: platform, usdc,
    readAllowance: async () => 10n ** 12n, confirmTx: async (h) => receiptFor(h), log: silent,
    readApproval: async (h) => approvals.get(h) || null,
    resolveRoom: (h) => { const c = rs.getRoomByHandle(h); return c ? { id: c.id, ownerKey: rs.roomOwnerOf(c.id) } : null; },
  });
  const w = { accountId: owner, isAdmin: false };
  const funder = privateKeyToAccount(generatePrivateKey());
  // 02:30Z, three days out: its UTC date is one day after its New York date,
  // which is what makes a zone-dependent date render differently (web-23).
  const deadline = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 3, 2, 30)).toISOString();
  const input = (title) => ({ title, blurb: 'Send a Holler on my stream and get paid for it.', action: { kind: 'holler', roomHandle: ROOM_HANDLE, require: 'aired' }, reward: { type: 'usdc', amount: '5' }, budget: { amount: '12' }, maxClaims: 2, deadline, rules: { minFollowers: 1000 } });
  const fund = async (c) => {
    const hash = `0x${randomBytes(32).toString('hex')}`;
    approvals.set(hash, { from: funder.address, to: c.token.address, status: 'success', timestampMs: Date.parse(c.termsAt || c.createdAt) + 1000, approvals: [{ token: c.token.address, owner: funder.address, spender: platform, value: c.budget.atomic }] });
    const td = fundTypedData({ chainId: 4217, campaignId: c.id, wallet: funder.address, token: c.token.address, amountAtomic: c.budget.atomic, deadline: Math.floor(Date.now() / 1000) + 300 });
    const signature = await funder.signTypedData(td);
    await engine.fund(c.id, { wallet: funder.address, approveTx: hash, signature, typedData: { ...td, message: { ...td.message, amountAtomic: c.budget.atomic, deadline: String(td.message.deadline) } } }, w);
  };
  const live = await engine.createCampaign(input('Web fixes live campaign'), w);
  await fund(live);
  engine.open(live.id, w);
  const funded = await engine.createCampaign(input('Web fixes funded campaign'), w);
  await fund(funded);
  const L = engine.store.getCampaign(live.id), F = engine.store.getCampaign(funded.id);
  console.log(JSON.stringify({ live: { id: L.id, slug: L.slug, status: L.status, deadline: L.deadline }, funded: { id: F.id, slug: F.slug, status: F.status }, roomHandle: ROOM_HANDLE }));
}

/** After boot. ctx = { ok(name, cond, extra), browser, APP, auth (mintBountyAuth result), seeded }. */
async function campaignScreens({ ok, browser, APP, auth, seeded }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  ok('W-C0. seeded: one LIVE and one FUNDED USDC campaign for the creator', seeded?.live?.status === 'live' && seeded?.funded?.status === 'funded', JSON.stringify(seeded).slice(0, 300));
  if (seeded?.live?.status !== 'live') return;
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const cookie = auth.cookieFor(CAMPAIGN_SCREENS_HANDLE);
  const eq = cookie.indexOf('=');
  await page.setCookie({ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url: APP });
  try {
    // web-11: the cost cap keeps its decimal point.
    await page.goto(`${APP}/dashboard/campaigns/new`, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(() => [...document.querySelectorAll('button.mcp-rule-head')].some((b) => /Followed by people on a list/.test(b.textContent || '')), { timeout: 30000 });
    await page.evaluate(() => [...document.querySelectorAll('button.mcp-rule-head')].find((b) => /Followed by people on a list/.test(b.textContent || '')).click());
    // Found by its visible label, which HEAD and the fix share (the fix adds
    // an aria-label; HEAD has none), so the same case runs on both.
    const capHandle = await page.waitForFunction(() => [...document.querySelectorAll('label.mcp-field')]
      .find((l) => (l.querySelector('span')?.textContent || '').trim() === 'X-API cost cap per claim')?.querySelector('input') || null, { timeout: 10000 });
    const cap = capHandle.asElement();
    // Select what the field holds, the way a person does before retyping it.
    await cap.evaluate((el) => { el.focus(); el.select(); });
    await page.keyboard.type('0.25', { delay: 40 });
    await sleep(200);
    const capValue = await cap.evaluate((el) => el.value);
    ok('W-C1 (web-11). typing 0.25 into the X-API cost cap reads back "0.25" (HEAD: "25")', capValue === '0.25', JSON.stringify(capValue));

    // web-8: a LIVE campaign offers no Freeze (the server refuses it); a FUNDED USDC one does.
    const freezeOffered = async (id) => {
      await page.goto(`${APP}/dashboard/campaigns/${encodeURIComponent(id)}`, { waitUntil: 'networkidle2', timeout: 60000 });
      await page.waitForFunction(() => /who qualifies/i.test(document.body.textContent || ''), { timeout: 30000 });
      await sleep(300);
      return page.evaluate(() => [...document.querySelectorAll('button')].some((b) => /Freeze a list from X/.test(b.textContent || '')));
    };
    const onLive = await freezeOffered(seeded.live.id);
    ok('W-C2 (web-8). a LIVE campaign page shows no "Freeze a list from X" (HEAD shows it)', onLive === false, `live: ${onLive}`);
    const onFunded = await freezeOffered(seeded.funded.id);
    ok('W-C3 (web-8 control). a FUNDED USDC campaign page still shows it, so W-C2 is not vacuous', onFunded === true, `funded: ${onFunded}`);
    // web-46: the Copy button's name is its visible text plus the hidden words.
    const copy = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.mcp-linkrow button')][0];
      return b ? { aria: b.getAttribute('aria-label'), text: (b.textContent || '').trim() } : null;
    });
    ok('W-C4 (web-46). the public-link Copy button has no aria-label hiding "Copied"; its text names what it copies', !!copy && copy.aria == null && /^Copy the public link$/.test(copy.text), JSON.stringify(copy));

    // web-10: the list row says "owed", and "left" is the server's remaining.
    await page.goto(`${APP}/dashboard/campaigns`, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(() => /Web fixes live campaign/.test(document.body.innerText), { timeout: 30000 });
    const row = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a.mcp-tr')].find((x) => /Web fixes live campaign/.test(x.textContent || ''));
      return a ? (a.querySelector('.mcp-td-budget small')?.textContent || '').trim() : null;
    });
    ok('W-C5 (web-10). the live row reads "… owed · … left" (HEAD: "… paid · … left")', !!row && / owed · .+ left$/.test(row) && !/ paid · /.test(row), JSON.stringify(row));

    // web-23: /c/<slug> hydrates with no text mismatch when the browser's
    // zone (UTC) is not the server's (TZ above): the deadline is 02:30Z, a
    // different calendar day in New York.
    const p2 = await ctx.newPage();
    const errors = [];
    p2.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    p2.on('pageerror', (e) => errors.push(String(e && e.message)));
    await p2.emulateTimezone('UTC');
    await p2.goto(`${APP}/c/${encodeURIComponent(seeded.live.slug)}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(1500);
    const hydration = errors.filter((e) => /hydrat|#418|#423|#425|did not match|server rendered/i.test(e));
    const deadlineText = await p2.evaluate(() => {
      const dt = [...document.querySelectorAll('dt')].find((x) => /Deadline/.test(x.textContent || ''));
      return dt?.nextElementSibling?.textContent || null;
    });
    ok('W-C6 (web-23). /c/<slug> in a UTC browser against a New York server logs no hydration mismatch', hydration.length === 0, hydration.length ? hydration.slice(0, 2).join(' | ').slice(0, 300) : `deadline reads ${JSON.stringify(deadlineText)}`);
    await p2.close();
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ═══ run ════════════════════════════════════════════════════════════════════
if (ONLY.has('letters')) await lettersSection();
if (ONLY.has('built')) await builtSection();
if (ONLY.has('app')) await appSections();
if (ONLY.has('lk')) await livekitSections();

console.log(`\nRESULT: ${pass} pass, ${fail} fail${MUTANT ? ` (against ${ROOT})` : ''}`);
process.exit(fail === 0 ? 0 : 1);
