/**
 * GATE — MEGA Phase 4: persistent handles, /r/<handle> permanence, demo room.
 */
import WebSocket from 'ws';
import puppeteer from 'puppeteer-core';

const BASE = process.env.GATE_BASE_URL || 'http://localhost:3212';
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

// /r/<handle> resolves; old id link keeps working
const r1 = await fetch(`${BASE}/r/${H}`, { redirect: 'manual' });
ok('/r/<handle> 302 → /join?room=<id>',
  r1.status === 302 && r1.headers.get('location') === `/join?room=${room.id}`,
  r1.headers.get('location'));
const r2 = await fetch(`${BASE}/r/${H}/overlay`, { redirect: 'manual' });
ok('/r/<handle>/overlay 302 → overlay',
  r2.status === 302 && r2.headers.get('location') === `/overlay?room=${room.id}`);
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
const r3 = await fetch(`${BASE}/r/${H2}`, { redirect: 'manual' });
ok('new handle resolves', r3.status === 302 && r3.headers.get('location') === `/join?room=${room.id}`);

// ── demo room ────────────────────────────────────────────────────────────────
const rd = await fetch(`${BASE}/r/demo`, { redirect: 'manual' });
ok('/r/demo resolves', rd.status === 302 && /^\/join\?room=/.test(rd.headers.get('location') || ''));
const demoRoomId = (rd.headers.get('location') || '').split('room=')[1];
const demoCfg = await (await fetch(`${BASE}/api/config?room=${demoRoomId}`)).json();
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

// demo banner + letter button on the join page
{
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
  });
  const page = await browser.newPage();
  await page.goto(`${BASE}/r/demo`, { waitUntil: 'networkidle2' });
  await sleep(1500);
  const probe = await page.evaluate(() => ({
    url: location.pathname + location.search,
    banner: getComputedStyle(document.getElementById('demoBanner')).display !== 'none',
    letterBtn: getComputedStyle(document.getElementById('letterBtn')).display !== 'none',
    joinIntact: ['username', 'joinBtn', 'priceAmount'].every((id) => !!document.getElementById(id)),
  }));
  ok('browser lands on the demo join page via /r/demo', /room=/.test(probe.url), probe.url);
  ok('demo banner visible', probe.banner);
  ok('letter button live in demo room', probe.letterBtn);
  ok('join controls intact', probe.joinIntact);
  await browser.close();
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
