/**
 * GATE — the two things a streamer must be TOLD, over real HTTP routes.
 *
 * 4b. A 480p streamer is warned, not silently shorted. Below the verifier's
 *     pixel floor the badge still reads, just barely: reads start dropping and
 *     the payout quietly comes up short. A shortfall that looks like ordinary
 *     partial verification is the one failure a streamer cannot argue with,
 *     because they never learn it happened. So: named up front, named again on
 *     the verification, with the measured number.
 *
 * 4c. Kick has no VOD, so it has no retry. The live pass is the only pass.
 *     That is a materially different bargain from Twitch and it has to be
 *     visible BEFORE a Kick streamer relies on it. We double the sampling
 *     density to compensate; we do not pretend the difference away.
 *
 * Zero external network, zero spend.
 */
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const PORT = 3313;
const APP = `http://localhost:${PORT}`;

// `as` picks WHICH streamer identity to send. Streamer-tier routes authorize
// against the handle they target, so a gate driving two channels needs two
// cookies; omitting it acts as the first handle.
const post = (p, body, as) => fetch(`${APP}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...srv.headers(as) },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (p, as) => fetch(`${APP}${p}`, { headers: srv.headers(as) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const vid = (n) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(n, 5)]);

const WORK = mkdtempSync(path.join(tmpdir(), 'mc-qual-'));
const FIXTURE = path.join(WORK, 'fixture.json');
// Reads land, but at 13px against a 12px floor — exactly the 480p case:
// verifiable, with no margin. This must NOT come out looking like a normal
// partial verification.
writeFileSync(FIXTURE, JSON.stringify({
  defaultCheck: { found: true, confidence: 0.95, pixelHeight: 13 },
}));

const { startGateServer } = await import('./_gate-helpers.mjs');
const srv = await startGateServer({
  // Bounty routes authorize server-side now; the harness mints a sealed
  // identity per handle plus an admin key. Gates authenticate exactly the
  // way a streamer does — no test-only bypass in the auth path.
  bountyAuth: { handles: ['qualstreamer', 'kick:qualslug'] },
  port: PORT,
  env: {
    BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true', MODERATION_API_KEY: '',
    BOUNTY_FIXTURE_PATH: FIXTURE,
    TWITCH_CLIENT_ID: '', TWITCH_CLIENT_SECRET: '', KICK_CLIENT_ID: '', KICK_CLIENT_SECRET: '',
    BOUNTY_CODE_ROTATE_MS: '600000', BOUNTY_CODE_VALIDITY_MS: '600000',
  },
});
const app = srv.child;

async function runSession(platform, handle, room, clipId) {
  // The identity that owns THIS handle — a Twitch cookie cannot open a Kick
  // handle's air session, which is exactly what the auth layer enforces.
  const as = platform === 'kick' ? `kick:${handle}` : handle;
  const pl = await post('/api/bounty/pledge', {
    targets: [{ platform, handle }], contributor: '0xq', amount: '40', expiresInMs: 86_400_000,
  });
  await fetch(`${APP}${pl.body.uploadUrl}?durationS=8`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm', ...srv.headers() }, body: vid(2048),
  });
  const claim = await post('/api/bounty/claim', { platform, handle, claimant: 'q' }, as);
  const air = await post('/api/bounty/air-session', {
    claimId: claim.body.claim.id, platform, roomId: room,
  }, as);
  const airId = air.body.airSession.id;
  await post('/api/bounty/admin/playback', { airSessionId: airId, clipId, durationS: 600 });
  await post('/api/bounty/admin/playback/end', { airSessionId: airId, clipId });
  const v = await post(`/api/bounty/air-session/${airId}/verify`, {}, as);
  return { claimId: claim.body.claim.id, airId, v };
}

try {
  // ── 4c. the platform profile is public and honest ────────────────────────
  const cfg = await get('/api/bounty/config');
  const kick = cfg.body.platformProfiles?.kick;
  const twitch = cfg.body.platformProfiles?.twitch;
  ok('the config route publishes a per-platform verification profile',
    !!kick && !!twitch, Object.keys(cfg.body.platformProfiles || {}).join(','));
  ok('Kick is declared to have NO VOD retry', kick?.vodRetry === false);
  ok('Twitch is declared to HAVE VOD retry', twitch?.vodRetry === true);
  ok('the Kick notice says plainly that the live check is the only check',
    /only check|no second look/i.test(kick?.notice || ''), kick?.notice?.slice(0, 80));
  ok('...and that it does not end in a denial',
    /never to a denial|goes to a person/i.test(kick?.notice || ''));
  ok('the declared Kick density is double', kick?.samplingMultiplier === 2);

  // ── 4c. the declared density is the density actually APPLIED ─────────────
  const tw = await runSession('twitch', 'qualstreamer', 'qroom1', 'Q1');
  const kk = await runSession('kick', 'qualslug', 'qroom2', 'Q2');
  const dTw = tw.v.body.verification?.samplingDensity;
  const dKk = kk.v.body.verification?.samplingDensity;
  ok('a Kick session really is sampled at twice the Twitch density',
    dKk === dTw * 2, `twitch=${dTw} kick=${dKk}`);
  ok('...and the density the verifier used is reported, not just configured',
    Number.isFinite(dKk) && dKk > 0, `${dKk}`);

  // ── 4b. marginal quality is marked, not swallowed ────────────────────────
  const ver = tw.v.body.verification;
  ok('a clip that read at 13px against a 12px floor is flagged below-floor',
    ver?.belowQualityFloorClips === 1, `belowQualityFloorClips=${ver?.belowQualityFloorClips}`);
  ok('...the measured height travels WITH the verdict',
    (ver?.clipVerdicts || []).every((c) => Number.isFinite(c.medianPixelHeight)),
    JSON.stringify((ver?.clipVerdicts || []).map((c) => c.medianPixelHeight)));
  ok('...the clip still VERIFIED — this is a warning, never a rejection',
    ver?.verifiedClips === 1 && ['PASS', 'PARTIAL'].includes(ver?.result),
    `${ver?.result} clips=${ver?.verifiedClips}`);
  ok('...and a human is put on it rather than the streamer being paid short',
    !!tw.v.body.review, tw.v.body.review?.reason?.slice(0, 90));
  ok('...the review reason names the QUALITY cause specifically',
    /below the verifier floor/i.test(tw.v.body.review?.reason || ''),
    tw.v.body.review?.reason?.slice(0, 110));
  ok('...with the measured size in the reason, so the reviewer needs no lookup',
    /\d+px vs \d+px floor/.test(tw.v.body.review?.reason || ''));
  // This server has NO platform credentials. The stream-context check cannot
  // run, and must not invent a review for every session — a flooded queue
  // hides the farming the check exists to catch.
  ok('an unconfigured platform API does NOT manufacture a context review',
    !/stream context:/.test(tw.v.body.review?.reason || ''),
    tw.v.body.review?.reason?.slice(0, 110));
  ok('...and says so explicitly rather than reporting the check as passed',
    tw.v.body.streamContext?.notEvaluated === true,
    JSON.stringify(tw.v.body.streamContext?.summary));

  // ── 4b. the streamer can SEE it on their own claim ───────────────────────
  const st = await get(`/api/bounty/claim/${tw.claimId}`);
  ok('the streamer-facing claim status reports the below-floor clip count',
    st.body.quality?.belowFloorClips === 1, JSON.stringify(st.body.quality));
  ok('...with the actual measured size and the floor it is judged against',
    st.body.quality?.smallestBadgePx === 13 && st.body.quality?.floorPx === 12,
    `${st.body.quality?.smallestBadgePx}px vs floor ${st.body.quality?.floorPx}px`);
  ok('...and the resolution to aim for (720p, the measured verifiable floor)',
    st.body.quality?.minVerifiableHeightPx === 720);
  const kst = await get(`/api/bounty/claim/${kk.claimId}`, 'kick:qualslug');
  ok('a Kick claim carries its platform profile so the UI can warn on it',
    kst.body.platformProfile?.vodRetry === false,
    kst.body.platformProfile?.platform);

  // ── drift: the UI must not restate these numbers ─────────────────────────
  const ui = readFileSync('web/components/bounty/claim-flow.tsx', 'utf8');
  ok('the claim UI reads the quality floor from config, not a literal',
    /config\.minVerifiableHeightPx/.test(ui) && !/\b720p\b/.test(ui));
  ok('the claim UI reads the platform notice from the server, not a literal',
    /profile\.notice/.test(ui) && !/no VOD we can read/.test(ui));
} finally {
  app.kill();
}
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
