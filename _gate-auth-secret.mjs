/**
 * GATE — a production box without AUTH_SECRET never seals with the public
 * dev constant (OPEN-ISSUES K7, 2026-10-24).
 *
 * THE DEFECT. Production (Railway) had none of AUTH_SECRET, MPP_SECRET_KEY,
 * NODE_ENV. auth.js then sealed every session cookie with the literal
 * 'megachat-dev-secret', which is in the public repo: anyone could seal
 * `{accountId}` — or the legacy `{provider, platformId}`, whose ids are public
 * — and be that account. overlay-key.js refused the constant only when
 * NODE_ENV === 'production'; that held at runtime solely because Next sets
 * NODE_ENV during prepare, so on Railway overlay keys were DISABLED (C shows
 * it), not forgeable — but the module itself, read before prepare or outside
 * the server, derived the public-constant key (D shows it).
 *
 * WHAT IT PROVES
 *   A. `server.js --prod`, no secret variable, booted through startGateServer:
 *      a cookie sealed with the dev constant for a SEEDED account is refused
 *      (both cookie shapes), and the server log names AUTH_SECRET once
 *   B. with AUTH_SECRET set, a cookie sealed with it is accepted — the seed
 *      resolves, so A's refusal is the secret and not a broken fixture — and
 *      the owner's overlay key is NOT the one the public constant derives;
 *      a tampered or truncated signature is refused without a 500; the
 *      pre-account {provider, platformId} shape is REFUSED even sealed with
 *      the current secret (its ids are public; retired 2026-10-24)
 *   S. sessions (2026-10-24): a real sign-in seals {accountId, iat} with a
 *      30-day Max-Age, HttpOnly, and Secure under --prod (not in dev); a
 *      session with no iat, older than 30 days, or dated in the future is
 *      nobody, while one 29 days old still resolves
 *   C. DISCRIMINATES: the same A run against a COPY of the tree with the old
 *      fallbacks put back (sessionSecret → the constant, overlay-key →
 *      NODE_ENV only) ADMITS the forged cookie. The copy is never the working
 *      tree. (Its overlay URL carries no key: what production really did.)
 *   D. overlay-key.js under `--prod` alone, or Railway's variable alone (no
 *      NODE_ENV), derives no key and logs the variable name; with a secret it
 *      derives one; in dev the dev key still works. The mutated copy disagrees.
 *   F. runtime-env.js itself: production by `--prod` or by Railway's variable
 *      alone never returns the constant; dev still does; a set secret wins.
 *   E. x-token-store.js: with no X_TOKEN_KEY/AUTH_SECRET it stores nothing,
 *      in production or dev; a rotated secret reads a stored token as null
 *      and the holder is no longer LISTED (it cannot vouch for anyone), while
 *      its row stays on disk, so the old key brings it back
 *   G. x-token-store.js refresh outcomes (2026-10-24): X refusing a refresh
 *      (400/401) marks the row dead — no second POST, not listed — until the
 *      holder signs in with X again; a 503 or a network error never does
 *
 * Gates authenticate; they never bypass: the seeded account and its real
 * cookie come from mintBountyAuth, the forged one is built exactly the way an
 * attacker would build it. Spends nothing, touches no chain.
 *
 *   node _gate-auth-secret.mjs
 */
import { createHmac } from 'crypto';
import { createServer } from 'http';
import { spawnSync, execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, symlinkSync, lstatSync, rmdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { startGateServer, mintBountyAuth, assertFreshBuild } from './_gate-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEV_CONSTANT = 'megachat-dev-secret'; // what an attacker reads off GitHub
const LOG_LINE = '[auth] AUTH_SECRET (or MPP_SECRET_KEY) is not set in production';
const PORT_A = 3361, PORT_B = 3362, PORT_C = 3363, PORT_G = 3364;
const NO_SECRETS = { AUTH_SECRET: '', MPP_SECRET_KEY: '', NODE_ENV: '', X_TOKEN_KEY: '', RAILWAY_ENVIRONMENT: '', RAILWAY_ENVIRONMENT_NAME: '' };

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};

