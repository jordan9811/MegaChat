/**
 * GATE — the site owner's hidden settings page (/dev), and the three settings
 * it moves, live.
 *
 * The owner, 2026-09-25: "can we make a hidden dev tab or something for me and
 * only me to set these settings whenever?" — the big-streamer threshold, how
 * long MegaChat clips are kept for replays, and whether broadcasts where
 * nothing happened appear in Recently aired.
 *
 *   A   only the owner reaches the page or the API — the first account with a
 *       Twitch login on SITE_ADMIN_TWITCH, then pinned by ACCOUNT, so a second
 *       account with the same Twitch name is refused; a stranger, a same-named
 *       Kick login and a signed-out visitor get exactly what a path that does
 *       not exist gets; a bad value changes nothing; only the owner's menu
 *       offers the page; no room can take the handle "dev"; resetting to a
 *       shorter keep asks before it deletes
 *   B   the big-streamer threshold features a live stream the moment it moves
 *   C   the replay days: what the send screen tells the fan, what is served,
 *       what is deleted — never longer than the fan was told, and a shorter
 *       setting or off applies to every kept clip at once; end to end, a real
 *       MegaChat is kept for the days its page showed
 *   D   quiet broadcasts: off by default; on, a finished broadcast of 5+
 *       minutes on a PROVEN channel, with its recording found, gets a card and
 *       a replay from its start; a 2-minute one, one on a channel nobody
 *       proved, and one with no recording never
 *   U   in process: a quiet broadcast's poster is taken from its middle
 *
 * Fake Twitch; needs ffmpeg locally for the test clip.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { assertFreshBuild, startGateServer, mintBountyAuth } from './_gate-helpers.mjs';

const PORT = 3306;
const TWITCH_PORT = 3309;
const APP = `http://localhost:${PORT}`;
const FAKE = `http://localhost:${TWITCH_PORT}`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const M = 60_000;
const DAY = 24 * 60 * M;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  (${detail})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
};
const until = async (fn, ms = 15000, step = 300) => {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); }
  return v;
};

console.log('\n── the owner\'s hidden settings page ──');
const fresh = assertFreshBuild();
ok('G0. the build under test is newer than the source it renders', fresh.ok, fresh.detail);
if (!fresh.ok) { console.log(`\nRESULT: ${pass} pass, ${fail} fail`); process.exit(1); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sitesettings-'));
const media = (name, args) => { const f = path.join(TMP, name); execFileSync('ffmpeg', ['-v', 'error', '-y', ...args, f]); return fs.readFileSync(f); };
const CLIP = media('clip.webm', ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-t', '2', '-c:v', 'libvpx', '-b:v', '300k']);
const POSTER = media('poster.jpg', ['-f', 'lavfi', '-i', 'mandelbrot=size=640x360', '-frames:v', '1', '-q:v', '3']);

// ── U: a quiet broadcast's poster, in process ─────────────────────────────
process.env.DATA_DIR = path.join(TMP, 'unit');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
const settings = await import('./site-settings.js');
const posters = await import('./airing-posters.js');
{
  const T0 = Date.now() - 300 * M;
  const quiet = { id: 'q', startedAt: T0, endedAt: T0 + 120 * M, moments: [] };
  const offTarget = posters.posterTarget(quiet);
  settings.updateSiteSettings({ recentShowsQuiet: true }, { by: 'unit' });
  const onTarget = posters.posterTarget(quiet);
  const cands = Array.from({ length: 30 }, (_, i) => ({ at: T0 + (i + 1) * 4 * M, file: 'x' }));
  const pick = posters.pickCandidate(cands, quiet);
  const short = { id: 's', startedAt: T0, endedAt: T0 + 2 * M, moments: [] };
  ok('U1 a quiet broadcast has no poster target while hidden, and its middle once shown',
    offTarget === null && onTarget?.at === T0 + 60 * M, `off ${offTarget}, on +${onTarget && (onTarget.at - T0) / M} min`);
  ok('U2 ...its preview is picked from the middle, and a 2-minute one is never shown',
    !!pick && Math.abs(pick.at - (T0 + 62.5 * M)) <= 4 * M && posters.isShowable(short) === false && posters.isShowable(quiet) === true,
    `picked +${pick && (pick.at - T0) / M} min`);
  settings.updateSiteSettings({ recentShowsQuiet: null }, { by: 'unit' });
}

// ── fixtures ─────────────────────────────────────────────────────────────
// Accounts minted here rather than by the harness: the quiet broadcasts below
// belong to a room its owner proved, so that room — and its owner's account
// id — must be on disk before the server boots.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gate-'));
const auth = mintBountyAuth({ handles: ['siteowner', 'intruder', 'kick:siteowner', 'bigchan', 'twitch:siteowner', 'quietchan'], dataDir });
const QROOM = 'a1b2c3d4';
fs.writeFileSync(path.join(dataDir, 'rooms.json'), JSON.stringify({ rooms: { [QROOM]: {
  id: QROOM, name: 'Quiet Room', active: true, createdAt: new Date().toISOString(), passwordHash: null,
  ownerKey: auth.accountIdFor('quietchan'),
  config: { twitchChannel: 'quietchan', twitchAuto: true, unlisted: false },
} } }, null, 2));
const now = Date.now();
const Q1 = randomUUID(); // quiet, 20 minutes, proven channel, its recording on Twitch
const Q2 = randomUUID(); // quiet, 2 minutes
const Q3 = randomUUID(); // quiet, 20 minutes, recording known — but a channel nobody proved
const Q4 = randomUUID(); // quiet, 20 minutes, proven, looked up and no recording exists
const C1 = randomUUID(); // a guest and four MegaChats
const [K1, K2, K3, K4] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const REC = [{ vodId: '9901', url: 'https://www.twitch.tv/videos/9901', startMs: now - 91 * M, durationS: 22 * 60 }];
const mom = (kind, label, at, start, ref) => ({ at, kind, label, offsetMs: at - start, ...(ref ? { ref } : {}) });
const c1Start = now - 12 * DAY;
const airings = [
  { id: C1, roomId: 'default', platform: 'twitch', channel: 'seedchan', startedAt: c1Start, endedAt: c1Start + 60 * M, captureRef: null,
    moments: [mom('seat', 'amy', c1Start + 5 * M, c1Start), mom('megachat', 'k1', c1Start + 10 * M, c1Start, K1),
      mom('megachat', 'k2', c1Start + 11 * M, c1Start, K2), mom('megachat', 'k3', c1Start + 12 * M, c1Start, K3),
      mom('megachat', 'k4', c1Start + 13 * M, c1Start, K4)] },
  { id: Q1, roomId: QROOM, platform: 'twitch', channel: 'quietchan', startedAt: now - 90 * M, endedAt: now - 70 * M, captureRef: null,
    recordings: REC, moments: [] },
  { id: Q2, roomId: QROOM, platform: 'twitch', channel: 'quietchan', startedAt: now - 60 * M, endedAt: now - 58 * M, captureRef: null,
    recordings: REC, moments: [] },
  { id: Q3, roomId: 'default', platform: 'twitch', channel: 'seedchan', startedAt: now - 89 * M, endedAt: now - 69 * M, captureRef: null,
    recordings: REC, moments: [] },
  // Days ago: no recording on the fake Twitch overlaps it, so it stays with none.
  { id: Q4, roomId: QROOM, platform: 'twitch', channel: 'quietchan', startedAt: now - 3 * DAY, endedAt: now - 3 * DAY + 20 * M, captureRef: null,
    recordings: [], moments: [] },
];

// ── fake Twitch ───────────────────────────────────────────────────────────
const viewersOf = new Map(); // login -> viewers, while live
const twitch = http.createServer((req, res) => {
  const url = new URL(req.url, FAKE);
  const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/oauth2/token') return json({ access_token: 'fake', expires_in: 3600 });
  if (url.pathname === '/helix/streams') {
    return json({ data: url.searchParams.getAll('user_login').filter((l) => viewersOf.has(l)).map((l) => ({ user_login: l, viewer_count: viewersOf.get(l) })) });
  }
  if (url.pathname === '/helix/users') return json({ data: [{ id: `u-${url.searchParams.get('login')}`, login: url.searchParams.get('login') }] });
  if (url.pathname === '/helix/videos') {
    const ids = url.searchParams.getAll('id');
    const row = { id: '9901', url: 'https://www.twitch.tv/videos/9901', created_at: new Date(now - 91 * M).toISOString(), duration: '0h22m0s', thumbnail_url: '' };
    if (ids.length) return ids.includes('9901') ? json({ data: [row] }) : json({ error: 'Not Found' }, 404);
    return json({ data: [row] });
  }
  if (url.pathname.startsWith('/previews-ttv/')) {
    const live = [...viewersOf.keys()].some((l) => url.pathname.includes(`live_user_${l}-`));
    if (live) { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(POSTER); }
    res.writeHead(302, { Location: `${FAKE}/ttv-static/404_preview-640x360.jpg` }); return res.end();
  }
  res.writeHead(404).end('{}');
});
await new Promise((r) => twitch.listen(TWITCH_PORT, r));

fs.writeFileSync(path.join(dataDir, 'airings.json'), JSON.stringify({ airings }, null, 2));
const clipDir = path.join(dataDir, 'aired-clips');
fs.mkdirSync(clipDir, { recursive: true });
const seedClip = (id, at, keepDays) => {
  fs.writeFileSync(path.join(clipDir, `${id}.clip`), CLIP);
  fs.writeFileSync(path.join(clipDir, `${id}.json`), JSON.stringify({ id, roomId: 'default', mime: 'video/webm', at, bytes: CLIP.length, ...(keepDays != null ? { keepDays } : {}) }));
};
seedClip(K1, now - 10 * DAY, 7); // sent when the page said 7 days: 10 days old
seedClip(K2, now - 10 * DAY, 30); // sent under 30 days: 10 days old
seedClip(K3, now - 1 * DAY, null); // kept before clips carried their days: said 30

const srv = await startGateServer({
  port: PORT, label: 'site-settings', dataDir,
  env: {
    ...auth.env,
    SITE_ADMIN_TWITCH: 'siteowner',
    TWITCH_CLIENT_ID: 'gate-client', TWITCH_CLIENT_SECRET: 'gate-secret',
    TWITCH_ID_BASE: FAKE, TWITCH_API_BASE: FAKE, TWITCH_PREVIEW_BASE: FAKE,
    FOLLOW_POLL_MS: '500', POSTER_SWEEP_MS: '1500', POSTER_VOD_WAIT_MS: '0', KEEP_ORPHAN_ROOMS: 'true',
  },
});
const as = (who) => (who ? { Cookie: auth.cookieFor(who) } : {});
const get = (p, who) => fetch(`${APP}${p}`, { headers: as(who), redirect: 'manual' });
const put = (body, who) => fetch(`${APP}/api/site-settings`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', ...as(who) }, body: JSON.stringify({ settings: body }),
});
const view = async () => (await get('/api/site-settings', 'siteowner')).json();
const shape = async (r) => ({ status: r.status, type: (r.headers.get('content-type') || '').split(';')[0], body: await r.text() });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const pageAs = async (who) => {
  const page = await browser.newPage();
  if (who) {
    const [name, ...v] = auth.cookieFor(who).split('=');
    await page.setCookie({ name, value: decodeURIComponent(v.join('=')), domain: 'localhost', path: '/' });
  }
  return page;
};

try {
  // ── A: who gets in ──────────────────────────────────────────────────────
  const nothing = await shape(await get('/api/no-such-route-here'));
  const anon = await shape(await get('/api/site-settings'));
  const intruder = await shape(await get('/api/site-settings', 'intruder'));
  const kick = await shape(await get('/api/site-settings', 'kick:siteowner'));
  const same = (x) => x.status === nothing.status && x.type === nothing.type && x.status === 404;
  ok('A1 signed out, /api/site-settings answers exactly as a path that does not exist', same(anon),
    `${anon.status} ${anon.type} vs ${nothing.status} ${nothing.type}`);
  ok('A2 a stranger, and a KICK login spelled like the owner\'s Twitch, get the same', same(intruder) && same(kick),
    `stranger ${intruder.status}, kick ${kick.status}`);
  const v0 = await view();
  const s0 = v0.settings || {};
  ok('A3 the owner gets the three settings, at their defaults',
    s0.bigStreamViewers?.value === 100 && s0.replayKeepDays?.value === 30 && s0.recentShowsQuiet?.value === false
      && ['bigStreamViewers', 'replayKeepDays', 'recentShowsQuiet'].every((k) => s0[k].source === 'default'),
    JSON.stringify(Object.fromEntries(Object.entries(s0).map(([k, v]) => [k, `${v.value}/${v.source}`]))));

  const sneak = await put({ bigStreamViewers: 1, recentShowsQuiet: true }, 'intruder');
  const sneakAnon = await put({ replayKeepDays: 0 });
  const after = (await view()).settings;
  ok('A4 a stranger\'s or a signed-out change is not taken, and nothing moves',
    sneak.status === 404 && sneakAnon.status === 404 && after.bigStreamViewers.value === 100 && after.replayKeepDays.value === 30
      && after.recentShowsQuiet.value === false
      && Object.keys(JSON.parse(fs.readFileSync(path.join(dataDir, 'site-settings.json'), 'utf8')).values || {}).length === 0,
    `${sneak.status}/${sneakAnon.status}`);

  const pinned = JSON.parse(fs.readFileSync(path.join(dataDir, 'site-settings.json'), 'utf8')).adminAccountIds;
  const impostor = await shape(await get('/api/site-settings', 'twitch:siteowner'));
  const impostorPut = await put({ bigStreamViewers: 2 }, 'twitch:siteowner');
  const impostorMe = await (await get('/api/auth/me', 'twitch:siteowner')).json();
  ok('A4b the owner\'s ACCOUNT is pinned; a second account with the same Twitch name gets the missing-page answer',
    JSON.stringify(pinned) === JSON.stringify([auth.accountIdFor('siteowner')]) && same(impostor) && impostorPut.status === 404
      && !('siteAdmin' in (impostorMe.identity || {})) && (await view()).settings.bigStreamViewers.value === 100,
    `pinned ${JSON.stringify(pinned)}; impostor ${impostor.status}/${impostorPut.status}`);

  const squat = await fetch(`${APP}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Squatter', password: 'squat-pass-1234', handle: 'dev', config: { unlisted: false } }),
  });
  const squatBody = await squat.json().catch(() => ({}));
  const devAnon = await get('/dev');
  const devOwner = await get('/dev', 'siteowner');
  ok('A4c no room can take the handle "dev": /dev stays the owner\'s page and a 404 for everyone else',
    (squatBody.room?.handle ?? squatBody.handle ?? null) !== 'dev' && devAnon.status === 404 && devOwner.status === 200,
    `create ${squat.status} handle=${squatBody.room?.handle ?? squatBody.handle ?? null}; /dev ${devAnon.status}/${devOwner.status}`);

  const bad = await put({ bigStreamViewers: 50, replayKeepDays: 500 }, 'siteowner');
  const bad2 = await put({ somethingElse: 1 }, 'siteowner');
  const afterBad = (await view()).settings;
  ok('A5 one bad value changes nothing at all', bad.status === 400 && bad2.status === 400 && afterBad.bigStreamViewers.value === 100,
    `${bad.status} ${(await bad.json().catch(() => ({}))).error || ''}`);

  const pageOwner = await get('/dev', 'siteowner');
  const ownerHtml = await pageOwner.text();
  const pageStranger = await get('/dev', 'intruder');
  const pageAnon = await get('/dev');
  const page404 = await get('/no-such-page-here');
  const strangerHtml = await pageStranger.text();
  const anonHtml = await pageAnon.text();
  ok('A6 /dev opens for the owner', pageOwner.status === 200 && /Site settings/.test(ownerHtml) && /id="replayKeepDays"/.test(ownerHtml), `${pageOwner.status}`);
  ok('A7 ...and is a plain 404 for a stranger and for a signed-out visitor, like any missing page',
    pageStranger.status === 404 && pageAnon.status === 404 && page404.status === 404
      && ![strangerHtml, anonHtml].some((h) => /Site settings|site-settings|mcd-/.test(h)),
    `${pageStranger.status}/${pageAnon.status} (missing page ${page404.status})`);

  const meOwner = await (await get('/api/auth/me', 'siteowner')).json();
  const meStranger = await (await get('/api/auth/me', 'intruder')).json();
  const meKick = await (await get('/api/auth/me', 'kick:siteowner')).json();
  ok('A8 only the owner\'s session says siteAdmin', meOwner.identity?.siteAdmin === true
    && !('siteAdmin' in (meStranger.identity || {})) && !('siteAdmin' in (meKick.identity || {})),
    JSON.stringify({ owner: meOwner.identity?.siteAdmin, stranger: meStranger.identity?.siteAdmin, kick: meKick.identity?.siteAdmin }));

  const menuItems = async (who) => {
    const p = await pageAs(who);
    await p.goto(`${APP}/account`, { waitUntil: 'networkidle2', timeout: 60000 });
    await until(() => p.$('button[aria-haspopup="menu"]'), 15000);
    await p.click('button[aria-haspopup="menu"]');
    await until(() => p.$('[role="menu"]'), 5000);
    const items = await p.$$eval('[role="menu"] [role="menuitem"]', (els) => els.map((e) => `${e.textContent.trim()}${e.getAttribute('href') ? ` ${e.getAttribute('href')}` : ''}`));
    await p.close();
    return items;
  };
  const ownerMenu = await menuItems('siteowner');
  const strangerMenu = await menuItems('intruder');
  ok('A9 the owner\'s account menu offers Site settings; a stranger\'s does not',
    ownerMenu.some((t) => t === 'Site settings /dev') && !strangerMenu.some((t) => /Site settings|\/dev/.test(t)),
    `owner [${ownerMenu.join(' | ')}] stranger [${strangerMenu.join(' | ')}]`);

  // ── B: the big-streamer threshold ───────────────────────────────────────
  viewersOf.set('bigchan', 60);
  const made = await fetch(`${APP}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth.headers('bigchan') },
    body: JSON.stringify({ name: 'Big Chan', password: 'big-pass-1234', config: { passkeyTickPrice: '0', twitchChannel: 'bigchan', twitchAuto: true, unlisted: false } }),
  }).then((r) => r.json());
  const bigRoom = made.roomId || made.room?.id;
  const card = async () => (await (await fetch(`${APP}/api/rooms/public`)).json()).rooms.find((r) => r.id === bigRoom);
  const c0 = await until(async () => { const c = await card(); return c?.viewers === 60 ? c : null; }, 15000, 500);
  ok('B1 a proven stream with 60 viewers is not big at the default 100', !!c0 && c0.bigStream === false, JSON.stringify(c0 && { viewers: c0.viewers, big: c0.bigStream }));
  const setBig = await put({ bigStreamViewers: 50 }, 'siteowner');
  const setBigBody = await setBig.json();
  const c1 = await card();
  ok('B2 the owner sets 50 — the same stream is big at once', setBig.status === 200 && c1?.bigStream === true && setBigBody.settings.bigStreamViewers.source === 'saved',
    JSON.stringify({ status: setBig.status, big: c1?.bigStream }));
  // The save applies it at once; the follow loop must then read the same
  // number on every poll (500 ms here), or the card would drop back.
  await sleep(2500);
  const c1b = await card();
  viewersOf.set('bigchan', 35);
  const c1c = await until(async () => { const c = await card(); return c?.viewers === 35 ? c : null; }, 5000, 300);
  viewersOf.set('bigchan', 60);
  ok('B2b ...and stays big through the next polls; under 80% of 50 it drops', c1b?.bigStream === true && c1c?.bigStream === false,
    JSON.stringify({ afterPolls: c1b?.bigStream, at35: c1c?.bigStream }));
  await until(async () => (await card())?.viewers === 60, 5000, 300);
  const liveRow = setBigBody.live?.find((r) => r.channel === 'bigchan');
  ok('B3 the page lists who is live, how many watch, and that the channel is proved', liveRow?.viewers === 60 && liveRow.proven === true && liveRow.big === true, JSON.stringify(liveRow));
  await put({ bigStreamViewers: null }, 'siteowner');
  const c2 = await card();
  ok('B4 reset to the default: back to a normal card', c2?.bigStream === false && (await view()).settings.bigStreamViewers.source === 'default', JSON.stringify({ big: c2?.bigStream }));

  // ── C: how long a MegaChat stays in the replay ──────────────────────────
  const cfg = async (room) => (await (await fetch(`${APP}/api/config?room=${room}`)).json()).letters || {};
  ok('C1 the send screen\'s days: 30 in a proven room, 0 in a room with no proven channel',
    (await cfg(bigRoom)).replayKeepDays === 30 && (await cfg('default')).replayKeepDays === 0,
    `${(await cfg(bigRoom)).replayKeepDays}/${(await cfg('default')).replayKeepDays}`);
  const noteText = async (room) => {
    const p = await pageAs(null);
    await p.goto(`${APP}/join?room=${room}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await until(() => p.evaluate(() => !!document.getElementById('letterKeepNote')), 10000);
    await sleep(800);
    const t = await p.evaluate(() => document.getElementById('letterKeepNote')?.closest('p')?.textContent || '');
    await p.close();
    return t;
  };
  const n30 = await noteText(bigRoom);
  const nAnon = await noteText('default');
  ok('C2 ...and that is what the fan reads', /replay for up to 30 days\.$/.test(n30) && /plays once on the broadcast\.$/.test(nAnon),
    `"${n30}" / "${nAnon}"`);

  const served = async (id) => (await fetch(`${APP}/api/aired-clips/${id}`)).status;
  ok('C3 never longer than the fan was told: 10 days old under a 7-day promise is gone, under 30 it plays; an older clip counts as told 30',
    (await served(K1)) === 404 && (await served(K2)) === 200 && (await served(K3)) === 200,
    `${await served(K1)}/${await served(K2)}/${await served(K3)}`);

  {
    // A saved 60 days keeps the 40-day-old clip that was told 90. "Reset to
    // 30 days" would delete it: the page must ask, and a No must change nothing.
    await put({ replayKeepDays: 60 }, 'siteowner');
    // Written now, not at boot: under the default 30 days a 40-day-old clip is
    // (rightly) swept the moment the server starts.
    seedClip(K4, now - 40 * DAY, 90); // told 90 days: 40 days old
    const k4Before = await served(K4);
    const p = await pageAs('siteowner');
    const dialogs = [];
    let answer = false;
    p.on('dialog', async (d) => { dialogs.push(d.message()); if (answer) await d.accept(); else await d.dismiss(); });
    await p.goto(`${APP}/dev`, { waitUntil: 'networkidle2', timeout: 60000 });
    const resetBtn = async () => {
      const b = await until(() => p.$('[data-setting="replayKeepDays"] button.mcd-link'), 8000);
      if (!b) throw new Error(`no Reset button: ${await p.evaluate(() => document.querySelector('[data-setting="replayKeepDays"]')?.textContent || document.title)}`);
      return b;
    };
    await (await resetBtn()).click();
    await sleep(800);
    const afterNo = (await view()).settings.replayKeepDays;
    const k4AfterNo = await served(K4);
    answer = true;
    await (await resetBtn()).click();
    const afterYes = await until(async () => { const v = (await view()).settings.replayKeepDays; return v.source === 'default' ? v : null; }, 5000);
    ok('C3b resetting to a shorter keep asks first: No changes nothing, Yes resets and deletes',
      k4Before === 200 && dialogs.length === 2 && /deletes 1 kept clip/.test(dialogs[0]) && afterNo.value === 60 && k4AfterNo === 200
        && afterYes?.value === 30 && (await served(K4)) === 404 && !fs.existsSync(path.join(clipDir, `${K4}.clip`)),
      JSON.stringify({ dialogs: dialogs.length, first: dialogs[0], afterNo: afterNo.value, afterYes: afterYes?.value }));
    // A blank days field is not "off".
    await p.evaluate(() => { const i = document.getElementById('replayKeepDays'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(300);
    const saveDisabled = await p.evaluate(() => document.querySelector('[data-setting="replayKeepDays"] .mcd-save')?.disabled);
    ok('C3c a blank days field cannot be saved as 0 (off)', saveDisabled === true, String(saveDisabled));
    await p.close();
  }

  const to5 = await put({ replayKeepDays: 5 }, 'siteowner');
  ok('C4 set to 5 days: the 10-day-old clip stops at once and its file is deleted; the 1-day-old one stays',
    to5.status === 200 && (await served(K2)) === 404 && !fs.existsSync(path.join(clipDir, `${K2}.clip`)) && (await served(K3)) === 200,
    `${await served(K2)} file=${fs.existsSync(path.join(clipDir, `${K2}.clip`))} / ${await served(K3)}`);
  const n5 = await noteText(bigRoom);
  ok('C5 ...and the send screen says 5 days', (await cfg(bigRoom)).replayKeepDays === 5 && /up to 5 days\.$/.test(n5), `"${n5}"`);

  const off = await put({ replayKeepDays: 0 }, 'siteowner');
  const nOff = await noteText(bigRoom);
  const replay = await (await fetch(`${APP}/api/rooms/default/replay?airing=${C1}`)).json();
  ok('C6 off: every kept clip stops and is deleted; the replay offers none; the fan is told it plays once',
    off.status === 200 && (await served(K3)) === 404 && !fs.existsSync(path.join(clipDir, `${K3}.clip`))
      && (replay.moments || []).every((m) => !m.clip) && /plays once on the broadcast\.$/.test(nOff),
    `${await served(K3)} / clips offered ${(replay.moments || []).filter((m) => m.clip).length} / "${nOff}"`);

  // End to end: a real MegaChat sent from a page that said 7 days is kept 7
  // days, even though the setting went to 30 before it aired.
  const airOne = async (fanName, beforeSend) => {
    const fan = await browser.newPage();
    await fan.evaluateOnNewDocument(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const c = document.createElement('canvas'); c.width = 640; c.height = 360;
        const ctx = c.getContext('2d');
        setInterval(() => { ctx.fillStyle = `hsl(${Date.now() / 15 % 360},80%,50%)`; ctx.fillRect(0, 0, 640, 360); }, 66);
        const stream = c.captureStream(15);
        try { const ac = new AudioContext(); const o = ac.createOscillator(); const d = ac.createMediaStreamDestination(); o.connect(d); o.start(); d.stream.getAudioTracks().forEach((t) => stream.addTrack(t)); } catch { /* video only */ }
        return stream;
      };
    });
    await fan.goto(`${APP}/join?room=${bigRoom}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(1500);
    const told = await fan.evaluate(() => document.getElementById('letterKeepNote')?.textContent || '');
    await fan.evaluate(() => { const el = document.getElementById('username'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await fan.type('#username', fanName);
    await fan.evaluate(() => document.getElementById('letterBtn').click());
    await sleep(1200);
    await fan.evaluate(() => document.getElementById('letterRecordBtn').click());
    await sleep(2500);
    await fan.evaluate(() => document.getElementById('letterRecordBtn').click());
    await sleep(1500);
    if (beforeSend) await beforeSend();
    await fan.evaluate(() => document.getElementById('letterSendBtn').click());
    const letters = async () => (await fetch(`${APP}/api/dashboard/rooms/${bigRoom}/letters`, { headers: { 'X-Room-Password': 'big-pass-1234' } }).then((r) => r.json())).letters || [];
    const queued = await until(async () => (await letters()).find((l) => l.status === 'queued' && l.username === fanName), 30000, 1000);
    const overlay = await browser.newPage();
    await overlay.goto(`${APP}/overlay?room=${bigRoom}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await until(async () => !(await letters()).some((l) => l.id === queued?.id && l.status !== 'done'), 25000, 1000);
    await sleep(1500);
    await overlay.close();
    await fan.close();
    return { id: queued?.id, told };
  };
  // The broadcast has to be open for the MegaChat to be a moment of it.
  await until(() => JSON.parse(fs.readFileSync(path.join(dataDir, 'airings.json'), 'utf8')).airings.find((a) => a.roomId === bigRoom && a.endedAt == null), 10000);
  await put({ replayKeepDays: 7 }, 'siteowner');
  const e1 = await airOne('seven-fan', () => put({ replayKeepDays: 30 }, 'siteowner'));
  const meta1 = await until(() => {
    const f = path.join(clipDir, `${e1.id}.json`);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  }, 10000, 500);
  ok('C7 end to end: a MegaChat whose page said 7 days is kept 7 days, though the setting was 30 when it aired',
    /up to 7 days$/.test(e1.told) && meta1?.keepDays === 7, JSON.stringify({ told: e1.told, keepDays: meta1?.keepDays }));
  await put({ replayKeepDays: 0 }, 'siteowner');
  const e2 = await airOne('off-fan');
  await sleep(2000);
  ok('C8 end to end: with keeping off, the next MegaChat airs and no copy is kept',
    !!e2.id && e2.told === '' && !fs.existsSync(path.join(clipDir, `${e2.id}.clip`)), JSON.stringify(e2));
  viewersOf.delete('bigchan');

  // ── D: quiet broadcasts in Recently aired ───────────────────────────────
  const recent = async () => (await (await fetch(`${APP}/api/rooms/recent?limit=24`)).json()).airings.map((a) => a.airingId);
  const r0 = await recent();
  ok('D1 by default a broadcast where nothing happened gets no card', r0.includes(C1) && ![Q1, Q2, Q3, Q4].some((q) => r0.includes(q)), JSON.stringify({ C1: r0.includes(C1), Q1: r0.includes(Q1) }));
  ok('D2 the page counts the quiet broadcasts a switch would add — 5 minutes or more, proven channel, recording found', (await view()).quiet?.count === 1, JSON.stringify((await view()).quiet));
  await put({ recentShowsQuiet: true }, 'siteowner');
  const r1 = await recent();
  const rq = await (await fetch(`${APP}/api/rooms/${QROOM}/replay?airing=${Q1}`)).json();
  ok('D3 switched on: the 20-minute one gets a card; the 2-minute one never', r1.includes(Q1) && !r1.includes(Q2), JSON.stringify({ Q1: r1.includes(Q1), Q2: r1.includes(Q2) }));
  const rq3 = await (await fetch(`${APP}/api/rooms/default/replay?airing=${Q3}`)).json();
  ok('D3b ...nor one on a channel its room\'s owner never proved (no card, no replay), nor one with no recording',
    !r1.includes(Q3) && rq3.airing?.id !== Q3 && !r1.includes(Q4), JSON.stringify({ Q3card: r1.includes(Q3), Q3replay: rq3.airing?.id === Q3, Q4card: r1.includes(Q4) }));
  ok('D4 ...and its replay opens at the start of its recording', rq.airing?.id === Q1 && rq.start === 0 && rq.moments?.[0]?.kind === 'start'
    && rq.moments[0].vod?.vodId === '9901' && rq.moments[0].vod.offsetS === 0, JSON.stringify(rq.moments));
  {
    const p = await pageAs(null);
    // Not networkidle: Twitch's real player keeps the network busy.
    await p.goto(`${APP}/join?room=${QROOM}&replay=${Q1}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const got = await until(() => p.evaluate(() => ({
      iframe: document.querySelector('#streamPreviewMount iframe')?.src || '',
      label: document.getElementById('streamPreviewLabel')?.textContent || '',
    })).then((x) => (x.iframe ? x : null)), 12000);
    await p.close();
    ok('D5 on the page: the recording from 0:00, labelled "from the start"',
      !!got && got.iframe.includes('video=v9901') && got.iframe.includes('time=0h0m0s') && /from the start/.test(got.label), JSON.stringify(got));
  }
  await put({ recentShowsQuiet: false }, 'siteowner');
  const r2 = await recent();
  const rq2 = await (await fetch(`${APP}/api/rooms/${QROOM}/replay?airing=${Q1}`)).json();
  ok('D6 switched off again: the card goes, and the replay no longer opens it', !r2.includes(Q1) && rq2.airing?.id !== Q1, JSON.stringify({ card: r2.includes(Q1), replay: rq2.airing?.id === Q1 }));

  // ── E: the record ───────────────────────────────────────────────────────
  const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'site-settings.json'), 'utf8'));
  const hist = (await view()).history || [];
  ok('E1 saved on the volume, with who changed what', disk.values.replayKeepDays === 0 && disk.values.recentShowsQuiet === false
    && hist.length >= 7 && hist.every((h) => h.by === 'siteowner') && hist[0].changed.recentShowsQuiet?.to === false,
    `${hist.length} changes; latest ${JSON.stringify(hist[0]?.changed)}`);
} catch (e) {
  fail++;
  console.log(`  FAIL  the gate threw: ${e.stack || e.message}`);
} finally {
  await browser.close().catch(() => {});
  srv.kill();
  twitch.close();
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
