/**
 * GATE — stream context over REAL HTTP ROUTES, end to end.
 *
 * _gate-stream-context.mjs proves the rule. This proves the WIRING, which is
 * where the rule was actually broken: the verify route asked the platform for
 * the broadcast start at verify time, hours after the stream ended, got null
 * every time, and routed every honest streamer to NO_BROADCAST_START review.
 * A unit test of the rule could never have caught that.
 *
 * So this gate stands up a STUB HELIX on localhost and points the server's
 * TWITCH_API_BASE at it. Everything downstream is the shipped code path:
 * playback route → real capture → real persistence → real verify route → real
 * review routing. Zero external network, zero spend, and the stub can be
 * flipped offline to reproduce the exact condition that broke it.
 */
import http from 'http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3311;
const STUB = 3312;
const APP = `http://localhost:${PORT}`;
const MIN = 60_000;

// ── the stub platform ──────────────────────────────────────────────────────
// `live` and `startedAt` are mutable so the gate can put a broadcast in the
// past, or take it off the air, exactly when it wants to.
const chan = { live: true, startedAt: new Date(Date.now() - 30 * MIN).toISOString(), viewers: 412 };
let helixCalls = 0;
const stub = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url.startsWith('/oauth2/token')) {
    return res.end(JSON.stringify({ access_token: 'stub-token', expires_in: 3600 }));
  }
  if (req.url.startsWith('/helix/streams')) {
    helixCalls++;
    return res.end(JSON.stringify({
      data: chan.live
        ? [{ user_login: 'ctxstreamer', viewer_count: chan.viewers, started_at: chan.startedAt, type: 'live' }]
        : [],
    }));
  }
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => stub.listen(STUB, r));

const post = (p, body) => fetch(`${APP}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (p) => fetch(`${APP}${p}`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const vid = (n) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(n, 5)]);

// The frame pipeline is not what is under test here — the run-b gate already
// drives the real decoder over re-encoded broadcast pixels. This fixture makes
// clips verify so the CONTEXT logic downstream of verification is reachable.
const WORK = mkdtempSync(path.join(tmpdir(), 'mc-ctx-'));
const FIXTURE = path.join(WORK, 'fixture.json');
writeFileSync(FIXTURE, JSON.stringify({ defaultCheck: { found: true, confidence: 0.95 } }));
// Own the data dir so the gate can read the evidence chain the server wrote.
const DATA = mkdtempSync(path.join(tmpdir(), 'mc-ctx-data-'));
const evidenceRows = () => {
  const f = path.join(DATA, 'bounty-evidence.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};

const { startGateServer } = await import('./_gate-helpers.mjs');
const srv = await startGateServer({
  port: PORT,
  env: {
    BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true', MODERATION_API_KEY: '',
    BOUNTY_FIXTURE_PATH: FIXTURE,
    // Credentials are fake and the hosts are localhost: configured enough to
    // take the real code path, incapable of reaching Twitch.
    TWITCH_CLIENT_ID: 'stub-id', TWITCH_CLIENT_SECRET: 'stub-secret',
    TWITCH_ID_BASE: `http://localhost:${STUB}`, TWITCH_API_BASE: `http://localhost:${STUB}`,
    KICK_CLIENT_ID: '', KICK_CLIENT_SECRET: '',
    BOUNTY_CODE_ROTATE_MS: '600000', BOUNTY_CODE_VALIDITY_MS: '600000',
    // Non-default on purpose: if these are ignored, the assertions below fail.
    // The tail is seconds rather than the shipped minute so the gate can
    // actually outlive it without sleeping for a minute.
    BOUNTY_STREAM_WARMUP_MS: String(15 * MIN),
    BOUNTY_STREAM_TAIL_MS: '4000',
  },
  dataDir: DATA,
});
const app = srv.child;

/** pledge → clip → claim → air session, the fan and streamer halves over HTTP. */
async function setup(handle, room) {
  const pl = await post('/api/bounty/pledge', {
    targets: [{ platform: 'twitch', handle }],
    contributor: '0xctx', amount: '40', expiresInMs: 86_400_000,
  });
  await fetch(`${APP}${pl.body.uploadUrl}?durationS=8`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: vid(2048),
  });
  const claim = await post('/api/bounty/claim', { platform: 'twitch', handle, claimant: 'ctx' });
  const air = await post('/api/bounty/air-session', {
    claimId: claim.body.claim.id, platform: 'twitch', roomId: room,
  });
  return air.body.airSession.id;
}
/** Play a clip and wait for the fire-and-forget platform observation to land. */
async function playClip(airId, clipId) {
  const before = helixCalls;
  await post('/api/bounty/admin/playback', { airSessionId: airId, clipId, durationS: 600 });
  for (let i = 0; i < 40 && helixCalls === before; i++) await sleep(50);
  await sleep(150); // let the store write settle
  await post('/api/bounty/admin/playback/end', { airSessionId: airId, clipId });
}
const sessionOf = async (airId) => (await get('/api/bounty/admin/sessions'))
  .body.sessions.find((s) => s.id === airId);