console.log('\n── K7: no public secret in production ──────────────────────');

const build = assertFreshBuild({ requireNextBuild: false });
if (!build.ok) { console.log(`  FAIL  build: ${build.detail}`); process.exit(1); }

// ── the seeded account, and the attacker's cookie for it ───────────────────
const DATA = mkdtempSync(path.join(tmpdir(), 'mc-k7-'));
const auth = mintBountyAuth({ handles: ['k7victim'], dataDir: DATA });
const victimId = auth.accountIdFor('k7victim');
const sealWith = (secret, obj) => {
  const payload = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `mc_identity=${encodeURIComponent(`${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`)}`;
};
// The attacker reads the source too, so the forgeries carry a fresh iat.
const forgedById = sealWith(DEV_CONSTANT, { accountId: victimId, iat: Date.now() });
const forgedByLink = sealWith(DEV_CONSTANT, { provider: 'twitch', platformId: '1000', iat: Date.now() }); // mintBountyAuth's first link
const DAY = 86_400_000;
const setCookieOf = (res, name) => (res.headers.getSetCookie?.() || []).find((l) => l.startsWith(`${name}=`)) || '';
const payloadOf = (cookie) => JSON.parse(Buffer.from(decodeURIComponent(cookie.split(';')[0].slice(cookie.indexOf('=') + 1)).split('.')[0], 'base64url').toString());
const devOverlayKey = (roomId) => createHmac('sha256', DEV_CONSTANT)
  .update(`megachat-overlay-key:v1:${String(roomId)}`).digest('base64url').slice(0, 32);

const whoami = async (port, cookie) => {
  const r = await fetch(`http://localhost:${port}/api/auth/me`, { headers: cookie ? { Cookie: cookie } : {} });
  return { status: r.status, identity: (await r.json().catch(() => ({}))).identity ?? null };
};
const account = async (port, cookie) => (await fetch(`http://localhost:${port}/api/account`, { headers: { Cookie: cookie } })).status;
const createRoom = async (port, cookie) => {
  const r = await fetch(`http://localhost:${port}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: 'k7 room' }),
  });
  const body = await r.json().catch(() => ({}));
  let k = null;
  try { k = new URL(body.overlayUrl).searchParams.get('k'); } catch { /* */ }
  return { status: r.status, roomId: body.room?.id ?? null, owned: body.owned === true, k };
};
const stop = async (srv) => {
  if (!srv) return;
  const gone = new Promise((r) => { srv.child.once('exit', r); setTimeout(r, 5000); });
  srv.kill();
  await gone;
};
const logCount = (out) => out.split(LOG_LINE).length - 1;

// ═══ A. --prod, no secret: the forgery is refused ═══
{
  let srv = null;
  try {
    srv = await startGateServer({ port: PORT_A, dataDir: DATA, label: 'k7-no-secret', env: { ...NO_SECRETS, KEEP_ORPHAN_ROOMS: 'true' } });
    const a1 = await whoami(PORT_A, forgedById);
    ok('A. --prod with no AUTH_SECRET/MPP_SECRET_KEY/NODE_ENV: an {accountId} cookie sealed with the public constant is NOBODY', a1.status === 200 && a1.identity === null, JSON.stringify(a1.identity));
    const a2 = await whoami(PORT_A, forgedByLink);
    ok('A. ...and so is the older {provider, platformId} shape', a2.identity === null, JSON.stringify(a2.identity));
    ok('A. ...a signed-in route answers 401 to the forgery', (await account(PORT_A, forgedById)) === 401);
    const room = await createRoom(PORT_A, forgedById);
    ok('A. ...and it cannot create a room as the victim', room.status === 400 && !room.owned, `http ${room.status}`);
    const out = srv.stderr();
    ok('A. the server log names AUTH_SECRET — exactly once across every request', logCount(out) === 1, `${logCount(out)} line(s)`);
    const line = out.split('\n').find((l) => l.includes(LOG_LINE)) || '';
    ok('A. ...and says what it costs and what to set, with no value in it',
      /per-boot secret/.test(line) && /set AUTH_SECRET/.test(line) && !/[0-9a-f]{32,}/i.test(line), line.trim().slice(0, 90));
  } catch (e) {
    ok(`A. server run — ${e.message.split('\n')[0]}`, false);
  } finally { await stop(srv); }
}

// ═══ B. AUTH_SECRET set: its cookie is accepted ═══
{
  let srv = null;
  try {
    srv = await startGateServer({ port: PORT_B, dataDir: DATA, label: 'k7-with-secret', env: { ...NO_SECRETS, AUTH_SECRET: auth.authSecret, KEEP_ORPHAN_ROOMS: 'true' } });
    const real = auth.cookieFor('k7victim');
    const b1 = await whoami(PORT_B, real);
    ok('B. with AUTH_SECRET set, a cookie sealed with it resolves to the seeded account', b1.identity?.handle === 'k7victim', JSON.stringify(b1.identity));
    ok('B. ...and mintBountyAuth seals the one current shape, {accountId, iat}, for that account',
      payloadOf(real).accountId === victimId && Number.isFinite(payloadOf(real).iat) && !('platformId' in payloadOf(real)), Object.keys(payloadOf(real)).join(','));
    // The pre-account shape names a PUBLIC platform id, so under a leaked or
    // default secret it forged anyone. Sealed with the CURRENT secret, with
    // and without an iat, it must still be nobody: the shape is retired.
    const legacy = sealWith(auth.authSecret, { provider: 'twitch', platformId: '1000' });
    const legacyIat = sealWith(auth.authSecret, { provider: 'twitch', platformId: '1000', iat: Date.now() });
    const l1 = await whoami(PORT_B, legacy), l2 = await whoami(PORT_B, legacyIat);
    ok('B. the legacy {provider, platformId} shape sealed with the CURRENT secret is nobody (with or without iat), and a signed-in route says 401',
      l1.identity === null && l2.identity === null && (await account(PORT_B, legacyIat)) === 401, `${JSON.stringify(l1.identity)} / ${JSON.stringify(l2.identity)}`);
    ok('B. ...a signed-in route answers 200', (await account(PORT_B, real)) === 200);
    ok('B. ...and the public-constant forgery is still nobody', (await whoami(PORT_B, forgedById)).identity === null);
    const room = await createRoom(PORT_B, real);
    ok('B. the owner gets a keyed overlay URL, and the key is NOT the one the public constant derives',
      room.status === 201 && room.owned && /^[A-Za-z0-9_-]{32}$/.test(room.k || '') && room.k !== devOverlayKey(room.roomId), `http ${room.status}`);
    // Constant-time compare (timingSafeEqual) must still refuse cleanly: a
    // flipped last character (same length) and a truncated signature (the
    // length guard in front of timingSafeEqual, which would otherwise throw).
    const raw = decodeURIComponent(real.slice('mc_identity='.length));
    const [p, s] = raw.split('.');
    const flipped = `mc_identity=${encodeURIComponent(`${p}.${s.slice(0, -1)}${s.endsWith('A') ? 'B' : 'A'}`)}`;
    const short = `mc_identity=${encodeURIComponent(`${p}.${s.slice(0, 10)}`)}`;
    const f1 = await whoami(PORT_B, flipped), f2 = await whoami(PORT_B, short);
    ok('B. a same-length tampered signature is nobody, and a truncated one is nobody without a 500',
      f1.status === 200 && f1.identity === null && f2.status === 200 && f2.identity === null, `http ${f1.status}/${f2.status}`);

    // ═══ S. sessions: issued at, 30 days, Secure in production ═══
    // A real sign-in: the handle picker's claim, with the pending cookie
    // sealed exactly as the OAuth callback seals it.
    const pending = sealWith(auth.authSecret, { provider: 'twitch', platformId: 'k7-claim', username: 'k7claimer', back: '/', t: Date.now() })
      .replace('mc_identity=', 'mc_pending_identity=');
    const claimed = await fetch(`http://localhost:${PORT_B}/api/auth/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: pending }, body: JSON.stringify({ handle: 'k7claimer' }),
    });
    const issued = setCookieOf(claimed, 'mc_identity');
    const sess = issued ? payloadOf(issued) : {};
    ok('S. a real sign-in seals {accountId, iat} with iat = now, and nothing else',
      claimed.status === 200 && /^acct_/.test(sess.accountId || '') && Math.abs(Date.now() - sess.iat) < 60_000 && Object.keys(sess).length === 2,
      `http ${claimed.status}, ${Object.keys(sess).join(',')}`);
    ok('S. ...as a 30-day, HttpOnly, SameSite=Lax cookie that is Secure under --prod',
      /Max-Age=2592000(;|$)/.test(issued) && /HttpOnly/.test(issued) && /SameSite=Lax/.test(issued) && /;\s*Secure(;|$)/.test(issued), issued.split(';').slice(1).join(';').trim());
    ok('S. ...and that session is the account it named', (await whoami(PORT_B, issued.split(';')[0])).identity?.handle === 'k7claimer');
    const aged = async (iat) => (await whoami(PORT_B, sealWith(auth.authSecret, iat === undefined ? { accountId: victimId } : { accountId: victimId, iat }))).identity?.handle ?? null;
    ok('S. a session with NO iat (the shape sealed before 2026-10-24) is nobody: everyone signs in once', (await aged(undefined)) === null);
    ok('S. one issued 30 days and a minute ago is nobody, server-side, whatever the browser kept', (await aged(Date.now() - 30 * DAY - 60_000)) === null);
    ok('S. ...one issued 29 days ago still resolves (the boundary, not a blanket refusal)', (await aged(Date.now() - 29 * DAY)) === 'k7victim');
    ok('S. ...and one dated a day in the future is nobody (no eternal session from a skewed or forged iat)', (await aged(Date.now() + DAY)) === null);
    ok('B. no K7 error line when the secret is set', logCount(srv.stderr()) === 0);
  } catch (e) {
    ok(`B. server run — ${e.message.split('\n')[0]}`, false);
  } finally { await stop(srv); }
}

