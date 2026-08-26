/**
 * GATE — X ownership through the Privy identity, PROVEN not assumed.
 *
 * The prompt behind this run asked one sharp question: does Privy genuinely
 * return the X @handle, or an opaque id? Answered two ways:
 *
 *   A. the PARSERS, against the raw REST shape production already sees (the
 *      account panel reads twitter_oauth.username off the live wire today —
 *      see the privy-sdk-drops-newer-accounts note): displayNameFromRaw picks
 *      a display name, platformLoginsFromRaw keeps EVERY platform's own
 *      login, and the two answer different questions on purpose — someone
 *      with Twitch and X linked DISPLAYS as their Twitch name, and that name
 *      proves nothing about their X handle.
 *
 *   B. the DECISIONS, over HTTP with BOUNTY_IDENTITY_REAL=1 and a
 *      privy-shaped identity in the store: X claims approve on the linked X
 *      login and only on it; cross-platform proof stays no proof; and — the
 *      biggest find of this task — TWITCH claims from a Privy sign-in work
 *      at all. Both ownership checks used to require provider === platform,
 *      which no Privy identity ever satisfies: with real verification on,
 *      NO streamer who signed in through the actual front door could claim
 *      or pass a STREAMER route on ANY platform. Gates minted the legacy
 *      shape, so nothing ever saw it.
 *
 * Plus the X frame path: no pullable stream + no self-capture must land
 * SOURCE_UNAVAILABLE → human review through the normal pipeline — never a
 * 500 from the route while building its options.
 *
 * Zero external network: no Privy call happens (identities are seeded in the
 * store exactly as identityFromToken writes them), no platform APIs exist.
 */
