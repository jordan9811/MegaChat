/**
 * VERIFY — the gate harness refuses to be fooled by a stale server.
 *
 * This is the regression test for the p2-moderation incident: a three-day-old
 * process held the port, the spawn died on EADDRINUSE with its error
 * swallowed, and the gate drove the zombie for days while reporting a
 * plausible-looking 6/4.
 *
 * A defence that has never been seen to fire is not a defence, so every case
 * here CREATES the failure and asserts the harness catches it.
 *
 * Cases 1 and 2 used to pass without testing what they are named for (audit
 * harness-3): the squatter bound 127.0.0.1, the one address the old bind probe
 * could see, and the "impostor" was refused by the precheck, so the nonce
 * branch never ran. Case 1 now squats the way server.js and a 0.0.0.0 server
 * do, and replays the old probe beside the new one to show they disagree;
 * case 2's impostor is the spawned child itself, so the precheck passes and
 * only the nonce can catch it. Cases 5-8 cover what the helper hands the
 * child (no live key unless named), the accounts merge, the sealing secret
 * and the build-config watch.
 *
 * Ports 3460-3467: private to this file.
 */
import { createServer } from 'http';
import { createServer as createTcpServer } from 'net';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  startGateServer, portInUse, mintBountyAuth, assertFreshBuild, DEFAULT_WATCH, SENSITIVE_ENV,
} from './_gate-helpers.mjs';
import { seedAccountForLink, sealSessionValue } from './_gate-identity-helper.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. an occupied port is refused, not inherited ─────────────────────────
// The probe this replaced, kept here so the case shows the two disagree.
const oldProbe = (port) => new Promise((resolve) => {
  const p = createTcpServer();
  p.once('error', (e) => resolve(e.code === 'EADDRINUSE'));
  p.once('listening', () => p.close(() => resolve(false)));
  p.listen(port, '127.0.0.1');
});
// The nastiest shape of the bug: the squatter answers /api/health with a
// perfectly plausible body. Only the nonce distinguishes it.
const plausible = () => createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, rooms: 3, persistentData: true }));
});
// '0.0.0.0' is a server on every IPv4 address; no host is listen(PORT), which
// is how server.js binds ('::', dual-stack).
for (const [host, shape] of [['0.0.0.0', 'every IPv4 address'], [undefined, 'the way server.js binds']]) {
  const squatter = plausible();
  await new Promise((r) => (host ? squatter.listen(3467, host, r) : squatter.listen(3467, r)));
  const before = await oldProbe(3467);
  ok(`1. portInUse sees a server bound on ${shape}`, await portInUse(3467) === true);
  // Windows lets a 127.0.0.1 bind sit beside a wildcard listener; that is the
  // hole, and the host this harness runs on.
  ok(`1. ...which the old 127.0.0.1 bind probe called free (the two disagree)`, process.platform !== 'win32' || before === false, `old probe: ${before ? 'in use' : 'free'}`);
  let refused = null;
  try { await startGateServer({ port: 3467, label: 'squatted' }); } catch (e) { refused = e.message; }
  ok(`1. a suite REFUSES to start on a port held on ${shape}`,
    !!refused && /ALREADY IN USE/.test(refused), (refused || '').split('\n')[0].slice(0, 90));
  ok('1. ...and the message names the port and how to find the holder',
    /3467/.test(refused || '') && /netstat/.test(refused || ''));
  await new Promise((r) => squatter.close(r));
}
ok('1. portInUse says false for a free port', await portInUse(3466) === false);

// ── 2. a plausible impostor is caught by the nonce ────────────────────────
// The zombie the precheck cannot see: the port is free when it is checked,
// and what answers /api/health afterwards is not the server the suite
// started (the real child died on EADDRINUSE in a race, and a stale process
// answers). Here the spawned child IS the impostor: it binds the port after
// the precheck has passed and answers with someone else's nonce, so the only
// defence left to fire is the nonce.
const IMPOSTOR = `require('http').createServer((q, s) => { s.setHeader('Content-Type', 'application/json');
  s.end(JSON.stringify({ ok: true, rooms: 3, gateNonce: 'SOMEONE-ELSES-NONCE' })); }).listen(Number(process.env.PORT));`;
let nonceCaught = null;
try { await startGateServer({ port: 3465, args: ['-e', IMPOSTOR], readyTimeoutMs: 10_000, label: 'impostor' }); }
catch (e) { nonceCaught = e.message; }
ok('2. an impostor answering /api/health past a clean precheck is refused by the NONCE',
  !!nonceCaught && /nonce mismatch/.test(nonceCaught) && !/ALREADY IN USE/.test(nonceCaught),
  (nonceCaught || '').split('\n')[0].slice(0, 110));
