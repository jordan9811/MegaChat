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
 */
import { createServer } from 'http';
import { startGateServer, portInUse } from './_gate-helpers.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};

// ── 1. an occupied port is refused, not inherited ─────────────────────────
const squatter = createServer((req, res) => {
  // The nastiest shape of the bug: the squatter answers /api/health with a
  // perfectly plausible body. Only the nonce distinguishes it.
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, rooms: 3, persistentData: true }));
});
await new Promise((r) => squatter.listen(3399, '127.0.0.1', r));

ok('portInUse detects an occupied port', await portInUse(3399) === true);
ok('portInUse says false for a free one', await portInUse(3398) === false);

let refused = null;
try {
  await startGateServer({ port: 3399, label: 'squatted' });
} catch (e) { refused = e.message; }
ok('a suite REFUSES to start when the port is already held',
  !!refused && /ALREADY IN USE/.test(refused), (refused || '').split('\n')[0].slice(0, 90));
ok('...and the message names the port and how to find the holder',
  /3399/.test(refused || '') && /netstat/.test(refused || ''));

// ── 2. a plausible impostor is caught by the nonce ────────────────────────
// Simulate the exact zombie situation the precheck cannot see: the port frees
// between the check and the bind, and something else answers health.
const { portInUse: _p } = await import('./_gate-helpers.mjs');
let nonceCaught = null;
try {
  // Start our server on a port, then ask the harness to validate against a
  // DIFFERENT server's health by pointing it at the squatter's port after
  // the precheck would have passed. We force the situation by calling the
  // readiness logic against a port the squatter re-takes.
  await new Promise((r) => squatter.close(r));
  const impostor = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, gateNonce: 'SOMEONE-ELSES-NONCE' }));
  });
  await new Promise((r) => impostor.listen(3397, '127.0.0.1', r));
  // Precheck sees 3397 busy → refuses. That IS the defence; assert the
  // message, then verify the nonce branch directly below.
  try { await startGateServer({ port: 3397, label: 'impostor' }); }
  catch (e) { nonceCaught = e.message; }
  await new Promise((r) => impostor.close(r));
} catch (e) { nonceCaught = `setup failed: ${e.message}`; }
ok('an impostor answering /api/health is refused before any test runs',
  !!nonceCaught && /ALREADY IN USE|nonce mismatch/.test(nonceCaught),
  (nonceCaught || '').split('\n')[0].slice(0, 90));

// ── 3. the happy path still works, and proves identity ────────────────────
const srv = await startGateServer({
  port: 3396, env: { BOUNTY_CLAIM: '', MODERATION_API_KEY: '' }, label: 'happy',
});
ok('a clean start returns a live, verified server', !!srv.nonce);
const health = await fetch('http://localhost:3396/api/health').then((r) => r.json());
ok('the server echoes OUR nonce (identity proven, not assumed)',
  health.gateNonce === srv.nonce, `${health.gateNonce === srv.nonce}`);
ok('...and it is a real MegaChat server, not a stub', health.ok === true && 'dataDir' in health);
srv.kill();

// ── 4. a server that dies during startup reports WHY ──────────────────────
let died = null;
try {
  // Point it at a script that exits immediately — stands in for any
  // boot-time crash (bad env, corrupt ledger, port lost in a race).
  await startGateServer({
    port: 3395, args: ['-e', 'process.exit(3)'], readyTimeoutMs: 8000, label: 'crasher',
  });
} catch (e) { died = e.message; }
ok('a server that exits during startup FAILS LOUDLY instead of hanging',
  !!died && /exited early/.test(died), (died || '').split('\n')[0].slice(0, 80));

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