// ═══ the mutated COPY (C, D, E's counterparts) ═══
// Tracked source only (no design-assets/, docs/ or media), plus untracked
// .js/.mjs (runtime-env.js until it is committed). node_modules, web/node_modules
// and web/.next are JUNCTIONS to the real ones, read-only in practice.
// CLEANUP ORDER MATTERS: a recursive delete of a tree that still holds a
// junction can walk into the real node_modules. So each junction is removed on
// its own first (rmdirSync, non-recursive: it removes the link, and on a real
// non-empty directory it simply fails), and the copy is deleted only once
// every junction is verifiably gone. Otherwise it is left, and said so.
const JUNCTIONS = ['node_modules', 'web/node_modules', 'web/.next'];
let MUT_DIR = null;
function removeCopy(dir) {
  for (const j of JUNCTIONS) {
    const p = path.join(dir, j);
    try { if (lstatSync(p).isSymbolicLink()) rmdirSync(p); } catch { /* absent */ }
  }
  if (JUNCTIONS.some((j) => { try { lstatSync(path.join(dir, j)); return true; } catch { return false; } })) {
    console.log(`\n  (mutated copy LEFT at ${dir}: a junction could not be removed — remove the junctions before the folder)`);
    return;
  }
  rmSync(dir, { recursive: true, force: true });
}
function mutatedCopy() {
  const dir = mkdtempSync(path.join(tmpdir(), 'mc-k7-mutant-'));
  MUT_DIR = dir;
  const media = /\.(png|jpe?g|gif|webp|mp4|webm|mov|wav|mp3|ogg|ttf|woff2?|psd|zip|pdf)$/i;
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: HERE }).toString().split('\0');
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: HERE }).toString().split('\0')
    .filter((f) => /\.(m?js|cjs)$/.test(f) && !f.includes('/'));
  for (const f of [...tracked, ...untracked]) {
    if (!f || f.startsWith('design-assets/') || f.startsWith('docs/') || media.test(f)) continue;
    const src = path.join(HERE, f);
    if (!existsSync(src)) continue;
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    copyFileSync(src, path.join(dir, f));
  }
  for (const j of JUNCTIONS) symlinkSync(path.join(HERE, j), path.join(dir, j), 'junction');
  // Put the OLD behaviour back, and refuse to call it a proof if a pattern missed.
  const swap = (file, from, to) => {
    const p = path.join(dir, file), src = readFileSync(p, 'utf8');
    if (!src.includes(from)) throw new Error(`mutation pattern not found in ${file}`);
    writeFileSync(p, src.replace(from, to));
  };
  swap('runtime-env.js', 'export function sessionSecret() {',
    "export function sessionSecret() { return process.env.AUTH_SECRET || process.env.MPP_SECRET_KEY || 'megachat-dev-secret';");
  swap('overlay-key.js', '  if (isProduction()) {', "  if (process.env.NODE_ENV === 'production') {");
  return dir;
}

