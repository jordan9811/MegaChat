/**
 * GATE — the board's hierarchy, measured in a real browser at the owner's
 * screen sizes.
 *
 * The owner, 2026-09-25: "the recently aired is on the bottom, you must scroll
 * to see it and it doesn't even have a thumbnail … it also shouldn't be so
 * big" — and then, once the tiles were small: "thumbnails are too small now …
 * they should be a bit bigger now since page isn't populated, then can be this
 * small when more usage … there should be one featured or 2 featured, like if
 * a big streamer uses it that has the old very big size".
 *
 * At 1920x927 and 1440x900, and 17px narrower for a Windows scrollbar:
 *   F1  nothing live → Recently aired sits directly under the featured card,
 *       ABOVE the rooms
 *   F2  its cards are ONE row, entirely above the fold
 *   F3  they are real pictures that loaded, not letters
 *   F4  the first ROOM (not the Open-a-room tile) is above the fold too
 *   F5  TILE SIZE FOLLOWS HOW FULL THE BOARD IS: a quiet board (≤ 4 tiles)
 *       shares one row with big tiles (≥ 300px, ≤ 520px); a busy one drops
 *       to small tiles (≤ 320px)
 *   F7  no sideways scroll
 * And:
 *   F6  Recently aired is in the first HTML (no pop-in)
 *   F9  a phone (390x844) stacks, and shows at most one recent card per row
 *   F8  something live → the live room is featured, and Recently aired is
 *       still there, after the rooms
 *   B1  a BIG stream (≥ the server's BOARD_BIG_VIEWERS) gets the big card:
 *       the stage takes most of the row
 *   B2  two big streams → two big cards side by side
 *
 * Local run (default): two boards — a quiet one (one finished broadcast, like
 * production today) and a busy one (six) — plus a fake Twitch that puts rooms
 * live with chosen viewer counts. `--base https://megachat.fun` measures a
 * deployed board instead (F1–F7, F9) in whatever state it is in.
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

// ── what the page shows ────────────────────────────────────────────────────
const measure = (page) => page.evaluate(() => {
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y + scrollY, w: b.width, h: b.height, bottom: b.bottom + scrollY }; };
  const visibleEl = (c) => getComputedStyle(c).display !== 'none';
  const feats = [...document.querySelectorAll('.mcr-feat')];
  const rail = document.querySelector('.mcr-recent-rail');
  const rooms = document.querySelector('.mcr-rooms');
  const all = [...document.querySelectorAll('.mcr-recent')];
  const shown = all.filter(visibleEl);
  const recent = shown.map(box);
  const firstRoom = rooms?.querySelector('.mcr-card');
  const firstTileOf = (sec) => sec?.querySelector('.mcr-card, .mcr-open, .mcr-recent');
  const tiles = [...document.querySelectorAll('.mcr-card, .mcr-recent, .mcr-open')].filter(visibleEl).map((c) => c.getBoundingClientRect().width);
  const col = document.querySelector('.mcr-cols > div');
  const stage = feats[0]?.querySelector('.mcr-stage');
  const strip = document.querySelector('.mcr-strip');
  return {
    fold: innerHeight,
    colW: col ? col.getBoundingClientRect().width : 0,
    feats: feats.map((f) => ({ ...box(f), name: f.querySelector('h2')?.textContent || '', big: f.classList.contains('is-big'), half: f.classList.contains('is-half'), live: f.classList.contains('is-live'),
      stageW: f.querySelector('.mcr-stage')?.getBoundingClientRect().width || 0 })),
    stageW: stage ? stage.getBoundingClientRect().width : 0,
    // The strip is in the page AND laid out as one row (it steps back to the
    // busy layout where the column cannot give each tile 300px).
    strip: !!strip && getComputedStyle(strip).display === 'grid',
    tileTops: [firstTileOf(rail), firstTileOf(rooms)].map((t) => (t ? Math.round(t.getBoundingClientRect().top) : null)),
    rail: box(rail),
    recent,
    recentAvailable: all.length,
    recentRows: new Set(recent.map((b) => Math.round(b.y))).size,
    recentLowest: Math.max(0, ...recent.map((b) => b.bottom)),
    rooms: box(rooms),
    firstRoom: box(firstRoom),
    railBeforeRooms: !!(rail && rooms && (rail.compareDocumentPosition(rooms) & Node.DOCUMENT_POSITION_FOLLOWING)),
    imgs: shown.map((c) => { const i = c.querySelector('img'); return !!i && i.complete && i.naturalWidth > 0; }),
    tileCount: tiles.length,
    narrowest: tiles.length ? Math.min(...tiles) : 0,
    widest: tiles.length ? Math.max(...tiles) : 0,
    overflow: document.documentElement.scrollWidth > innerWidth,
  };
});

let browser = null;
const open = async (APP, w, h) => {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  await page.goto(`${APP}/app`, { waitUntil: 'networkidle2', timeout: 60000 });
  await until(async () => { const m = await measure(page); return !m.imgs.length || m.imgs.every(Boolean); }, 8000);
  return page;
};

/** F1–F7 at the four desktop sizes, F6 and F9, on whatever board APP serves. */
async function quietBoard(APP, label) {
  const html = await (await fetch(`${APP}/app`)).text();
  ok(`F6 [${label}] Recently aired is in the first HTML (no pop-in)`, /mcr-recent-rail/.test(html) && /Recently aired/.test(html), `${html.length} bytes`);
  // The owner's two screens (and 17px narrower for a Windows scrollbar) are
  // held to the fold; the laptop widths only to the tile-size rule.
  for (const [w, h, fold] of [[1920, 927, true], [1903, 927, true], [1440, 900, true], [1423, 900, true], [1280, 800, false], [1101, 800, false]]) {
    const page = await open(APP, w, h);
    const m = await measure(page);
    const tag = `[${label}] ${w}x${h}`;
    const f = m.feats[0];
    if (!fold) {
      // The busy layout is auto-fill 236px tracks: a tile is 236px or more and
      // under 484px (else another column would fit). The one row is only used
      // where it gives every tile 300px or more.
      ok(`F5 ${tag} tiles are ${m.strip ? 'big (300–520px) in one row' : 'the busy layout (236–483px auto-fill)'} — the one row never makes them smaller`,
        m.strip ? m.narrowest >= 300 && m.widest <= 521 : m.narrowest >= 235 && m.widest < 484,
        `${m.tileCount} tiles, ${Math.round(m.narrowest)}–${Math.round(m.widest)}px`);
      ok(`F7 ${tag} no sideways scroll`, !m.overflow);
      await page.close();
      continue;
    }
    ok(`F1 ${tag} nothing live → Recently aired directly under the featured card, above the rooms`,
      !!m.rail && !!f && m.railBeforeRooms && m.rail.y >= f.bottom && m.rail.y - f.bottom < 40,
      m.rail ? `feat ends ${Math.round(f?.bottom)}, rail starts ${Math.round(m.rail.y)}` : 'no rail');
    ok(`F2 ${tag} one row of recent cards, all above the fold`,
      m.recent.length >= 1 && m.recentRows === 1 && m.recentLowest <= m.fold,
      `${m.recent.length} shown of ${m.recentAvailable}, ${m.recentRows} row(s), lowest ${Math.round(m.recentLowest)} / fold ${m.fold}`);
    ok(`F3 ${tag} every recent card is a real picture that loaded`, m.imgs.length > 0 && m.imgs.every(Boolean), JSON.stringify(m.imgs));
    ok(`F4 ${tag} the first room is above the fold`, !!m.firstRoom && m.firstRoom.bottom <= m.fold,
      m.firstRoom ? `ends ${Math.round(m.firstRoom.bottom)} / fold ${m.fold}` : 'no room card');
    if (m.strip) {
      ok(`F5 ${tag} a quiet board (${m.tileCount} tiles) shares one row with BIG tiles (300–520px)`,
        m.narrowest >= 300 && m.widest <= 521, `${Math.round(m.narrowest)}–${Math.round(m.widest)}px`);
      ok(`F10 ${tag} in that row, Recently aired and Rooms start level`,
        m.tileTops[0] != null && m.tileTops[0] === m.tileTops[1], JSON.stringify(m.tileTops));
    } else if (m.tileCount <= 4) {
      ok(`F5 ${tag} a quiet board (${m.tileCount} tiles) too wide for one row of 300px tiles uses the busy layout (≤ 320px)`,
        m.widest <= 320 && m.colW < m.tileCount * 300 + (m.tileCount - 1) * 12, `column ${Math.round(m.colW)}px, widest ${Math.round(m.widest)}px`);
    } else {
      ok(`F5 ${tag} a busy board (${m.tileCount} tiles) drops to small tiles (≤ 320px), rail capped to what fits`,
        !m.strip && m.widest <= 320 && m.recentRows === 1, `widest ${Math.round(m.widest)}px, ${m.recent.length} of ${m.recentAvailable} recent shown`);
    }
    ok(`F7 ${tag} no sideways scroll`, !m.overflow);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `board-${label}-${w}x${h}.png`) });
    await page.close();
  }
  const page = await open(APP, 390, 844);
  const m = await measure(page);
  ok(`F9 [${label}] a phone shows ONE recent card, not a stack, and no sideways scroll`,
    m.recent.length === 1 && !m.overflow && m.widest <= 390, `${m.recent.length} of ${m.recentAvailable} recent shown, widest ${Math.round(m.widest)}px`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `board-${label}-390x844.png`), fullPage: true });
  await page.close();
}

