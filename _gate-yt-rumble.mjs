/**
 * GATE — YouTube + Rumble external capture, against LOCAL STUBS only.
 *
 * Three layers:
 *   A. the API modules parse what the stubs serve — and the stubs encode our
 *      WIRE ASSUMPTIONS, so a wrong assumption fails here loudly instead of
 *      silently in production (the Rumble shape especially: designed from
 *      docs, not yet seen on a real wire, and the module header says so)
 *   B. the frame sources select the RIGHT URL and the RIGHT offset — proven
 *      by decoding the frame ffmpeg actually extracted from a local fixture,
 *      not by observing that a function was called
 *   C. the HTTP routes: an air session opened with a watch URL stores it, a
 *      playback observation lands a VIEWER_SAMPLE evidence row with the
 *      stub's viewer count, and broadcastStartedAt is platform truth
 *
 * Zero external network: both platform APIs are localhost stubs, the media
 * is an ffmpeg-generated local file, and no real credentials exist here.
 */
import http from 'http';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { startGateServer } from './_gate-helpers.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORK = mkdtempSync(path.join(tmpdir(), 'mc-ytr-'));
const STUB = 3396;
const APP_PORT = 3397;

// ── the platform stubs ─────────────────────────────────────────────────────
const state = {
  ytLive: true, ytViewers: 41,
  ytStart: new Date(Date.now() - 32 * 60_000).toISOString(),
  rumbleLive: true, rumbleViewers: 9,
  rumbleStart: new Date(Date.now() - 21 * 60_000).toISOString(),
  ytCalls: 0, rumbleCalls: 0, lastYtQuery: null,
};
const stub = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${STUB}`);
  if (url.pathname === '/yt/videos') {
    state.ytCalls += 1;
    state.lastYtQuery = { id: url.searchParams.get('id'), part: url.searchParams.get('part') };
    res.setHeader('Content-Type', 'application/json');
    // The exact Data API v3 shape videos.list returns for a live video.
    return res.end(JSON.stringify({
      items: [{
        id: url.searchParams.get('id'),
        snippet: { title: 'gate stream', liveBroadcastContent: state.ytLive ? 'live' : 'none' },
        liveStreamingDetails: {
          actualStartTime: state.ytStart,
          ...(state.ytLive
            ? { concurrentViewers: String(state.ytViewers) }
            : { actualEndTime: new Date().toISOString() }),
        },
      }],
    }));
  }
  if (url.pathname === '/rumble/ls') {
    state.rumbleCalls += 1;
    if (url.searchParams.get('key') !== 'gate-creator-key') { res.statusCode = 403; return res.end('{}'); }
    res.setHeader('Content-Type', 'application/json');
    // THE REAL WIRE SHAPE, captured from a live creator URL on 2026-08-26 —
    // no longer docs-derived. The identity envelope and, critically, the
    // INGEST CREDENTIALS every livestream entry carries: server_url and
    // stream_key in plaintext. The stub serves them precisely so the
    // no-leak assertion below is testing against reality.
    const entry = (over) => ({
      id: 'r1', title: 'gate rumble', created_on: state.rumbleStart,
      is_live: true, scheduled_on: null, visibility: 'public',
      categories: { primary: null, secondary: null },
      server_url: 'rtmp://ls18.live.rmbl.ws/slot-23',
      stream_key: 'GATEKEYDONOTLEAK',
      likes: 0, dislikes: 0, watching_now: state.rumbleViewers,
      chat: { latest_message: null, recent_messages: [], latest_rant: null, recent_rants: [] },
      ...over,
    });
    return res.end(JSON.stringify({
      now: Math.floor(Date.now() / 1000),
      type: 'user', user_id: '4qdjv0', username: 'gatecreator',
      channel_id: null, channel_name: null, since: null, max_num_results: 50,
      followers: { num_followers: 0, num_followers_total: 0, latest_follower: null, recent_followers: [] },
      subscribers: { num_subscribers: 0, latest_subscriber: null, recent_subscribers: [] },
      gifted_subs: { num_gifted_subs: 0, latest_gifted_sub: null, recent_gifted_subs: [] },
      livestreams: state.rumbleLive
        ? [entry({})]
        : [entry({ id: 'r0', title: 'old one', is_live: false, watching_now: 0 })],
    }));
  }
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => stub.listen(STUB, r));

process.env.YOUTUBE_API_KEY = 'gate-yt-key';
process.env.YOUTUBE_API_BASE = `http://localhost:${STUB}/yt`;
process.env.RUMBLE_LIVESTREAM_API_URL = `http://localhost:${STUB}/rumble/ls?key=gate-creator-key`;

