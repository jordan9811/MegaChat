/**
 * GATE — the Privy front door's REJECTION WALL, plus proof the deleted
 * in-house OAuth flow stays deleted.
 *
 * Replaces _gate-phase5-oauth.mjs, which drove /auth/twitch and the join-page
 * #authTwitchBtn — both deliberately deleted in 3a8d55e ("one front door —
 * Privy does Twitch, so the second sign-in is deleted"). That gate then
 * CRASHED on every run for weeks, which is worse than red: it trained the
 * suite output to contain a stack trace nobody read.
 *
 * What the current surface actually is: the Privy modal client-side, and
 * POST /api/auth/privy server-side, which verifies the access token against
 * Privy's keys and mints a handle. The ACCEPT path cannot run here — it
 * requires a token signed by Privy for a real app id, and faking that would
 * mean patching the verifier, i.e. gating a bypass instead of the code. What
 * CAN be proven locally, deterministically, and matters most, is that the
 * wall fails CLOSED:
 *
 *   - unconfigured server: 503, honestly reported by /api/auth/providers
 *   - junk / missing / non-string / forged tokens: 400 or 401, and CRITICALLY
 *     no cookie is set and NOTHING is minted into the identity store — the
 *     store is byte-compared before and after, because "verification ran" is
 *     not the assertion, "nothing was created" is
 *   - a forged mc_identity cookie reads back as nobody
 *   - the deleted flow STAYS deleted: the served pages carry zero /auth/*
 *     anchors and none of the old button ids
 *
 * The forged-JWT case may attempt a JWKS fetch that fails (fake app id, or no
 * network); the route maps EVERY failure to 401, so the assertion holds
 * either way — fail-closed is exactly the property under test.
 *
 * Zero external spend: no real Privy credentials exist in this environment.
 */
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { createHmac } from 'crypto';
import { startGateServer } from './_gate-helpers.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};

const b64url = (buf) => Buffer.from(buf).toString('base64url');
/** A structurally valid JWT signed with OUR key — i.e. forged. */
function forgedJwt() {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({
    sub: 'did:privy:forged', userId: 'did:privy:forged',
    iss: 'privy.io', exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  const sig = createHmac('sha256', 'attacker-key').update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

const identityStoreBytes = (dataDir) => {
  const f = path.join(dataDir, 'identities.json');
  return existsSync(f) ? readFileSync(f, 'utf8') : '<absent>';
};

// ── A. unconfigured server: honest 503, nothing pretends ──────────────────
const plain = await startGateServer({
  port: 3225, label: 'privy-unconfigured',
  env: {
    NEXT_PUBLIC_PRIVY_APP_ID: '', PRIVY_APP_ID: '', PRIVY_APP_SECRET: '',
    KEEP_ORPHAN_ROOMS: 'true',
  },
});
try {
  const APP = 'http://localhost:3225';
  const prov = await (await fetch(`${APP}/api/auth/providers`)).json();
  ok('A. providers reports privy unconfigured', prov.privy === false && prov.privyReady === false,
    JSON.stringify({ privy: prov.privy, privyReady: prov.privyReady }));
  const r = await fetch(`${APP}/api/auth/privy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: forgedJwt() }),
  });
  ok('A. /api/auth/privy answers 503 with no Privy env', r.status === 503, `HTTP ${r.status}`);
  ok('A. ...and sets no cookie', !r.headers.get('set-cookie'));
  const me = await (await fetch(`${APP}/api/auth/me`)).json();
  ok('A. /api/auth/me with no cookie is nobody', me.identity === null, JSON.stringify(me));
} finally { plain.kill(); }

// ── B. configured-but-fake server: every bad token bounces, mints nothing ─
const srv = await startGateServer({
  port: 3226, label: 'privy-fake-creds',
  env: {
    NEXT_PUBLIC_PRIVY_APP_ID: 'gate-fake-app-id', PRIVY_APP_SECRET: 'gate-fake-secret',
    // Blank the legacy providers too: the machine running this gate has real
    // Twitch creds in .env, and inheriting them makes the legacy-route check
    // depend on the machine instead of the code.
    TWITCH_CLIENT_ID: '', TWITCH_CLIENT_SECRET: '', X_CLIENT_ID: '', X_CLIENT_SECRET: '',
    KEEP_ORPHAN_ROOMS: 'true',
  },
});
try {
  const APP = 'http://localhost:3226';
  const storeBefore = identityStoreBytes(srv.dataDir);

  const post = (body) => fetch(`${APP}/api/auth/privy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const missing = await post({});
  ok('B. missing token → 400', missing.status === 400, `HTTP ${missing.status}`);
  const nonString = await post({ token: 12345 });
  ok('B. non-string token → 400', nonString.status === 400, `HTTP ${nonString.status}`);
  const junk = await post({ token: 'not-a-jwt-at-all' });
  ok('B. junk token → 401, never 200', junk.status === 401, `HTTP ${junk.status}`);
  ok('B. ...junk sets no cookie', !junk.headers.get('set-cookie'));
  const forged = await post({ token: forgedJwt() });
  ok('B. structurally-valid FORGED jwt → 401', forged.status === 401, `HTTP ${forged.status}`);
  ok('B. ...forged sets no cookie', !forged.headers.get('set-cookie'));
  const forgedBody = await forged.json();
  ok('B. ...and the error body leaks no identity fields',
    !('identity' in forgedBody) && !('handle' in forgedBody), JSON.stringify(forgedBody));

  // THE assertion: not that verification ran — that nothing was CREATED.
  const storeAfter = identityStoreBytes(srv.dataDir);
  ok('B. identity store is byte-identical after every rejection (nothing minted)',
    storeAfter === storeBefore,
    `before=${storeBefore.length}B after=${storeAfter.length}B`);

  // Forged session cookie reads back as nobody.
  const badCookie = await (await fetch(`${APP}/api/auth/me`, {
    headers: { Cookie: `mc_identity=${b64url('{"provider":"privy","platformId":"did:privy:x"}')}.forgedsig` },
  })).json();
  ok('B. a forged mc_identity cookie is nobody', badCookie.identity === null, JSON.stringify(badCookie));

  // ── C. the deleted flow STAYS deleted ───────────────────────────────────
  // This is the stale gate's replacement duty: 3a8d55e removed the in-house
  // OAuth buttons and routes. Assert the served pages carry neither, so a
  // regression that resurrects the second sign-in fails a gate instead of
  // shipping.
  for (const p of ['/join?room=default', '/']) {
    const html = await (await fetch(`${APP}${p}`)).text();
    const anchors = (html.match(/href="\/auth\//g) || []).length;
    const oldBtns = /authTwitchBtn|authXBtn/.test(html);
    ok(`C. ${p} carries zero /auth/* anchors and no legacy auth buttons`,
      anchors === 0 && !oldBtns && html.length > 2000,
      `${anchors} anchors, legacyBtns=${oldBtns}, ${html.length}B served`);
  }
  // The legacy route itself survives ON PURPOSE (3a8d55e: "old links/cookies
  // degrade honestly") — what must hold is that unconfigured it refuses with
  // 503 rather than erroring or, worse, answering 200 with a sign-in.
  const oldRoute = await fetch(`${APP}/auth/twitch`, { redirect: 'manual' });
  ok('C. the unlinked legacy /auth/twitch degrades honestly (503 unconfigured)',
    oldRoute.status === 503, `HTTP ${oldRoute.status}`);
} finally { srv.kill(); }

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
