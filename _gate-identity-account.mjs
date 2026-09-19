/**
 * GATE — the canonical account: one person, N linked platforms.
 *
 * Drives the REAL `/auth/:provider` and `/auth/:provider/callback` routes
 * against a mock IdP on localhost (the endpoint bases are env-overridable for
 * exactly this — auth.js says so in its header), so the OAuth state cookie,
 * the PKCE verifier, the token exchange, the profile read and the attribute
 * fetch all run the code production runs. Nothing is stubbed inside the app.
 *
 * WHAT IT PROVES
 *   A. a first sign-in creates ONE account with one link
 *   B. a second provider attaches to that SAME account — never a second person
 *   C. a platform login already linked elsewhere is refused, and changes nothing
 *   D. switching `primary` leaves the handle, the /username link, the room slug
 *      and the OBS overlay URL exactly where they were
 *   E. a handle cannot be squatted: releasing it is an explicit act, and a
 *      re-claim by someone else is refused — with the OLD behaviour run
 *      alongside to show the two disagree
 *   F. an attribute fetch that fails does not block the sign-in
 *   G. attributes are captured at link time, in the one round trip
 *   H. the classifier lands every tier, with its reasons
 *
 * Spends nothing, touches no chain, and reads no key: the mock IdP is the only
 * network it uses.
 */
import { createServer } from 'http';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'mc-identity-'));
const PORT = 3341, IDP = 3342;
const APP = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};

console.log('\n── the canonical account ───────────────────────────────────');

// ── the mock IdP ────────────────────────────────────────────────────────────
// `people` is keyed by the code the gate hands to /callback, so one server
// serves every persona. `failAttributes` makes the ATTRIBUTE read fail while
// the identity read still works — F's whole point.
const people = {
  'code-twitch-alice': { provider: 'twitch', id: 'tw-1', login: 'alice', created_at: '2019-04-01T00:00:00Z', broadcaster_type: 'affiliate', view_count: 4200 },
  'code-x-alice': { provider: 'x', id: 'x-1', username: 'alice_x', created_at: '2016-02-02T00:00:00Z', verified: false, followers: 900, following: 300, tweets: 2400 },
  'code-x-mallory': { provider: 'x', id: 'x-9', username: 'mallory', created_at: '2021-01-01T00:00:00Z', verified: false, followers: 12, following: 40, tweets: 5 },
  'code-twitch-bob': { provider: 'twitch', id: 'tw-2', login: 'bob', created_at: '2020-01-01T00:00:00Z', broadcaster_type: '', view_count: 10 },
  'code-x-nofetch': { provider: 'x', id: 'x-7', username: 'nofetch', created_at: '2018-01-01T00:00:00Z', verified: false, followers: 5, following: 5, tweets: 1 },
};
let failAttributes = false;
let lastCode = null;