const { youtubeApiConfigured, getVideoLiveDetails, extractVideoId } = await import('./youtube-api.js');
const { rumbleApiConfigured, getRumbleLiveStatus } = await import('./rumble-api.js');
const { bountyConfig } = await import('./bounty-claim.config.js');

// ── A1. video-id extraction: every shape a streamer will actually paste ───
{
  const cases = [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtube.com/live/dQw4w9WgXcQ?feature=share', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=4s', 'dQw4w9WgXcQ'],
    ['dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/@somechannel', null],       // a channel, not a video
    ['https://example.com/watch?v=dQw4w9WgXcQ', null],    // not youtube at all
    ['', null],
  ];
  let all = true;
  for (const [input, want] of cases) {
    const got = extractVideoId(input);
    if (got !== want) { all = false; console.error(`    ${input || '(empty)'} → ${got}, wanted ${want}`); }
  }
  ok('A1. extractVideoId handles every real paste shape and refuses to guess', all,
    `${cases.length} shapes incl. channel URL and non-youtube host`);
}

// ── A2. the YouTube module reads what the wire says ───────────────────────
{
  const live = await getVideoLiveDetails('dQw4w9WgXcQ');
  ok('A2. a live video reads live with the stub\'s viewers and start',
    live?.live === true && live.viewerCount === 41 && Date.parse(live.startedAt) > 0,
    JSON.stringify(live));
  ok('A2. ...via videos.list on the KNOWN id — the 1-unit call, never a search',
    state.lastYtQuery?.id === 'dQw4w9WgXcQ' && /liveStreamingDetails/.test(state.lastYtQuery?.part || ''),
    JSON.stringify(state.lastYtQuery));
  state.ytLive = false;
  const ended = await getVideoLiveDetails('dQw4w9WgXcQ');
  ok('A2. an ended broadcast reads live:false WITH the archive start intact',
    ended?.live === false && Date.parse(ended.startedAt) > 0 && !!ended.endedAt,
    JSON.stringify(ended));
  state.ytLive = true;

  const saveKey = process.env.YOUTUBE_API_KEY;
  delete process.env.YOUTUBE_API_KEY;
  ok('A2. unconfigured is null (could-not-ask), never a fake zero',
    youtubeApiConfigured() === false && (await getVideoLiveDetails('dQw4w9WgXcQ')) === null);
  process.env.YOUTUBE_API_KEY = saveKey;
}

// ── A3. the Rumble module: URL-as-credential, tolerant parse ──────────────
{
  ok('A3. configured by possessing the creator URL', rumbleApiConfigured() === true);
  const live = await getRumbleLiveStatus();
  ok('A3. a live creator reads live with viewers and start',
    live?.live === true && live.viewerCount === 9 && Date.parse(live.startedAt) > 0,
    JSON.stringify(live));
  state.rumbleLive = false;
  const off = await getRumbleLiveStatus();
  ok('A3. no stream live is a REAL answer (live:false), distinct from null',
    off?.live === false && off.viewerCount === 0, JSON.stringify(off));
  state.rumbleLive = true;
  const wrongKey = await getRumbleLiveStatus({ apiUrl: `http://localhost:${STUB}/rumble/ls?key=WRONG` });
  ok('A3. a revoked/wrong URL is null (could-not-ask) — regeneration is revocation',
    wrongKey === null);
  const unreachable = await getRumbleLiveStatus({ apiUrl: 'http://localhost:1/nope' });
  ok('A3. unreachable is null, never a fake "nobody watching"', unreachable === null);

  // ── A4. THE CREDENTIAL BOUNDARY ────────────────────────────────────────
  // MEASURED, not supposed: a real Rumble live-status response carries
  // server_url + stream_key for every livestream, so the creator's API URL
  // confers the power to BROADCAST AS that channel. Our parser must copy out
  // four scalars and let the rest die. Asserted on the serialized result so a
  // future 'return { ...liveNow, live: true }' — the tidy-looking refactor
  // that would publish a broadcast credential — fails here.
  state.rumbleLive = true;
  const live2 = await getRumbleLiveStatus();
  const serialized = JSON.stringify(live2);
  ok('A4. the parsed result carries NO ingest credential',
    !/GATEKEYDONOTLEAK/.test(serialized) && !/rmbl\.ws/.test(serialized)
    && !/stream_key/.test(serialized) && !/server_url/.test(serialized),
    serialized);
  ok('A4. ...and is EXACTLY the four safe fields, nothing spread in',
    JSON.stringify(Object.keys(live2).sort())
    === JSON.stringify(['live', 'startedAt', 'title', 'viewerCount']),
    Object.keys(live2).sort().join(','));
}

