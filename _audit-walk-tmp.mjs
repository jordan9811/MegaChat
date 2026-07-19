/**
 * STAGE 1 WALKER — no assertions, just structured observation.
 * For each screen: screenshot + button inventory (classified filled/ghost by
 * computed background) + text stats + duplicate-line scan. Also walks the
 * FREE room to live and back, logging the control states at every step.
 */
import { createServer } from 'http';
import { spawn } from 'child_process';
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import os from 'os';

try { process.loadEnvFile(); } catch { /* env external */ }
const OUT = process.argv[2] || 'audit-out';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const notes = [];
const note = (s) => { notes.push(s); console.log(s); };

// mock IdP for a signed-in identity
const RAND = Math.random().toString(36).slice(2, 7);
const USER = { id: 'aud_' + RAND, login: 'auditor_' + RAND, display_name: 'aud' };
const idp = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/oauth2/authorize') {
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', 'c'); back.searchParams.set('state', url.searchParams.get('state'));
    res.writeHead(302, { Location: back.toString() }); return res.end();
  }
  if (url.pathname === '/oauth2/token') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"access_token":"t","token_type":"bearer"}'); }
  if (url.pathname === '/helix/users') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [USER] })); }
  res.writeHead(404); res.end();
});
await new Promise((r) => idp.listen(3991, r));

const VOL = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-aud-'));
const PORT = 3251;
const APP = `http://localhost:${PORT}`;
const srv = spawn(process.execPath, ['server.js', '--prod'], {
  env: {
    ...process.env, PORT: String(PORT), DATA_DIR: VOL,
    TWITCH_CLIENT_ID: 'm', TWITCH_CLIENT_SECRET: 'm',
    TWITCH_AUTH_BASE: 'http://localhost:3991/oauth2', TWITCH_API_BASE: 'http://localhost:3991/helix',
  },
  stdio: 'ignore', cwd: process.cwd(),
});
for (let i = 0; i < 80; i++) { try { const r = await fetch(`${APP}/api/config`); if (r.ok) break; } catch { } await sleep(500); }

// rooms: one free, one paid
const mk = async (name, config, handle) => (await (await fetch(`${APP}/api/dashboard/create`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name, config, password: 'audit1234', handle }),
})).json()).room;
const freeRoom = await mk('Audit Free', { passkeyTickPrice: '0', letters: { enabled: true, maxSeconds: 5 } }, 'audit_free');
const paidRoom = await mk('Audit Paid', { passkeyTickPrice: '0.001' }, 'audit_paid');

// identity cookie
const loc = (r) => r.headers.get('location') || '';
const cks = (r) => (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]);
let jar; {
  const s = await fetch(`${APP}/auth/twitch?returnTo=%2F`, { redirect: 'manual' });
  jar = cks(s).join('; ');
  const cb = await fetch(loc(await fetch(loc(s), { redirect: 'manual' })), { redirect: 'manual', headers: { cookie: jar } });
  jar = [jar, ...cks(cb)].join('; ');
}
const identityCookie = (jar.match(/mc_identity=[^;]+/) || [])[0];

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

const INVENTORY = (label) => `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'; };
  const btns = [...document.querySelectorAll('button, a[class*="rounded"], a[class*="bg-"]')].filter(vis).map((b) => {
    const cs = getComputedStyle(b);
    const bg = cs.backgroundColor;
    const filled = bg && bg !== 'rgba(0, 0, 0, 0)' && !/0\\.0?[0-3]\\)$/.test(bg);
    const r = b.getBoundingClientRect();
    return { t: (b.innerText || b.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 46), filled, big: r.height >= 44, w: Math.round(r.width) };
  }).filter((b) => b.t);
  const lines = document.body.innerText.split('\\n').map((l) => l.trim()).filter((l) => l.length > 24);
  const dupes = Object.entries(lines.reduce((m, l) => (m[l] = (m[l] || 0) + 1, m), {})).filter(([, n]) => n > 1).map(([l, n]) => n + 'x ' + l.slice(0, 66));
  return JSON.stringify({
    label: ${JSON.stringify('X')}.replace('X', '${label}'),
    textLen: document.body.innerText.length,
    primaries: btns.filter((b) => b.filled && b.big),
    filled: btns.filter((b) => b.filled && !b.big),
    ghost: btns.filter((b) => !b.filled).slice(0, 18),
    dupes,
  }, null, 1);
})()`;

async function shoot(page, name, label) {
  await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
  const inv = await page.evaluate(INVENTORY(label));
  fs.writeFileSync(path.join(OUT, name + '.json'), inv);
  note(`--- ${label} → ${name}.png ---`);
}