ok('2. ...and the message says what it got', /SOMEONE-ELSES-NONCE/.test(nonceCaught || ''));
await sleep(500);
ok('2. ...and the impostor child is killed, not left on the port', await portInUse(3465) === false);

// ── 3. the happy path still works, and proves identity ────────────────────
const srv = await startGateServer({ port: 3464, env: { BOUNTY_CLAIM: '' }, label: 'happy' });
ok('3. a clean start returns a live, verified server', !!srv.nonce);
const health = await fetch('http://localhost:3464/api/health').then((r) => r.json());
ok('3. the server echoes OUR nonce (identity proven, not assumed)',
  health.gateNonce === srv.nonce, `${health.gateNonce === srv.nonce}`);
ok('3. ...and it is a real MegaChat server, not a stub', health.ok === true && 'dataDir' in health);
ok('3. ...booted with every SENSITIVE_ENV name blank', SENSITIVE_ENV.every((n) => (srv.blankedEnv || []).includes(n)),
  `${(srv.blankedEnv || []).length} names blank`);
srv.kill();

// ── 4. a server that dies during startup reports WHY ──────────────────────
let died = null;
try {
  // Point it at a script that exits immediately — stands in for any
  // boot-time crash (bad env, corrupt ledger, port lost in a race).
  await startGateServer({
    port: 3463, args: ['-e', 'process.exit(3)'], readyTimeoutMs: 8000, label: 'crasher',
  });
} catch (e) { died = e.message; }
ok('4. a server that exits during startup FAILS LOUDLY instead of hanging',
  !!died && /exited early/.test(died), (died || '').split('\n')[0].slice(0, 80));

// ── 5. the child never inherits a live key unless the gate names it ───────
// The child here is a probe, not server.js: it loads .env exactly the way
// server.js does (process.loadEnvFile() in its cwd), then reports, as
// booleans only, which names it ended up with. Its cwd is a scratch dir with
// a FAKE .env, so the case never depends on, or touches, the real one.
const fakeRoot = mkdtempSync(path.join(tmpdir(), 'mc-harness-env-'));
const FAKE_KEY = `0x${'1'.repeat(64)}`;
writeFileSync(path.join(fakeRoot, '.env'), [
  `SELLER_PRIVATE_KEY=${FAKE_KEY}`, 'LIVEKIT_URL=wss://fake.livekit.invalid', 'LIVEKIT_API_KEY=fake',
  'LIVEKIT_API_SECRET=fake', 'MODERATION_API_KEY=fake', 'GATE_HARNESS_NEW_TOKEN=fake', 'GATE_HARNESS_PLAIN=plain',
].join('\n'));
const REPORT = ['SELLER_PRIVATE_KEY', 'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'MODERATION_API_KEY',
  'GATE_HARNESS_NEW_TOKEN', 'GATE_HARNESS_PLAIN', 'GATE_HARNESS_PROBE_SECRET'];
const PROBE = `try { process.loadEnvFile(); } catch {}
const names = ${JSON.stringify(REPORT)};
require('http').createServer((q, s) => { s.setHeader('Content-Type', 'application/json');
  s.end(JSON.stringify({ ok: true, gateNonce: process.env.GATE_NONCE,
    set: Object.fromEntries(names.map((n) => [n, !!process.env[n]])),
    sellerIsFake: process.env.SELLER_PRIVATE_KEY === ${JSON.stringify(FAKE_KEY)},
    sellerIsGiven: process.env.SELLER_PRIVATE_KEY === '0x${'2'.repeat(64)}' })); }).listen(Number(process.env.PORT));`;
process.env.GATE_HARNESS_PROBE_SECRET = 'set-in-the-gate-process';
const probe = async (opts) => {
  const s = await startGateServer({ port: 3462, args: ['-e', PROBE], cwd: fakeRoot, label: 'env-probe', readyTimeoutMs: 10_000, ...opts });
  try { return await fetch('http://localhost:3462/api/health').then((r) => r.json()); } finally { s.kill(); await sleep(300); }
};
const dflt = await probe({});
// Every "blank" below is read beside GATE_HARNESS_PLAIN: a child that never
// loaded the fake .env would report everything blank and prove nothing.
ok('5. a key in .env reaches the child BLANK (SELLER_PRIVATE_KEY, MODERATION_API_KEY)',
  dflt.set.GATE_HARNESS_PLAIN === true && dflt.set.SELLER_PRIVATE_KEY === false && dflt.set.MODERATION_API_KEY === false,
  JSON.stringify(dflt.set));