let MUT = null;
try { MUT = mutatedCopy(); } catch (e) { ok(`C. build the mutated copy — ${e.message}`, false); }

// ═══ C. DISCRIMINATES: the old fallback admits the forgery ═══
if (MUT) {
  let srv = null;
  try {
    srv = await startGateServer({
      port: PORT_C, dataDir: DATA, label: 'k7-mutant', args: [path.join(MUT, 'server.js'), '--prod'],
      env: { ...NO_SECRETS, KEEP_ORPHAN_ROOMS: 'true' },
    });
    const c1 = await whoami(PORT_C, forgedById);
    ok('C. DISCRIMINATES: on the copy with the old fallback, the SAME forged cookie IS the victim — A and the old code disagree',
      c1.identity?.handle === 'k7victim', JSON.stringify(c1.identity));
    const room = await createRoom(PORT_C, forgedById);
    // What production REALLY did with overlay keys: none. Next sets NODE_ENV
    // during prepare, so the old NODE_ENV-only check fired at runtime and N14
    // was disabled (campaign Hollers never count as aired), not forgeable.
    ok('C. ...the forger owns a room, but the old --prod server hands out NO overlay key (Next set NODE_ENV during prepare): keys were disabled on production, not forgeable',
      room.status === 201 && room.owned && room.k === null, `http ${room.status}, key ${room.k === null ? 'none' : room.k === devOverlayKey(room.roomId) ? 'PUBLIC-CONSTANT' : 'other'}`);
    ok('C. ...and logs nothing about it', logCount(srv.stderr()) === 0);
  } catch (e) {
    ok(`C. mutant server run — ${e.message.split('\n')[0]}`, false);
  } finally { await stop(srv); }
}

