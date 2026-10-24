/**
 * GATE — the bounty money path's audit fixes (2026-10-24), each against the
 * behaviour it replaced.
 *
 * In-process: the real bounty routes on an express app with the same global
 * JSON parser server.js mounts, real sealed identities from mintBountyAuth,
 * and the fixture verifier (every sampled frame reads the code) so the payout
 * arithmetic, not the decoder, is what is under test. _gate-run-b-pipeline
 * covers the real decoder. Every case here failed on the pre-fix tree (the
 * mutation run in the audit's fix-bounty NOTES.md).
 *
 *  A. bounty-1  the session's own streamer cannot choose the verification
 *               source; the operator still can
 *  B. bounty-5  a reviewer's approval pays what the automatic path pays for
 *               the same evidence: one airing per pledge
 *  C. bounty-6  after a reviewer rejects a session, a re-verify does not pay
 *               it unattended — and approving that new review pays once
 *  D. bounty-3  a second session for the same claim closes the first, and the
 *               playback hooks and the overlay's room route agree on which
 *  E. bounty-17 ending a session twice changes nothing
 *  F. bounty-11 a recorder whose every poll fails stops on its own
 *  G. bounty-12 the pledge sweeper applies the capture retention
 *  H. cc-env    the config's numbers read through env-num.js: floors on the
 *               intervals, defaults for empty and non-numeric values
 *  I. harness-8 BOUNTY_IDENTITY_STUB=1 is refused on Railway (the real
 *               verifier decides, one error line) and still works for a
 *               --prod gate server with no Railway variables
 */
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { log() {}, warn() {}, error() {}, info() {} };

// BEFORE any bounty import: the config, the stores and the clip index all read
// their environment at module load.
const DATA_DIR = fs.mkdtempSync(path.join(tmpdir(), 'mc-bounty-audit-'));
const FIXTURE = path.join(DATA_DIR, 'fixture-allfound.json');
fs.writeFileSync(FIXTURE, JSON.stringify({ defaultAvailable: true, defaultCheck: { found: true, confidence: 0.9, pixelHeight: 40 } }));
Object.assign(process.env, {
  BOUNTY_CLAIM: '1', DATA_DIR, KEEP_ORPHAN_ROOMS: 'true',
  BOUNTY_FIXTURE_PATH: FIXTURE, BOUNTY_SELF_CAPTURE: '0',
  // G needs the sweeper to tick inside the run: its floor (env-num.js).
  BOUNTY_PLEDGE_SWEEP_MS: '1000',
  // The gate must never reach a real platform or classifier.
  TWITCH_CLIENT_ID: '', TWITCH_CLIENT_SECRET: '', KICK_CLIENT_ID: '', KICK_CLIENT_SECRET: '',
  YOUTUBE_API_KEY: '', RUMBLE_LIVESTREAM_API_URL: '', MODERATION_API_KEY: '',
});
const { mintBountyAuth } = await import('./_gate-helpers.mjs');
const auth = mintBountyAuth({ handles: ['stra', 'strb', 'strc', 'strd'], dataDir: DATA_DIR });
Object.assign(process.env, auth.env);

const require = createRequire(import.meta.url);
const express = require('express');
const store = await import('./bounty-store.js');
const watermark = await import('./bounty-watermark.js');
const capture = await import('./bounty-capture.js');
const { bountyConfig } = await import('./bounty-claim.config.js');
const { createRoom } = await import('./rooms-store.js');
const routes = await import('./bounty-routes.js');

const app = express();
app.use(express.json()); // the same global parser server.js mounts
routes.attachBountyRoutes(app, { log: quiet });
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;

