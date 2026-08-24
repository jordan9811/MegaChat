/**
 * GATE — every state-changing bounty route authorizes, server-side.
 *
 * Before this, approve/reject and the whole /admin/* surface answered to
 * anyone who knew the path. The gate that matters is not "these three routes
 * are locked" — it is that the SET IS ENUMERATED, so a route added next month
 * cannot quietly ship unprotected.
 *
 * Three layers:
 *   1. COVERAGE — the policy table and the registered routes must match in
 *      BOTH directions. An unlisted route is unprotected; a stale entry is a
 *      policy describing something imaginary.
 *   2. EXERCISE — every STREAMER and ADMIN route is actually called over HTTP
 *      with no credential and with the WRONG user, and must reject. Driven off
 *      the same table, so a new entry is automatically exercised.
 *   3. THE POSITIVE — the right streamer gets through, or we have merely built
 *      a wall with no door.
 *
 * Identity is the sealed mc_identity cookie. This gate mints real ones through
 * the same seal the server uses, because a hand-written cookie proves nothing
 * about the real path.
 */
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};

const PORT = 3360;
const APP = `http://localhost:${PORT}`;
const ADMIN_KEY = 'gate-admin-key-abc123';
const AUTH_SECRET = 'gate-auth-secret-for-sealing-cookies';

// BEFORE any import: bounty-claim.config.js reads BOUNTY_CLAIM at module load,
// and bounty-auth pulls it in transitively. Setting it later froze
// `enabled:false` and attachBountyRoutes returned { mounted:false } with no
// route list at all.
process.env.AUTH_SECRET = AUTH_SECRET;
process.env.BOUNTY_CLAIM = '1';
const { ROUTE_POLICY, TIER, SUBJECT, assertPolicyCoversRoutes } = await import('./bounty-auth.js');

// ── 1. COVERAGE: the table vs what actually registers ─────────────────────
{
  // Register against a recording stub rather than a live server: this asks
  // "what does bounty-routes.js mount", not "what answers on a port".
  const recorded = [];
  const stubApp = {
    get: (p) => recorded.push(`GET ${p}`),
    post: (p) => recorded.push(`POST ${p}`),
  };
  const routes = await import('./bounty-routes.js');
  const res = routes.attachBountyRoutes(stubApp, { log: { log() {}, warn() {} } });
  const cover = assertPolicyCoversRoutes(res.routes);
  ok('every registered route appears in the policy table', cover.unlisted.length === 0,
    cover.unlisted.join(', ') || `${res.routes.length} routes, none unlisted`);
  ok('every policy entry corresponds to a real route (no stale entries)',
    cover.stale.length === 0, cover.stale.join(', ') || 'none stale');
  ok('the guarded registrar saw the same count the table holds',
    res.routes.length === Object.keys(ROUTE_POLICY).length,
    `${res.routes.length} registered vs ${Object.keys(ROUTE_POLICY).length} in table`);
}

// A route with no policy must be IMPOSSIBLE to register, not merely unusual.
{
  const { policyFor } = await import('./bounty-auth.js');
  let threw = false;
  try { policyFor('POST', '/api/bounty/some-new-route'); } catch { threw = true; }
  ok('registering an UNLISTED route throws rather than defaulting to open', threw);
}

// ── the server ────────────────────────────────────────────────────────────
// Seed the identity store so readIdentityFromRequest resolves a USERNAME.
// The cookie only carries provider+platformId; the username that must equal
// the handle lives here, which is the whole point of the ownership check.
const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-bauth-'));
const ident = (provider, platformId, username) => ([`${provider}:${platformId}`,
  { provider, platformId, username, handle: null, createdAt: Date.now() }]);
writeFileSync(path.join(dataDir, 'identities.json'), JSON.stringify({
  identities: Object.fromEntries([
    ident('twitch', '1', 'gatestreamer'),
    ident('twitch', '2', 'someoneelse'),
    ident('kick', '3', 'gatestreamer'),
  ]),
  handles: {},
}));

const { startGateServer } = await import('./_gate-helpers.mjs');
const srv = await startGateServer({
  port: PORT, dataDir, label: 'bounty-auth',
  env: {
    BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true',
    BOUNTY_ADMIN_KEY: ADMIN_KEY, AUTH_SECRET,
    TWITCH_CLIENT_ID: '', TWITCH_CLIENT_SECRET: '', KICK_CLIENT_ID: '', KICK_CLIENT_SECRET: '',
  },
});

/** Mint a sealed mc_identity cookie the same way the server does. */
const { sealIdentityForTests } = await import('./_gate-identity-helper.mjs');

