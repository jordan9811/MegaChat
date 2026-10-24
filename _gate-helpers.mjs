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
 *     on any address `localhost` can reach, naming the port. No more silent
 *     inheritance.
 *  2. SPAWN + EARLY-EXIT WATCH — child 'error' and any exit during startup
 *     are captured with the tail of stderr, instead of vanishing.
 *  3. READINESS POLL, not a blind sleep — wait until /api/health answers,
 *     with a real timeout and the captured stderr in the failure message.
 *  4. IDENTITY NONCE — /api/health echoes GATE_NONCE, and we assert the
 *     responder is OUR process. This is the one that would have caught the
 *     zombie even if it had somehow passed 1-3: a stale server cannot know a
 *     nonce minted seconds ago.
 *
 * And one rule about what the child is GIVEN: it never inherits a live key.
 * See SENSITIVE_ENV below.
 *
 * Usage:
 *   const srv = await startGateServer({ port: 3301, env: { BOUNTY_CLAIM: '1' } });
 *   ...
 *   srv.kill();          // and srv.stderr() for diagnostics on failure
 */
import { spawn } from 'child_process';
import { createServer, connect } from 'net';
import { randomUUID } from 'crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import path from 'path';
import { sessionCookieFor } from './_gate-identity-helper.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Is anything already answering on this port, on any address a gate reaches?
 *
 * It used to BIND 127.0.0.1 and call the port free when that worked. server.js
 * listens with listen(PORT), which is '::' dual-stack, and Windows lets a
 * second socket bind 127.0.0.1:PORT beside it, so the probe called a running
 * server.js free, and anything on 0.0.0.0 too: the defence written for the
 * zombie never fired for a zombie. Now it CONNECTS on 127.0.0.1 and ::1 (the
 * readiness poll fetches `localhost`, which is one of the two), and still tries
 * the bind server.js itself makes ('::'), so a port the child could not take
 * is refused here, by name, instead of as an early exit.
 */
export async function portInUse(port) {
  const answers = (host) => new Promise((resolve) => {
    const sock = connect({ port, host });
    sock.setTimeout(1500, () => { sock.destroy(); resolve(false); });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
  const bindRefused = (host) => new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (e) => resolve(e.code === 'EADDRINUSE'));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port, host);
  });
  const [v4, v6] = await Promise.all([answers('127.0.0.1'), answers('::1')]);
  return v4 || v6 || bindRefused('::');
}

/** The repo root, resolved from THIS module — never from cwd, because a gate
 *  run from anywhere else would silently compare the wrong trees. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

/**
 * WHAT A GATE SERVER NEVER INHERITS (harness-9).
 *
 * The child used to start from the gate's whole environment, and server.js
 * then loadEnvFile()s .env, which fills every name still unset: every live key
 * in .env reached every gate. Seller and reward-pool signers, the OpenAI key
 * that moderation sends clips to, LiveKit Cloud, the platform client secrets.
 * Five gates each kept their own blanking list, and the lists had already
 * drifted apart.
 *
 * Now every name below, and every name in the gate's environment or in .env
 * that ends in _KEY, _SECRET, PRIVATE_KEY or TOKEN, starts BLANK in the child.
 * '' is a set value, so loadEnvFile leaves it alone. A gate that sets a name in
 * `env` still gets exactly that value: a generated key, a stand-in URL, a
 * local SFU. A gate that genuinely needs the real key from .env names it in
 * `keepEnv: ['NAME']`, and in doing so it SPENDS and belongs on the owner-run
 * list in docs/technical/testing-methodology.md.
 *
 * Not on the list, on purpose: the platform client IDs (public; nothing calls
 * a platform without the secret beside them) and TEMPO_RPC_URL (a public
 * endpoint; with every signer blank nothing can be sent through it).
 */
export const SENSITIVE_ENV = Object.freeze([
  // Signers. Anything that can move money.
  'SELLER_PRIVATE_KEY', 'PLATFORM_SETTLEMENT_KEY', 'REWARD_POOL_PRIVATE_KEY', 'CAMPAIGN_SPENDER_KEY',
  'ESCROW_OPERATOR_KEY', 'ESCROW_ATTEST_KEY', 'ESCROW_FUNDER_KEY', 'ESCROW_DEPLOYER_KEY', 'TEST_VIEWER_KEY',
  // Paid or third-party APIs.
  'MODERATION_API_KEY', 'OPENAI_API_KEY', 'YOUTUBE_API_KEY', 'RUMBLE_LIVESTREAM_API_URL', 'CIRCLE_CLIENT_KEY',
  'X_BEARER_TOKEN', 'X_TOKEN_KEY', 'X_CLIENT_SECRET', 'TWITCH_CLIENT_SECRET', 'KICK_CLIENT_SECRET',
  'PRIVY_APP_SECRET', 'OPS_ALERT_WEBHOOK',
  // LiveKit Cloud, all three, so no gate room lands on the cloud SFU (harness-10).
  'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET',
  // Session and admin secrets. A gate mints its own (mintBountyAuth).
  'AUTH_SECRET', 'MPP_SECRET_KEY', 'BOUNTY_ADMIN_KEY',
  // Stream keys. A rehearsal pushes with them from its own process, never the server.
  'TWITCH_STREAM_KEY', 'KICK_STREAM_KEY', 'RUMBLE_STREAM_KEY', 'PUMPFUN_STREAM_KEY', 'YOUTUBE_STREAM_KEY', 'X_STREAM_KEY',
]);
const SENSITIVE_SUFFIX = /(_KEY|_SECRET|PRIVATE_KEY|TOKEN)$/;