// ── B. frame sources: right URL, right offset, proven by the pixel ────────
// A 30s local fixture whose every frame encodes its own timestamp as its
// LUMINANCE (lum = 8×seconds) — the extracted frame proves the seek landed
// where the math said, not merely that ffmpeg ran. (drawbox cannot see the
// clock — its expressions have no T — which this gate's first cut discovered
// by measuring a full-width bar at every offset.)
const ff = (args, what) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${what}: ${r.stderr?.slice(0, 300)}`);
};
const fixture = path.join(WORK, 'archive.mp4');
ff(['-f', 'lavfi', '-i', 'color=c=black:s=320x120:r=5:d=30',
  '-vf', "geq=lum='8*floor(T)':cb=128:cr=128",
  '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', fixture], 'fixture');
/** Seconds encoded in a frame: mean luminance / 8, read off the raw pixels. */
const secondsAt = (png) => {
  const raw = path.join(WORK, `px-${Math.random().toString(36).slice(2, 8)}.gray`);
  ff(['-i', png, '-vf', 'crop=64:64:128:28,format=gray', '-f', 'rawvideo', raw], 'px');
  const bytes = readFileSync(raw);
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum += bytes[i];
  return (sum / bytes.length) / 8;
};

{
  const { YouTubeFrameSource, RumbleFrameSource } = await import('./frame-sources.js');
  const resolved = [];
  const resolver = (url) => { resolved.push(url); return fixture; };

  // YouTube VOD: offset comes from the Data API's actualStartTime — the
  // stub says the broadcast started 32 minutes ago; ask for a frame at
  // start+20s and the bar must measure ~20s.
  const startMs = Date.parse(state.ytStart);
  const yt = new YouTubeFrameSource({
    mode: 'vod', watchUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    resolver, log: { warn() {} },
  });
  const frames = await yt.getFrames('youtube', 'ignored', [{ ts: startMs + 20_000 }], { skewMs: 0 });
  ok('B1. youtube vod resolves the WATCH URL the streamer handed over',
    resolved[0] === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', resolved[0]);
  ok('B1. ...and pulled the broadcast start from the Data API on its own',
    Math.abs(yt.vodStartMs - startMs) < 1500, `vodStartMs=${yt.vodStartMs}`);
  const sec = secondsAt(frames[0].ref);
  ok('B1. ...and the extracted frame IS the one at start+20s',
    Math.abs(sec - 20) <= 1.5, `frame encodes ${sec.toFixed(1)}s, wanted 20s`);
  ok('B1. ...marked non-live so the verifier treats timestamps normally',
    frames[0].live === false);

  // YouTube live: playlist head, offset 0, marked live.
  const yl = new YouTubeFrameSource({
    mode: 'live', watchUrl: 'https://youtu.be/dQw4w9WgXcQ', resolver, log: { warn() {} },
  });
  const lf = await yl.getFrames('youtube', 'ignored', [{ ts: Date.now() }]);
  ok('B2. youtube live grabs the playlist head and marks the frame live',
    lf[0].live === true && secondsAt(lf[0].ref) <= 2, `head frame at ${secondsAt(lf[0].ref).toFixed(1)}s`);

  // Missing watch URL: typed refusal, not a guess at a channel URL.
  let threw = null;
  try { await new YouTubeFrameSource({ mode: 'live' }).getFrames('youtube', 'x', [{ ts: 1 }]); }
  catch (e) { threw = e; }
  ok('B3. no watch URL is a TYPED refusal, never a guessed channel URL',
    threw?.state === 'NO_VOD_COVERING_TS', `${threw?.state}: ${threw?.detail || threw?.message}`);

  // Rumble live + the vod escape hatch.
  resolved.length = 0;
  const rl = new RumbleFrameSource({
    mode: 'live', watchUrl: 'https://rumble.com/v-gate-live.html', resolver, log: { warn() {} },
  });
  const rf = await rl.getFrames('rumble', 'ignored', [{ ts: Date.now() }]);
  ok('B4. rumble live resolves the stream page URL and marks the frame live',
    resolved[0] === 'https://rumble.com/v-gate-live.html' && rf[0].live === true, resolved[0]);
  const rv = new RumbleFrameSource({
    mode: 'vod', vodUrl: 'https://rumble.com/v-gate-vod.html',
    vodStartMs: Date.now() - 60_000, resolver, log: { warn() {} },
  });
  // A MEASURED SKEW MUST REACH THE SEEK. This asserted a raw
  // (ts - vodStartMs) subtraction, which passed only because the source's
  // getFrames had no `opts` parameter at all: RumbleFrameSource declares
  // itself `calibratable`, so calibration spent frame grabs measuring a skew
  // for it and then handed the result to a signature that could not accept
  // it. The measurement was computed and dropped on the floor.
  const rvf = await rv.getFrames('rumble', 'ignored',
    [{ ts: rv.vodStartMs + 12_000 }], { skewMs: 0 });
  const rsec = secondsAt(rvf[0].ref);
  ok('B4. rumble vod honours a MEASURED skew of 0 — seeks by the supplied start',
    Math.abs(rsec - 12) <= 1.5, `frame encodes ${rsec.toFixed(1)}s, wanted 12s`);
  const rvf2 = await rv.getFrames('rumble', 'ignored',
    [{ ts: rv.vodStartMs + 12_000 }], { skewMs: 5_000 });
  ok('B4. ...and a non-zero measured skew actually moves the seek',
    Math.abs(secondsAt(rvf2[0].ref) - 17) <= 1.5,
    `frame encodes ${secondsAt(rvf2[0].ref).toFixed(1)}s, wanted 17s`);
  // With no measurement supplied it falls back to the documented constant,
  // exactly as Twitch does. NOTE the constant is derived from TWITCH VODs and
  // has never been checked against a real Rumble one — which is precisely why
  // the calibrated value has to be able to override it.
  const rvf3 = await rv.getFrames('rumble', 'ignored', [{ ts: rv.vodStartMs + 12_000 }]);
  // Asserted as "clearly past the unskewed position" rather than pinned to
  // 12 + 16 = 28s, because this fixture is only ~30s long: a 28s seek lands in
  // its tail and the encoded clock saturates around 30.3s. Pinning the exact
  // value here would be measuring the fixture's length, not the fallback.
  const rsec3 = secondsAt(rvf3[0].ref);
  ok('B4. ...and with no measurement it falls back to the documented constant',
    rsec3 >= 12 + bountyConfig.vodTimelineSkewMs / 1000 - 2.5,
    `frame encodes ${rsec3.toFixed(1)}s, constant ${bountyConfig.vodTimelineSkewMs / 1000}s `
    + '(fixture saturates near its ~30s end)');
  let rThrew = null;
  try { await new RumbleFrameSource({ mode: 'vod' }).getFrames('rumble', 'x', [{ ts: 1 }]); }
  catch (e) { rThrew = e; }
  ok('B4. rumble vod without discovery data refuses, typed',
    rThrew?.state === 'NO_VOD_COVERING_TS');

  const { platformProfile } = await import('./bounty-claim.config.js');
  ok('B5. both platforms have verifier profiles (density lookup cannot degrade silently)',
    platformProfile('youtube')?.vodRetry === true
    && platformProfile('rumble')?.vodRetry === false
    && platformProfile('rumble')?.samplingMultiplier === 2
    && /replay/.test(platformProfile('youtube')?.notice || ''),
    'youtube vodRetry, rumble live-first ×2');
}

// ── C. the HTTP routes: session carries the URL, observation lands ────────
const srv = await startGateServer({
  port: APP_PORT, label: 'yt-rumble',
  bountyAuth: { handles: ['youtube:ytstar', 'rumble:rumstar'] },
  env: {
    BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true', MODERATION_API_KEY: '',
    TWITCH_CLIENT_ID: '', TWITCH_CLIENT_SECRET: '', KICK_CLIENT_ID: '', KICK_CLIENT_SECRET: '',
    YOUTUBE_API_KEY: 'gate-yt-key',
    YOUTUBE_API_BASE: `http://localhost:${STUB}/yt`,
    RUMBLE_LIVESTREAM_API_URL: `http://localhost:${STUB}/rumble/ls?key=gate-creator-key`,
    BOUNTY_CODE_ROTATE_MS: '600000', BOUNTY_CODE_VALIDITY_MS: '600000',
    BOUNTY_SELF_CAPTURE: '0', // capture is not what is under test here
  },
});
try {
  const APP = `http://localhost:${APP_PORT}`;
  const post = (p, body, as) => fetch(`${APP}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...srv.headers(as) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const evidenceRows = () => {
    const f = path.join(srv.dataDir, 'bounty-evidence.jsonl');
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8').split(String.fromCharCode(10)).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  };
  const setup = async (platform, handle, watchUrl) => {
    const as = `${platform}:${handle}`;
    const pl = await post('/api/bounty/pledge', {
      targets: [{ platform, handle }], contributor: '0xytr', amount: '20', expiresInMs: 86_400_000,
    });
    if (pl.body.uploadUrl) {
      await fetch(`${APP}${pl.body.uploadUrl}?durationS=8`, {
        method: 'POST', headers: { 'Content-Type': 'video/webm', ...srv.headers() },
        body: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2048, 5)]),
      });
    }
    const claim = await post('/api/bounty/claim', { platform, handle, claimant: handle }, as);
    if (!claim.body.claim) return { air: claim, claim };
    const air = await post('/api/bounty/air-session', {
      claimId: claim.body.claim.id, platform, roomId: `room-${handle}`, watchUrl,
    }, as);
    return { air, claim };
  };

  // C1: YouTube demands the watch URL up front, with a sentence not a shrug.
  const noUrl = await setup('youtube', 'ytstar', undefined);
  ok('C1. a youtube session WITHOUT a watch URL is refused with instructions',
    noUrl.air.status === 400 && /watch URL/i.test(noUrl.air.body.error || ''), noUrl.air.body.error);

  const second = await setup('youtube', 'ytstar', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  // FOUND BY THIS GATE'S FIRST RUN: the failed session-open above had left
  // the handle in AWAITING_AIRTIME, and re-claiming 409'd with escrow jargon
  // — an honest VERIFIED streamer walled out of their own claim by one bad
  // watch URL. The route now hands the verified owner their existing claim.
  ok('C1. a verified owner RE-ENTERS their claim after a failed session open',
    second.claim.status === 200 && second.claim.body.reclaimed === true,
    `reclaimed=${second.claim.body.reclaimed}`);
  const yt = second.air;
  ok('C1. ...and WITH a watch URL the session opens and stores it',
    yt.status === 200 && yt.body.airSession?.watchUrl === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    yt.body.airSession?.watchUrl);

  const before = state.ytCalls;
  await post('/api/bounty/admin/playback', { airSessionId: yt.body.airSession.id, clipId: 'YT1', durationS: 600 });
  for (let i = 0; i < 40 && state.ytCalls === before; i++) await sleep(50);
  await sleep(250);
  ok('C1. a playback observation asks the Data API about THAT video',
    state.ytCalls > before && state.lastYtQuery?.id === 'dQw4w9WgXcQ',
    `${state.ytCalls - before} call(s), id=${state.lastYtQuery?.id}`);
  const ytSample = evidenceRows().find((r) => r.type === 'VIEWER_SAMPLE' && r.airSessionId === yt.body.airSession.id);
  ok('C1. ...and the VIEWER_SAMPLE evidence row carries the stub\'s count',
    ytSample?.viewerCount === 41 && ytSample.live === true, JSON.stringify(ytSample || null));
  const ytSess = (await post('/api/bounty/admin/playback/end', { airSessionId: yt.body.airSession.id, clipId: 'YT1' }),
    await fetch(`${APP}/api/bounty/admin/sessions`, { headers: srv.headers() }).then((r) => r.json()))
    .sessions.find((x) => x.id === yt.body.airSession.id);
  ok('C1. broadcastStartedAt is PLATFORM truth (the stub\'s actualStartTime)',
    Math.abs((ytSess?.broadcastStartedAt || 0) - Date.parse(state.ytStart)) < 2000,
    new Date(ytSess?.broadcastStartedAt || 0).toISOString());

  // C2: Rumble — the creator URL is the whole credential.
  const rumS = await setup('rumble', 'rumstar', 'https://rumble.com/v-gate-live.html');
  const rum = rumS.air;
  ok('C2. a rumble session opens (watch URL stored, not required)',
    rum.status === 200 && rum.body.airSession?.watchUrl === 'https://rumble.com/v-gate-live.html');
  const rBefore = state.rumbleCalls;
  await post('/api/bounty/admin/playback', { airSessionId: rum.body.airSession.id, clipId: 'RM1', durationS: 600 });
  for (let i = 0; i < 40 && state.rumbleCalls === rBefore; i++) await sleep(50);
  await sleep(250);
  const rumSample = evidenceRows().find((r) => r.type === 'VIEWER_SAMPLE' && r.airSessionId === rum.body.airSession.id);
  ok('C2. the observation hit the creator URL and landed the viewer count',
    state.rumbleCalls > rBefore && rumSample?.viewerCount === 9,
    `${state.rumbleCalls - rBefore} call(s), sample=${JSON.stringify(rumSample || null)}`);
} finally {
  srv.kill();
  await new Promise((r) => stub.close(r));
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