ok('5. ...all three LiveKit names too, so no gate room lands on LiveKit Cloud',
  !dflt.set.LIVEKIT_URL && !dflt.set.LIVEKIT_API_KEY && !dflt.set.LIVEKIT_API_SECRET);
ok('5. ...a name nobody listed is caught by its suffix (…_TOKEN in .env, …_SECRET in the gate process)',
  dflt.set.GATE_HARNESS_NEW_TOKEN === false && dflt.set.GATE_HARNESS_PROBE_SECRET === false);
ok('5. ...while an ordinary name in .env still arrives (the probe really loaded it)', dflt.set.GATE_HARNESS_PLAIN === true);
const kept = await probe({ keepEnv: ['SELLER_PRIVATE_KEY', 'GATE_HARNESS_PROBE_SECRET'] });
ok('5. keepEnv opts a named key back in, from .env or from the gate process',
  kept.sellerIsFake === true && kept.set.GATE_HARNESS_PROBE_SECRET === true && kept.set.MODERATION_API_KEY === false);
const given = await probe({ env: { SELLER_PRIVATE_KEY: `0x${'2'.repeat(64)}` } });
ok('5. a value the gate sets in env wins (a generated stand-in key)', given.sellerIsGiven === true);
const undef = await probe({ env: { SELLER_PRIVATE_KEY: undefined } });
ok('5. ...but env: { NAME: undefined } does not un-blank it (it used to drop the name, and .env refilled it)',
  undef.set.GATE_HARNESS_PLAIN === true && undef.set.SELLER_PRIVATE_KEY === false);
delete process.env.GATE_HARNESS_PROBE_SECRET;
let badKeep = null;
try { await startGateServer({ port: 3461, keepEnv: 'SELLER_PRIVATE_KEY' }); } catch (e) { badKeep = e.message; }
ok('5. keepEnv must be a list of names (a bare string is refused before anything boots)', /keepEnv must be/.test(badKeep || ''));

// ── 6. mintBountyAuth merges into accounts.json instead of replacing it ───
const mergeDir = mkdtempSync(path.join(tmpdir(), 'mc-harness-accounts-'));
const seeded = seedAccountForLink(mergeDir, { provider: 'twitch', platformId: 'seed1', username: 'seededfan' });
const minted = mintBountyAuth({ handles: ['mintedstreamer'], dataDir: mergeDir });
const store = JSON.parse(readFileSync(path.join(mergeDir, 'accounts.json'), 'utf8'));
ok('6. an account seeded before mintBountyAuth survives it (the file used to be overwritten)',
  !!store.accounts?.[seeded] && store.links?.['twitch:seed1'] === seeded && store.handles?.seededfan === seeded);
ok('6. ...and the minted account is there beside it', !!store.accounts?.[minted.accountIdFor('mintedstreamer')]);

// ── 7. sealing with no secret is an error, not the public dev constant ────
const savedSecrets = { AUTH_SECRET: process.env.AUTH_SECRET, MPP_SECRET_KEY: process.env.MPP_SECRET_KEY };
delete process.env.AUTH_SECRET; delete process.env.MPP_SECRET_KEY;
let sealErr = null;
try { sealSessionValue('acct_x'); } catch (e) { sealErr = e.message; }
ok('7. sealSessionValue with no AUTH_SECRET throws (a --prod server refuses the dev constant)', /no secret to seal with/.test(sealErr || ''));
ok('7. ...and an explicit secret still seals', /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(sealSessionValue('acct_x', { secret: 's' })));
for (const [k, v] of Object.entries(savedSecrets)) if (v !== undefined) process.env[k] = v;

// ── 8. the freshness check watches the build config, not only the source ──
ok('8. DEFAULT_WATCH includes web/next.config.mjs and web/package.json',
  DEFAULT_WATCH.includes('web/next.config.mjs') && DEFAULT_WATCH.includes('web/package.json'));
const one = assertFreshBuild({ watch: ['web/package.json'] });
ok('8. a watched FILE is compared by its own mtime (a directory walk saw nothing in it)',
  one.builtAt === null || /package\.json$/.test(one.newestFile || ''), one.newestFile || one.detail);

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
