/**
 * GATE — an offline room plays the replay of its broadcast, on the page.
 *
 * The owner, 2026-09-25, on a room page showing Twitch's "jordandotfun is
 * offline — Watch Latest Stream": "i can't watch the vod in here … is there a
 * way to embed the vod or pull the clip … as fallback? and if vod works have
 * it open to the timestamp say 20 seconds before the megachat".
 *
 *   U1  a kept MegaChat copy is written, read back, and evicted oldest-first
 *       past the budget; the sweep drops copies no broadcast refers to
 *   S1  the sweep gives a broadcast that only had a VOD link its recordings
 *       (with their starts) — what last night's broadcast needs
 *   R1  ?replay= opens that broadcast's recording in a Twitch player on the
 *       page, 20s before its MegaChat (in the recording that covers it)
 *   R2  a button per moment; one in the OTHER recording opens that one
 *   R3  no ?replay= → the room's latest broadcast
 *   R4  the recording gone → the MegaChat's kept clip plays instead
 *   R5  nothing left to play → the broadcast's picture, and why
 *   R6  a LIVE room keeps the live player — no replay
 *   R7  a kept clip is served only for a broadcast that refers to it, with
 *       Range support (the player can seek)
 *   R8  a "Recently aired" card links into its broadcast's replay
 *
 * Fake Twitch; needs ffmpeg locally for the test media.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { assertFreshBuild, startGateServer } from './_gate-helpers.mjs';

const PORT = 3296;
const TWITCH_PORT = 3299;
const APP = `http://localhost:${PORT}`;
const FAKE = `http://localhost:${TWITCH_PORT}`;
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

console.log('\n── an offline room plays the replay of its broadcast ──');
const fresh = assertFreshBuild();
ok('G0. the build under test is newer than the source it renders', fresh.ok, fresh.detail);
if (!fresh.ok) { console.log(`\nRESULT: ${pass} pass, ${fail} fail`); process.exit(1); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-replay-'));
const media = (name, args) => { const f = path.join(TMP, name); execFileSync('ffmpeg', ['-v', 'error', '-y', ...args, f]); return fs.readFileSync(f); };
const CLIP = media('clip.webm', ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-t', '2', '-c:v', 'libvpx', '-b:v', '300k']);
const POSTER = media('poster.jpg', ['-f', 'lavfi', '-i', 'mandelbrot=size=640x360', '-frames:v', '1', '-q:v', '3']);

// ── U1: the clip archive, in process ──────────────────────────────────────
process.env.DATA_DIR = path.join(TMP, 'unit');
process.env.AIRED_CLIPS_MAX_BYTES = String(CLIP.length * 2 + 10);
const clips = await import('./aired-clips.js');
{
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
  clips.archiveAiredClip({ id: a, roomId: 'r', mime: 'video/webm', at: Date.now() - 3000, keepDays: 30 }, CLIP, { log: {} });
  clips.archiveAiredClip({ id: b, roomId: 'r', mime: 'video/webm', at: Date.now() - 2000, keepDays: 30 }, CLIP, { log: {} });
  clips.archiveAiredClip({ id: c, roomId: 'r', mime: 'video/webm', at: Date.now() - 1000, keepDays: 30 }, CLIP, { log: {} });
  const kept = [a, b, c].map((x) => !!clips.readAiredClip(x));
  clips.sweepAiredClips([c], { log: {} });
  ok('U1 a kept clip reads back; past the budget the oldest goes; the sweep drops unreferenced ones',
    JSON.stringify(kept) === JSON.stringify([false, true, true]) && !clips.readAiredClip(b) && !!clips.readAiredClip(c),
    `after archive ${JSON.stringify(kept)}, after sweep ${JSON.stringify([b, c].map((x) => !!clips.readAiredClip(x)))}`);
}

// ── the broadcasts, seeded ────────────────────────────────────────────────
const now = Date.now();
const rec1 = { vodId: '8801', start: now - 180 * M, durS: 60 * 60 };
const rec2 = { vodId: '8802', start: now - 118 * M, durS: 100 * 60 };
const A1 = randomUUID(); // recordings on Twitch; seeded with only the old vodUrl
const A2 = randomUUID(); // its recording deleted, its MegaChat clip kept
const A3 = randomUUID(); // recording deleted, no clip: only the picture
const L1 = randomUUID();
const L2 = randomUUID();
const mom = (kind, label, at, start, ref) => ({ at, kind, label, offsetMs: at - start, ...(ref ? { ref } : {}) });
const a1Start = now - 179 * M;
const moments1 = [
  mom('seat', 'amy', now - 170 * M, a1Start),            // in recording 1
  mom('megachat', 'viv', now - 60 * M, a1Start, L1),     // in recording 2
  mom('seat', 'bo', now - 50 * M, a1Start),              // in recording 2
];
const airings = [
  { id: A1, roomId: 'default', platform: 'twitch', channel: 'seedchan', startedAt: a1Start, endedAt: now - 20 * M,
    vodId: '8802', vodUrl: 'https://www.twitch.tv/videos/8802', captureRef: null, moments: moments1 },
  { id: A2, roomId: 'default', platform: 'twitch', channel: 'seedchan', startedAt: now - 3000 * M, endedAt: now - 2940 * M,
    vodId: '7701', vodUrl: 'https://www.twitch.tv/videos/7701', captureRef: null,
    recordings: [{ vodId: '7701', url: 'https://www.twitch.tv/videos/7701', startMs: now - 3001 * M, durationS: 3600 }],
    moments: [mom('seat', 'cy', now - 2990 * M, now - 3000 * M), mom('megachat', 'zed', now - 2980 * M, now - 3000 * M, L2)] },
  { id: A3, roomId: 'default', platform: 'twitch', channel: 'seedchan', startedAt: now - 5000 * M, endedAt: now - 4940 * M,
    vodId: '6601', vodUrl: 'https://www.twitch.tv/videos/6601', captureRef: null,
    recordings: [{ vodId: '6601', url: 'https://www.twitch.tv/videos/6601', startMs: now - 5001 * M, durationS: 3600 }],
    moments: [mom('seat', 'dee', now - 4990 * M, now - 5000 * M)] },
];

// ── fake Twitch ───────────────────────────────────────────────────────────
const liveLogins = new Set();
let vodIdCalls = 0;
const EXISTING = new Map([[rec1.vodId, rec1], [rec2.vodId, rec2]]);
const vodRow = (r) => ({ id: r.vodId, url: `https://www.twitch.tv/videos/${r.vodId}`, created_at: new Date(r.start).toISOString(), duration: `${Math.floor(r.durS / 3600)}h${Math.floor((r.durS % 3600) / 60)}m0s`, thumbnail_url: '' });
const twitch = http.createServer((req, res) => {
  const url = new URL(req.url, FAKE);
  const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/oauth2/token') return json({ access_token: 'fake', expires_in: 3600 });
  if (url.pathname === '/helix/streams') return json({ data: url.searchParams.getAll('user_login').filter((l) => liveLogins.has(l)).map((l) => ({ user_login: l, viewer_count: 5 })) });
  if (url.pathname === '/helix/users') return json({ data: [{ id: `u-${url.searchParams.get('login')}`, login: url.searchParams.get('login') }] });
  if (url.pathname === '/helix/videos') {
    const ids = url.searchParams.getAll('id');
    if (ids.length) {
      vodIdCalls++;
      const found = ids.filter((id) => EXISTING.has(id)).map((id) => vodRow(EXISTING.get(id)));
      return found.length ? json({ data: found }) : json({ error: 'Not Found' }, 404);
    }
    return json({ data: [rec2, rec1].map(vodRow) });
  }
  if (url.pathname.startsWith('/previews-ttv/')) {
    const live = [...liveLogins].some((l) => url.pathname.includes(`live_user_${l}-`));
    if (live) { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(POSTER); }
    res.writeHead(302, { Location: `${FAKE}/ttv-static/404_preview-640x360.jpg` }); return res.end();
  }
  res.writeHead(404).end('{}');
});
await new Promise((r) => twitch.listen(TWITCH_PORT, r));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gate-'));
fs.writeFileSync(path.join(dataDir, 'airings.json'), JSON.stringify({ airings }, null, 2));
fs.mkdirSync(path.join(dataDir, 'aired-clips'), { recursive: true });
for (const id of [L1, L2]) {
  fs.writeFileSync(path.join(dataDir, 'aired-clips', `${id}.clip`), CLIP);
  fs.writeFileSync(path.join(dataDir, 'aired-clips', `${id}.json`), JSON.stringify({ id, roomId: 'default', mime: 'video/webm', at: now, bytes: CLIP.length }));
}
fs.mkdirSync(path.join(dataDir, 'airing-posters'), { recursive: true });
for (const id of [A1, A2, A3]) {
  fs.writeFileSync(path.join(dataDir, 'airing-posters', `${id}.jpg`), POSTER);
  fs.writeFileSync(path.join(dataDir, 'airing-posters', `${id}.json`), JSON.stringify({ kind: 'frame', source: 'twitch-preview', at: now }));
}

const srv = await startGateServer({
  port: PORT, label: 'replay', dataDir,
  bountyAuth: { handles: ['livechan', 'clipchan'] },
  env: {
    TWITCH_CLIENT_ID: 'gate-client', TWITCH_CLIENT_SECRET: 'gate-secret',
    TWITCH_ID_BASE: FAKE, TWITCH_API_BASE: FAKE, TWITCH_PREVIEW_BASE: FAKE,
    FOLLOW_POLL_MS: '500', POSTER_SWEEP_MS: '1500', POSTER_VOD_WAIT_MS: '0', KEEP_ORPHAN_ROOMS: 'true',
  },
});
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const state = (page) => page.evaluate(() => {
  const mount = document.getElementById('streamPreviewMount');
  const iframe = mount?.querySelector('iframe');
  const video = mount?.querySelector('video');
  const img = mount?.querySelector('img');
  return {
    shown: document.getElementById('streamPreview')?.style.display !== 'none',
    iframe: iframe ? iframe.src : null,
    video: video ? { src: video.querySelector('source')?.getAttribute('src') || video.getAttribute('src'), ready: video.readyState, dur: video.duration } : null,
    img: img ? { src: img.getAttribute('src'), ok: img.complete && img.naturalWidth > 0 } : null,
    label: document.getElementById('streamPreviewLabel')?.textContent || '',
    buttons: [...document.querySelectorAll('#streamReplayMoments button')].map((b) => b.textContent),
    moments: !document.getElementById('streamReplayMoments')?.hidden,
  };
});
const openRoom = async (q) => {
  const page = await browser.newPage();
  await page.goto(`${APP}/join?room=${q}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await until(async () => { const s = await state(page); return s.iframe || s.video || s.img; }, 12000);
  return page;
};

try {
  // ── S1: the sweep backfills recordings ──────────────────────────────────
  const recs = await until(() => {
    const a = JSON.parse(fs.readFileSync(path.join(dataDir, 'airings.json'), 'utf8')).airings.find((x) => x.id === A1);
    return Array.isArray(a?.recordings) && a.recordings.length === 2 ? a.recordings : null;
  }, 20000, 500);
  ok('S1 the sweep gives a broadcast that only had a VOD link both of its recordings, with their starts',
    !!recs && recs[0].vodId === rec1.vodId && recs[0].startMs === rec1.start && recs[1].vodId === rec2.vodId, JSON.stringify(recs));

  // ── R1/R2: the replay on the page ───────────────────────────────────────
  let page = await openRoom(`default&replay=${A1}`);
  let s = await state(page);
  const want1 = `video=v${rec2.vodId}`;
  const t1 = twitchTime(offsetFor(moments1[1].at, rec2.start));
  ok('R1 ?replay= plays the broadcast\'s recording ON the page, 20s before its MegaChat',
    !!s.iframe && s.iframe.startsWith('https://player.twitch.tv/?') && s.iframe.includes(want1) && s.iframe.includes(`time=${t1}`) && s.iframe.includes('parent=localhost'),
    `${s.iframe} (want ${want1}, time=${t1})`);
  ok('R1 ...and says what it is', /Replay/.test(s.label) && /20s before MegaChat · viv/.test(s.label), s.label);
  ok('R2 a button for every moment', s.moments && s.buttons.length === 3, JSON.stringify(s.buttons));
  await page.evaluate(() => [...document.querySelectorAll('#streamReplayMoments button')].find((b) => /amy/.test(b.textContent)).click());
  s = await state(page);
  const t2 = twitchTime(offsetFor(moments1[0].at, rec1.start));
  ok('R2 a moment in the OTHER recording opens that recording at its own time',
    !!s.iframe && s.iframe.includes(`video=v${rec1.vodId}`) && s.iframe.includes(`time=${t2}`), `${s.iframe} (want v${rec1.vodId}, ${t2})`);
  await page.close();

  // ── R3: the latest broadcast by default ─────────────────────────────────
  page = await openRoom('default');
  s = await state(page);
  ok('R3 no ?replay= → the room\'s latest broadcast', !!s.iframe && s.iframe.includes(want1), s.iframe);
  await page.close();

  // ── R4: the recording is gone → the kept clip ───────────────────────────
  page = await openRoom(`default&replay=${A2}`);
  await until(async () => (await state(page)).video?.ready >= 1, 8000);
  s = await state(page);
  ok('R4 the recording gone → the MegaChat\'s kept clip plays in its place',
    !!s.video && s.video.src === `/api/aired-clips/${L2}` && s.video.ready >= 1 && s.video.dur > 0 && !s.iframe, JSON.stringify(s.video));
  ok('R4 ...and says the recording is gone', /recording is gone/.test(s.label), s.label);
  await page.close();

  // ── R5: nothing left but the picture ────────────────────────────────────
  page = await openRoom(`default&replay=${A3}`);
  s = await state(page);
  ok('R5 nothing left to play → the broadcast\'s picture, and why', !!s.img && s.img.ok && /no longer available/.test(s.label), JSON.stringify({ img: s.img, label: s.label }));
  await page.close();

  // ── R6: a live room keeps the live player ───────────────────────────────
  const created = await fetch(`${APP}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...srv.headers('livechan') },
    body: JSON.stringify({ name: 'Live Room', password: 'gate-pass-1234', config: { twitchChannel: 'livechan', twitchAuto: true, unlisted: false } }),
  }).then((r) => r.json());
  const liveId = created.roomId || created.room?.id;
  liveLogins.add('livechan');
  await sleep(2500);
  page = await openRoom(liveId);
  s = await state(page);
  ok('R6 a LIVE room keeps the live player — no replay', !!s.iframe && s.iframe.includes('channel=livechan') && !s.moments, s.iframe);
  await page.close();

  // ── R7: the clip route ──────────────────────────────────────────────────
  const whole = await fetch(`${APP}/api/aired-clips/${L1}`);
  const ranged = await fetch(`${APP}/api/aired-clips/${L1}`, { headers: { Range: 'bytes=0-99' } });
  const stranger = await fetch(`${APP}/api/aired-clips/${randomUUID()}`);
  ok('R7 a kept clip is served for the broadcast that refers to it, seekable (206 on a Range)',
    whole.status === 200 && /video\/webm/.test(whole.headers.get('content-type') || '') && ranged.status === 206, `${whole.status} ${whole.headers.get('content-type')} / range ${ranged.status}`);
  ok('R7 ...and nothing else (an id no broadcast refers to is 404)', stranger.status === 404, String(stranger.status));

  // ── E: end to end — real MegaChats air on live broadcasts ─────────────────
  // Recorded through the join page and played by the overlay. A room whose
  // owner proved the channel keeps a copy for the replay; an anonymous room
  // naming a channel keeps none.
  const airOneMegaChat = async (roomId, password, fanName) => {
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
    await fan.goto(`${APP}/join?room=${roomId}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(1500);
    await fan.evaluate(() => { const el = document.getElementById('username'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await fan.type('#username', fanName);
    await fan.evaluate(() => document.getElementById('letterBtn').click());
    await sleep(1200);
    await fan.evaluate(() => document.getElementById('letterRecordBtn').click());
    await sleep(2500);
    await fan.evaluate(() => document.getElementById('letterRecordBtn').click());
    await sleep(1500);
    await fan.evaluate(() => document.getElementById('letterSendBtn').click());
    const letters = async () => (await fetch(`${APP}/api/dashboard/rooms/${roomId}/letters`, { headers: { 'X-Room-Password': password } }).then((r) => r.json())).letters || [];
    const queued = await until(async () => (await letters()).find((l) => l.status === 'queued'), 30000, 1000);
    const overlay = await browser.newPage();
    await overlay.goto(`${APP}/overlay?room=${roomId}`, { waitUntil: 'networkidle2', timeout: 60000 });
    // Played to the end: the letter leaves the queue (status done, then removed).
    await until(async () => !(await letters()).some((l) => l.id === queued?.id && l.status !== 'done'), 25000, 1000);
    await sleep(1500);
    await overlay.close();
    await fan.close();
    return queued?.id;
  };
  const room = async (name, channel, password, owner) => {
    const made = await fetch(`${APP}/api/dashboard/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(owner ? srv.headers(owner) : {}) },
      body: JSON.stringify({ name, password, config: { passkeyTickPrice: '0', twitchChannel: channel, twitchAuto: true, unlisted: false } }),
    }).then((r) => r.json());
    const id = made.roomId || made.room?.id;
    liveLogins.add(channel);
    await until(() => JSON.parse(fs.readFileSync(path.join(dataDir, 'airings.json'), 'utf8')).airings.find((a) => a.roomId === id && a.endedAt == null), 10000);
    return id;
  };
  {
    const clipRoom = await room('Clip Room', 'clipchan', 'clip-pass-1234', 'clipchan');
    const letterId = await airOneMegaChat(clipRoom, 'clip-pass-1234', 'replay-fan');
    const kept = await until(() => letterId && fs.existsSync(path.join(dataDir, 'aired-clips', `${letterId}.clip`)), 10000, 500);
    const moment = JSON.parse(fs.readFileSync(path.join(dataDir, 'airings.json'), 'utf8')).airings
      .find((a) => a.roomId === clipRoom)?.moments.find((m) => m.kind === 'megachat');
    ok('E1 a MegaChat that COMPLETED on a proven broadcast is kept, and its moment names it', !!kept && moment?.ref === letterId,
      JSON.stringify({ letterId, kept: !!kept, ref: moment?.ref }));

    const anonRoom = await room('Anon Clip Room', 'anonclipchan', 'anon-pass-1234', null);
    const anonLetter = await airOneMegaChat(anonRoom, 'anon-pass-1234', 'anon-fan');
    const anonMoment = JSON.parse(fs.readFileSync(path.join(dataDir, 'airings.json'), 'utf8')).airings
      .find((a) => a.roomId === anonRoom)?.moments.find((m) => m.kind === 'megachat');
    ok('E3 an anonymous room naming a channel keeps NO copy (its moment is recorded, the clip is not)',
      !!anonLetter && anonMoment?.ref === anonLetter && !fs.existsSync(path.join(dataDir, 'aired-clips', `${anonLetter}.clip`)),
      JSON.stringify({ anonLetter, ref: anonMoment?.ref }));
    liveLogins.delete('anonclipchan');

    liveLogins.delete('clipchan');
    const replay = await until(async () => {
      const j = await fetch(`${APP}/api/rooms/${clipRoom}/replay`).then((r) => r.json());
      return !j.live && j.moments?.length ? j : null;
    }, 15000, 1000);
    const m0 = replay?.moments?.[replay.start];
    ok('E2 once the stream ends, its replay opens at that MegaChat — the kept clip, since no recording exists',
      !!m0 && m0.kind === 'megachat' && m0.label === 'replay-fan' && m0.clip?.url === `/api/aired-clips/${letterId}` && !m0.vod,
      JSON.stringify(m0));
    const got = await fetch(`${APP}${m0?.clip?.url || '/nope'}`);
    ok('E2 ...and the clip is served', got.status === 200 && Number(got.headers.get('content-length') || 0) > 1024, `${got.status} ${got.headers.get('content-length')}`);
    ok('X1 ...as exactly video/webm, never sniffed (a sender cannot make it a web page)',
      got.headers.get('content-type') === 'video/webm' && got.headers.get('x-content-type-options') === 'nosniff',
      `${got.headers.get('content-type')} / ${got.headers.get('x-content-type-options')}`);

    // The owner removes it; a stranger cannot.
    const anon = await fetch(`${APP}/api/dashboard/rooms/${clipRoom}/aired-clips/${letterId}`, { method: 'DELETE' });
    const wrongRoom = await fetch(`${APP}/api/dashboard/rooms/${anonRoom}/aired-clips/${letterId}`, { method: 'DELETE', headers: { 'X-Room-Password': 'anon-pass-1234' } });
    const owner = await fetch(`${APP}/api/dashboard/rooms/${clipRoom}/aired-clips/${letterId}`, { method: 'DELETE', headers: { 'X-Room-Password': 'clip-pass-1234' } });
    const after = await fetch(`${APP}/api/aired-clips/${letterId}`);
    ok('X2 the room\'s owner removes a kept clip; no password, or another room, cannot',
      anon.status === 401 && wrongRoom.status === 404 && owner.status === 200 && after.status === 404,
      `${anon.status}/${wrongRoom.status}/${owner.status} → ${after.status}`);
  }

  // A room whose HANDLE spells another room's id must not answer for it.
  {
    const hijack = await fetch(`${APP}/api/dashboard/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hijacker', password: 'hijack-pass-1234', handle: liveId, config: { unlisted: false } }),
    });
    const j = await fetch(`${APP}/api/rooms/${liveId}/replay`).then((r) => r.json());
    ok('X3 a room claiming another room\'s id as its handle cannot answer for it (the live room stays live)',
      j.live === true, `create ${hijack.status}; replay live=${j.live}`);
    const before = vodIdCalls;
    for (let i = 0; i < 5; i++) await fetch(`${APP}/api/rooms/${liveId}/replay`);
    ok('X4 a live room\'s answer costs no Twitch recording lookup', vodIdCalls === before, `${vodIdCalls - before} /videos?id= call(s)`);
  }

  // ── R8: the card links into the replay ──────────────────────────────────
  page = await browser.newPage();
  await page.goto(`${APP}/app`, { waitUntil: 'networkidle2', timeout: 60000 });
  const hrefs = await page.evaluate(() => [...document.querySelectorAll('a.mcr-recent')].map((a) => a.getAttribute('href')));
  ok('R8 a "Recently aired" card links into ITS broadcast\'s replay', hrefs.some((h) => h && h.includes(`replay=${A1}`)), JSON.stringify(hrefs));
  await page.close();
} catch (e) {
  fail++;
  console.log(`  FAIL  harness threw: ${e.message}`);
  console.log(srv.stderr().slice(-1500));
} finally {
  await browser.close().catch(() => {});
  srv.kill();
  twitch.close();
  console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
