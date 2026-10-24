/**
 * GATE — MEGA Phase 4: persistent handles, /<handle> permanence, demo room.
 * Handles moved from /r/<handle> to bare /<handle>; the old prefix must keep
 * 301ing so links already shared stay alive. `/<handle>` serves the join
 * page IN PLACE (server.js, since the pretty URL became the real URL): 200,
 * no redirect, so the address bar keeps the handle.
 *
 * Boots its own server (startGateServer, scratch DATA_DIR, money keys
 * blanked) unless GATE_BASE_URL names one already running.
 */
import WebSocket from 'ws';
import puppeteer from 'puppeteer-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startGateServer, assertFreshBuild } from './_gate-helpers.mjs';

const PORT = 3212;
let srv = null;
let scratch = null;
if (!process.env.GATE_BASE_URL) {
  scratch = mkdtempSync(path.join(tmpdir(), 'mc-phase4-'));
  srv = await startGateServer({
    port: PORT, dataDir: scratch, label: 'phase4',
    // Every live key starts blank (startGateServer, SENSITIVE_ENV).
    env: { FOLLOW_STREAM: '0', TEMPO_RPC_URL: 'http://127.0.0.1:9' },
  });
  // A crash mid-gate must not leave the server behind.
  process.on('exit', () => srv?.kill());
}
const BASE = process.env.GATE_BASE_URL || `http://localhost:${PORT}`;
const WS_URL = BASE.replace(/^http/, 'ws');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = 'gate_' + Math.random().toString(36).slice(2, 8);

// create with handle
const res = await fetch(`${BASE}/api/dashboard/create`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Handle Gate', password: 'phase4-gate', handle: H, config: {} }),
});
const { room } = await res.json();
ok('create claims handle', res.status === 201 && room?.handle === H, `handle=${room?.handle}`);

// /<handle> resolves IN PLACE; old id link keeps working
const servesInPlace = async (url) => {
  const r = await fetch(url, { redirect: 'manual' });
  const body = await r.text();
  return { ok: r.status === 200 && !r.headers.get('location') && /<html/i.test(body), status: r.status, location: r.headers.get('location') };
};
const r1 = await servesInPlace(`${BASE}/${H}`);
ok('/<handle> serves the join page in place (200, no redirect)', r1.ok, `${r1.status} ${r1.location || ''}`);
const unknown = await fetch(`${BASE}/gate_nobody_${H.slice(5)}`, { redirect: 'manual' });
ok('...an unclaimed name is not a room: it falls through to the 404', unknown.status === 404, `${unknown.status}`);
const r2 = await fetch(`${BASE}/${H}/overlay`, { redirect: 'manual' });
ok('/<handle>/overlay 302 → overlay',
  r2.status === 302 && r2.headers.get('location') === `/overlay?room=${room.id}`);
// retired prefix: must 301 to the bare form so shared links survive
const r1L = await fetch(`${BASE}/r/${H}`, { redirect: 'manual' });
ok('legacy /r/<handle> 301 → /<handle>',
  r1L.status === 301 && r1L.headers.get('location') === `/${H}`,
  r1L.headers.get('location'));
const r2L = await fetch(`${BASE}/r/${H}/overlay`, { redirect: 'manual' });
ok('legacy /r/<handle>/overlay 301 → /<handle>/overlay',
  r2L.status === 301 && r2L.headers.get('location') === `/${H}/overlay`);
const old = await fetch(`${BASE}/join?room=${room.id}`);
ok('old room-id link still works', old.status === 200);

// collisions + validation
const dup = await fetch(`${BASE}/api/dashboard/create`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Dup', password: 'phase4-gate', handle: H, config: {} }),
});
ok('duplicate handle rejected with 409', dup.status === 409);
const badH = await fetch(`${BASE}/api/dashboard/create`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Bad', password: 'phase4-gate', handle: 'x y!!', config: {} }),
});
ok('invalid handle rejected with 400', badH.status === 400);
const reserved = await fetch(`${BASE}/api/dashboard/create`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Rsv', password: 'phase4-gate', handle: 'dashboard', config: {} }),
});
ok('reserved handle rejected', reserved.status === 400);