console.log(`\n── the board's hierarchy (${REMOTE || 'local'}) ──`);
browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--hide-scrollbars'] });
let twitch = null;
let srv = null;
try {
  if (REMOTE) {
    await quietBoard(REMOTE, 'remote');
  } else {
    const fresh = assertFreshBuild();
    ok('G0. the build under test is newer than the source it renders', fresh.ok, fresh.detail);
    if (!fresh.ok) throw new Error('stale build');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-board-fold-'));
    const frame = (i) => {
      const f = path.join(tmp, `f${i}.jpg`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=1,trim=start=${i * 2}`, '-frames:v', '1', '-q:v', '3', f]);
      return fs.readFileSync(f);
    };
    const LIVE = frame(9);
    // Channels the fake Twitch reports live, and with how many viewers.
    const liveViewers = new Map();
    twitch = http.createServer((req, res) => {
      const url = new URL(req.url, FAKE);
      const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (url.pathname === '/oauth2/token') return json({ access_token: 'fake', expires_in: 3600 });
      if (url.pathname === '/helix/streams') {
        return json({ data: url.searchParams.getAll('user_login').filter((l) => liveViewers.has(l)).map((l) => ({ user_login: l, viewer_count: liveViewers.get(l) })) });
      }
      if (url.pathname === '/helix/users' || url.pathname === '/helix/videos') return json({ data: [] });
      const pm = /^\/previews-ttv\/live_user_([^-]+)-/.exec(url.pathname);
      if (pm && liveViewers.has(pm[1])) { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(LIVE); }
      if (pm) { res.writeHead(302, { Location: `${FAKE}/ttv-static/404_preview-640x360.jpg` }); return res.end(); }
      res.writeHead(404).end('{}');
    });
    await new Promise((r) => twitch.listen(TWITCH_PORT, r));

    // A board with `n` finished broadcasts of the default room, each with a guest and a picture.
    const boot = async (n, label) => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gate-'));
      const now = Date.now();
      const airings = [];
      fs.mkdirSync(path.join(dataDir, 'airing-posters'), { recursive: true });
      for (let i = 0; i < n; i++) {
        const id = randomUUID();
        const start = now - (i + 2) * 60 * M;
        airings.push({ id, roomId: 'default', platform: 'twitch', channel: 'seeded', startedAt: start, endedAt: start + 50 * M, vodId: null, vodUrl: null, captureRef: null,
          moments: [{ at: start + 10 * M, kind: 'seat', label: `guest${i}`, offsetMs: 10 * M }] });
        fs.writeFileSync(path.join(dataDir, 'airing-posters', `${id}.jpg`), frame(i));
        fs.writeFileSync(path.join(dataDir, 'airing-posters', `${id}.json`), JSON.stringify({ kind: 'frame', source: 'twitch-preview', at: now }));
      }
      fs.writeFileSync(path.join(dataDir, 'airings.json'), JSON.stringify({ airings }, null, 2));
      const s = await startGateServer({
        port: PORT, label: `board-fold:${label}`, dataDir,
        // Signed-in streamers whose linked Twitch login IS their channel — the
        // only rooms allowed the big card (server.js ownerProvesChannel).
        bountyAuth: { handles: ['smallchan', 'bigchan', 'bigchan2'] },
        env: {
          TWITCH_CLIENT_ID: 'gate-client', TWITCH_CLIENT_SECRET: 'gate-secret',
          TWITCH_ID_BASE: FAKE, TWITCH_API_BASE: FAKE, TWITCH_PREVIEW_BASE: FAKE,
          FOLLOW_POLL_MS: '500', FOLLOW_OFF_CONFIRM_MS: '2000', KEEP_ORPHAN_ROOMS: 'true',
          BOARD_BIG_VIEWERS: '100',
        },
      });
      const seen = (await (await fetch(`http://localhost:${PORT}/api/rooms/recent`)).json()).airings || [];
      ok(`S0 [${label}] ${n} finished broadcast(s) with pictures on offer`, seen.filter((a) => a.poster?.kind === 'frame').length === n, `${seen.length}`);
      return s;
    };
    const APP = `http://localhost:${PORT}`;

    // ── a busy board: six finished broadcasts ─────────────────────────────
    srv = await boot(6, 'busy');
    await quietBoard(APP, 'busy');
    srv.kill();
    await sleep(1500);

    // ── a quiet board with four tiles: two finished broadcasts ────────────
    srv = await boot(2, 'quiet4');
    await quietBoard(APP, 'quiet4');
    srv.kill();
    await sleep(1500);

    // ── a quiet board, like production today: one ─────────────────────────
    srv = await boot(1, 'quiet');
    await quietBoard(APP, 'quiet');

    // ── the featured tier ─────────────────────────────────────────────────
    const follow = async (name, channel, owner) => {
      const r = await fetch(`${APP}/api/dashboard/create`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(owner ? srv.headers(owner) : {}) },
        body: JSON.stringify({ name, password: 'gate-pass-1234', config: { twitchChannel: channel, twitchAuto: true, unlisted: false } }),
      });
      const j = await r.json();
      if (!(j.roomId || j.room?.id)) throw new Error(`room create failed (${r.status})`);
    };
    await follow('Small Streamer', 'smallchan', 'smallchan');
    await follow('Big Streamer', 'bigchan', 'bigchan');
    await follow('Other Big Streamer', 'bigchan2', 'bigchan2');
    const liveBoard = async (want, tag) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 927 });
      await page.goto(`${APP}/app`, { waitUntil: 'networkidle2', timeout: 60000 });
      const m = await until(async () => { const x = await measure(page); return want(x) ? x : null; }, 30000, 1000);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `board-live-${tag}-1920x927.png`) });
      await page.close();
      return m || await (async () => { const p2 = await browser.newPage(); await p2.setViewport({ width: 1920, height: 927 }); await p2.goto(`${APP}/app`, { waitUntil: 'networkidle2' }); const x = await measure(p2); await p2.close(); return x; })();
    };

    liveViewers.set('smallchan', 20);
    // Settled: rooms created a moment ago stay listed until the follow loop has
    // looked at them once (nothing is hidden on a guess), then leave.
    let m = await liveBoard((x) => x.feats[0]?.live && x.strip, 'small');
    ok('F8 a small live stream is featured at the NORMAL size, and Recently aired follows the rooms',
      m.feats.length === 1 && m.feats[0].live && !m.feats[0].big && !!m.rail && !m.railBeforeRooms,
      JSON.stringify({ feats: m.feats.map((f) => ({ big: f.big, half: f.half, live: f.live })), railBeforeRooms: m.railBeforeRooms }));

    ok('F10 live: in the one row, Rooms and Recently aired start level', m.strip && m.tileTops[0] != null && m.tileTops[0] === m.tileTops[1], JSON.stringify({ strip: m.strip, tops: m.tileTops }));

    // An impostor room naming a famous channel, live with 90,000 viewers.
    // Anyone can TYPE a famous channel into a password-only room.
    await follow('Totally Famous Streamer', 'famouschan', null);
    liveViewers.set('famouschan', 90000);
    await sleep(3000);
    const pub = (await (await fetch(`${APP}/api/rooms/public`)).json()).rooms || [];
    const impostor = pub.find((r) => r.twitchChannel === 'famouschan');
    ok('B0 a room that merely NAMES a famous channel gets no viewer count and no big card',
      !!impostor && impostor.viewers == null && impostor.bigStream === false, JSON.stringify(impostor && { viewers: impostor.viewers, bigStream: impostor.bigStream }));

    liveViewers.set('bigchan', 5000);
    m = await liveBoard((x) => x.feats[0]?.big, 'big');
    ok('B1 a big stream gets the BIG card — the stage takes most of the row',
      m.feats.length === 1 && m.feats[0].big && m.stageW >= 0.55 * m.colW,
      `stage ${Math.round(m.stageW)}px of a ${Math.round(m.colW)}px column`);
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1101, height: 800 });
      await page.goto(`${APP}/app`, { waitUntil: 'networkidle2', timeout: 60000 });
      const x = await until(async () => { const y = await measure(page); return y.feats[0]?.big ? y : null; }, 15000, 1000) || await measure(page);
      ok('B1 ...and on a narrow laptop its picture is never smaller than the normal card (448px)', x.feats[0]?.big && x.stageW >= 447, `stage ${Math.round(x.stageW)}px at 1101`);
      await page.close();
    }

    liveViewers.set('bigchan2', 3000);
    m = await liveBoard((x) => x.feats.length === 2, 'pair');
    ok('B2 two big streams → two big cards side by side, sharing the row',
      m.feats.length === 2 && m.feats.every((f) => f.half) && Math.abs(m.feats[0].y - m.feats[1].y) < 2
        && m.feats.every((f) => f.w > 0.45 * m.colW),
      JSON.stringify(m.feats.map((f) => ({ half: f.half, y: Math.round(f.y), w: Math.round(f.w) }))));
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(`${APP}/app`, { waitUntil: 'networkidle2', timeout: 60000 });
      const x = await until(async () => { const y = await measure(page); return y.feats.length === 2 ? y : null; }, 15000, 1000) || await measure(page);
      ok('B2 ...and where two would each be under 448px, they stack instead of shrinking',
        x.feats.length === 2 && x.feats.every((f) => f.stageW >= 447) && x.feats[1].y > x.feats[0].y,
        JSON.stringify(x.feats.map((f) => ({ y: Math.round(f.y), stage: Math.round(f.stageW) }))));
      await page.close();
    }
    ok('B0 ...and the impostor, with 90,000 "viewers", is featured nowhere', m.feats.length > 0 && !m.feats.some((f) => /Totally Famous/.test(f.name || '')),
      JSON.stringify(m.feats.map((f) => f.name)));
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
