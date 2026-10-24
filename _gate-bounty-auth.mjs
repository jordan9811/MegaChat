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
 *   4. WHAT THE HANDLER TRUSTS — the claim verifier's default, the body vs
 *      the session, private clips, the overlay key, the frames hold. The
 *      first three layers stayed green while all of these reproduced.
 *
 * Identity is the sealed mc_identity cookie. This gate mints real ones through
 * the same seal the server uses, because a hand-written cookie proves nothing
 * about the real path.
 */
import path from 'node:path';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
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
// ...and a scratch DATA_DIR, for the same reason: bounty-store and
// bounty-clips fix their data dir when they load, and section 1's
// attachBountyRoutes validates the ledgers, sweeps unindexed clip media (it
// DELETES files) and seeds the demo pools in it. Without this, all of that ran
// on the repo's own data/ (audit harness-6). The HTTP server below gets its
// own dir from startGateServer.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'mc-bauth-routes-'));
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
// Seed the account store so readIdentityFromRequest resolves a USERNAME.
// The cookie only names a link (provider + platformId); the username that must
// equal the channel handle lives on that link, which is the whole point of the
// ownership check. No MegaChat handle is claimed here — these people have an
// account and a platform login, and nothing else, which is the state a fan
// arrives in.
const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-bauth-'));
const seeded = [
  ['twitch', '1', 'gatestreamer'],
  ['twitch', '2', 'someoneelse'],
  ['kick', '3', 'gatestreamer'],
  // The site owner (SITE_ADMIN_TWITCH below): an account, not a key.
  ['twitch', '4', 'gatesiteowner'],
];
const accounts = {}, links = {};
for (const [provider, platformId, username] of seeded) {
  const id = `acct_bauth${provider}${platformId}`;
  const now = new Date().toISOString();
  accounts[id] = {
    id, handle: null, primary: provider, createdAt: now,
    links: [{ provider, platformId, username, handle: null, linkedAt: now, attributes: null, attributesFetchedAt: null }],
    reservedHandles: [],
  };
  links[`${provider}:${platformId}`] = id;
}
writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({ accounts, handles: {}, links }, null, 2));