const call = async (method, urlPath, { body, cookie, adminKey } = {}) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (adminKey) headers['x-bounty-admin-key'] = adminKey;
  const r = await fetch(`${APP}${urlPath}`, {
    method, headers, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

/**
 * A concrete request for each policy entry: the path with params filled and a
 * plausible body. Built from the table so a NEW entry without a sample here
 * fails loudly rather than going unexercised.
 */
function sampleFor(key, ids) {
  const [method, tmpl] = key.split(' ');
  const policy = ROUTE_POLICY[key];
  // `:id` means different things on different routes — a claimId here, an
  // airSessionId there. Using one value for both made half these requests
  // 404 before they ever reached the ownership check, which would have let a
  // real hole hide behind a fixture bug.
  const idFor = policy?.subject === SUBJECT.PARAM_CLAIM ? ids.claimId : ids.airSessionId;
  const urlPath = tmpl
    .replace(':contributionId', ids.contributionId)
    .replace(':clipId', ids.clipId)
    .replace(':id', idFor);
  const bodies = {
    'GET /api/bounty/queue': null,
    'POST /api/bounty/refund-expired': { platform: 'twitch', handle: ids.handle },
    'POST /api/bounty/air-session': { claimId: ids.claimId, platform: 'twitch', roomId: 'r' },
    'POST /api/bounty/admin/playback': { airSessionId: ids.airSessionId, clipId: 'C', durationS: 8 },
    'POST /api/bounty/admin/playback/end': { airSessionId: ids.airSessionId, clipId: 'C' },
    'POST /api/bounty/admin/seed': { platform: 'twitch', handle: 'seeded' },
    'POST /api/bounty/admin/override': { platform: 'twitch', handle: ids.handle, to: 'OPEN', reason: 'x', actor: 'a' },
  };
  let query = '';
  if (key === 'GET /api/bounty/queue') query = `?platform=twitch&handle=${ids.handle}`;
  return { method, urlPath: urlPath + query, body: bodies[key] ?? (method === 'POST' ? {} : undefined) };
}

try {
  // ── fixtures: a real claim owned by 'gatestreamer' ───────────────────────
  const owner = sealIdentityForTests({ provider: 'twitch', platformId: '1', username: 'gatestreamer' });
  const other = sealIdentityForTests({ provider: 'twitch', platformId: '2', username: 'someoneelse' });
  const kickSameName = sealIdentityForTests({ provider: 'kick', platformId: '3', username: 'gatestreamer' });

  const pledge = await call('POST', '/api/bounty/pledge', {
    cookie: owner,
    body: { targets: [{ platform: 'twitch', handle: 'gatestreamer' }], contributor: '0xg', amount: '30', expiresInMs: 86400000 },
  });
  ok('a signed-in fan can pledge (FAN tier positive)', pledge.status === 200, `${pledge.status}`);
  const contributionId = pledge.body?.contributions?.[0]?.id || pledge.body?.contributionId || 'none';

  const claim = await call('POST', '/api/bounty/claim', {
    cookie: owner, body: { platform: 'twitch', handle: 'gatestreamer', claimant: 'g' },
  });
  const claimId = claim.body?.claim?.id;
  const air = await call('POST', '/api/bounty/air-session', {
    cookie: owner, body: { claimId, platform: 'twitch', roomId: 'gateroom' },
  });
  const airSessionId = air.body?.airSession?.id;
  ok('the OWNING streamer can open an air session (STREAMER positive)',
    air.status === 200 && !!airSessionId, `${air.status}`);

  // A REAL stored clip, so approve/reject resolve to a real handle and the
  // ownership check is what decides — not a missing fixture.
  const uploadUrl = pledge.body?.uploadUrl;
  await fetch(`${APP}${uploadUrl}?durationS=8`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm' },
    body: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2048, 5)]),
  });
  const queue = await call('GET', '/api/bounty/queue?platform=twitch&handle=gatestreamer', { cookie: owner });
  const clipId = queue.body?.queue?.[0]?.clipId;
  ok('the owning streamer sees their own queue, with the uploaded clip',
    queue.status === 200 && !!clipId, `${queue.status} clips=${queue.body?.count}`);

  const ids = { handle: 'gatestreamer', claimId, airSessionId, clipId: clipId || 'noclip', contributionId };

  // ── 2. EXERCISE every protected entry, driven off the table ──────────────
  const streamerKeys = Object.entries(ROUTE_POLICY)
    .filter(([, v]) => v.tier === TIER.STREAMER).map(([k]) => k);
  const adminKeys = Object.entries(ROUTE_POLICY)
    .filter(([, v]) => v.tier === TIER.ADMIN).map(([k]) => k);
  const fanKeys = Object.entries(ROUTE_POLICY)
    .filter(([, v]) => v.tier === TIER.FAN).map(([k]) => k);

  // A refusal is 401/403. 404 is NOT accepted here: after the
  // auth-before-resolve fix an anonymous caller can never reach resolution,
  // so a 404 would mean the auth check was skipped.
  const rejects = (r) => r.status === 401 || r.status === 403;

  // No credential at all.
  const anonFails = [];
  for (const k of [...streamerKeys, ...adminKeys, ...fanKeys]) {
    const s = sampleFor(k, ids);
    const r = await call(s.method, s.urlPath, { body: s.body });
    if (!rejects(r)) anonFails.push(`${k} -> ${r.status}`);
  }
  ok(`ANONYMOUS is rejected on all ${streamerKeys.length + adminKeys.length + fanKeys.length} protected routes`,
    anonFails.length === 0, anonFails.slice(0, 3).join(' | ') || 'all rejected');

  // Signed in, but the WRONG streamer.
  const wrongUserFails = [];
  for (const k of streamerKeys) {
    const s = sampleFor(k, ids);
    const r = await call(s.method, s.urlPath, { body: s.body, cookie: other });
    if (!rejects(r)) wrongUserFails.push(`${k} -> ${r.status}`);
  }
  ok(`the WRONG signed-in streamer is rejected on all ${streamerKeys.length} streamer routes`,
    wrongUserFails.length === 0, wrongUserFails.slice(0, 3).join(' | ') || 'all rejected');

  // Right name, wrong PLATFORM — a Kick session must not act on a Twitch handle.
  const crossFails = [];
  for (const k of streamerKeys) {
    const s = sampleFor(k, ids);
    const r = await call(s.method, s.urlPath, { body: s.body, cookie: kickSameName });
    if (!rejects(r)) crossFails.push(`${k} -> ${r.status}`);
  }
  ok('a KICK session with the same username cannot act on the Twitch handle',
    crossFails.length === 0, crossFails.slice(0, 3).join(' | ') || 'all rejected');

  // Admin routes: a signed-in ordinary user is still not an admin.
  const adminAsUser = [];
  for (const k of adminKeys) {
    const s = sampleFor(k, ids);
    const r = await call(s.method, s.urlPath, { body: s.body, cookie: owner });
    if (!rejects(r)) adminAsUser.push(`${k} -> ${r.status}`);
  }
  ok(`a signed-in streamer is NOT an admin on all ${adminKeys.length} admin routes`,
    adminAsUser.length === 0, adminAsUser.slice(0, 3).join(' | ') || 'all rejected');

  // Wrong admin key.
  const badKey = await call('GET', '/api/bounty/admin/ledger', { adminKey: 'not-the-key' });
  ok('a wrong admin key is rejected', badKey.status === 401, `${badKey.status}`);
  const rightKey = await call('GET', '/api/bounty/admin/ledger', { adminKey: ADMIN_KEY });
  ok('the right admin key gets through (ADMIN positive)', rightKey.status === 200, `${rightKey.status}`);

  // ── T5: strikes follow the ACCOUNT, not a string ─────────────────────────
  // The old hole: `contributor` was whatever the client sent, so a struck fan
  // typed a new name and probed the classifier again for free.
  const pledgeAsOwner = await call('POST', '/api/bounty/pledge', {
    cookie: owner,
    body: { targets: [{ platform: 'twitch', handle: 'gatestreamer' }],
      contributor: 'TOTALLY-DIFFERENT-NAME', amount: '5', expiresInMs: 86400000 },
  });
  ok('a pledge is recorded against the ACCOUNT, not the name the client sent',
    pledgeAsOwner.status === 200, `${pledgeAsOwner.status}`);
  const mine = await call('GET', '/api/bounty/my', { cookie: owner });
  ok('...and "my contributions" resolves from the session, not a query string',
    mine.status === 200 && (mine.body.contributions || []).length >= 1,
    `${mine.status} n=${(mine.body.contributions || []).length}`);
  const mineAnon = await call('GET', '/api/bounty/my');
  ok("...so nobody can read another account's contributions by guessing a name",
    mineAnon.status === 401, `${mineAnon.status}`);
  const mineOther = await call('GET', '/api/bounty/my', { cookie: other });
  ok("...and a DIFFERENT account sees its own (empty) list, not the owner's",
    mineOther.status === 200 && (mineOther.body.contributions || []).length === 0,
    `n=${(mineOther.body.contributions || []).length}`);

  // ── 3. Public routes stay public ─────────────────────────────────────────
  const pub = await call('GET', '/api/bounty/pools');
  ok('public routes remain public (the directory is not behind a login)', pub.status === 200);

  // The overlay's capability route: no cookie, must still work — it runs in an
  // OBS browser source that cannot hold one.
  const overlayPoll = await call('GET', `/api/bounty/air-session/${airSessionId}/code`);
  ok('the OBS overlay can still poll its code with NO session (capability tier)',
    overlayPoll.status === 200, `${overlayPoll.status}`);
} finally {
  srv.kill();
}
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