import { writeFileSync, readFileSync, existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { startGateServer } from './_gate-helpers.mjs';
import { sealIdentityForTests } from './_gate-identity-helper.mjs';
import { displayNameFromRaw, platformLoginsFromRaw } from './privy-identity.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};

// ── A. the parsers, against the raw REST shape ────────────────────────────
{
  const both = [
    { type: 'twitch_oauth', username: 'pixelqueen', subject: 'tw123' },
    { type: 'twitter_oauth', username: 'pixel_on_x', subject: 'x456', name: 'Pixel Q' },
    { type: 'email', address: 'pixel@example.com' },
  ];
  const display = displayNameFromRaw(both);
  ok('A. the display ladder picks the TWITCH name when both are linked',
    display?.username === 'pixelqueen' && display.provider === 'twitch', JSON.stringify(display));
  const logins = platformLoginsFromRaw(both);
  ok('A. ...while the per-platform logins keep BOTH — the X handle survives',
    logins.twitch === 'pixelqueen' && logins.x === 'pixel_on_x', JSON.stringify(logins));

  const xOnly = [{ type: 'twitter_oauth', username: 'lone_xer', subject: 'x9' }];
  ok('A. an X-only account: the REAL @handle, not the opaque subject id',
    displayNameFromRaw(xOnly)?.username === 'lone_xer'
    && platformLoginsFromRaw(xOnly).x === 'lone_xer'
    && platformLoginsFromRaw(xOnly).twitch === undefined,
    'username field, never subject');

  const googleOnly = [{ type: 'google_oauth', email: 'g@example.com' }];
  ok('A. a google-only account has NO platform logins to claim with',
    Object.keys(platformLoginsFromRaw(googleOnly)).length === 0,
    'an email is identity, not channel ownership');
}

// ── B. the decisions, over HTTP with REAL verification on ─────────────────
const DATA = mkdtempSync(path.join(tmpdir(), 'mc-xclaims-'));
// Seed identities EXACTLY as identityFromToken writes them: provider 'privy',
// the DID as platformId, username from the display ladder, platformLogins
// from the linked accounts.
const DID = 'did:privy:gatestreamer';
const DID_GOOGLE = 'did:privy:gatefan';
writeFileSync(path.join(DATA, 'identities.json'), JSON.stringify({
  identities: {
    [`privy:${DID}`]: {
      provider: 'privy', platformId: DID, username: 'pixelqueen', handle: 'pixelqueen',
      createdAt: new Date().toISOString(),
      platformLogins: { twitch: 'pixelqueen', x: 'pixel_on_x' },
    },
    [`privy:${DID_GOOGLE}`]: {
      provider: 'privy', platformId: DID_GOOGLE, username: 'gfan', handle: 'gfan',
      createdAt: new Date().toISOString(),
      // Google-only sign-in: no platformLogins at all.
    },
  },
  handles: { pixelqueen: `privy:${DID}`, gfan: `privy:${DID_GOOGLE}` },
}));

const AUTH_SECRET = 'x-claims-gate-secret';
process.env.AUTH_SECRET = AUTH_SECRET; // the helper seals with the same secret
const srv = await startGateServer({
  port: 3242, label: 'x-claims', dataDir: DATA,
  env: {
    BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true', MODERATION_API_KEY: '',
    BOUNTY_IDENTITY_REAL: '1', BOUNTY_IDENTITY_STUB: '0',
    AUTH_SECRET,
    BOUNTY_ADMIN_KEY: 'x-claims-admin',
    TWITCH_CLIENT_ID: '', TWITCH_CLIENT_SECRET: '', KICK_CLIENT_ID: '', KICK_CLIENT_SECRET: '',
    BOUNTY_SELF_CAPTURE: '0', // the no-capture X verification path is under test
  },
});
try {
  const APP = 'http://localhost:3242';
  const cookie = sealIdentityForTests({ provider: 'privy', platformId: DID });
  const googleCookie = sealIdentityForTests({ provider: 'privy', platformId: DID_GOOGLE });
  const admin = { 'x-bounty-admin-key': 'x-claims-admin' };
  const post = (p, body, extra = {}) => fetch(`${APP}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  // Pools to claim against.
  for (const [platform, handle] of [['x', 'pixel_on_x'], ['x', 'someone_else'], ['twitch', 'pixelqueen'], ['kick', 'pixelqueen']]) {
    await post('/api/bounty/admin/seed', { platform, handle }, admin);
  }

  // B1: the X claim approves on the LINKED X login.
  const xClaim = await post('/api/bounty/claim',
    { platform: 'x', handle: 'pixel_on_x', claimant: 'pixelqueen' }, { Cookie: cookie });
  ok('B1. an X claim VERIFIES off the Privy-linked X handle',
    xClaim.status === 200 && xClaim.body.claim?.verificationState === 'VERIFIED'
    && xClaim.body.identity?.method === 'X_OAUTH_SESSION',
    `${xClaim.body.claim?.verificationState} via ${xClaim.body.identity?.method}`);

  // B2: somebody else's X handle: denied, named.
  const wrongX = await post('/api/bounty/claim',
    { platform: 'x', handle: 'someone_else', claimant: 'pixelqueen' }, { Cookie: cookie });
  ok('B2. someone else\'s X handle is DENIED as a mismatch',
    wrongX.body.claim?.verificationState === 'DENIED'
    && wrongX.body.identity?.method === 'REAL_HANDLE_MISMATCH',
    wrongX.body.identity?.method);

  // B3: THE PRODUCTION FIX — a Privy sign-in can claim their Twitch handle.
  const twClaim = await post('/api/bounty/claim',
    { platform: 'twitch', handle: 'pixelqueen', claimant: 'pixelqueen' }, { Cookie: cookie });
  ok('B3. a PRIVY sign-in claims their TWITCH handle (was impossible: provider mismatch)',
    twClaim.body.claim?.verificationState === 'VERIFIED'
    && twClaim.body.identity?.method === 'TWITCH_OAUTH_SESSION',
    `${twClaim.body.claim?.verificationState} via ${twClaim.body.identity?.method}`);

  // B4: cross-platform proof stays no proof — no Kick link, no Kick claim.
  const kickClaim = await post('/api/bounty/claim',
    { platform: 'kick', handle: 'pixelqueen', claimant: 'pixelqueen' }, { Cookie: cookie });
  ok('B4. the SAME name on Kick is still DENIED — no Kick link, no Kick claim',
    kickClaim.body.claim?.verificationState === 'DENIED'
    && /REAL_NO_KICK_LINK/.test(kickClaim.body.identity?.method || ''),
    kickClaim.body.identity?.method);

  // B5: a google-only sign-in has no X proof to offer.
  const gClaim = await post('/api/bounty/claim',
    { platform: 'x', handle: 'pixel_on_x', claimant: 'gfan' }, { Cookie: googleCookie });
  // pixel_on_x already carries a VERIFIED claim (B1), so this exercises the
  // RE-ENTRY branch — whose first cut handed the claim to any signed-in
  // caller before verifying them. This assert is what caught it.
  ok('B5. a google-only sign-in is REFUSED re-entry into another streamer claim',
    gClaim.status === 403
    && /REAL_NO_X_LINK/.test(gClaim.body.identity?.method || ''),
    `HTTP ${gClaim.status} via ${gClaim.body.identity?.method}`);
  const freshDenied = await post('/api/bounty/claim',
    { platform: 'x', handle: 'someone_else', claimant: 'gfan' }, { Cookie: googleCookie });
  ok('B5. ...and a FRESH X claim from a google-only sign-in is DENIED outright',
    freshDenied.body.claim?.verificationState === 'DENIED'
    && /REAL_NO_X_LINK/.test(freshDenied.body.identity?.method || ''),
    freshDenied.body.identity?.method);

  // B6: STREAMER tier rides the same proof — the X owner opens a session.
  const air = await post('/api/bounty/air-session',
    { claimId: xClaim.body.claim.id, platform: 'x', roomId: 'xroom' }, { Cookie: cookie });
  ok('B6. the X owner passes STREAMER tier to open an air session',
    air.status === 200 && !!air.body.airSession, `HTTP ${air.status}`);
  const airAnon = await post('/api/bounty/air-session',
    { claimId: xClaim.body.claim.id, platform: 'x', roomId: 'xroom2' }, { Cookie: googleCookie });
  ok('B6. ...and the google-only account is refused the same route',
    airAnon.status === 401 || airAnon.status === 403, `HTTP ${airAnon.status}`);

  // B7: the X frame path — no external source, no capture: review, not 500.
  await post('/api/bounty/admin/playback',
    { airSessionId: air.body.airSession.id, clipId: 'X1', durationS: 600 }, admin);
  await post('/api/bounty/admin/playback/end',
    { airSessionId: air.body.airSession.id, clipId: 'X1' }, admin);
  await post(`/api/bounty/air-session/${air.body.airSession.id}/end`, {}, { Cookie: cookie });
  const v = await post(`/api/bounty/air-session/${air.body.airSession.id}/verify`,
    { mode: 'real' }, { Cookie: cookie });
  ok('B7. verifying an X session with no capture is a 200, not a route error',
    v.status === 200, `HTTP ${v.status}${v.status !== 200 ? ` — ${JSON.stringify(v.body).slice(0, 120)}` : ''}`);
  ok('B7. ...reported as SOURCE_UNAVAILABLE with X\'s reality in the detail',
    v.body.verification?.result === 'SOURCE_UNAVAILABLE'
    && /no pullable stream/i.test(v.body.verification?.sourceDetail || ''),
    `${v.body.verification?.result}: ${String(v.body.verification?.sourceDetail).slice(0, 80)}`);
  ok('B7. ...routing to a HUMAN with the cause named, money stopped',
    !!v.body.review && /source unavailable/i.test(v.body.review.reason)
    && (v.body.release?.released ?? 0) === 0,
    `review=${!!v.body.review} released=${v.body.release?.released ?? 0}`);

  // B8: the streamer-facing profile tells the X bargain before they rely on it.
  const cfg = await fetch(`${APP}/api/bounty/config`).then((r) => r.json());
  ok('B8. the X platform profile is served with the honest notice',
    cfg.platformProfiles?.x?.vodRetry === false
    && /own recording/i.test(cfg.platformProfiles?.x?.notice || ''),
    (cfg.platformProfiles?.x?.notice || '').slice(0, 60) + '…');
} finally {
  srv.kill();
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
