/**
 * GATE — Claimed pledges on the rooms board.
 *
 * The owner, 2026-11-09: "have a claimed pledge section like recently aired
 * and rooms. just have it empty almost like a collapsed dropdown. populate it
 * with the vod thing for claimed bounties and do like we have now where you
 * click through each one at diff timestamps. like in case a streamer had 5
 * and they did it one by one across an hour long vod."
 *
 *   C1  /api/rooms/claimed lists a broadcast on which pledged clips aired —
 *       with the count, the pools (platform + handle) and only those clips'
 *       moments, in order — and NOT a broadcast whose Hollers were ordinary
 *   C2  it never carries who pledged (contributor, contribution id)
 *   C3  the replay with &only=bounty opens at the FIRST pledged clip and
 *       offers just the pledged clips; without it, the replay is unchanged
 *       (opens at the first Holler of any kind, every moment)
 *   B1  the board's Claimed pledges section is in the first HTML: a heading
 *       like Recently aired and Rooms, BELOW the rooms (owner, 2026-11-10)
 *   B2  it shows the card: platform badge, "3 bounty clips", a link into the
 *       replay with &only=bounty
 *   B3  that link opens the recording at the first pledged clip (20s before
 *       it), with one button per pledged clip; the second button seeks to
 *       the second clip
 *   B4  the Recently aired card for the same broadcast still opens at its
 *       first Holler of any kind (behaviour unchanged)
 *   E1  with no pledged clip aired anywhere: the heading alone, no cards and
 *       no empty row held open
 *
 * `--old <file>` runs the same checks against another server entry (e.g.
 * `git show HEAD:server.js` written next to server.js) to show they fail
 * without this change. No Twitch keys: every recording counts as available.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import puppeteer from 'puppeteer-core';

const oi = process.argv.indexOf('--old');
const OLD = oi > 0 ? process.argv[oi + 1] : null;
const PORT = 3341;
const APP = `http://localhost:${PORT}`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const M = 60_000;
const SKEW_MS = 16_000; // bounty-claim.config.js vodTimelineSkewMs default
const LEAD_S = 20;
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
const twitchTime = (s) => `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m${s % 60}s`;
const offsetFor = (at, recStart) => Math.max(0, Math.round((at - recStart + SKEW_MS) / 1000) - LEAD_S);
const getJson = async (p) => { const r = await fetch(`${APP}${p}`); return { status: r.status, body: r.ok ? await r.json() : null, text: r.ok ? '' : await r.text() }; };

console.log(`\n── Claimed pledges on the board${OLD ? ` (against ${OLD})` : ''} ──`);

// The clip index is written in process, into the data dir the server will
// read: getClipRecord is what decides a moment was a pledged clip.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-claimed-'));
process.env.DATA_DIR = dataDir;
const { startGateServer, assertFreshBuild } = await import('./_gate-helpers.mjs');
const clips = await import('./bounty-clips.js');

const fresh = assertFreshBuild();
ok('G0. the build under test is newer than the source it renders', fresh.ok, fresh.detail);
if (!fresh.ok) { console.log(`\nRESULT: ${pass} pass, ${fail} fail`); process.exit(1); }

const SECRET_FAN = `twitch:secretfan${randomBytes(3).toString('hex')}`;
const store = (handleKey, i) => clips.storeClip({
  handleKey, contributionId: `contrib-secret-${i}`, contributor: SECRET_FAN,
  mime: 'video/webm', durationS: 4, data: randomBytes(2048),
}).clipId;
const [K1, K2, K3] = [store('twitch:pledgedchan', 1), store('twitch:pledgedchan', 2), store('kick:otherpool', 3)];

const now = Date.now();
const mom = (kind, label, at, start, ref) => ({ at, kind, label, offsetMs: at - start, ...(ref ? { ref } : {}) });
const recStart = now - 121 * M;
const recording = (vodId) => [{ vodId, url: `https://www.twitch.tv/videos/${vodId}`, startMs: recStart, durationS: 2 * 3600 }];
// A: an hour-long broadcast; an ordinary Holler first, then three pledged clips one by one.
const A = randomUUID();
const aStart = now - 120 * M;
const aMoments = [
  mom('seat', 'amy', aStart + 5 * M, aStart),
  mom('megachat', 'plainfan', aStart + 8 * M, aStart, randomUUID()),
  mom('megachat', null, aStart + 15 * M, aStart, K1),
  mom('megachat', null, aStart + 30 * M, aStart, K2),
  mom('megachat', null, aStart + 45 * M, aStart, K3),
];
// B: newer, Hollers but none of them pledged.
const B = randomUUID();
const bStart = now - 50 * M;
const bMoments = [mom('seat', 'bo', bStart + 2 * M, bStart), mom('megachat', 'otherfan', bStart + 4 * M, bStart, randomUUID())];
const airingA = { id: A, roomId: 'default', platform: 'twitch', channel: 'pledgedchan', startedAt: aStart, endedAt: aStart + 60 * M,
  vodId: '5501', vodUrl: 'https://www.twitch.tv/videos/5501', captureRef: null, recordings: recording('5501'), moments: aMoments };
const airingB = { id: B, roomId: 'default', platform: 'twitch', channel: 'pledgedchan', startedAt: bStart, endedAt: bStart + 20 * M,
  vodId: '5502', vodUrl: 'https://www.twitch.tv/videos/5502', captureRef: null, recordings: recording('5502'), moments: bMoments };
// Older plain broadcasts, so the first board is a BUSY one (past SPARSE_MAX
// tiles): the layout where the closed toggle docks on Recently aired's line.
const extras = [3, 4, 5, 6].map((h) => {
  const st = now - h * 60 * M;
  return { id: randomUUID(), roomId: 'default', platform: 'twitch', channel: 'pledgedchan', startedAt: st, endedAt: st + 30 * M,
    vodId: null, vodUrl: null, captureRef: null, moments: [mom('seat', `g${h}`, st + M, st)] };
});
fs.writeFileSync(path.join(dataDir, 'airings.json'), JSON.stringify({ airings: [airingA, airingB, ...extras] }, null, 2));

const args = OLD ? [OLD, '--prod'] : undefined;
let srv = await startGateServer({ port: PORT, label: 'claimed', dataDir, ...(args ? { args } : {}), env: { KEEP_ORPHAN_ROOMS: 'true' } });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--mute-audio'] });
const newPage = async () => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  // The Twitch player is not under test; its URL is.
  await page.setRequestInterception(true);
  page.on('request', (r) => (/twitch\.tv|jtvnw|decapi|kick\.com/.test(r.url()) ? r.abort() : r.continue()));
  return page;
};
const replayState = (page) => page.evaluate(() => {
  const iframe = document.querySelector('#streamPreviewMount iframe');
  return {
    iframe: iframe ? iframe.src : null,
    buttons: [...document.querySelectorAll('#streamReplayMoments button')].map((b) => ({ t: b.textContent, on: b.getAttribute('aria-pressed') })),
  };
});
const timeOf = (src) => (/[?&]time=([^&]+)/.exec(src || '') || [])[1] || null;
const claimedRow = (page) => page.evaluate(() => {
  const sec = document.querySelector('section.mcr-claimed');
  const rooms = document.querySelector('.mcr-rooms');
  const head = sec?.querySelector('h2');
  return sec ? {
    heading: head?.textContent || '',
    cards: [...sec.querySelectorAll('a.mcr-recent')].map((a) => ({ href: a.getAttribute('href'), text: a.textContent, pips: a.querySelectorAll('svg.mc-pip').length })),
    grid: !!sec.querySelector('.mcr-recent-grid'),
    // Below the rooms: the section starts under the rooms' bottom edge.
    belowRooms: rooms ? sec.getBoundingClientRect().top >= rooms.getBoundingClientRect().bottom - 1 : null,
    rowH: Math.round(sec.getBoundingClientRect().height),
    headH: head ? Math.round(head.getBoundingClientRect().height) : null,
  } : null;
});

try {
  // ── C1/C2: the endpoint ──────────────────────────────────────────────────
  const cl = await getJson('/api/rooms/claimed');
  const list = cl.body?.airings || [];
  const a = list.find((x) => x.airingId === A);
  ok('C1 a broadcast on which pledged clips aired is listed', cl.status === 200 && !!a, `status ${cl.status}, ${list.length} listed`);
  ok('C1 ...and one whose Hollers were ordinary is not', cl.status === 200 && !list.some((x) => x.airingId === B));
  ok('C1 ...with the count, both pools, and only the pledged clips\' moments, in order',
    a?.bountyClips === 3 && a.moments.length === 3 && a.moments.every((m) => m.kind === 'megachat')
      && JSON.stringify(a.moments.map((m) => m.offsetMs)) === JSON.stringify([15 * M, 30 * M, 45 * M])
      && a.pools.length === 2 && a.pools.some((p) => p.platform === 'twitch' && p.handle === 'pledgedchan') && a.pools.some((p) => p.platform === 'kick' && p.handle === 'otherpool'),
    a ? JSON.stringify({ n: a.bountyClips, offsets: a.moments.map((m) => m.offsetMs / M), pools: a.pools }) : 'absent');
  ok('C1 ...and the Recently aired card fields (poster, avatarUrl key, link target)',
    !!a && 'poster' in a && 'avatarUrl' in a && a.roomId === 'default', a ? Object.keys(a).join(',') : 'absent');
  const raw = JSON.stringify(cl.body || {});
  ok('C2 it never carries who pledged', cl.status === 200 && !raw.includes(SECRET_FAN) && !raw.includes('contrib-secret') && !/contributor/i.test(raw));

  // ── C3: the replay door ──────────────────────────────────────────────────
  const only = (await getJson(`/api/rooms/default/replay?airing=${A}&only=bounty`)).body;
  ok('C3 &only=bounty: just the pledged clips, opening at the first',
    !!only && only.moments.length === 3 && only.start === 0 && only.moments[0].offsetMs === 15 * M
      && only.moments.every((m) => m.kind === 'megachat') && only.moments[0].vod?.offsetS === offsetFor(aStart + 15 * M, recStart),
    only ? JSON.stringify({ n: only.moments.length, start: only.start, first: only.moments[only.start]?.offsetMs / M }) : 'no body');
  const all = (await getJson(`/api/rooms/default/replay?airing=${A}`)).body;
  ok('C3 without it the replay is unchanged: every moment, opening at the first Holler of any kind',
    !!all && all.moments.length === 5 && all.start === 1 && all.moments[1].offsetMs === 8 * M,
    all ? JSON.stringify({ n: all.moments.length, start: all.start }) : 'no body');

  // ── B1–B4: the board, in a browser ───────────────────────────────────────
  const html = await (await fetch(`${APP}/app`)).text();
  ok('B1 the Claimed pledges section is in the first HTML', /mcr-claimed/.test(html) && /Claimed pledges/.test(html));
  let page = await newPage();
  await page.goto(`${APP}/app`, { waitUntil: 'networkidle2', timeout: 60000 });
  let row = await claimedRow(page);
  ok('B1 ...a "Claimed pledges" heading like Recently aired and Rooms, below the rooms',
    !!row && row.heading === 'Claimed pledges' && row.belowRooms === true, JSON.stringify(row));
  row = await until(async () => { const r = await claimedRow(page); return r?.cards.length ? r : null; }, 5000) || await claimedRow(page);
  const card = row?.cards[0];
  ok('B2 the card: a platform badge, "3 bounty clips", a link into the replay with &only=bounty',
    row?.cards.length === 1 && card.pips >= 1 && /3 bounty clips/.test(card.text) && card.href.includes(`replay=${A}&only=bounty`),
    JSON.stringify(card || row));
  const recentHref = await page.evaluate((id) => [...document.querySelectorAll('.mcr-recent-rail a.mcr-recent')].map((x) => x.getAttribute('href')).find((h) => h.includes(id)) || null, A);
  await page.close();

  if (card) {
    page = await newPage();
    await page.goto(`${APP}${card.href}`, { waitUntil: 'networkidle2', timeout: 60000 });
    let s = await until(async () => { const x = await replayState(page); return x.iframe ? x : null; }, 12000) || await replayState(page);
    const want1 = twitchTime(offsetFor(aStart + 15 * M, recStart));
    ok('B3 the card opens the recording 20s before the FIRST pledged clip',
      timeOf(s.iframe) === want1 && /video=v5501/.test(s.iframe || ''), `time ${timeOf(s.iframe)} want ${want1}`);
    ok('B3 ...with one button per pledged clip, the first pressed',
      s.buttons.length === 3 && s.buttons[0].on === 'true' && s.buttons.slice(1).every((b) => b.on === 'false'), JSON.stringify(s.buttons));
    await page.evaluate(() => document.querySelectorAll('#streamReplayMoments button')[1]?.click());
    s = await until(async () => { const x = await replayState(page); return timeOf(x.iframe) !== want1 ? x : null; }, 5000) || await replayState(page);
    const want2 = twitchTime(offsetFor(aStart + 30 * M, recStart));
    ok('B3 ...and the second button seeks to the second clip', timeOf(s.iframe) === want2, `time ${timeOf(s.iframe)} want ${want2}`);
    await page.close();
  } else {
    ok('B3 the card opens the replay at the first pledged clip', false, 'no card to follow');
  }

  if (recentHref) {
    page = await newPage();
    await page.goto(`${APP}${recentHref}`, { waitUntil: 'networkidle2', timeout: 60000 });
    const s = await until(async () => { const x = await replayState(page); return x.iframe ? x : null; }, 12000) || await replayState(page);
    const want = twitchTime(offsetFor(aStart + 8 * M, recStart));
    ok('B4 the Recently aired card still opens at the first Holler of any kind, every moment offered',
      !recentHref.includes('only=') && timeOf(s.iframe) === want && s.buttons.length === 5, `${recentHref}; time ${timeOf(s.iframe)} want ${want}; ${s.buttons.length} buttons`);
    await page.close();
  } else {
    ok('B4 the Recently aired card for the broadcast exists', false, 'not on the rail');
  }

  // ── E1: nothing pledged has aired ────────────────────────────────────────
  srv.kill();
  await sleep(1500);
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-claimed-empty-'));
  fs.writeFileSync(path.join(emptyDir, 'airings.json'), JSON.stringify({ airings: [airingB] }, null, 2));
  srv = await startGateServer({ port: PORT, label: 'claimed-empty', dataDir: emptyDir, ...(args ? { args } : {}), env: { KEEP_ORPHAN_ROOMS: 'true' } });
  page = await newPage();
  await page.goto(`${APP}/app`, { waitUntil: 'networkidle2', timeout: 60000 });
  const empty = await claimedRow(page);
  ok('E1 nothing pledged aired: the heading alone, below the rooms, no cards and no empty row held open',
    !!empty && empty.heading === 'Claimed pledges' && empty.belowRooms === true && empty.cards.length === 0 && !empty.grid && empty.rowH <= (empty.headH || 0) + 2, JSON.stringify(empty));
  await page.close();
} catch (e) {
  fail++;
  console.log(`  FAIL  harness threw: ${e.message}`);
} finally {
  await browser.close().catch(() => {});
  if (srv) srv.kill();
  console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