// handle change via authenticated update
const H2 = H + '_v2';
const upd = await fetch(`${BASE}/api/dashboard/rooms/${room.id}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'X-Room-Password': 'phase4-gate' },
  body: JSON.stringify({ handle: H2 }),
});
const updData = await upd.json();
ok('handle re-claim from dashboard works', upd.ok && updData.room.handle === H2, updData.room?.handle);
const r3 = await servesInPlace(`${BASE}/${H2}`);
const r3cfg = await (await fetch(`${BASE}/api/config?room=${H2}`)).json();
ok('new handle resolves (in place, and /api/config names the same room)', r3.ok && r3cfg.roomId === room.id, `${r3.status} ${r3cfg.roomId}`);

// ── demo room ────────────────────────────────────────────────────────────────
const rd = await servesInPlace(`${BASE}/demo`);
// The page resolves its room from the pathname; /api/config takes the handle.
const demoCfg = await (await fetch(`${BASE}/api/config?room=demo`)).json();
const demoRoomId = demoCfg.roomId;
ok('/demo resolves', rd.ok && !!demoRoomId, `${rd.status} ${demoRoomId}`);
ok('demo room runs dust pricing',
  demoCfg.passkeyTickPrice === '0.001' && demoCfg.passkeyTickSeconds === 1 && demoCfg.maxSession === '0.03',
  `${demoCfg.passkeyTickPrice}/${demoCfg.passkeyTickSeconds}s cap ${demoCfg.maxSession}`);
ok('demo room has letters + drops on',
  demoCfg.letters?.enabled === true && demoCfg.rewardsEnabled === true && demoCfg.isDemo === true,
  `letters=${demoCfg.letters?.enabled} drops=${demoCfg.rewardsEnabled} isDemo=${demoCfg.isDemo}`);

// drops accrue in the demo room (points mode)
{
  const ws = new WebSocket(WS_URL);
  const earned = [];
  await new Promise((res2, rej) => { ws.on('open', res2); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'rewards_register', wallet: '0x' + 'b2'.repeat(20), roomId: demoRoomId }));
  ws.send(JSON.stringify({ type: 'rewards_visibility', visible: true }));
  ws.on('message', (raw) => {
    try { const m = JSON.parse(raw.toString()); if (m.type === 'rewards_earned' && m.credited) earned.push(m); } catch { }
  });
  // demo interval is 30s — too slow for a gate; assert config instead + one manual wait is too long.
  // 35s wait: acceptable once.
  await sleep(35_000);
  ok('drops accrue in the demo room', earned.length >= 1, `${earned.length} credits (30s interval)`);
  ws.close();
}

// demo banner + letter button on the join page. A browser check grades the
// build on disk, so it runs only against a build newer than web/'s source.
const fresh = assertFreshBuild();
ok('G0 the web build is newer than its source (the browser checks below grade THIS tree)', fresh.ok, fresh.detail);
if (fresh.ok) {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
  });
  const page = await browser.newPage();
  // Deliberately the RETIRED url: a real browser must survive the whole
  // legacy chain (/r/demo 301 → /demo, served in place), which is what
  // anyone clicking an old pasted link actually does.
  await page.goto(`${BASE}/r/demo`, { waitUntil: 'networkidle2' });
  await sleep(1500);
  const probe = await page.evaluate(() => ({
    url: location.pathname + location.search,
    banner: getComputedStyle(document.getElementById('demoBanner')).display !== 'none',
    letterBtn: getComputedStyle(document.getElementById('letterBtn')).display !== 'none',
    joinIntact: ['username', 'joinBtn', 'priceAmount'].every((id) => !!document.getElementById(id)),
  }));
  ok('browser survives the legacy /r/demo redirect and lands on the pretty URL',
    probe.url === '/demo', probe.url);
  ok('demo banner visible', probe.banner);
  ok('letter button live in demo room', probe.letterBtn);
  ok('join controls intact', probe.joinIntact);
  await browser.close();
}

if (srv) srv.kill();
if (scratch) { await sleep(1000); try { rmSync(scratch, { recursive: true, force: true }); } catch { /* OneDrive may hold a file */ } }
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