// ═══ D. overlay-key.js under --prod alone ═══
const probe = (dir, code, { args = [], env = {} } = {}) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, '--', ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, ...NO_SECRETS, ...env },
  });
  let out = null;
  try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* */ }
  return { out, stderr: r.stderr || '' };
};
const keyProbe = (dir) => `import(${JSON.stringify(pathToFileURL(path.join(dir, 'overlay-key.js')).href)}).then((m) => console.log(JSON.stringify({ k: m.overlayKeyFor('abc123'), match: m.overlayKeyMatches('abc123', 'x'.repeat(32)) })))`;
{
  const prod = probe(HERE, keyProbe(HERE), { args: ['--prod'] });
  ok('D. overlay-key.js under --prod (NODE_ENV unset, no secret) derives NO key, matches nothing, and names AUTH_SECRET',
    prod.out?.k === null && prod.out.match === false && /\[overlay-key\] AUTH_SECRET/.test(prod.stderr), `key ${prod.out?.k === null ? 'null' : 'DERIVED'}`);
  const railway = probe(HERE, keyProbe(HERE), { env: { RAILWAY_ENVIRONMENT: 'production' } });
  ok('D. ...and so does RAILWAY_ENVIRONMENT alone (no --prod, no NODE_ENV): a changed start command still counts as production',
    railway.out?.k === null && /\[overlay-key\] AUTH_SECRET/.test(railway.stderr), `key ${railway.out?.k === null ? 'null' : 'DERIVED'}`);
  const withSecret = probe(HERE, keyProbe(HERE), { args: ['--prod'], env: { AUTH_SECRET: 'k7-gate-secret' } });
  ok('D. ...with AUTH_SECRET set it derives a 32-char key that is not the public-constant one',
    /^[A-Za-z0-9_-]{32}$/.test(withSecret.out?.k || '') && withSecret.out.k !== devOverlayKey('abc123'));
  const dev = probe(HERE, keyProbe(HERE));
  ok('D. ...and in development (no --prod, no NODE_ENV) the dev key still works, unchanged', dev.out?.k === devOverlayKey('abc123'));
  if (MUT) {
    const old = probe(MUT, keyProbe(MUT), { args: ['--prod'] });
    ok('D. DISCRIMINATES: the copy with the old NODE_ENV-only check derives the public-constant key under --prod',
      old.out?.k === devOverlayKey('abc123'), `key ${old.out?.k === devOverlayKey('abc123') ? '= public-constant key' : String(old.out?.k)}`);
    const oldRailway = probe(MUT, keyProbe(MUT), { env: { RAILWAY_ENVIRONMENT: 'production' } });
    ok('D. DISCRIMINATES: ...and under RAILWAY_ENVIRONMENT alone', oldRailway.out?.k === devOverlayKey('abc123'));
  }
}