const { startGateServer } = await import('./_gate-helpers.mjs');
const srv = await startGateServer({
  port: PORT, dataDir, label: 'bounty-auth',
  env: {
    BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true',
    BOUNTY_ADMIN_KEY: ADMIN_KEY, AUTH_SECRET, SITE_ADMIN_TWITCH: 'gatesiteowner',
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
  if (key === 'GET /api/bounty/queue' || key === 'GET /api/bounty/bank') query = `?platform=twitch&handle=${ids.handle}`;
  return { method, urlPath: urlPath + query, body: bodies[key] ?? (method === 'POST' ? {} : undefined) };
}

try {
  // ── fixtures: a real claim owned by 'gatestreamer' ───────────────────────
  // The cookie names an ACCOUNT, so the helper reads it from this server's
  // accounts.json — dataDir says which one.
  const owner = sealIdentityForTests({ provider: 'twitch', platformId: '1', username: 'gatestreamer', dataDir });
  const other = sealIdentityForTests({ provider: 'twitch', platformId: '2', username: 'someoneelse', dataDir });
  const kickSameName = sealIdentityForTests({ provider: 'kick', platformId: '3', username: 'gatestreamer', dataDir });

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
  // bounty-N2: the /bounty/admin page sends the site owner's cookie, no key.
  const siteOwner = sealIdentityForTests({ provider: 'twitch', platformId: '4', username: 'gatesiteowner', dataDir });
  const ownerAdmin = await Promise.all(['/api/bounty/admin/sessions', '/api/bounty/admin/reviews']
    .map((p) => call('GET', p, { cookie: siteOwner }).then((r) => r.status)));
  ok('bounty-N2: the SITE OWNER\'s sign-in reaches the admin routes the admin page calls (it 401\'d)',
    ownerAdmin.every((s) => s === 200), ownerAdmin.join(','));

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

  // ── 4. WHAT EACH HANDLER TRUSTS (audit 2026-10-24) ────────────────────────
  // Everything above was green while six bounty findings reproduced: it
  // proves who REACHES a handler, not what the handler then believes. Each
  // case below failed on the pre-fix tree (the mutation run in the audit's
  // fix-bounty NOTES.md) and passes on this one. No identity flag is set on
  // this server, so the claim cases run against the DEFAULT verifier.
  const ledgerLen = async () => (await call('GET', '/api/bounty/admin/ledger', { adminKey: ADMIN_KEY })).body.ledger?.length ?? -1;
  const reservedOf = async (handle) => (await call('GET', `/api/bounty/pool?platform=twitch&handle=${handle}`)).body.reserved;

  // bounty-9: the default is the REAL verifier. An anonymous claim used to be
  // approved by the stub and bind the payee; now it is refused, unwritten.
  await call('POST', '/api/bounty/pledge', {
    cookie: other, body: { targets: [{ platform: 'twitch', handle: 'freshhandle' }], amount: '4', expiresInMs: 86400000 },
  });
  const rowsBefore = await ledgerLen();
  const anonClaim = await call('POST', '/api/bounty/claim', {
    body: { platform: 'twitch', handle: 'freshhandle', claimant: '0xIMPOSTOR' },
  });
  ok('bounty-9: with no identity flag, an ANONYMOUS claim is refused (the stub approved it)',
    anonClaim.status === 401 && anonClaim.body.identity?.approved === false,
    `HTTP ${anonClaim.status} ${anonClaim.body.identity?.method}`);
  ok('bounty-9: ...before a single ledger row or claim is written',
    (await ledgerLen()) === rowsBefore && (await reservedOf('freshhandle'))?.claimedBy == null,
    `rows ${rowsBefore} -> ${await ledgerLen()}`);
  const strangerClaim = await call('POST', '/api/bounty/claim', {
    cookie: other, body: { platform: 'twitch', handle: 'freshhandle', claimant: '0xSTRANGER' },
  });
  ok('bounty-9: a signed-in account that does not own the handle is DENIED',
    strangerClaim.body.identity?.approved === false && (await reservedOf('freshhandle'))?.claimedBy == null,
    strangerClaim.body.identity?.method);

  // bounty-N3: the verified owner's re-entry rebinds the payee, on the ledger.
  const reentry = await call('POST', '/api/bounty/claim', {
    cookie: owner, body: { platform: 'twitch', handle: 'gatestreamer', claimant: 'g-rebound' },
  });
  const rebound = (await call('GET', '/api/bounty/admin/ledger?platform=twitch&handle=gatestreamer', { adminKey: ADMIN_KEY }))
    .body.ledger?.find((r) => r.type === 'IDENTITY_CHECK' && r.meta?.payeeReboundFrom === 'g');
  ok('bounty-N3: the verified owner re-entering rebinds claimedBy to the payee they name',
    reentry.body.reclaimed === true && (await reservedOf('gatestreamer'))?.claimedBy === 'g-rebound',
    `claimedBy=${(await reservedOf('gatestreamer'))?.claimedBy}`);
  ok('bounty-N3: ...and the change is a ledger row naming the old payee', !!rebound);

  // bounty-7(a): the contributor is the session's account, never the body's.
  const filed = await call('POST', '/api/bounty/contribute', {
    cookie: owner, body: { platform: 'twitch', handle: 'gatestreamer', contributor: 'acct_bauthtwitch2', amount: '2' },
  });
  ok('bounty-7a: /contribute files under the SIGNED-IN account, not the id in the body',
    filed.status === 200 && filed.body.contribution?.contributor === 'acct_bauthtwitch1',
    `contributor=${filed.body.contribution?.contributor}`);

  // bounty-N1: the type must be exactly one video type, and is served that way.
  const html = Buffer.from('<!doctype html><script>document.title="SCRIPT_RAN"</script>');
  const pledgeFor = async (cookie) => (await call('POST', '/api/bounty/pledge', {
    cookie, body: { targets: [{ platform: 'twitch', handle: 'gatestreamer' }], amount: '3', expiresInMs: 86400000 },
  })).body;
  const evil = await pledgeFor(other);
  const evilUp = await fetch(`${APP}${evil.uploadUrl}?durationS=8`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm, text/html' }, body: html,
  });
  ok('bounty-N1: an upload typed "video/webm, text/html" is refused, not stored',
    evilUp.status === 400, `HTTP ${evilUp.status}`);
  const fanUp = await fetch(`${APP}${evil.uploadUrl}?durationS=8`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm' },
    body: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2048, 6)]),
  }).then((r) => r.json());
  const privateClip = fanUp.clip?.clipId;
  ok('bounty-N1: ...while a plain video/webm upload still stores', !!privateClip);

  // ...and mp4 is still one of the two types, served back as exactly that.
  const mp4Pledge = await pledgeFor(other);
  const mp4Up = await fetch(`${APP}${mp4Pledge.uploadUrl}?durationS=8`, {
    method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: Buffer.alloc(2048, 7),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const mp4Media = await fetch(`${APP}/api/bounty/clip/${mp4Up.body.clip?.clipId}/media`, { headers: { Cookie: other } });
  ok('bounty-N1: a video/mp4 upload still stores and serves as video/mp4',
    mp4Up.status === 200 && mp4Media.headers.get('content-type') === 'video/mp4'
    && mp4Media.headers.get('content-disposition') === 'inline; filename="holler-clip.mp4"',
    `HTTP ${mp4Up.status} / ${mp4Media.headers.get('content-type')}`);

  // web-5: one pledge per take. A retried submit carrying the same attemptId
  // gets the first pledge back instead of escrowing again.
  const attemptId = '3f0c2a52-6b1e-4a7e-9d2f-1c0b8e7a5d41';
  const pledgeBody = { targets: [{ platform: 'twitch', handle: 'gatestreamer' }], amount: '2', expiresInMs: 86400000, attemptId };
  const firstTry = await call('POST', '/api/bounty/pledge', { cookie: other, body: pledgeBody });
  const retry = await call('POST', '/api/bounty/pledge', { cookie: other, body: pledgeBody });
  const freshTake = await call('POST', '/api/bounty/pledge', { cookie: other, body: { ...pledgeBody, attemptId: '9b1d7c3e-2f4a-4c8b-8e6d-5a0f1b2c3d4e' } });
  const ownerSame = await call('POST', '/api/bounty/pledge', { cookie: owner, body: pledgeBody });
  ok('web-5: the same attemptId from the same account returns the FIRST pledge, deduped (it escrowed twice)',
    retry.status === 200 && retry.body.deduped === true && retry.body.pledge?.id === firstTry.body.pledge?.id
    && retry.body.uploadUrl === firstTry.body.uploadUrl, `${firstTry.body.pledge?.id} / ${retry.body.pledge?.id}`);
  ok('web-5: ...a new attempt, or another account with the same id, is a new pledge',
    freshTake.body.pledge?.id && freshTake.body.pledge.id !== firstTry.body.pledge?.id
    && ownerSame.body.pledge?.id && ownerSame.body.pledge.id !== firstTry.body.pledge?.id && !ownerSame.body.deduped);
  const pubCfg = await call('GET', '/api/bounty/config');
  ok('web-5: the public config carries the clip size limit, so a take can be refused before paying',
    Number.isFinite(pubCfg.body.clipMaxBytes) && pubCfg.body.clipMaxBytes > 0, `clipMaxBytes=${pubCfg.body.clipMaxBytes}`);

  // bounty-8: an unmoderated clip is PRIVATE.
  const media = (id, cookie, adminKey) => fetch(`${APP}/api/bounty/clip/${id}/media`, {
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(adminKey ? { 'x-bounty-admin-key': adminKey } : {}) },
  });
  const pubList = await call('GET', '/api/bounty/clips?platform=twitch&handle=gatestreamer');
  ok('bounty-8: the PUBLIC clip list leaves the unapproved clip out',
    pubList.status === 200 && !(pubList.body.clips || []).some((c) => c.clipId === privateClip)
    && pubList.body.waiting >= 2, `${(pubList.body.clips || []).length} listed, ${pubList.body.waiting} waiting`);
  ok('bounty-8 / 7b: ...and carries no account ids, no contribution ids and no storage path',
    !/acct_|contribution|storageRoot/.test(JSON.stringify(pubList.body)) && !pubList.body.storage);
  const ownList = await call('GET', '/api/bounty/clips?platform=twitch&handle=gatestreamer', { cookie: owner });
  ok('bounty-8: the streamer still sees every clip waiting for them',
    (ownList.body.clips || []).some((c) => c.clipId === privateClip) && !ownList.body.storage?.storageRoot);
  const anonMedia = await media(privateClip);
  const strangerMedia = await media(privateClip, kickSameName);
  ok('bounty-8: an anonymous caller cannot play the unapproved clip (it streamed before)',
    anonMedia.status === 404, `HTTP ${anonMedia.status}`);
  ok('bounty-8: ...nor can an account that is neither its pledger nor its streamer',
    strangerMedia.status === 404, `HTTP ${strangerMedia.status}`);
  const pledgerMedia = await media(privateClip, other);
  const streamerMedia = await media(privateClip, owner);
  const adminMedia = await media(privateClip, null, ADMIN_KEY);
  ok('bounty-8: its pledger, its streamer and the operator can',
    pledgerMedia.status === 200 && streamerMedia.status === 200 && adminMedia.status === 200,
    `${pledgerMedia.status}/${streamerMedia.status}/${adminMedia.status}`);
  ok('bounty-N1: media is served as exactly video/webm, nosniff, with a fixed filename',
    pledgerMedia.headers.get('content-type') === 'video/webm'
    && pledgerMedia.headers.get('x-content-type-options') === 'nosniff'
    && pledgerMedia.headers.get('content-disposition') === 'inline; filename="holler-clip.webm"',
    `${pledgerMedia.headers.get('content-type')} / ${pledgerMedia.headers.get('x-content-type-options')} / ${pledgerMedia.headers.get('content-disposition')}`);
  await call('POST', `/api/bounty/clip/${privateClip}/approve`, { cookie: owner, body: { by: 'gatestreamer' } });
  const approvedMedia = await media(privateClip);
  const approvedList = await call('GET', '/api/bounty/clips?platform=twitch&handle=gatestreamer');
  ok('bounty-8: once the streamer approves it, the clip is public',
    approvedMedia.status === 200 && (approvedList.body.clips || []).some((c) => c.clipId === privateClip),
    `HTTP ${approvedMedia.status}`);

  // bounty-2: the room route hands the session id only to a keyed overlay,
  // and the overlay's two writes need that key (or the streamer / operator).
  const k = new URLSearchParams(String(air.body.overlayPath || '').split('?')[1] || '').get('k');
  const room = air.body.roomId;
  ok('bounty-2: (fixture) the dashboard overlay URL carries the room key', !!k && !!room, `room=${room} k=${k ? 'present' : 'absent'}`);
  const unkeyedCode = await call('GET', `/api/bounty/room/${room}/code`);
  const keyedCode = await call('GET', `/api/bounty/room/${room}/code?k=${k}`);
  ok('bounty-2: an UNKEYED room poll gets no session id (it used to get the UUID)',
    unkeyedCode.status === 200 && unkeyedCode.body.status === 'OPEN' && unkeyedCode.body.airSessionId === null,
    `airSessionId=${unkeyedCode.body.airSessionId}`);
  ok('bounty-2: ...a KEYED one does', keyedCode.body.airSessionId === airSessionId);
  const storeFile = path.join(dataDir, 'bounty.json');
  const sizeBefore = statSync(storeFile).size;
  const big = { height: 1, canvasH: 1080, ratio: 0.001, junk: 'x'.repeat(90_000) };
  const anonBadge = [];
  for (let i = 0; i < 20; i++) {
    anonBadge.push((await call('POST', `/api/bounty/air-session/${airSessionId}/badge`, { body: { tooSmall: true, detail: big } })).status);
  }
  const anonEnv = await call('POST', `/api/bounty/air-session/${airSessionId}/overlay-env`, {
    body: { width: 1, height: 1, visibilityState: 'visible', at: Date.now() },
  });
  const grew = statSync(storeFile).size - sizeBefore;
  ok('bounty-2: unkeyed /badge posts are refused', anonBadge.every((s) => s === 401), [...new Set(anonBadge)].join(','));
  ok('bounty-2: ...as is an unkeyed /overlay-env', anonEnv.status === 401, `HTTP ${anonEnv.status}`);
  ok('bounty-2: ...so 20 x 90KB of junk no longer grows bounty.json (it grew ~1.8MB)',
    grew < 64 * 1024, `${(grew / 1024).toFixed(1)}KB`);
  const keyedBadge = await call('POST', `/api/bounty/air-session/${airSessionId}/badge?k=${k}`, { body: { tooSmall: true, detail: big } });
  const keyedEnv = await call('POST', `/api/bounty/air-session/${airSessionId}/overlay-env?k=${k}`, {
    body: { width: 1920, height: 1080, visibilityState: 'visible', at: Date.now() },
  });
  ok('bounty-2: the keyed overlay reports both', keyedBadge.status === 200 && keyedEnv.status === 200,
    `${keyedBadge.status}/${keyedEnv.status}`);
  const sess = (await call('GET', '/api/bounty/admin/sessions', { adminKey: ADMIN_KEY })).body.sessions
    ?.find((s) => s.id === airSessionId);
  const lastViolation = sess?.violations?.[sess.violations.length - 1];
  ok('bounty-2: the stored badge detail is three numbers, not the client\'s JSON',
    JSON.stringify(Object.keys(lastViolation?.detail || {}).sort()) === '["canvasH","height","ratio"]',
    JSON.stringify(lastViolation?.detail || null).slice(0, 80));
  const streamerBadge = await call('POST', `/api/bounty/air-session/${airSessionId}/badge`, { cookie: owner, body: { tooSmall: false } });
  ok('bounty-2: the streamer\'s own session also counts as a credential', streamerBadge.status === 200, `HTTP ${streamerBadge.status}`);

  // bounty-14: frames are held only for a contribution still awaiting its clip.
  const ghost = await call('POST', '/api/bounty/clip/not-a-contribution/frames', { body: { frames: ['data:image/jpeg;base64,AAAA'] } });
  ok('bounty-14: frames for an id that is no contribution are refused (any string used to be held)',
    ghost.status === 404, `HTTP ${ghost.status}`);
  const late = await call('POST', `/api/bounty/clip/${evil.contribution.id}/frames`, { body: { frames: ['data:image/jpeg;base64,AAAA'] } });
  ok('bounty-14: ...and for a contribution whose clip already landed', late.status === 409, `HTTP ${late.status}`);
  const fresh = await pledgeFor(other);
  const early = await call('POST', `${fresh.uploadUrl}/frames`, { body: { frames: ['data:image/jpeg;base64,AAAA', 'not-an-image'] } });
  ok('bounty-14: a contribution awaiting its clip still gets its frames held',
    early.status === 200 && early.body.frames === 1, `HTTP ${early.status} frames=${early.body.frames}`);
} finally {
  srv.kill();
}
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
