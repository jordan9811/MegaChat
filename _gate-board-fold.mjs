/**
 * GATE — the board's hierarchy, measured in a real browser at the owner's
 * screen sizes.
 *
 * The owner, 2026-09-25: "the recently aired is on the bottom, you must scroll
 * to see it and it doesn't even have a thumbnail … with no other options this
 * should def be on the main page not scrolling … and it also shouldn't be so
 * big". On megachat.fun/app that night the rail started at y=947 on a 927px
 * screen, an idle room was a 732x480 tile, and the card was a letter on grey.
 *
 * At 1920x927 and 1440x900, and 17px narrower for a Windows scrollbar:
 *   F1  nothing live → Recently aired sits directly under the featured card,
 *       ABOVE the rooms
 *   F2  its cards are ONE row, entirely above the fold, as many as fit
 *   F3  they are real pictures that loaded, not letters
 *   F4  the first ROOM (not the Open-a-room tile) is above the fold too
 *   F5  no tile is half the screen: every card ≤ 320px wide
 *   F7  no sideways scroll
 * And:
 *   F6  Recently aired is in the first HTML (no pop-in)
 *   F9  a phone (390x844) shows one recent card, not a 1,600px stack
 *   F8  something live → the live room is featured, and Recently aired is
 *       still there, after the rooms
 *
 * Local run (default): six finished broadcasts are seeded with pictures (the
 * pipeline that makes them is _gate-airing-poster.mjs), and a fake Twitch puts
 * a room live for F8. `--base https://megachat.fun` measures a deployed board
 * instead (F1–F7): the build before this change fails F1, F2, F3, F5 and F6
 * there — recorded in OPEN-ISSUES "Recently aired: real pictures".
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { assertFreshBuild, startGateServer } from './_gate-helpers.mjs';

const bi = process.argv.indexOf('--base');
const REMOTE = bi > 0 ? process.argv[bi + 1].replace(/\/$/, '') : null;
const PORT = 3293;
const TWITCH_PORT = 3294;
const FAKE = `http://localhost:${TWITCH_PORT}`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOTS = process.env.BOARD_SHOTS || null; // a directory to save screenshots in
const M = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  (${detail})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
};
const until = async (fn, ms = 20000, step = 300) => {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); }
  return v;
};

console.log(`\n── the board's hierarchy (${REMOTE || 'local'}) ──`);

let APP = REMOTE;
let srv = null;
let twitch = null;
let live = false;
if (!REMOTE) {
  const fresh = assertFreshBuild();
  ok('G0. the build under test is newer than the source it renders', fresh.ok, fresh.detail);
  if (!fresh.ok) { console.log(`\nRESULT: ${pass} pass, ${fail} fail`); process.exit(1); }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-board-fold-'));
  const frame = (i) => {
    const f = path.join(tmp, `f${i}.jpg`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=1,trim=start=${i * 2}`, '-frames:v', '1', '-q:v', '3', f]);
    return fs.readFileSync(f);
  };
  // Six finished broadcasts of the default room, each with a guest and a picture.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gate-'));
  const now = Date.now();
  const airings = [];
  fs.mkdirSync(path.join(dataDir, 'airing-posters'), { recursive: true });
  for (let i = 0; i < 6; i++) {
    const id = randomUUID();
    const start = now - (i + 2) * 60 * M;
    airings.push({ id, roomId: 'default', platform: 'twitch', channel: 'seeded', startedAt: start, endedAt: start + 50 * M, vodId: null, vodUrl: null, captureRef: null,
      moments: [{ at: start + 10 * M, kind: 'seat', label: `guest${i}`, offsetMs: 10 * M }] });
    fs.writeFileSync(path.join(dataDir, 'airing-posters', `${id}.jpg`), frame(i));
    fs.writeFileSync(path.join(dataDir, 'airing-posters', `${id}.json`), JSON.stringify({ kind: 'frame', source: 'twitch-preview', at: now }));
  }
  fs.writeFileSync(path.join(dataDir, 'airings.json'), JSON.stringify({ airings }, null, 2));
  const LIVE = frame(9);
  twitch = http.createServer((req, res) => {
    const url = new URL(req.url, FAKE);
    const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/oauth2/token') return json({ access_token: 'fake', expires_in: 3600 });
    if (url.pathname === '/helix/streams') return json({ data: live ? url.searchParams.getAll('user_login').filter((l) => l === 'foldgate').map((l) => ({ user_login: l })) : [] });
    if (url.pathname === '/helix/users' || url.pathname === '/helix/videos') return json({ data: [] });
    if (url.pathname.startsWith('/previews-ttv/live_user_foldgate') && live) { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(LIVE); }
    if (url.pathname.startsWith('/previews-ttv/')) { res.writeHead(302, { Location: `${FAKE}/ttv-static/404_preview-640x360.jpg` }); return res.end(); }
    res.writeHead(404).end('{}');
  });
  await new Promise((r) => twitch.listen(TWITCH_PORT, r));
  srv = await startGateServer({
    port: PORT, label: 'board-fold', dataDir,
    env: {
      TWITCH_CLIENT_ID: 'gate-client', TWITCH_CLIENT_SECRET: 'gate-secret',
      TWITCH_ID_BASE: FAKE, TWITCH_API_BASE: FAKE, TWITCH_PREVIEW_BASE: FAKE,
      FOLLOW_POLL_MS: '500', FOLLOW_OFF_CONFIRM_MS: '2000', KEEP_ORPHAN_ROOMS: 'true',
    },
  });
  APP = `http://localhost:${PORT}`;
  // A room that follows a channel, for F8.
  const r = await fetch(`${APP}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Fold Live Room', password: 'gate-pass-1234', config: { twitchChannel: 'foldgate', twitchAuto: true, unlisted: false } }),
  });
  const created = await r.json();
  if (!(created.roomId || created.room?.id)) throw new Error(`room create failed (${r.status})`);
  const seen = (await (await fetch(`${APP}/api/rooms/recent`)).json()).airings || [];
  ok('S0. six finished broadcasts with pictures are on offer', seen.filter((a) => a.poster?.kind === 'frame').length === 6, `${seen.length} airings`);
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--hide-scrollbars'] });
const measure = (page) => page.evaluate(() => {
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y + scrollY, w: b.width, h: b.height, bottom: b.bottom + scrollY }; };
  const feat = document.querySelector('.mcr-feat');
  const rail = document.querySelector('.mcr-recent-rail');
  const grid = document.querySelector('.mcr-grid');
  const shown = [...document.querySelectorAll('.mcr-recent')].filter((c) => getComputedStyle(c).display !== 'none');
  const recent = shown.map(box);
  const firstRoom = grid?.querySelector('.mcr-card');
  const cards = [...document.querySelectorAll('.mcr-card, .mcr-recent, .mcr-open')].filter((c) => getComputedStyle(c).display !== 'none').map((c) => c.getBoundingClientRect().width);
  const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0;
  return {
    fold: innerHeight,
    feat: box(feat),
    featLive: !!feat?.classList.contains('is-live'),
    rail: box(rail),
    recent,
    recentRows: new Set(recent.map((b) => Math.round(b.y))).size,
    recentLowest: Math.max(0, ...recent.map((b) => b.bottom)),
    grid: box(grid),
    cols,
    firstRoom: box(firstRoom),
    railBeforeGrid: !!(rail && grid && (rail.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING)),
    imgs: shown.map((c) => { const i = c.querySelector('img'); return !!i && i.complete && i.naturalWidth > 0; }),
    widest: Math.max(0, ...cards),
    overflow: document.documentElement.scrollWidth > innerWidth,
  };
});
const open = async (w, h) => {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  await page.goto(`${APP}/app`, { waitUntil: 'networkidle2', timeout: 60000 });
  await until(async () => { const m = await measure(page); return m.imgs.length && m.imgs.every(Boolean); }, 8000);
  return page;
};

try {
  const html = await (await fetch(`${APP}/app`)).text();
  ok('F6 Recently aired is in the first HTML (no pop-in)', /mcr-recent-rail/.test(html) && /Recently aired/.test(html), `${html.length} bytes`);

  for (const [w, h] of [[1920, 927], [1903, 927], [1440, 900], [1423, 900]]) {
    const page = await open(w, h);
    const m = await measure(page);
    const tag = `${w}x${h}`;
    ok(`F1 ${tag} nothing live → Recently aired directly under the featured card, above the rooms`,
      !!m.rail && !!m.feat && m.railBeforeGrid && m.rail.y >= m.feat.bottom && m.rail.y - m.feat.bottom < 40,
      m.rail ? `feat ends ${Math.round(m.feat?.bottom)}, rail starts ${Math.round(m.rail.y)}` : 'no rail');
    ok(`F2 ${tag} one row of recent cards, as many as fit, all above the fold`,
      m.recent.length === Math.min(6, m.cols) && m.recentRows === 1 && m.recentLowest <= m.fold,
      `${m.recent.length} shown for ${m.cols} columns, ${m.recentRows} row(s), lowest ${Math.round(m.recentLowest)} / fold ${m.fold}`);
    ok(`F3 ${tag} every recent card is a real picture that loaded`, m.imgs.length > 0 && m.imgs.every(Boolean), JSON.stringify(m.imgs));
    ok(`F4 ${tag} the first room is above the fold`, !!m.firstRoom && m.firstRoom.bottom <= m.fold,
      m.firstRoom ? `ends ${Math.round(m.firstRoom.bottom)} / fold ${m.fold}` : 'no room card in the grid');
    ok(`F5 ${tag} no tile is half the screen (every card ≤ 320px)`, m.widest > 0 && m.widest <= 320, `widest ${Math.round(m.widest)}px`);
    ok(`F7 ${tag} no sideways scroll`, !m.overflow);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `board-${REMOTE ? 'remote' : 'local'}-${tag}.png`) });
    await page.close();
  }

  {
    const page = await open(390, 844);
    const m = await measure(page);
    ok('F9 a phone shows ONE recent card, not a stack', m.recent.length === 1 && !m.overflow, `${m.recent.length} shown`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `board-${REMOTE ? 'remote' : 'local'}-390x844.png`), fullPage: true });
    await page.close();
  }

  if (!REMOTE) {
    live = true; // the followed channel goes live
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 927 });
    await page.goto(`${APP}/app`, { waitUntil: 'networkidle2', timeout: 60000 });
    const m = await until(async () => { const x = await measure(page); return x.featLive ? x : null; }, 30000, 1000);
    ok('F8 something live → the live room is featured, and Recently aired is still there, after the rooms',
      !!m && !!m.rail && !m.railBeforeGrid && m.rail.y > m.grid.y,
      m ? `rail ${Math.round(m.rail?.y ?? -1)} vs rooms ${Math.round(m.grid?.y ?? -1)}` : 'never went live on the board');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'board-local-live-1920x927.png') });
    await page.close();
  }
} catch (e) {
  fail++;
  console.log(`  FAIL  harness threw: ${e.message}`);
} finally {
  await browser.close().catch(() => {});
  if (srv) srv.kill();
  if (twitch) twitch.close();
  console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