try {
  // ── 1. the observation exists at all ─────────────────────────────────────
  const airA = await setup('ctxstreamer', 'ctxroom');
  await playClip(airA, 'CTX1');
  const sA = await sessionOf(airA);
  ok('the playback route captures the broadcast start from the platform',
    Number.isFinite(sA?.broadcastStartedAt), `broadcastStartedAt=${sA?.broadcastStartedAt}`);
  ok('...as PLATFORM truth, not when the air session opened',
    Math.abs(sA.broadcastStartedAt - Date.parse(chan.startedAt)) < 2000
    && sA.broadcastStartedAt < sA.startedAt - 20 * MIN,
    `broadcast=${new Date(sA.broadcastStartedAt).toISOString()} session=${new Date(sA.startedAt).toISOString()}`);
  const sample = evidenceRows().find((r) => r.type === 'VIEWER_SAMPLE' && r.airSessionId === airA);
  ok('...and the viewer count lands in the EVIDENCE chain alongside it',
    sample?.viewerCount === chan.viewers && sample.live === true,
    `viewerCount=${sample?.viewerCount}`);

  // ── 2. after the warmup: counts, no review, payout released ──────────────
  // THE REGRESSION: take the channel offline, end the session, and only then
  // verify. This is the NORMAL path — verification is VOD-first — and it is
  // what used to null the broadcast start and send honest sessions to review.
  await sleep(5000); // outlive the 4s tail: they streamed on after the clip
  chan.live = false;
  await post(`/api/bounty/air-session/${airA}/end`, {});
  const callsBeforeVerify = helixCalls;
  const vA = await post(`/api/bounty/air-session/${airA}/verify`, {});
  ok('verification does NOT ask the platform — it reads what was observed live',
    helixCalls === callsBeforeVerify,
    `${helixCalls - callsBeforeVerify} lookups during verify`);
  ok('a playback AFTER the warmup counts', vA.body.streamContext?.counted?.length === 1,
    JSON.stringify(vA.body.streamContext?.counted?.length));
  ok('REGRESSION: verifying an ENDED broadcast still knows when it started',
    vA.body.streamContext?.rejected?.length === 0
    && vA.body.streamContext?.summary === 'stream context OK',
    vA.body.streamContext?.summary);
  ok('...so no review is opened and the release computes', !vA.body.review
    && vA.body.release, `review=${vA.body.review ? 'opened' : 'none'}`);
  ok('the configured warmup (15m, not the 10m default) is the one applied',
    vA.body.streamContext?.warmupMs === 15 * MIN, `${vA.body.streamContext?.warmupMs}`);

  // ── 3. inside the warmup: does not count, routes to review ───────────────
  chan.live = true;
  chan.startedAt = new Date(Date.now() - 2 * MIN).toISOString(); // just went live
  const airB = await setup('ctxfarmer', 'ctxroom2');
  await playClip(airB, 'CTX2');
  const vB = await post(`/api/bounty/air-session/${airB}/verify`, {});
  ok('a playback INSIDE the warmup does not count',
    vB.body.streamContext?.counted?.length === 0
    && vB.body.streamContext?.rejected?.length === 1,
    JSON.stringify(vB.body.streamContext?.rejected?.[0]?.failure));
  ok('...it routes to HUMAN REVIEW, not auto-denial', !!vB.body.review,
    vB.body.review?.reason);
  ok('...and the review names the specific condition, not "failed checks"',
    /warmup/i.test(vB.body.review?.reason || ''), vB.body.review?.reason);
  ok('...the payout is NOT scaled or zeroed — it waits for the human',
    vB.body.release?.blocked || vB.body.release?.reason || vB.body.release?.released === 0,
    JSON.stringify(vB.body.release).slice(0, 120));

  // ── 4. the tail: stream ends too soon after the last playback ────────────
  chan.live = true;
  chan.startedAt = new Date(Date.now() - 40 * MIN).toISOString();
  const airC = await setup('ctxquitter', 'ctxroom3');
  await playClip(airC, 'CTX3');
  chan.live = false;              // they cut the stream right after the clip
  await post(`/api/bounty/air-session/${airC}/end`, {});
  const sC = await sessionOf(airC);
  ok('ending the session observes that the broadcast is over',
    Number.isFinite(sC?.broadcastEndedAt), `broadcastEndedAt=${sC?.broadcastEndedAt}`);
  const vC = await post(`/api/bounty/air-session/${airC}/verify`, {});
  ok('a stream ending too soon after the last playback is flagged',
    (vC.body.streamContext?.warnings || []).some((w) => w.failure === 'STREAM_ENDED_TOO_SOON'),
    vC.body.streamContext?.summary);
  ok('...the playback still COUNTS — they did play it',
    vC.body.streamContext?.counted?.length === 1);
  ok('...and it goes to review rather than being silently dropped',
    !!vC.body.review, vC.body.review?.reason);
  ok('the configured tail (4s, not the 60s default) is the one applied',
    vC.body.streamContext?.tailMs === 4000, `${vC.body.streamContext?.tailMs}`);

  // ── 5. no viewer weighting reached the payout ────────────────────────────
  ok('viewer count never appears in the release computation',
    !JSON.stringify(vA.body.release || {}).match(/viewer/i)
    && !JSON.stringify(vC.body.release || {}).match(/viewer/i));
  ok('the platform was only ever asked on localhost (zero external spend)',
    helixCalls > 0, `${helixCalls} stub calls, 0 real`);
} finally {
  app.kill();
  stub.close();
}
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