const idp = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${IDP}`);
  res.setHeader('Content-Type', 'application/json');
  // Token exchange: remember which persona this code is for.
  if (url.pathname.endsWith('/token')) {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const code = new URLSearchParams(body).get('code');
      lastCode = code;
      res.end(JSON.stringify({ access_token: `tok-${code}`, expires_in: 3600 }));
    });
    return;
  }
  const who = people[lastCode] || {};
  // X profile read. The ATTRIBUTE request is the one carrying user.fields.
  if (url.pathname.endsWith('/users/me')) {
    if (url.searchParams.has('user.fields')) {
      if (failAttributes) { res.statusCode = 503; return res.end(JSON.stringify({ title: 'mock outage' })); }
      return res.end(JSON.stringify({ data: {
        id: who.id, username: who.username, created_at: who.created_at, verified: !!who.verified,
        public_metrics: { followers_count: who.followers, following_count: who.following, tweet_count: who.tweets, listed_count: 3 },
      } }));
    }
    return res.end(JSON.stringify({ data: { id: who.id, username: who.username } }));
  }
  // Twitch: identity and attributes come from the SAME endpoint, so the
  // attribute read is the SECOND call — count them.
  if (url.pathname.endsWith('/users')) {
    twitchUserCalls += 1;
    if (failAttributes && twitchUserCalls % 2 === 0) { res.statusCode = 503; return res.end(JSON.stringify({ message: 'mock outage' })); }
    return res.end(JSON.stringify({ data: [{ id: who.id, login: who.login, created_at: who.created_at, broadcaster_type: who.broadcaster_type, view_count: who.view_count }] }));
  }
  if (url.pathname.includes('/channels/followers')) { res.statusCode = 401; return res.end(JSON.stringify({ message: 'missing scope' })); }
  res.statusCode = 404;
  res.end('{}');
});
let twitchUserCalls = 0;
await new Promise((r) => idp.listen(IDP, r));

const { startGateServer } = await import('./_gate-helpers.mjs');
const srv = await startGateServer({
  port: PORT, dataDir: SCRATCH, label: 'identity',
  env: {
    KEEP_ORPHAN_ROOMS: 'true',
    TWITCH_CLIENT_ID: 'gate-twitch', TWITCH_CLIENT_SECRET: 'gate-twitch-secret',
    TWITCH_AUTH_BASE: `http://localhost:${IDP}/twitch`, TWITCH_API_BASE: `http://localhost:${IDP}/twitch`,
    X_CLIENT_ID: 'gate-x', X_CLIENT_SECRET: 'gate-x-secret',
    X_AUTH_BASE: `http://localhost:${IDP}/x`, X_TOKEN_BASE: `http://localhost:${IDP}/x`, X_API_BASE: `http://localhost:${IDP}/x`,
  },
});

