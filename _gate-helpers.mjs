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
import { randomUUID, createHmac } from 'crypto';
import { mkdtempSync, writeFileSync, existsSync, statSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
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

/** The repo root, resolved from THIS module — never from cwd, because a gate
 *  run from anywhere else would silently compare the wrong trees. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

const DEFAULT_WATCH = ['web/app', 'web/components', 'web/lib'];

/** Newest mtime under a directory, ignoring build output and dependencies. */
function newestUnder(dir) {
  let newest = { at: 0, file: null };
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      let at;
      try { at = statSync(p).mtimeMs; } catch { continue; }
      if (at > newest.at) newest = { at, file: path.relative(REPO_ROOT, p) };
    }
  };
  walk(dir);
  return newest;
}

/**
 * IS THE BUILD UNDER TEST NEWER THAN THE SOURCE IT CLAIMS TO SERVE?
 *
 * `server.js --prod` serves web/.next exactly as it sits on disk, so a gate
 * that drives a page before a rebuild is grading the PREVIOUS tree and
 * reporting it as the current one. That happened for two weeks on
 * _gate-bounty-claim's section G: it asserted a line of copy that the merged
 * source no longer produced, and passed, because the .next it rendered from
 * predated the merge.
 *
 * Returns a VERDICT rather than exiting: each gate owns its own pass/fail
 * counters and RESULT line, and a helper that called process.exit would print
 * someone else's totals.
 *
 *   watch            dirs whose mtimes must predate the build (repo-relative)
 *   requireNextBuild false for gates that render something Express serves
 *                    directly (public/overlay.html), where there is no build
 *                    step to be stale — the file on disk IS what is served.
 *                    The build must still EXIST, because nextApp.prepare()
 *                    runs at boot in prod even for a gate that never loads a
 *                    Next page.
 */
export function assertFreshBuild({ watch = DEFAULT_WATCH, requireNextBuild = true } = {}) {
  const buildId = path.join(REPO_ROOT, 'web', '.next', 'BUILD_ID');
  if (!existsSync(buildId)) {
    return { ok: false, builtAt: null, newestAt: 0, newestFile: null,
      detail: 'no web/.next/BUILD_ID — run `npm run build` first' };
  }
  const builtAt = statSync(buildId).mtimeMs;
  if (!requireNextBuild) {
    return { ok: true, builtAt, newestAt: 0, newestFile: null,
      detail: `build present; ${watch.join(', ')} is served directly, so it cannot be stale` };
  }
  let newest = { at: 0, file: null };
  for (const rel of watch) {
    const n = newestUnder(path.join(REPO_ROOT, rel));
    if (n.at > newest.at) newest = n;
  }
  const ok = builtAt >= newest.at;
  return {
    ok,
    builtAt,
    newestAt: newest.at,
    newestFile: newest.file,
    detail: ok
      ? `built ${new Date(builtAt).toISOString()}, newest source ${new Date(newest.at).toISOString()}`
      : `STALE: ${newest.file} changed ${new Date(newest.at).toISOString()}, after the build at ${new Date(builtAt).toISOString()} — run \`npm run build\``,
  };
}

/**
 * Spawn server.js and return only once it is verifiably OURS and answering.
 * @throws with a diagnostic message (never a silent stale-server pass).
 */
/**
 * Bounty routes authorize server-side now (see bounty-auth.js), so a suite
 * that drives them needs credentials. This mints them: a sealed mc_identity
 * cookie per handle plus an admin key, with the identity records seeded into
 * the server's own data dir so `readIdentityFromRequest` resolves a username.
 *
 * Deliberately NOT a bypass. Gates authenticate exactly the way a streamer
 * does; a test-only escape hatch in the auth path is the thing that later
 * turns out to be reachable in production.
 */
/**
 * Mint gate credentials: one ACCOUNT per handle, written to accounts.json in
 * the store's own shape, plus a sealed cookie for each.
 *
 * It used to write `identities.json` with one `provider:platformId` row per
 * handle, because that was the identity. Since the account layer, a person is
 * an account with links and everything owner-keyed carries the ACCOUNT ID —
 * so a gate that needs an owner key asks `accountIdFor(handle)` instead of
 * building `provider:platformId` itself. The cookie still seals
 * `{provider, platformId}`, which `readIdentityFromRequest` resolves through
 * the link table exactly as it resolves a real one.
 */
export function mintBountyAuth({ handles = [], dataDir }) {
  const authSecret = `gate-auth-${randomUUID()}`;
  const adminKey = `gate-admin-${randomUUID()}`;
  const accounts = {};
  const handleMap = {};
  const links = {};
  const cookies = {};
  const accountIds = {};
  handles.forEach((raw, i) => {
    // "handle" or "platform:handle"; platform defaults to twitch.
    const [platform, handle] = raw.includes(':') ? raw.split(':') : ['twitch', raw];
    const platformId = String(1000 + i);
    const accountId = `acct_gate${String(i).padStart(4, '0')}${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const now = new Date().toISOString();
    accounts[accountId] = {
      id: accountId,
      handle,
      primary: platform,
      createdAt: now,
      links: [{ provider: platform, platformId, username: handle, handle, linkedAt: now, attributes: null, attributesFetchedAt: null }],
      reservedHandles: [],
    };
    handleMap[handle] = accountId;
    links[`${platform}:${platformId}`] = accountId;
    accountIds[raw] = accountId;
    const payload = Buffer.from(JSON.stringify({ provider: platform, platformId })).toString('base64url');
    const sig = createHmac('sha256', authSecret).update(payload).digest('base64url');
    cookies[raw] = `mc_identity=${encodeURIComponent(`${payload}.${sig}`)}`;
  });
  writeFileSync(path.join(dataDir, 'accounts.json'),
    JSON.stringify({ accounts, handles: handleMap, links }, null, 2));
  const first = handles[0];
  const cookieFor = (h) => cookies[h] ?? cookies[first] ?? '';
  return {
    authSecret, adminKey, cookieFor,
    /** The owner key for `handle` — what rooms, whitelists and bounties store. */
    accountIdFor: (h) => accountIds[h] ?? accountIds[first] ?? null,
    env: { AUTH_SECRET: authSecret, BOUNTY_ADMIN_KEY: adminKey },
    /** Spread into a fetch's headers to act as `handle` (default: the first). */
    headers: (h) => ({ Cookie: cookieFor(h), 'x-bounty-admin-key': adminKey }),
  };
}

export async function startGateServer({
  port,
  env = {},
  args = ['server.js', '--prod'],
  readyTimeoutMs = 45_000,
  dataDir = null,
  label = `:${port}`,
  /** e.g. { handles: ['pipestreamer', 'kick:someslug'] } */
  bountyAuth = null,
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

  const resolvedDataDir = dataDir || mkdtempSync(path.join(tmpdir(), 'mc-gate-'));
  const auth = bountyAuth
    ? mintBountyAuth({ ...bountyAuth, dataDir: resolvedDataDir })
    : null;

  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: resolvedDataDir,
      GATE_NONCE: nonce,
      ...(auth ? auth.env : {}),
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
            dataDir: resolvedDataDir,
            // Present only when bountyAuth was requested. `headers(handle)`
            // spreads into a fetch to act as that streamer plus admin.
            adminKey: auth?.adminKey ?? null,
            cookieFor: auth ? auth.cookieFor : () => '',
            headers: auth ? auth.headers : () => ({}),
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