async function open(p, { cookie, w = 1280, h = 950, pre } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  if (cookie) { const [n, v] = cookie.split('='); await browser.setCookie({ name: n, value: v, domain: 'localhost', path: '/' }); }
  if (pre) await page.evaluateOnNewDocument(pre);
  await page.goto(`${APP}${p}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(2500);
  return page;
}

// 1-3: landing, docs, roadmap (signed out)
{ const p = await open('/'); await shoot(p, '01-landing', 'landing signed-out dark adv'); await p.close(); }
{ const p = await open('/how-it-works'); await shoot(p, '02-hiw', 'how-it-works'); await p.close(); }
{ const p = await open('/roadmap'); await shoot(p, '03-roadmap', 'roadmap'); await p.close(); }

// 4-6: join paid — adv dark / simple / light
{ const p = await open(`/audit_paid`); await shoot(p, '04-join-paid-adv-dark', 'join paid adv dark signed-out'); await p.close(); }
{ const p = await open(`/audit_paid`, { pre: `localStorage.setItem('mc-ui-mode','simple')` }); await shoot(p, '05-join-paid-simple', 'join paid SIMPLE mode'); await p.close(); }
{ const p = await open(`/audit_paid`, { pre: `localStorage.setItem('theme','light')` }); await shoot(p, '06-join-paid-light', 'join paid LIGHT theme'); await p.close(); }

// 7: FREE room — the full live walk with click counting
{
  const p = await open(`/audit_free`);
  let clicks = 0;
  const state = () => p.evaluate(`(() => ({
    join: { t: document.getElementById('joinBtn')?.textContent.trim(), disabled: document.getElementById('joinBtn')?.disabled, visible: getComputedStyle(document.getElementById('joinBtn')).display !== 'none' },
    leave: { t: document.getElementById('leaveBtn')?.textContent.trim(), visible: document.getElementById('leaveBtn') ? getComputedStyle(document.getElementById('leaveBtn')).display !== 'none' : false },
    mc: document.getElementById('letterBtn') ? getComputedStyle(document.getElementById('letterBtn')).display !== 'none' : false,
    msg: (document.getElementById('message')?.innerText || '').slice(0, 70),
  }))()`);
  note('FREE WALK step0 (arrive): ' + JSON.stringify(await state()));
  await shoot(p, '07a-join-free-idle', 'join free idle');
  await p.evaluate(`document.getElementById('username').value = 'auditor'`);
  await p.evaluate(`document.getElementById('joinBtn').click()`); clicks++;
  await sleep(3500);
  note('FREE WALK step1 (after Join click): ' + JSON.stringify(await state()));
  await shoot(p, '07b-join-free-seated', 'join free seated/awaiting-camera');
  // camera fake stream: wait for go-live state
  for (let i = 0; i < 10; i++) { const s = await state(); if (/Go Live/i.test(s.join.t || '')) break; await sleep(1000); }
  const s2 = await state();
  note('FREE WALK step2 (camera ready): ' + JSON.stringify(s2));
  if (/Go Live/i.test(s2.join.t || '')) {
    await p.evaluate(`document.getElementById('joinBtn').click()`); clicks++;
    await sleep(3000);
    note('FREE WALK step3 (LIVE): ' + JSON.stringify(await state()));
    await shoot(p, '07c-join-free-live', 'join free LIVE — note the join+leave pair');
    await p.evaluate(`document.getElementById('leaveBtn').click()`); clicks++;
    await sleep(2500);
    note('FREE WALK step4 (after Leave): ' + JSON.stringify(await state()));
    await shoot(p, '07d-join-free-left', 'join free after leaving');
  }
  note(`FREE WALK on-page clicks (join→live→leave): ${clicks} (+1 typing name)`);
  await p.close();
}

// 8: dashboard — signed out, then signed in, then managing
{ const p = await open('/dashboard'); await shoot(p, '08a-dash-signedout', 'dashboard signed-out create'); await p.close(); }
{
  const p = await open('/dashboard', { cookie: identityCookie });
  await shoot(p, '08b-dash-signedin', 'dashboard signed-in create + your rooms');
  // open advanced for the tier inventory
  await p.evaluate(`document.querySelector('details')?.setAttribute('open','')`);
  await sleep(400);
  await shoot(p, '08c-dash-advanced-open', 'dashboard advanced expanded');
  await p.close();
}
{
  // managing: create an OWNED room via UI-less API w/ cookie then open it
  const r = await fetch(`${APP}/api/dashboard/create`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: identityCookie },
    body: JSON.stringify({ name: 'Auditor Own', config: {} }),
  });
  const own = (await r.json()).room;
  const p = await open('/dashboard', { cookie: identityCookie });
  await p.evaluate(`(async () => {
    const btn = [...document.querySelectorAll('button')].find((b) => /manage →/i.test(b.innerText));
    btn?.click();
  })()`);
  await sleep(3000);
  await shoot(p, '08d-dash-managing', 'dashboard MANAGING an owned room');
  await p.close();
}

// 9: overlay + 10: demo
{ const p = await open(`/overlay?room=${freeRoom.id}`, { w: 700, h: 900 }); await shoot(p, '09-overlay', 'overlay'); await p.close(); }
{ const p = await open('/demo'); await shoot(p, '10-demo', 'demo room join page'); await p.close(); }

await browser.close();
srv.kill(); idp.close();
fs.writeFileSync(path.join(OUT, 'NOTES.txt'), notes.join('\n'));
fs.rmSync(VOL, { recursive: true, force: true });
console.log('\nDONE →', OUT);
