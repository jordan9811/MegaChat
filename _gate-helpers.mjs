/**
 * SHARED GATE HARNESS — spawn a server you can TRUST is the one you started.
 *
 * The p2-moderation incident: a node process from three days earlier still
 * held :3222. Every later gate run spawned its own server, which died
 * instantly on EADDRINUSE — with `stdio: 'ignore'` swallowing the error — and
 * the gate then drove the STALE process, whose config pointed at long-dead
 * mocks. It failed 6/4 for days and was written off as "pre-existing".
 *
 * A gate that fails is annoying. A gate that PASSES while driving a stale
 * server is a lie, and that is the failure this closes. Four defences, in the
 * order they catch things:
 *
 *  1. PORT PRECHECK — refuse to start if something already listens there,
 *     naming the port. No more silent inheritance.
 *  2. SPAWN + EARLY-EXIT WATCH — child 'error' and any exit during startup
 *     are captured with the tail of stderr, instead of vanishing.
 *  3. READINESS POLL, not a blind sleep — wait until /api/health answers,
 *     with a real timeout and the captured stderr in the failure message.
 *  4. IDENTITY NONCE — /api/health echoes GATE_NONCE, and we assert the
 *     responder is OUR process. This is the one that would have caught the
 *     zombie even if it had somehow passed 1-3: a stale server cannot know a
 *     nonce minted seconds ago.
 *
 * Usage:
 *   const srv = await startGateServer({ port: 3301, env: { BOUNTY_CLAIM: '1' } });
 *   ...
 *   srv.kill();          // and srv.stderr() for diagnostics on failure
 */
import { spawn } from 'child_process';
import { createServer } from 'net';
import { randomUUID } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is anything already listening on this port? */
export function portInUse(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (e) => resolve(e.code === 'EADDRINUSE'));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port, host);
  });
}

/**
 * Spawn server.js and return only once it is verifiably OURS and answering.
 * @throws with a diagnostic message (never a silent stale-server pass).
 */
export async function startGateServer({
  port,
  env = {},
  args = ['server.js', '--prod'],
  readyTimeoutMs = 45_000,
  dataDir = null,
  label = `:${port}`,
} = {}) {
  if (await portInUse(port)) {
    throw new Error(
      `[gate-harness] port ${port} is ALREADY IN USE before ${label} started. `
      + 'Refusing to run: the suite would silently drive whatever is there. '
      + `Find it with:  netstat -ano | grep ":${port} .*LISTEN"`,
    );
  }

  const nonce = randomUUID();
  let stderr = '';
  let exitedEarly = null;

  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir || mkdtempSync(path.join(tmpdir(), 'mc-gate-')),
      GATE_NONCE: nonce,
      ...env,
    },
    // stdio 'ignore' is what hid the original failure. Pipe and KEEP it.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { stderr += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('error', (e) => { exitedEarly = `spawn error: ${e.message}`; });
  child.on('exit', (code, sig) => {
    if (exitedEarly === null) exitedEarly = `exited early (code ${code}${sig ? `, ${sig}` : ''})`;
  });

  const deadline = Date.now() + readyTimeoutMs;
  let lastErr = 'no response yet';
  while (Date.now() < deadline) {
    if (exitedEarly) {
      throw new Error(`[gate-harness] ${label} ${exitedEarly}\n--- server output ---\n${stderr.slice(-1200)}`);
    }
    try {
      const r = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(2500) });
      if (r.ok) {
        const body = await r.json();
        if (body.gateNonce === nonce) {
          return {
            child, port, nonce,
            stderr: () => stderr,
            kill: () => { try { child.kill(); } catch { /* already gone */ } },
          };
        }
        // Answering, but NOT ours. This is precisely the zombie case.
        child.kill();
        throw new Error(
          `[gate-harness] ${label}: something is answering on ${port} that is NOT the server this suite `
          + `started (nonce mismatch: got ${body.gateNonce ?? 'none'}). A stale process is holding the port.`,
        );
      }
      lastErr = `health returned ${r.status}`;
    } catch (e) {
      if (/nonce mismatch/.test(e.message)) throw e;
      lastErr = e.message;
    }
    await sleep(400);
  }
  child.kill();
  throw new Error(
    `[gate-harness] ${label} never became ready within ${readyTimeoutMs}ms (${lastErr})`
    + `\n--- server output ---\n${stderr.slice(-1200)}`,
  );
}