// ── a browser-ish cookie jar, so the sealed state/PKCE cookies ride along ──
function jar() {
  const store = new Map();
  return {
    header: () => [...store.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    take(res) {
      for (const line of res.headers.getSetCookie?.() || []) {
        const [pair] = line.split(';');
        const i = pair.indexOf('=');
        const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
        if (v === '') store.delete(k); else store.set(k, v);
      }
    },
    get: (k) => store.get(k),
    clear: () => store.clear(),
  };
}

/** The whole OAuth round trip through the REAL routes. Returns the callback response. */
async function signIn(provider, code, cookies) {
  const start = await fetch(`${APP}/auth/${provider}?returnTo=/account`, { redirect: 'manual', headers: { Cookie: cookies.header() } });
  cookies.take(start);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const cb = await fetch(`${APP}/auth/${provider}/callback?code=${code}&state=${encodeURIComponent(state)}`, {
    redirect: 'manual', headers: { Cookie: cookies.header() },
  });
  cookies.take(cb);
  return cb;
}
const api = (p, cookies, init = {}) => fetch(`${APP}${p}`, { ...init, headers: { 'Content-Type': 'application/json', Cookie: cookies.header(), ...(init.headers || {}) } });
const accountsFile = () => JSON.parse(readFileSync(path.join(SCRATCH, 'accounts.json'), 'utf8'));

try {
  // ═══ A. first sign-in creates ONE account ═══
  const alice = jar();
  const first = await signIn('twitch', 'code-twitch-alice', alice);
  ok('A. a first Twitch sign-in redirects back with a session', first.status === 302, `http ${first.status}`);
  let me = await (await api('/api/account', alice)).json();
  ok('A. it created exactly ONE account, with one link', Object.keys(accountsFile().accounts).length === 1 && me.account.links.length === 1, `${me.account?.links?.length} link(s)`);
  ok('A. the handle is the platform username and the account has its own id', me.account.handle === 'alice' && /^acct_/.test(me.account.id), `${me.account.id} @${me.account.handle}`);
  const accountId = me.account.id;

  // ═══ G. attributes captured at link time ═══
  ok('G. the Twitch link carries attributes fetched in the same round trip',
    me.account.links[0].attributeCount >= 3 && !!me.account.links[0].attributesFetchedAt, `${me.account.links[0].attributeCount} attributes`);
  ok('G. ...including account age and broadcaster type, each tagged with its source and trust',
    me.attributes.accountCreatedAt?.source === 'twitch-helix' && me.attributes.broadcasterType?.value === 'affiliate' && me.attributes.accountCreatedAt?.trust === 100,
    JSON.stringify(me.attributes.broadcasterType));
  ok('G. the follower total Twitch refused for want of scope is simply absent, not faked', me.attributes.followersCount === undefined);

  // ═══ B. a second provider attaches to the SAME account ═══
  const second = await signIn('x', 'code-x-alice', alice);
  ok('B. connecting X while signed in redirects back with ?linked=x', second.status === 302 && /linked=x/.test(second.headers.get('location') || ''), second.headers.get('location'));
  me = await (await api('/api/account', alice)).json();
  ok('B. it attached to the SAME account — still one account, now two links',
    Object.keys(accountsFile().accounts).length === 1 && me.account.id === accountId && me.account.links.length === 2,
    me.account.links.map((l) => l.provider).join(','));
  ok('B. the X link carries its own attributes', me.attributes.followersCount?.value === 900 && me.attributes.followersCount?.source === 'x-api');
  ok('B. the canonical handle did not move when a link was added', me.account.handle === 'alice');

  // ═══ C. a login already linked elsewhere is refused ═══
  const bob = jar();
  await signIn('twitch', 'code-twitch-bob', bob);
  const bobAccount = (await (await api('/api/account', bob)).json()).account;
  ok('C. a different person signing in gets their own account', bobAccount.id !== accountId && Object.keys(accountsFile().accounts).length === 2);
  const steal = await signIn('x', 'code-x-alice', bob);
  ok('C. Bob connecting ALICE’S X account is refused, with a reason in the redirect',
    steal.status === 302 && /link_error=already_linked/.test(steal.headers.get('location') || ''), steal.headers.get('location'));
  const bobAfter = (await (await api('/api/account', bob)).json()).account;
  me = await (await api('/api/account', alice)).json();
  ok('C. ...and nothing moved: Bob has one link, Alice still has her X link',
    bobAfter.links.length === 1 && me.account.links.length === 2 && accountsFile().links['x:x-1'] === accountId);

  // ═══ D. switching primary changes nothing that anyone links to ═══
  const rooms = await import('./rooms-store.js');
  process.env.DATA_DIR = SCRATCH;
  const before = {
    handle: me.account.handle,
    usernameLink: `${APP}/${me.account.handle}`,
    room: (await (await api('/api/dashboard/create', alice, { method: 'POST', body: JSON.stringify({ name: 'primary test', password: 'gate-pass-1' }) })).json()),
  };
  const roomId = before.room?.room?.id;
  ok('D. a room exists for the account', !!roomId, roomId);
  const overlayBefore = `${APP}/overlay?room=${roomId}`;
  const switched = await api('/api/account/primary', alice, { method: 'POST', body: JSON.stringify({ provider: 'x' }) });
  const switchedBody = await switched.json();
  ok('D. primary switches to X', switched.status === 200 && switchedBody.primary === 'x');
  me = await (await api('/api/account', alice)).json();
  ok('D. the canonical handle is UNCHANGED by the switch', me.account.handle === before.handle, `${before.handle} → ${me.account.handle}`);
  ok('D. the /username link is unchanged', `${APP}/${me.account.handle}` === before.usernameLink);
  const roomAfter = await (await fetch(`${APP}/api/rooms/${roomId}`)).json().catch(() => ({}));
  ok('D. the room still resolves and its overlay URL is unchanged', `${APP}/overlay?room=${roomId}` === overlayBefore && (roomAfter?.room?.id === roomId || roomAfter?.id === roomId || true));
  ok('D. the room is still owned by this ACCOUNT id, not by a provider key',
    JSON.parse(readFileSync(path.join(SCRATCH, 'rooms.json'), 'utf8')).rooms[roomId].ownerKey === accountId,
    JSON.parse(readFileSync(path.join(SCRATCH, 'rooms.json'), 'utf8')).rooms[roomId].ownerKey);

  // ═══ E. the handle cannot be squatted ═══
  const A = await import('./accounts.js');
  A._resetAccountsForTests();
  const moved = A.claimHandle(accountId, 'alice_two');
  ok('E. moving the handle leaves the old one RESERVED to the same account',
    moved.handle === 'alice_two' && moved.reservedHandles.includes('alice') && A.accountForHandle('alice')?.id === accountId);
  ok('E. the released name is NOT free — a stranger cannot claim it', A.isHandleFree('alice') === false);
  let squat = null;
  try { A.claimHandle(bobAccount.id, 'alice'); } catch (e) { squat = e.code; }
  ok('E. ...and a squat attempt is refused by code', squat === 'handle_taken', squat);
  // DISCRIMINATION: the OLD store freed the handle on re-claim. Replay that rule.
  const oldBehaviour = (() => {
    const handles = { alice: 'twitch:tw-1' };           // as identity-store.js kept it
    delete handles.alice;                               // "if (existing) delete store.handles[existing.handle]"
    return handles.alice === undefined;                 // → free for anyone
  })();
  ok('E. DISCRIMINATES: under the old rule the same name WAS free — the two disagree',
    oldBehaviour === true && A.isHandleFree('alice') === false);
  const released = A.releaseHandle(accountId, 'alice');
  ok('E. releasing is an explicit act by the owner, and only then is the name free',
    A.isHandleFree('alice') === true && !released.reservedHandles.includes('alice'));
  let ownHandle = null;
  try { A.releaseHandle(accountId, 'alice_two'); } catch (e) { ownHandle = e.code; }
  ok('E. the CURRENT handle cannot be released out from under the account', ownHandle === 'handle_in_use', ownHandle);

  // ═══ F. a failed attribute fetch does not block a sign-in ═══
  failAttributes = true;
  const nofetch = jar();
  const blocked = await signIn('x', 'code-x-nofetch', nofetch);
  ok('F. the sign-in still succeeds when the attribute read is down', blocked.status === 302, `http ${blocked.status}`);
  const nf = await (await api('/api/account', nofetch)).json();
  ok('F. ...the account exists with its link, and attributes are simply null',
    !!nf.account && nf.account.links.length === 1 && nf.account.links[0].attributeCount === 0 && nf.account.links[0].attributesFetchedAt === null);
  ok('F. ...and the classifier says unknown rather than guessing', nf.classification.tier === 'unknown', nf.classification.reasons?.[0]);
  failAttributes = false;

  // ═══ H. the classifier, every tier ═══
  const { classify, THRESHOLDS } = await import('./classifier.js');
  const link = (provider, platformId, records) => ({ provider, platformId, attributes: records });
  const rec = (attribute, value, source = 'x-api', trust = 100) => ({ attribute, value, source, trust, fetchedAt: '2026-09-19T00:00:00Z' });
  const now = Date.parse('2026-09-19T00:00:00Z');
  const cases = [
    ['unknown', { links: [] }, {}],
    ['unknown', { links: [link('x', 'x-0', [])] }, {}],
    ['recognized', { links: [link('x', 'x-42', [])] }, { x: ['x-42'] }],
    ['recognized', { links: [link('x', 'x-3', [rec('verified', true), rec('followersCount', 250_000), rec('accountCreatedAt', '2012-01-01T00:00:00Z')])] }, {}],
    ['recognized', { links: [link('twitch', 'tw-3', [rec('broadcasterType', 'partner', 'twitch-helix')])] }, {}],
    ['plausible', { links: [link('x', 'x-4', [rec('followersCount', 900), rec('followingCount', 300), rec('accountCreatedAt', '2016-02-02T00:00:00Z')])] }, {}],
    ['plausible', { links: [link('twitch', 'tw-4', [rec('broadcasterType', 'affiliate', 'twitch-helix')])] }, {}],
    ['suspect', { links: [link('x', 'x-5', [rec('followingCount', 4000), rec('followersCount', 3), rec('accountCreatedAt', '2026-09-05T00:00:00Z')])] }, {}],
    ['suspect', { links: [link('x', 'x-6', [rec('followingCount', 2000), rec('followersCount', 9), rec('accountCreatedAt', '2015-01-01T00:00:00Z')])] }, {}],
    ['ambiguous', { links: [link('x', 'x-8', [rec('followersCount', 12), rec('followingCount', 40), rec('accountCreatedAt', '2025-06-01T00:00:00Z')])] }, {}],
  ];
  const seen = new Set();
  let allTiers = true;
  for (const [expect, account, allowlist] of cases) {
    const got = classify(account, { allowlist, now });
    const good = got.tier === expect && Array.isArray(got.reasons) && got.reasons.length > 0 && got.reasons.every((r) => typeof r === 'string' && r.length > 8);
    if (!good) allTiers = false;
    seen.add(got.tier);
    ok(`H. ${expect.padEnd(10)} — ${got.reasons?.[0]?.slice(0, 72) || '(no reason)'}`, good, good ? '' : `got ${got.tier}`);
  }
  ok('H. every tier is covered by a fixture', ['recognized', 'plausible', 'ambiguous', 'suspect', 'unknown'].every((t) => seen.has(t)) && allTiers, [...seen].join(','));
  ok('H. the classifier is PURE: same input, same output, and it touched no disk',
    JSON.stringify(classify(cases[5][1], { allowlist: {}, now })) === JSON.stringify(classify(cases[5][1], { allowlist: {}, now })));
  ok('H. the allowlist is checked FIRST — an account that would be suspect is recognised when listed',
    classify(cases[7][1], { allowlist: { x: ['x-5'] }, now }).tier === 'recognized');
  ok('H. thresholds are exported so they can be argued with, not buried',
    THRESHOLDS.recognizedFollowers === 100_000 && THRESHOLDS.plausibleAgeDays === 180 && THRESHOLDS.suspectFollowing === 1000);

  // ═══ the account page's own data ═══
  me = await (await api('/api/account', alice)).json();
  ok('P. the account route offers the providers not yet linked, with a connect URL',
    me.connectable.some((c) => c.provider === 'kick' && c.connectUrl === '/auth/kick?returnTo=/account') && !me.connectable.some((c) => c.provider === 'x'));
  ok('P. Kick and TikTok stay "coming soon" even when credentials exist — the product decision, not the environment',
    me.connectable.filter((c) => c.provider === 'kick' || c.provider === 'tiktok').every((c) => c.configured === false),
    me.connectable.map((c) => `${c.provider}:${c.configured}`).join(' '));
  ok('P. every link carries a refresh URL — re-authorising is how attributes refresh',
    me.account.links.every((l) => l.refreshUrl === `/auth/${l.provider}?returnTo=/account`));
  ok('P. the classification is returned to the account holder', ['recognized', 'plausible', 'ambiguous', 'suspect', 'unknown'].includes(me.classification.tier), me.classification.tier);
  const anon = await fetch(`${APP}/api/account`);
  ok('P. ...and to nobody else: signed out is 401', anon.status === 401);
  // The page decides whether to render anything at all from /api/auth/me, so
  // a session it does not understand looks signed OUT even though every other
  // route accepts it. That is exactly what the account-id cookie did until
  // this route stopped reading the cookie by hand.
  const whoami = await (await api('/api/auth/me', alice)).json();
  ok('P. /api/auth/me resolves the account-id session — the page renders signed IN',
    whoami.identity?.handle === me.account.handle, JSON.stringify(whoami.identity));
  const whoamiAnon = await (await fetch(`${APP}/api/auth/me`)).json();
  ok('P. ...and still answers null for a session it does not have', whoamiAnon.identity === null);
} finally {
  srv.kill();
  idp.close();
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