// ═══ F. runtime-env.js: never the constant in production ═══
{
  const envUrl = (dir) => JSON.stringify(pathToFileURL(path.join(dir, 'runtime-env.js')).href);
  // Booleans only: the secret itself never leaves the probe.
  const code = (dir) => `import(${envUrl(dir)}).then((m) => { const a = m.sessionSecret(), b = m.sessionSecret(); console.log(JSON.stringify({ prod: m.isProduction(), constant: a === ${JSON.stringify(DEV_CONSTANT)}, stable: a === b, hex64: /^[0-9a-f]{64}$/.test(a), isSet: a === process.env.AUTH_SECRET })); })`;
  const viaProd = probe(HERE, code(HERE), { args: ['--prod'] });
  ok('F. --prod, no secret: sessionSecret() is a per-boot 256-bit random, stable within the process, never the constant, with ONE log line',
    viaProd.out?.prod === true && !viaProd.out.constant && viaProd.out.stable && viaProd.out.hex64 && logCount(viaProd.stderr) === 1, `${logCount(viaProd.stderr)} line(s)`);
  const viaRailway = probe(HERE, code(HERE), { env: { RAILWAY_ENVIRONMENT: 'production' } });
  ok('F. RAILWAY_ENVIRONMENT alone: production, and not the constant', viaRailway.out?.prod === true && !viaRailway.out.constant && viaRailway.out.hex64);
  const viaDev = probe(HERE, code(HERE));
  ok('F. development (nothing set): the dev constant, as before, and no log line', viaDev.out?.prod === false && viaDev.out.constant && logCount(viaDev.stderr) === 0);
  const viaSet = probe(HERE, code(HERE), { args: ['--prod'], env: { AUTH_SECRET: 'k7-gate-secret' } });
  ok('F. AUTH_SECRET set: it is the secret, in production, with no log line', viaSet.out?.isSet === true && logCount(viaSet.stderr) === 0);
  if (MUT) {
    const old = probe(MUT, code(MUT), { args: ['--prod'] });
    ok('F. DISCRIMINATES: the copy with the old fallback returns the public constant under --prod', old.out?.constant === true);
  }
}