/** Names (never values) assigned in `dir`/.env. */
function envFileNames(dir) {
  let text;
  try { text = readFileSync(path.join(dir, '.env'), 'utf8'); } catch { return []; }
  return text.split(/\r?\n/).map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1]).filter(Boolean);
}

/** Every name a child booted from `cwd` starts with blank: the list above plus
 *  every suffix match in this process's environment and in `cwd`/.env. */
export function sensitiveEnvNames(cwd = REPO_ROOT) {
  const names = new Set(SENSITIVE_ENV);
  for (const n of [...Object.keys(process.env), ...envFileNames(cwd)]) if (SENSITIVE_SUFFIX.test(n)) names.add(n);
  return [...names].sort();
}

/** What assertFreshBuild compares against the build by default: the source
 *  directories, and the config files that change a build without touching
 *  them (a dependency bump in package.json, a Next or PostCSS setting). */
export const DEFAULT_WATCH = Object.freeze([
  'web/app', 'web/components', 'web/lib',
  'web/next.config.mjs', 'web/postcss.config.mjs', 'web/tsconfig.json', 'web/package.json',
]);

/** Newest mtime of a file, or under a directory, ignoring build output and dependencies. */
function newestUnder(dir) {
  let newest = { at: 0, file: null };
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) return { at: st.mtimeMs, file: path.relative(REPO_ROOT, dir) };
  } catch { return newest; }
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
 *   watch            dirs and files whose mtimes must predate the build
 *                    (repo-relative). A gate that adds one spreads
 *                    DEFAULT_WATCH rather than replacing it.
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
 * Mint gate credentials: one ACCOUNT per handle, written to accounts.json in
 * the store's own shape, plus a sealed cookie for each, plus an admin key.
 * Bounty routes authorize server-side (bounty-auth.js), so a suite that drives
 * them needs these.
 *
 * Deliberately NOT a bypass. Gates authenticate exactly the way a streamer
 * does; a test-only escape hatch in the auth path is the thing that later
 * turns out to be reachable in production.
 *
 * The accounts are MERGED into an accounts.json already in `dataDir`, so a
 * gate that seeds its own accounts (seedAccountForLink) and also asks for
 * bountyAuth keeps both. It used to overwrite the file and drop the seeds.
 *
 * It used to write `identities.json` with one `provider:platformId` row per
 * handle, because that was the identity. Since the account layer, a person is
 * an account with links and everything owner-keyed carries the ACCOUNT ID —
 * so a gate that needs an owner key asks `accountIdFor(handle)` instead of
 * building `provider:platformId` itself. The cookie seals `{accountId, iat}`,
 * the one session shape auth.js accepts (the `{provider, platformId}` shape it
 * used to seal is refused now), for the account the link table names, which
 * is the account the old cookie resolved to. Valid for 30 days from the mint.
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
    cookies[raw] = sessionCookieFor(accountId, { secret: authSecret });
  });
  const file = path.join(dataDir, 'accounts.json');
  let prior = {};
  try { prior = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none yet */ }
  writeFileSync(file, JSON.stringify({
    ...prior,
    accounts: { ...prior.accounts, ...accounts },
    handles: { ...prior.handles, ...handleMap },
    links: { ...prior.links, ...links },
  }, null, 2));
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

/**
 * Spawn server.js and return only once it is verifiably OURS and answering.
 * @throws with a diagnostic message (never a silent stale-server pass).
 *
 *   env      set in the child exactly as given, over the blanking and over
 *            bountyAuth's names (an `undefined` value counts as not given)
 *   keepEnv  names from SENSITIVE_ENV the child may inherit, from this
 *            process or .env. Naming one means the gate uses a real key.
 *   cwd      the child's working directory, and so the .env it loads.
 *            Defaults to this module's repo, the tree assertFreshBuild checks.
 */
export async function startGateServer({
  port,
  env = {},
  keepEnv = [],
  args = ['server.js', '--prod'],
  cwd = REPO_ROOT,
  readyTimeoutMs = 45_000,
  dataDir = null,
  label = `:${port}`,
  /** e.g. { handles: ['pipestreamer', 'kick:someslug'] } */
  bountyAuth = null,
} = {}) {
  if (!Array.isArray(keepEnv) || keepEnv.some((n) => typeof n !== 'string' || !n)) {
    throw new Error(`[gate-harness] ${label}: keepEnv must be an array of variable names`);
  }
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

  const blankedEnv = sensitiveEnvNames(cwd).filter((n) => !keepEnv.includes(n));
  const given = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined));
  const child = spawn(process.execPath, args, {
    cwd,
    env: {
      ...process.env,
      ...Object.fromEntries(blankedEnv.map((n) => [n, ''])),
      PORT: String(port),
      DATA_DIR: resolvedDataDir,
      GATE_NONCE: nonce,
      ...(auth ? auth.env : {}),
      ...given,
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
            /** The names (never values) this child started with blank. */
            blankedEnv,
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