const call = async (method, p, body, headers = {}) => {
  const r = await fetch(`${BASE}${p}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const cookie = (h) => ({ Cookie: auth.cookieFor(h) });
const admin = { 'x-bounty-admin-key': auth.adminKey };
const released = (key) => store.getPool(key).releasedContributor;
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 5)]);

/**
 * One pledged clip that aired TWICE in one session (a first airing and its
 * replay), both verified by the fixture: two pieces of evidence, ONE payable
 * airing.
 */
async function scene(handle) {
  const me = cookie(handle);
  const p = await call('POST', '/api/bounty/pledge', { targets: [{ platform: 'twitch', handle }], amount: '100' }, me);
  const up = await fetch(`${BASE}${p.body.uploadUrl}?durationS=10`, {
    method: 'POST', headers: { 'content-type': 'video/webm', ...me }, body: webm,
  }).then((r) => r.json());
  const claim = await call('POST', '/api/bounty/claim', { platform: 'twitch', handle, claimant: `${handle}-wallet` }, me);
  const air = await call('POST', '/api/bounty/air-session', { claimId: claim.body.claim.id }, me);
  const s = air.body.airSession.id;
  const t0 = Date.now() - 60_000;
  for (const off of [0, 30_000]) {
    const r = watermark.startClipPlayback(s, { clipId: up.clip.clipId, durationS: 10, now: t0 + off });
    for (let k = 1; k <= 2; k++) watermark.issueCodeForWindow(s, r.playbackId, { now: t0 + off + k * 4000 });
    watermark.endClipPlayback(s, { playbackId: r.playbackId, now: t0 + off + 10_000 });
  }
  return { me, s, claimId: claim.body.claim.id, key: `twitch:${handle}`, claimed: claim.body.identity?.approved === true };
}

try {
  // ── A. bounty-1 ──────────────────────────────────────────────────────────
  const A = await scene('stra');
  ok('(fixture) the owner claims under the default verifier with their own sign-in', A.claimed);
  // The automatic path first: what this evidence pays when nobody looks.
  const vA = await call('POST', `/api/bounty/air-session/${A.s}/verify`, {}, A.me);
  const autoPaid = released(A.key);
  ok('A. a plain verify runs and pays automatically, one airing for the pledge',
    vA.status === 200 && autoPaid > 0 && vA.body.release?.payable?.payableClips === 1,
    `result=${vA.body.verification?.result} raw=${vA.body.verification?.verifiedClips} payable=${vA.body.release?.payable?.payableClips} paid=${autoPaid}`);
  const attempts = store.listVerifications(A.s).length;
  const forged = await call('POST', `/api/bounty/air-session/${A.s}/verify`,
    { mode: 'real', sourceMode: 'files', frames: [{ file: 'C:/anything.png' }] }, A.me);
  ok('A. bounty-1: the streamer cannot hand the verifier their own frames (it ran them, and paid tier 1)',
    forged.status === 403 && forged.body.reason === 'operator_only_source', `HTTP ${forged.status} ${forged.body.reason || ''}`);
  const forgedVod = await call('POST', `/api/bounty/air-session/${A.s}/verify`, { vodUrl: 'http://127.0.0.1:1/x.m3u8' }, A.me);
  ok('A. ...nor name a VOD URL', forgedVod.status === 403, `HTTP ${forgedVod.status}`);
  ok('A. ...and a refused call records no verification attempt', store.listVerifications(A.s).length === attempts);
  const opVerify = await call('POST', `/api/bounty/air-session/${A.s}/verify`, { sourceMode: 'vod' }, { ...A.me, ...admin });
  ok('A. the operator key still chooses a source', opVerify.status === 200, `HTTP ${opVerify.status}`);

  // ── B. bounty-5 ──────────────────────────────────────────────────────────
  // A review opened by another door (the bank's expiry, an operator) pins no
  // evidence; the session's verified playbacks must still collapse.
  const B = await scene('strb');
  const rv = store.createReview({
    airSessionId: B.s, claimId: B.claimId, handleKey: B.key, verificationId: null, confidence: null,
    reason: 'banked: overlay hidden during 1 pledged playback(s) — queued for replay',
  });
  const vB = await call('POST', `/api/bounty/air-session/${B.s}/verify`, {}, B.me);
  ok('B. (fixture) the open review holds the release', vB.body.release?.skipped === 'pending_review' && released(B.key) === 0);
  await call('POST', `/api/bounty/admin/reviews/${rv.id}/resolve`, { approve: true, reason: 'gate: aired', actor: 'admin' }, admin);
  ok('B. bounty-5: a reviewer approving the same evidence pays what the automatic path paid (it paid double)',
    released(B.key) === autoPaid, `review ${released(B.key)} vs auto ${autoPaid}`);

  // ── C. bounty-6 ──────────────────────────────────────────────────────────
  const C = await scene('strc');
  const rc = store.createReview({
    airSessionId: C.s, claimId: C.claimId, handleKey: C.key, verificationId: null, confidence: null,
    reason: 'stream context: 2 playback(s) inside the 10-minute warmup',
  });
  await call('POST', `/api/bounty/air-session/${C.s}/verify`, {}, C.me);
  await call('POST', `/api/bounty/admin/reviews/${rc.id}/resolve`, { approve: false, reason: 'gate: farming', actor: 'admin' }, admin);
  const vC = await call('POST', `/api/bounty/air-session/${C.s}/verify`, {}, C.me);
  ok('C. bounty-6: re-verifying a REJECTED session pays nothing unattended (it released)',
    released(C.key) === 0 && vC.body.release?.skipped === 'pending_review', `paid=${released(C.key)} skipped=${vC.body.release?.skipped}`);
  ok('C. ...it opens a review naming the earlier rejection',
    !!vC.body.review && vC.body.review.reason.includes(rc.id), vC.body.review?.reason?.slice(0, 100));
  ok('C. ...and the review carries the evidence it was opened on',
    Array.isArray(vC.body.review?.verifiedPlaybacks) && vC.body.review.verifiedPlaybacks.length === 2);
  await call('POST', `/api/bounty/admin/reviews/${vC.body.review?.id}/resolve`, { approve: true, reason: 'gate: second look, aired', actor: 'admin' }, admin);
  ok('C. a person approving it pays once for the pledge, like the automatic path',
    released(C.key) === autoPaid, `paid ${released(C.key)} vs auto ${autoPaid}`);

  // ── D. bounty-3 ──────────────────────────────────────────────────────────
  const room = createRoom('audit gate room', {}).id;
  const meD = cookie('strd');
  await call('POST', '/api/bounty/pledge', { targets: [{ platform: 'twitch', handle: 'strd' }], amount: '10' }, meD);
  const claimD = await call('POST', '/api/bounty/claim', { platform: 'twitch', handle: 'strd', claimant: 'strd-wallet' }, meD);
  const first = await call('POST', '/api/bounty/air-session', { claimId: claimD.body.claim.id, roomId: room }, meD);
  await sleep(5);
  const second = await call('POST', '/api/bounty/air-session', { claimId: claimD.body.claim.id, roomId: room }, meD);
  const s1 = store.getAirSession(first.body.airSession.id);
  const s2 = store.getAirSession(second.body.airSession.id);
  ok('D. bounty-3: opening a second session for the claim CLOSES the first (two stayed OPEN)',
    s1.status === 'CLOSED' && s1.supersededBy === s2.id && s2.status === 'OPEN', `first=${s1.status} second=${s2.status}`);
  const hooks = routes.makeClipHooks({ log: quiet });
  hooks.onClipPlay(room, { clipId: 'audit-clip', durationS: 10 });
  const code = await call('GET', `/api/bounty/room/${room}/code`, undefined, admin);
  ok('D. ...the playback hooks open the window on the session the overlay is drawing',
    (store.getAirSession(s2.id).playbackWindows || []).length === 1
    && (store.getAirSession(s1.id).playbackWindows || []).length === 0
    && code.body.airSessionId === s2.id && !!code.body.code,
    `windows ${(store.getAirSession(s1.id).playbackWindows || []).length}/${(store.getAirSession(s2.id).playbackWindows || []).length}, room code ${code.body.code ? 'drawn' : 'null'}`);

  // ── E. bounty-17 ─────────────────────────────────────────────────────────
  hooks.onClipEnd(room, { clipId: 'audit-clip' });
  const end1 = await call('POST', `/api/bounty/air-session/${s2.id}/end`, {}, meD);
  await sleep(20);
  const end2 = await call('POST', `/api/bounty/air-session/${s2.id}/end`, {}, meD);
  ok('E. bounty-17: ending a closed session again is a no-op (it re-stamped the end)',
    end1.status === 200 && end2.body.alreadyClosed === true
    && store.getAirSession(s2.id).endedAt === end1.body.airSession.endedAt,
    `endedAt ${end1.body.airSession?.endedAt} -> ${store.getAirSession(s2.id).endedAt}`);

  // ── F. bounty-11 ─────────────────────────────────────────────────────────
  {
    const saved = { on: bountyConfig.selfCaptureEnabled, poll: bountyConfig.capturePollMs, run: bountyConfig.captureMaxErrorRunMs };
    Object.assign(bountyConfig, { selfCaptureEnabled: true, capturePollMs: 20, captureMaxErrorRunMs: 150 });
    let polls = 0;
    await capture.startCapture('audit-dark-recorder', {
      hlsUrl: 'http://127.0.0.1:1/dead.m3u8', platform: 'twitch', handle: 'strd', log: quiet,
      fetchImpl: async () => { polls += 1; return { ok: false, status: 404, text: async () => '' }; },
    });
    await sleep(700);
    const stillOn = capture.isCapturing('audit-dark-recorder');
    capture.stopCapture('audit-dark-recorder', { log: quiet });
    Object.assign(bountyConfig, { selfCaptureEnabled: saved.on, capturePollMs: saved.poll, captureMaxErrorRunMs: saved.run });
    ok('F. bounty-11: a recorder whose every poll fails stops on its own (it polled a 404 forever)',
      stillOn === false && polls > 2, `${polls} poll(s), capturing=${stillOn}`);
  }

  // ── G. bounty-12 ─────────────────────────────────────────────────────────
  {
    // Where bounty-capture.js keeps its media. Written by hand on purpose: if
    // that layout moves, the expired file is not purged and this FAILS.
    const dir = path.join(DATA_DIR, 'bounty-captures');
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'audit-expired__pb.ts');
    const fresh = path.join(dir, 'audit-fresh__pb.ts');
    fs.writeFileSync(old, Buffer.alloc(16));
    fs.writeFileSync(fresh, Buffer.alloc(16));
    const past = (Date.now() - bountyConfig.captureRetentionMs - 60_000) / 1000;
    fs.utimesSync(old, past, past);
    await sleep(2_500); // past two ticks of the 1s sweeper
    ok('G. bounty-12: the sweeper removes a capture past retention (nothing ever called the purge)',
      !fs.existsSync(old), fs.existsSync(old) ? 'still on disk' : 'purged');
    ok('G. ...and keeps one inside it', fs.existsSync(fresh));
  }

  // ── H. the config's numbers go through envNum ────────────────────────────
  // A fresh process, because the config is read once at import. '' used to
  // read as 0 (num() took Number('')), an interval had no floor, and a
  // non-number was NaN on the `Number(x || d)` reads.
  {
    const { spawnSync } = await import('node:child_process');
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
      "const { bountyConfig: c } = await import('./bounty-claim.config.js');"
      + 'console.log(JSON.stringify([c.pledgeSweepMs, c.capturePollMs, c.clipMaxBytes, c.minConfidence, c.streamWarmupMs]))'],
    { cwd: process.cwd(), encoding: 'utf8', env: {
      ...process.env, BOUNTY_PLEDGE_SWEEP_MS: '5', BOUNTY_CAPTURE_POLL_MS: '10', BOUNTY_CLIP_MAX_BYTES: '',
      BOUNTY_MIN_CONFIDENCE: 'sixty', BOUNTY_STREAM_WARMUP_MS: '0',
    } });
    const got = JSON.parse(probe.stdout.trim().split(/\r?\n/).pop() || 'null');
    ok('H. intervals take their floors, an empty value its default, a non-number its default, and 0 stays 0',
      JSON.stringify(got) === JSON.stringify([1000, 250, 25 * 1024 * 1024, 0.6, 0]),
      `${JSON.stringify(got)} (the old readers gave [5,10,0,NaN,0])`);
  }

  // ── I. the auto-approving identity stub never decides on Railway ────────
  // harness-8. A fresh process per case (the routes read the variable when
  // they attach), each `--prod` like every gate server, each on its own data
  // dir. Only RAILWAY_ENVIRONMENT differs between the two.
  {
    const { spawnSync } = await import('node:child_process');
    const attachWith = (railway) => {
      const dir = fs.mkdtempSync(path.join(tmpdir(), 'mc-bounty-audit-stub-'));
      const r = spawnSync(process.execPath, ['--input-type=module', '-e',
        "const lines = []; const put = (k) => (m) => lines.push([k, String(m)]);"
        + "const log = { log: put('log'), warn: put('warn'), error: put('error'), info() {} };"
        + "const express = (await import('express')).default;"
        + "const { attachBountyRoutes } = await import('./bounty-routes.js');"
        + 'attachBountyRoutes(express(), { log });'
        + "console.log('@@' + JSON.stringify(lines.filter(([, m]) => /identity verifier|IDENTITY_STUB/.test(m))));"
        + 'process.exit(0);', '--', '--prod'],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, env: {
        ...process.env, DATA_DIR: dir, BOUNTY_CLAIM: '1', BOUNTY_IDENTITY_STUB: '1',
        RAILWAY_ENVIRONMENT: railway, RAILWAY_ENVIRONMENT_NAME: '',
      } });
      const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('@@'));
      return line ? JSON.parse(line.slice(2)) : [['error', `no output: ${(r.stderr || '').slice(-300)}`]];
    };
    const verifierOf = (lines) => (lines.find(([, m]) => /identity verifier:/.test(m)) || [, '?'])[1].replace(/.*identity verifier: /, '');
    const local = attachWith('');
    ok('I. BOUNTY_IDENTITY_STUB=1 under --prod with no Railway variables: gates still get the stub',
      verifierOf(local) === 'StubIdentityVerifier', verifierOf(local));
    const railway = attachWith('production');
    const refusals = railway.filter(([k, m]) => k === 'error' && /BOUNTY_IDENTITY_STUB=1 is set on Railway/.test(m));
    ok('I. ...the same variable on Railway is REFUSED: the real verifier decides (it used to be the stub)',
      verifierOf(railway) === 'PlatformIdentityVerifier', verifierOf(railway));
    ok('I. ...with exactly one error line, and no "approved without proof" warning',
      refusals.length === 1 && !railway.some(([, m]) => /approved without proof/.test(m)), JSON.stringify(railway.map(([k]) => k)));
  }
} catch (e) {
  ok(`gate threw — ${e?.stack || e}`, false);
} finally {
  await new Promise((r) => server.close(() => r()));
}
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