// ═══ S (dev half). Secure follows isProduction(), so http:// dev still works ═══
{
  const SDIR = mkdtempSync(path.join(tmpdir(), 'mc-k7-s-'));
  // DATA_DIR first, so nothing auth.js loads can touch the repo's own data/.
  const code = `process.env.DATA_DIR = ${JSON.stringify(SDIR)};
    const { default: express } = await import(${JSON.stringify(pathToFileURL(path.join(HERE, 'node_modules/express/index.js')).href)});
    const { attachAuth } = await import(${JSON.stringify(pathToFileURL(path.join(HERE, 'auth.js')).href)});
    const app = express(); attachAuth(app, { log: { log() {}, warn() {}, error() {} } });
    const srv = app.listen(0); const port = srv.address().port;
    const r = await fetch('http://localhost:' + port + '/api/auth/logout', { method: 'POST' });
    srv.close(); console.log(JSON.stringify({ cookie: r.headers.get('set-cookie') || '' }));`;
  const dev = probe(HERE, code);
  const prod = probe(HERE, code, { args: ['--prod'] });
  ok('S. in development (no --prod) the cookie carries no Secure flag, so the http:// dev app keeps its session; under --prod the same cookie does',
    /^mc_identity=/.test(dev.out?.cookie || '') && !/Secure/.test(dev.out.cookie) && /;\s*Secure(;|$)/.test(prod.out?.cookie || ''),
    `dev: ${dev.out?.cookie ? (/Secure/.test(dev.out.cookie) ? 'Secure' : 'no Secure') : 'no cookie'}, prod: ${/Secure/.test(prod.out?.cookie || '') ? 'Secure' : 'no Secure'}`);
}

// ═══ E. x-token-store.js: never under the constant ═══
{
  const XDIR = mkdtempSync(path.join(tmpdir(), 'mc-k7-x-'));
  const url = JSON.stringify(pathToFileURL(path.join(HERE, 'x-token-store.js')).href);
  const save = `import(${url}).then((m) => console.log(JSON.stringify({ configured: m.tokenStoreConfigured(), saved: m.saveXToken('acct_k7', 'x-77', { access_token: 'gate-tok', refresh_token: 'gate-ref', expires_in: 3600 }) })))`;
  const read = `import(${url}).then(async (m) => console.log(JSON.stringify({ tok: await m.getXAccessToken('acct_k7', { log: { warn() {} } }), holder: m.holdersByXUserId().get('x-77') || null })))`;
  const prodNone = probe(HERE, save, { args: ['--prod'], env: { DATA_DIR: XDIR } });
  ok('E. x-token-store under --prod with no X_TOKEN_KEY/AUTH_SECRET stores NOTHING (no key, no file) — never the public constant',
    prodNone.out?.configured === false && prodNone.out.saved === false && !existsSync(path.join(XDIR, 'x-tokens.json')));
  const devNone = probe(HERE, save, { env: { DATA_DIR: XDIR } });
  ok('E. ...and the same in development: no secret, nothing stored', devNone.out?.configured === false && devNone.out.saved === false);
  const savedA = probe(HERE, save, { args: ['--prod'], env: { DATA_DIR: XDIR, AUTH_SECRET: 'k7-secret-A' } });
  const readB = probe(HERE, read, { args: ['--prod'], env: { DATA_DIR: XDIR, AUTH_SECRET: 'k7-secret-B' } });
  const readA = probe(HERE, read, { args: ['--prod'], env: { DATA_DIR: XDIR, AUTH_SECRET: 'k7-secret-A' } });
  const rowKept = (() => { try { return !!JSON.parse(readFileSync(path.join(XDIR, 'x-tokens.json'), 'utf8')).tokens.acct_k7; } catch { return false; } })();
  ok('E. a token stored under one secret reads as NULL under another, and that holder is no longer LISTED (it cannot vouch), while its row stays on disk',
    savedA.out?.saved === true && readB.out?.tok === null && readB.out.holder === null && rowKept,
    `saved ${savedA.out?.saved}, read ${readB.out?.tok === null ? 'null' : 'TOKEN'}, listed ${readB.out?.holder ?? 'no'}, row ${rowKept ? 'kept' : 'GONE'}`);
  ok('E. ...and under the secret it was stored with, it reads back and is listed again (the control)', readA.out?.tok === 'gate-tok' && readA.out.holder === 'acct_k7');
}

