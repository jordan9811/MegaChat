/**
 * VERIFY — Task 8's build half.
 *
 *  A. REAL identity verification (BOUNTY_IDENTITY_REAL=1) over HTTP: a claim
 *     is approved only when the requester's SIGNED-IN Twitch session owns the
 *     handle. No session → denied. Wrong handle → denied. Right handle →
 *     approved with method TWITCH_OAUTH_SESSION in the ledger.
 *  B. Viewer-count capture at clip playback, against a mocked Helix: the
 *     evidence log gains a VIEWER_SAMPLE row with the count — data that can
 *     never be backfilled. (The capture is a playback HOOK, not a route; this
 *     section drives the hook against the real modules and mock API, stated
 *     honestly.)
 */
import { spawn } from 'child_process';
import { createServer } from 'http';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHmac } from 'crypto';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3303;
const APP = `http://localhost:${PORT}`;
const AUTH_SECRET = 'oauth-verify-secret';

// ── A. real identity verification over HTTP ─────────────────────────────────
const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-oauth-'));
writeFileSync(path.join(dataDir, 'identities.json'), JSON.stringify({
  identities: {
    'twitch:tw9': {
      provider: 'twitch', platformId: 'tw9', username: 'realstreamer',
      handle: 'realstreamer', createdAt: new Date().toISOString(),
    },
  },
  handles: { realstreamer: 'twitch:tw9' },
}));
const seal = (o) => {
  const p = Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${p}.${createHmac('sha256', AUTH_SECRET).update(p).digest('base64url')}`;
};
const sessionCookie = `mc_identity=${encodeURIComponent(seal({ provider: 'twitch', platformId: 'tw9' }))}`;

const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: {
    ...process.env, PORT: String(PORT), DATA_DIR: dataDir, AUTH_SECRET,
    BOUNTY_CLAIM: '1', BOUNTY_IDENTITY_REAL: '1', KEEP_ORPHAN_ROOMS: 'true',
    MODERATION_API_KEY: '',
  },
  stdio: 'ignore', cwd: process.cwd(),
});
await sleep(11000);

const post = (p, body, headers = {}) => fetch(`${APP}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

try {
  // Seed a pool for the handle.
  await post('/api/bounty/pledge', {
    targets: [{ platform: 'twitch', handle: 'realstreamer' }],
    contributor: '0xfan', amount: '10', expiresInMs: 7 * 86_400_000,
  });

  // A second pool so the wrong-handle case exercises identity, not a 404.
  await post('/api/bounty/pledge', {
    targets: [{ platform: 'twitch', handle: 'someoneelse' }],
    contributor: '0xfan', amount: '5', expiresInMs: 7 * 86_400_000,
  });

  const anon = await post('/api/bounty/claim', { platform: 'twitch', handle: 'realstreamer', claimant: 'whoever' });
  ok('A. an anonymous claim is DENIED', anon.body.identity?.approved === false, anon.body.identity?.method);
  ok('A. ...with a method naming the reason', anon.body.identity?.method === 'REAL_NOT_SIGNED_IN');
  // The route-level regression this verifier caught: the denied claim above
  // must NOT wedge the handle — the owner's claim below has to succeed.

  const wrong = await post('/api/bounty/claim',
    { platform: 'twitch', handle: 'someoneelse', claimant: 'whoever' },
    { cookie: sessionCookie });
  ok('A. a signed-in session claiming SOMEONE ELSE\'S handle is DENIED',
    wrong.body.identity?.approved === false && wrong.body.identity?.method === 'REAL_HANDLE_MISMATCH',
    wrong.body.identity?.method);

  const right = await post('/api/bounty/claim',
    { platform: 'twitch', handle: 'realstreamer', claimant: 'realstreamer' },
    { cookie: sessionCookie });
  ok('A. the channel owner\'s session claiming THEIR handle is APPROVED',
    right.body.identity?.approved === true, right.body.identity?.method);
  ok('A. the approval method is the OAuth session, not a stub',
    right.body.identity?.method === 'TWITCH_OAUTH_SESSION');
  const ledg = await fetch(`${APP}/api/bounty/admin/ledger?handleKey=twitch:realstreamer`)
    .then((r) => r.json()).catch(() => ({}));
  ok('A. the ledger records HOW identity was verified (never mistakable for a stub)',
    JSON.stringify(ledg).includes('TWITCH_OAUTH_SESSION')
    && !JSON.stringify(ledg).match(/STUBBED_APPROVAL/), 'method in IDENTITY_CHECK row');
} finally {
  app.kill();
}

// ── B. viewer-count capture against a mocked Helix ──────────────────────────
const mock = createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (/oauth2\/token/.test(req.url)) return res.end(JSON.stringify({ access_token: 'mock-app-token', expires_in: 3600 }));
    res.end(JSON.stringify({ data: [{ viewer_count: 1234, started_at: '2026-07-27T00:00:00Z' }] }));
  });
});
await new Promise((r) => mock.listen(3999, r));

process.env.BOUNTY_CLAIM = '1';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'mc-viewer-'));
process.env.TWITCH_CLIENT_ID = 'mock-id';
process.env.TWITCH_CLIENT_SECRET = 'mock-secret';
process.env.TWITCH_ID_BASE = 'http://localhost:3999';
process.env.TWITCH_API_BASE = 'http://localhost:3999';

const store = await import('./bounty-store.js');
const escrowMod = await import('./bounty-escrow.js');
const { makeClipHooks } = await import('./bounty-routes.js');
store.verifyEvidenceIntegrity();

escrowMod.reserve({ platform: 'twitch', handle: 'viewertest' });
const claim = store.createClaim({ handleKey: 'twitch:viewertest', claimant: 'v', ttlMs: 1e9 });
store.createAirSession({ claimId: claim.id, roomId: 'vroom', platform: 'twitch' });
const hooks = makeClipHooks({ log: { log() {}, warn() {}, error() {} } });
hooks.onClipPlay('vroom', { clipId: 'VC1', durationS: 8 });
await sleep(1500); // the capture is deliberately fire-and-forget

const evPath = path.join(process.env.DATA_DIR, 'bounty-evidence.jsonl');
const rows = readFileSync(evPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const sample = rows.find((r) => r.type === 'VIEWER_SAMPLE');
ok('B. clip playback captures a VIEWER_SAMPLE into the EVIDENCE log', !!sample);
ok('B. it carries the live flag and the concurrent count (unbackfillable data)',
  sample?.live === true && sample?.viewerCount === 1234, JSON.stringify(sample || {}));
ok('B. it is bound to the playback, not just the session',
  !!sample?.playbackId && sample?.clipId === 'VC1', sample?.playbackId);
ok('B. the evidence chain still validates with the new row type',
  (() => { try { store.verifyEvidenceIntegrity(); return true; } catch { return false; } })());

mock.close();
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
