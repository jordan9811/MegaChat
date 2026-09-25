/**
 * GATE — a finished broadcast has a real picture of itself on the board, and
 * only one the owner's rule allows: "a frame from when the MegaChat or live
 * seat was actually up".
 *
 * Until 2026-09-25 nothing made one for an ordinary stream: the only picture
 * path ran at the close of a bounty air session, and `/api/rooms/recent` read
 * the poster off the RESOLVED room config, which never carries it — so every
 * card, the owner's 4-hour stream included, was a letter on a grey box marked
 * "No recording" while Twitch held the recording (airing-posters.js header).
 *
 * THE FRAME CHOICE (pure):
 *   U1  the longest guest's stretch, not the middle of the stream
 *   U2  two guests at once beats one guest for longer
 *   U3  no seat and no MegaChat → NO preview poster
 *   U4  a leave with no join, a null name, a duplicate name: the crowd stays right
 *   U5  a restart ends every seat (seats live in memory)
 *   U6  MegaChat only → a preview from while it played
 *   U7  a short broadcast never gets its last preview when an earlier one shows the guest
 *   U8  rank: capture > recording frame > preview > recording thumbnail, both ways
 *   U9  an id nobody aired is not remembered (a public URL cannot fill memory)
 *
 * THE SERVER, against a FAKE Twitch, from seeded airings (so the frame picked
 * is known in advance):
 *   R1  boot marks a restart in every open airing
 *   R2  a stream that ended while the server was down is closed at the last
 *       moment it was known up — and its poster is picked AT THAT CLOSE, before
 *       any sweep could have done it
 *   R3  the picked frame is EXACTLY the preview from the longest guest's
 *       stretch, served byte-for-byte at the URL the board is given
 *   R4  the recording is attached
 *   R5  a broadcast with guests but no preview gets the recording's thumbnail
 *   R6  a broadcast with no guest and no MegaChat: no picture, not on the board
 *   R7  cleanup: previews of a finished guest-less broadcast, of an airing whose
 *       room is gone, and posters of airings the store no longer keeps — gone;
 *       previews of the broadcast just finished — kept
 *   L1  live: an unchanged preview is kept once, each refresh is kept
 *   L2  a black frame or the offline placeholder is never kept
 *   L3  a room nobody signed in to own keeps no previews
 *   P7  the poster URL takes known airing ids only
 *
 * Needs ffmpeg locally (to make the test JPEGs). Discriminates — see the
 * OPEN-ISSUES entry "Recently aired: real pictures" for the recorded runs.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { startGateServer } from './_gate-helpers.mjs';

const PORT = 3291;
const TWITCH_PORT = 3292;
const APP = `http://localhost:${PORT}`;
const FAKE = `http://localhost:${TWITCH_PORT}`;
const M = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (b) => createHash('sha1').update(b).digest('hex');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  (${detail})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
};
const until = async (fn, ms = 15000, step = 250) => {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); }
  return v;
};

// ── test pictures (all distinct, all well over the near-black floor) ──────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-airing-poster-'));
const jpg = (name, lavfi) => {
  const f = path.join(TMP, `${name}.jpg`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', lavfi, '-frames:v', '1', '-q:v', '3', f]);
  return fs.readFileSync(f);
};
const FRAMES = Array.from({ length: 16 }, (_, i) => jpg(`f${i}`, `testsrc2=size=640x360:rate=1,trim=start=${i * 2}`));
const THUMB = jpg('thumb', 'mandelbrot=size=640x360');
const BLACK = jpg('black', 'color=black:size=640x360');
if (new Set(FRAMES.map(sha1)).size !== FRAMES.length) throw new Error('test frames are not distinct');

// ── U: the frame choice, pure (in-process, its own data dir) ──────────────
process.env.DATA_DIR = path.join(TMP, 'unit-data');
const posters = await import('./airing-posters.js');
{
  const T0 = 1_790_000_000_000;
  const every = (step, from, to) => { const c = []; for (let t = from; t <= to; t += step) c.push({ at: t }); return c; };
  const seat = (label, at) => ({ kind: 'seat', label, at });
  const leave = (label, at) => ({ kind: 'seat_leave', label, at });

  const a1 = { startedAt: T0, endedAt: T0 + 240 * M, moments: [seat('A', T0 + 30 * M), leave('A', T0 + 36.5 * M), seat('B', T0 + 120 * M), leave('B', T0 + 122 * M)] };
  const p1 = posters.pickCandidate(every(5 * M, T0 + M, T0 + 240 * M), a1);
  ok('U1 a preview from while the longest guest was on', p1 && p1.at > T0 + 30 * M && p1.at - 5 * M < T0 + 36.5 * M, `picked +${p1 && (p1.at - T0) / M} min`);

  const a2 = { startedAt: T0, endedAt: T0 + 180 * M, moments: [seat('A', T0 + 20 * M), seat('B', T0 + 100 * M), leave('B', T0 + 110 * M), leave('A', T0 + 150 * M)] };
  ok('U2 two guests at once beats one guest for longer', posters.posterTarget(a2)?.at === T0 + 105 * M, `target +${(posters.posterTarget(a2)?.at - T0) / M} min`);

  const a3 = { startedAt: T0, endedAt: T0 + 120 * M, moments: [] };
  ok('U3 no seat and no MegaChat → no preview poster at all', posters.pickCandidate(every(4 * M, T0 + M, T0 + 119 * M), a3) === null
    && posters.hasContent(a3) === false);

  const odd = posters.seatSpans({ startedAt: T0, endedAt: T0 + 30 * M, moments: [
    leave('X', T0 + M), seat(null, T0 + 2 * M), leave(null, T0 + 4 * M), seat('Sam', T0 + 5 * M), seat('Sam', T0 + 6 * M), leave('Sam', T0 + 7 * M), leave('Sam', T0 + 9 * M),
  ] });
  ok('U4 a leave with no join, a null name, a duplicate name: the crowd stays right',
    JSON.stringify(odd.map((s) => [(s.from - T0) / M, (s.to - T0) / M, s.count])) === JSON.stringify([[2, 4, 1], [5, 6, 1], [6, 7, 2], [7, 9, 1]]),
    JSON.stringify(odd.map((s) => [(s.from - T0) / M, (s.to - T0) / M, s.count])));

  const a5 = { startedAt: T0, endedAt: T0 + 180 * M, moments: [seat('A', T0 + 10 * M), leave('A', T0 + 20 * M), seat('B', T0 + 30 * M), { kind: 'restart', label: null, at: T0 + 35 * M }] };
  const s5 = posters.seatSpans(a5);
  ok('U5 a restart ends every seat (B does not "stay on" for the rest of the stream)',
    s5.length === 2 && s5[1].to === T0 + 35 * M && posters.posterTarget(a5).at === T0 + 15 * M, JSON.stringify(s5.map((s) => [(s.from - T0) / M, (s.to - T0) / M])));

  const a6 = { startedAt: T0, endedAt: T0 + 180 * M, moments: [{ kind: 'megachat', label: 'v', at: T0 + 20 * M }] };
  const p6 = posters.pickCandidate(every(2 * M, T0 + M, T0 + 179 * M), a6);
  ok('U6 MegaChat only → a preview from while it played', p6 && p6.at > T0 + 20 * M && p6.at - 5 * M < T0 + 21.5 * M, `picked +${p6 && (p6.at - T0) / M} min`);

  const a7 = { startedAt: T0, endedAt: T0 + 7 * M, moments: [seat('A', T0 + 30_000)] };
  const c7 = every(M, T0 + M, T0 + 7 * M);
  const p7 = posters.pickCandidate(c7, a7);
  ok('U7 a 7-minute broadcast does not get its LAST preview when earlier ones show the guest', p7 && p7.at < c7[c7.length - 1].at, `picked +${p7 && (p7.at - T0) / M} of 7 min`);

  const rid = randomUUID();
  const seq = [['twitch-preview', FRAMES[0]], ['twitch-vod-thumbnail', THUMB], ['capture', FRAMES[1]], ['twitch-preview', FRAMES[2]], ['twitch-vod', FRAMES[3]], ['capture', FRAMES[4]]];
  const kept = seq.map(([source, buf]) => posters.saveAiringPoster(rid, buf, { source }, { log: {} })?.source);
  ok('U8 rank: a poster is replaced only by one as good or better',
    JSON.stringify(kept) === JSON.stringify(['twitch-preview', 'twitch-preview', 'capture', 'capture', 'capture', 'capture'])
      && sha1(fs.readFileSync(posters.posterFileFor(rid))) === sha1(FRAMES[4]), JSON.stringify(kept));

  const ghost = randomUUID();
  const before = posters.readAiringPoster(ghost);
  fs.copyFileSync(posters.posterFileFor(rid), posters.posterFileFor(ghost));
  fs.writeFileSync(posters.posterFileFor(ghost).replace(/\.jpg$/, '.json'), JSON.stringify({ kind: 'frame', source: 'twitch-preview' }));
  ok('U9 an id nobody aired is not remembered as missing (found the moment it exists)', before === null && posters.readAiringPoster(ghost)?.source === 'twitch-preview');
}

// ── fake Twitch ────────────────────────────────────────────────────────────
const liveLogins = new Set();
let previewMode = 'frames'; // 'frames' | 'placeholder' | 'black'
let frameIdx = 0;
let videos = [];
const twitch = http.createServer((req, res) => {
  const url = new URL(req.url, FAKE);
  const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/oauth2/token') return json({ access_token: 'fake', expires_in: 3600 });
  if (url.pathname === '/helix/streams') return json({ data: url.searchParams.getAll('user_login').filter((l) => liveLogins.has(l)).map((l) => ({ user_login: l })) });
  if (url.pathname === '/helix/users') return json({ data: [{ id: `u-${url.searchParams.get('login')}`, login: url.searchParams.get('login') }] });
  if (url.pathname === '/helix/videos') return json({ data: videos });
  const pm = /^\/previews-ttv\/live_user_([^-]+)-640x360\.jpg$/.exec(url.pathname);
  if (pm) {
    if (!liveLogins.has(pm[1]) || previewMode === 'placeholder') {
      res.writeHead(302, { Location: `${FAKE}/ttv-static/404_preview-640x360.jpg` });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    return res.end(previewMode === 'black' ? BLACK : FRAMES[frameIdx % FRAMES.length]);
  }
  if (url.pathname.startsWith('/ttv-static/')) { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(BLACK); }
  if (url.pathname === '/vod-thumb-640x360.jpg') { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(THUMB); }
  res.writeHead(404).end('{}');
});
await new Promise((r) => twitch.listen(TWITCH_PORT, r));

const ENV = {
  TWITCH_CLIENT_ID: 'gate-client', TWITCH_CLIENT_SECRET: 'gate-secret',
  TWITCH_ID_BASE: FAKE, TWITCH_API_BASE: FAKE, TWITCH_PREVIEW_BASE: FAKE,
  FOLLOW_POLL_MS: '500', FOLLOW_OFF_CONFIRM_MS: '2000',
  POSTER_SNAPSHOT_MS: '400', POSTER_SWEEP_MS: '6000', POSTER_VOD_WAIT_MS: '0',
  KEEP_ORPHAN_ROOMS: 'true',
};
const PASSWORD = 'gate-pass-1234';
let srv = null;
try {
  // ── boot 1: two rooms that follow channels — one signed-in owner, one not ─
  srv = await startGateServer({ port: PORT, label: 'airing-poster#1', env: ENV, bountyAuth: { handles: ['posterowner'] } });
  const create = async (name, channel, headers = {}) => {
    const r = await fetch(`${APP}/api/dashboard/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ name, password: PASSWORD, config: { twitchChannel: channel, twitchAuto: true, unlisted: false } }),
    });
    const j = await r.json();
    const id = j.roomId || j.room?.id;
    if (!id) throw new Error(`create ${name}: ${r.status}`);
    return id;
  };
  const owned = await create('Seeded Owner Room', 'seedchan', srv.headers('posterowner'));
  const anon = await create('Anonymous Room', 'anonchan');
  const dataDir = srv.dataDir;
  srv.kill();
  await sleep(1500);

  // ── seed: what the server will find at boot 2 ─────────────────────────────
  const now = Date.now();
  const A = randomUUID(); // open: the stream ended while the server was down
  const B = randomUUID(); // closed, had a guest, no preview kept
  const C = randomUUID(); // closed hours ago, nobody came, previews left over
  const D = randomUUID(); // open, its room was deleted
  const E = randomUUID(); // not in the store at all
  const seatM = (kind, label, at, start) => ({ at, kind, label, offsetMs: at - start });
  const aStart = now - 60 * M;
  const airings = [
    { id: A, roomId: owned, platform: 'twitch', channel: 'seedchan', startedAt: aStart, endedAt: null, vodId: null, vodUrl: null, captureRef: null,
      moments: [seatM('seat', 'amy', now - 50 * M, aStart), seatM('seat_leave', 'amy', now - 44 * M, aStart), seatM('seat', 'bo', now - 30 * M, aStart), seatM('megachat', 'viv', now - 20 * M, aStart)] },
    { id: B, roomId: owned, platform: 'twitch', channel: 'seedchan', startedAt: now - 600 * M, endedAt: now - 540 * M, vodId: null, vodUrl: null, captureRef: null,
      moments: [seatM('seat', 'cy', now - 580 * M, now - 600 * M)] },
    { id: C, roomId: owned, platform: 'twitch', channel: 'seedchan', startedAt: now - 300 * M, endedAt: now - 240 * M, vodId: null, vodUrl: null, captureRef: null, moments: [] },
    { id: D, roomId: 'gone-room', platform: 'twitch', channel: 'ghostchan', startedAt: now - 30 * M, endedAt: null, vodId: null, vodUrl: null, captureRef: null, moments: [] },
  ];
  fs.writeFileSync(path.join(dataDir, 'airings.json'), JSON.stringify({ airings }, null, 2));
  const cand = (id, at, buf) => {
    const d = path.join(dataDir, 'airing-posters', 'candidates', id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${at}.jpg`), buf);
  };
  // A: a preview every 4 minutes, -58 … -2 min, each a different frame.
  const aCands = [];
  for (let i = 0; i < 15; i++) { const at = now - (58 - 4 * i) * M; cand(A, at, FRAMES[i]); aCands.push({ at, buf: FRAMES[i] }); }
  cand(C, now - 270 * M, FRAMES[0]);
  cand(D, now - 20 * M, FRAMES[1]);
  fs.writeFileSync(path.join(dataDir, 'airing-posters', `${E}.jpg`), FRAMES[2]);
  fs.writeFileSync(path.join(dataDir, 'airing-posters', `${E}.json`), JSON.stringify({ kind: 'frame', source: 'twitch-preview' }));
  // Expected: bo's stretch [-30, -2] (the stream's last known moment) is the
  // longest; its middle is -16, aim -13.5 → the preview fetched at -14 min.
  const expected = aCands.find((c) => c.at === now - 14 * M);
  videos = [
    { id: '7001', url: 'https://www.twitch.tv/videos/7001', created_at: new Date(aStart - M).toISOString(), duration: '1h2m0s', thumbnail_url: `${FAKE}/vod-thumb-%{width}x%{height}.jpg` },
    { id: '7002', url: 'https://www.twitch.tv/videos/7002', created_at: new Date(now - 601 * M).toISOString(), duration: '1h2m0s', thumbnail_url: `${FAKE}/vod-thumb-%{width}x%{height}.jpg` },
  ];

  // ── boot 2 ─────────────────────────────────────────────────────────────────
  const bootAt = Date.now();
  srv = await startGateServer({ port: PORT, label: 'airing-poster#2', env: ENV, dataDir, bountyAuth: { handles: ['posterowner'] } });
  const raw = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'airings.json'), 'utf8')).airings;
  const recentFor = async (id) => ((await (await fetch(`${APP}/api/rooms/recent?limit=24`)).json()).airings || []).find((a) => a.airingId === id);
  const candsOf = (id) => { try { return fs.readdirSync(path.join(dataDir, 'airing-posters', 'candidates', id)); } catch { return []; } };
  const posterOf = (id) => fs.existsSync(path.join(dataDir, 'airing-posters', `${id}.jpg`));

  ok('R1 boot marks a restart in every open airing', raw().filter((a) => a.id === A || a.id === D).every((a) => a.moments.some((m) => m.kind === 'restart')));
  const closedA = await until(() => { const a = raw().find((x) => x.id === A); return a?.endedAt != null && posterOf(A) ? a : null; }, 4500, 150);
  ok('R2 the stream that ended while the server was down is closed, and its poster picked AT THAT CLOSE (before any sweep)',
    !!closedA && Date.now() - bootAt < 6000, closedA ? `closed at -${Math.round((now - closedA.endedAt) / M)} min, ${Date.now() - bootAt}ms after boot` : 'not closed with a poster within 4.5s');
  ok('R2 ...at the last moment it was known up (its newest preview), not at boot', !!closedA && closedA.endedAt === now - 2 * M,
    closedA ? `${(closedA.endedAt - now) / M} min` : '');
  const cardA = await until(async () => { const a = await recentFor(A); return a?.poster?.kind === 'frame' ? a : null; }, 8000);
  ok('R3 it is on the board with a real frame', !!cardA, JSON.stringify((await recentFor(A))?.poster || null));
  if (cardA) {
    const img = await fetch(`${APP}${cardA.poster.url}`);
    const buf = Buffer.from(await img.arrayBuffer());
    ok('R3 ...EXACTLY the preview from the longest guest\'s stretch (fetched at -14 min), byte-for-byte at the board\'s URL',
      img.status === 200 && sha1(buf) === sha1(expected.buf), `picked frame #${FRAMES.findIndex((f) => sha1(f) === sha1(buf))}, expected #${FRAMES.indexOf(expected.buf)}`);
  }

  // the sweep (first at +6s)
  const withVod = await until(async () => { const a = await recentFor(A); return a?.vodUrl ? a : null; }, 15000);
  ok('R4 the recording is attached', withVod?.vodUrl === 'https://www.twitch.tv/videos/7001', String(withVod?.vodUrl));
  const cardB = await until(async () => { const a = await recentFor(B); return a?.poster?.kind === 'frame' ? a : null; }, 15000);
  ok('R5 a broadcast with a guest but no preview gets the recording\'s thumbnail', cardB?.poster?.source === 'twitch-vod-thumbnail', JSON.stringify(cardB?.poster || null));
  if (cardB) ok('R5 ...and it is that thumbnail', sha1(Buffer.from(await (await fetch(`${APP}${cardB.poster.url}`)).arrayBuffer())) === sha1(THUMB));
  ok('R6 a broadcast with no guest and no MegaChat: no picture, not on the board', !posterOf(C) && !(await recentFor(C)));
  await until(() => candsOf(C).length === 0 && candsOf(D).length === 0 && !posterOf(E), 15000);
  ok('R7 cleanup: leftover previews of a finished guest-less broadcast are gone', candsOf(C).length === 0, `${candsOf(C).length} left`);
  ok('R7 ...previews of an airing whose room is gone are gone', candsOf(D).length === 0, `${candsOf(D).length} left`);
  ok('R7 ...a poster for an airing the store does not keep is gone', !posterOf(E));
  ok('R7 ...and the previews of the broadcast that just finished are KEPT (a blip may reopen it)', candsOf(A).length === 15, `${candsOf(A).length} kept`);

  // ── live ───────────────────────────────────────────────────────────────────
  liveLogins.add('seedchan');
  liveLogins.add('anonchan');
  const openF = await until(() => raw().find((a) => a.roomId === owned && a.endedAt == null));
  const openG = await until(() => raw().find((a) => a.roomId === anon && a.endedAt == null));
  if (!openF || !openG) throw new Error('live airings did not open');
  await sleep(2500);
  ok('L1 an unchanged preview is kept once, however often it is asked for', candsOf(openF.id).length === 1, `${candsOf(openF.id).length} kept`);
  for (let i = 1; i < 4; i++) { frameIdx = i; await sleep(900); }
  ok('L1 ...and each refresh is kept', candsOf(openF.id).length === 4, `${candsOf(openF.id).length} kept for 4 distinct previews`);
  previewMode = 'black'; await sleep(1500);
  previewMode = 'placeholder'; await sleep(1500);
  ok('L2 a black frame and the offline placeholder are never kept', candsOf(openF.id).length === 4, `${candsOf(openF.id).length} kept`);
  previewMode = 'frames';
  ok('L3 a room nobody signed in to own keeps no previews', candsOf(openG.id).length === 0, `${candsOf(openG.id).length} kept`);
  liveLogins.clear();
  await until(() => raw().find((a) => a.id === openF.id)?.endedAt != null, 8000);
  await sleep(1000);
  ok('R6 ...the same for a live broadcast nobody joined: no picture, not on the board', !posterOf(openF.id) && !(await recentFor(openF.id)));

  const bad = await fetch(`${APP}/api/airings/..%2F..%2Frooms/poster.jpg`);
  const unknown = await fetch(`${APP}/api/airings/${E}/poster.jpg`);
  ok('P7 the poster URL takes known airing ids only (400 malformed, 404 unknown)', bad.status === 400 && unknown.status === 404, `${bad.status}/${unknown.status}`);
} catch (e) {
  fail++;
  console.log(`  FAIL  harness threw: ${e.message}`);
  if (srv) console.log(srv.stderr().slice(-2000));
} finally {
  if (srv) srv.kill();
  try { twitch.close(); } catch { /* closed */ }
  console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