// ═══ G. x-token-store: what a refresh outcome does to the row ═══
// In-process against a mock token endpoint: x-token-store reads its env on
// every call and imports nothing with side effects.
{
  const GDIR = mkdtempSync(path.join(tmpdir(), 'mc-k7-g-'));
  const posts = new Map(); // refresh token → POSTs it drew
  const answers = { 'rt-400': 400, 'rt-401': 401, 'rt-503': 503 };
  const tokenEndpoint = createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const rt = new URLSearchParams(b).get('refresh_token');
      posts.set(rt, (posts.get(rt) || 0) + 1);
      res.setHeader('Content-Type', 'application/json');
      if (answers[rt]) { res.statusCode = answers[rt]; return res.end('{"error":"invalid_request"}'); }
      res.end(JSON.stringify({ access_token: `fresh-${rt}`, refresh_token: `${rt}-next`, expires_in: 7200 }));
    });
  });
  await new Promise((r) => tokenEndpoint.listen(PORT_G, r));
  const saved = { ...process.env };
  Object.assign(process.env, { DATA_DIR: GDIR, X_TOKEN_KEY: 'k7-g-key', X_CLIENT_ID: 'g-client', X_CLIENT_SECRET: 'g-secret', X_TOKEN_BASE: `http://localhost:${PORT_G}` });
  try {
    const X = await import(pathToFileURL(path.join(HERE, 'x-token-store.js')).href);
    X._resetXTokensForTests();
    const quiet = { log: { warn() {} } };
    const expired = (rt) => ({ access_token: 'stale', refresh_token: rt, expires_in: -120 });
    for (const [acct, xid, rt] of [['acct_g400', 'x-400', 'rt-400'], ['acct_g401', 'x-401', 'rt-401'], ['acct_g503', 'x-503', 'rt-503'], ['acct_gnet', 'x-net', 'rt-net']]) X.saveXToken(acct, xid, expired(rt));
    const first = [await X.getXAccessToken('acct_g400', quiet), await X.getXAccessToken('acct_g401', quiet), await X.getXAccessToken('acct_g503', quiet)];
    const second = [await X.getXAccessToken('acct_g400', quiet), await X.getXAccessToken('acct_g401', quiet), await X.getXAccessToken('acct_g503', quiet)];
    const listed = X.holdersByXUserId();
    ok('G. X refusing a refresh (400 or 401) marks the row dead: the NEXT check makes no second POST, and the holder is no longer listed',
      first.every((t) => t === null) && second.every((t) => t === null) && posts.get('rt-400') === 1 && posts.get('rt-401') === 1 && !listed.has('x-400') && !listed.has('x-401'),
      `POSTs 400:${posts.get('rt-400')} 401:${posts.get('rt-401')}, listed ${[...listed.keys()].join(',')}`);
    ok('G. ...a 503 never does: the row stays listed and the next check may try again', posts.get('rt-503') === 2 && listed.has('x-503'), `${posts.get('rt-503')} POSTs`);
    process.env.X_TOKEN_BASE = 'http://localhost:9'; // nothing listens: a network error, like a timeout
    const net = await X.getXAccessToken('acct_gnet', quiet);
    ok('G. ...nor does a network error or a timeout (the grant may be fine): still listed', net === null && X.holdersByXUserId().has('x-net'));
    process.env.X_TOKEN_BASE = `http://localhost:${PORT_G}`;
    X.saveXToken('acct_g400', 'x-400', { access_token: 'relinked', refresh_token: 'rt-ok', expires_in: 7200 });
    ok('G. ...and signing in with X again revives a dead holder: listed, and its new token is served without a POST',
      X.holdersByXUserId().get('x-400') === 'acct_g400' && (await X.getXAccessToken('acct_g400', quiet)) === 'relinked' && !posts.has('rt-ok'));
  } catch (e) {
    ok(`G. token-store run — ${e.message.split('\n')[0]}`, false);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    await new Promise((r) => tokenEndpoint.close(r));
  }
}

if (MUT_DIR) removeCopy(MUT_DIR);
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
