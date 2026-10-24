/**
 * GATE — x-token-store.js: a torn x-tokens.json is left alone, never saved over.
 *
 * THE DEFECT (found by the docs pass, 2026-10-24; the stores-2 class). The X
 * token store read any file it could not parse as `{ tokens: {} }`, and the
 * next save (any holder's X sign-in, or a refresh) wrote that view over the
 * file: every stored holder lost their token and had to re-link X, silently.
 * The store now goes through json-store.js like the other document stores.
 *
 * WHAT IT PROVES, each case on its own scratch DATA_DIR
 *   T  TORN, EMPTY, WRONG-SHAPED. The store refuses writes (StoreRefused,
 *      `store_refused`), the bytes on disk survive every write path (save,
 *      drop, a refresh), nobody is served as a holder, no refresh is POSTed,
 *      and the refusal is logged once. It is latched: repairing the file does
 *      nothing until a restart; after one, the repaired rows are back.
 *   H  THE HEALTHY ROUND TRIP. A first save creates the file; on disk it holds
 *      the X user id in the clear and no token in the clear; a restart reads
 *      the token back and lists the holder; a drop removes the row; no temp
 *      file is left behind; with no key nothing is written at all.
 *   D  THE DEAD-ROW RULES (identity lane, 2026-10-24) still hold: X refusing a
 *      refresh (400/401) marks the row dead (no second POST, not listed); a
 *      503 or a network error never does; a new X sign-in revives it. A row
 *      the current key cannot open is not listed but stays on disk, byte for
 *      byte, through another holder's save, and the old key lists it again.
 *
 * Discriminates: on a copy holding the pre-change x-token-store.js (its own
 * writer, a bad file read as empty) 18 of the 36 cases fail, every T case but
 * T3 (which only says nobody is served, true of an empty read too), while H
 * and D pass on both (2026-10-24).
 *
 * Boots no app server and spends nothing. One in-process stand-in for X's
 * token endpoint on 127.0.0.1; every key and client id is a gate-only string;
 * writes only under the OS temp dir.
 *
 *   node _gate-x-token-store.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};

// Nothing from a real environment reaches the module: it reads these on every
// call, so each case sets its own.
for (const k of ['X_TOKEN_KEY', 'AUTH_SECRET', 'X_CLIENT_ID', 'X_CLIENT_SECRET', 'X_TOKEN_BASE', 'DATA_DIR']) delete process.env[k];

// ── X's token endpoint, stood in: the answer is chosen by the refresh token ──
const posts = new Map(); // refresh token → POSTs it drew
const answers = { 'rt-400': 400, 'rt-401': 401, 'rt-503': 503 };
const endpoint = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => { b += d; });
  req.on('end', () => {
    const rt = new URLSearchParams(b).get('refresh_token');
    posts.set(rt, (posts.get(rt) || 0) + 1);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Connection', 'close'); // no kept-alive socket for close() to wait on
    if (answers[rt]) { res.statusCode = answers[rt]; return res.end('{"error":"invalid_request"}'); }
    res.end(JSON.stringify({ access_token: `fresh-${rt}`, refresh_token: `${rt}-next`, expires_in: 7200 }));
  });
});
await new Promise((r) => endpoint.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${endpoint.address().port}`;

// The refusal line goes to console.error (json-store.js); the drop warning to
// the log the caller passes. Both are counted, never printed.
const errors = [];
const realError = console.error;
console.error = (...a) => errors.push(a.join(' '));
const warns = [];
const quiet = { log: { warn: (m) => warns.push(m) } };

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-xtok-'));
const X = await import(pathToFileURL(path.join(HERE, 'x-token-store.js')).href);

/** A fresh scratch DATA_DIR and a "restart": the module forgets what it read. */
function fresh(name, key = 'gate-key-a') {
  const dir = path.join(work, name);
  fs.mkdirSync(dir, { recursive: true });
  Object.assign(process.env, { DATA_DIR: dir, X_TOKEN_KEY: key, X_CLIENT_ID: 'gate-client', X_CLIENT_SECRET: 'gate-secret', X_TOKEN_BASE: BASE });
  X._resetXTokensForTests();
  errors.length = 0;
  warns.length = 0;
  return { dir, file: path.join(dir, 'x-tokens.json') };
}
const restart = () => X._resetXTokensForTests();
const live = (tok) => ({ access_token: tok, refresh_token: `${tok}-rt`, expires_in: 7200 });
const expired = (rt) => ({ access_token: 'stale', refresh_token: rt, expires_in: -120 });
const tryThrow = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const tmpFiles = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
const refusalLines = () => errors.filter((m) => m.includes('REFUSING WRITES') && m.includes('x-tokens.json')).length;

console.log('\n── x-token-store: a torn file is left alone ─────────────');

try {
  // ── T. torn, empty, wrong-shaped ─────────────────────────────────────────
  // A real store with two holders, written by the module itself, then torn.
  const seed = fresh('seed');
  X.saveXToken('acct_a', 'x-a', live('tok-a'));
  X.saveXToken('acct_b', 'x-b', expired('rt-ok'));
  const good = fs.readFileSync(seed.file, 'utf8');

  const shapes = {
    torn: good.slice(0, Math.floor(good.length / 2)),
    empty: '',
    'tokens-array': '{ "tokens": [] }',
    'not-an-object': '[1, 2, 3]',
  };
  for (const [name, bytes] of Object.entries(shapes)) {
    const { dir, file } = fresh(`t-${name}`);
    fs.writeFileSync(file, bytes);
    const before = sha(file);
    const posted = posts.get('rt-ok') || 0;

    const holders = X.holdersByXUserId();
    const tok = await X.getXAccessToken('acct_b', quiet);
    const saveErr = tryThrow(() => X.saveXToken('acct_c', 'x-c', live('tok-c')));
    const saveErr2 = tryThrow(() => X.saveXToken('acct_a', 'x-a', live('tok-a2')));
    const dropErr = tryThrow(() => X.dropXToken('acct_a', quiet));

    ok(`T1 ${name}: a save is refused — StoreRefused (store_refused), not a silent overwrite`,
      saveErr?.code === 'store_refused' && saveErr2?.code === 'store_refused', saveErr ? saveErr.message.slice(0, 70) : 'no throw');
    ok(`T2 ${name}: the bytes on disk survive two saves, a drop and a refresh attempt`,
      fs.existsSync(file) && sha(file) === before && tmpFiles(dir).length === 0);
    ok(`T3 ${name}: nobody is served as a holder, no token is handed out, nothing is POSTed to X`,
      holders.size === 0 && tok === null && (posts.get('rt-ok') || 0) === posted);
    ok(`T4 ${name}: the refusal is logged once, naming the file`, refusalLines() === 1, `${refusalLines()} line(s)`);
    ok(`T5 ${name}: a drop never throws (its disconnect already happened) and names the account for the repair`,
      dropErr === null && warns.some((m) => m.includes('acct_a') && m.includes('refuses writes')));
  }

  // Latched for the life of the process; a restart after the repair reads it.
  {
    const { file } = fresh('t-latch');
    fs.writeFileSync(file, shapes.torn);
    X.holdersByXUserId();
    fs.writeFileSync(file, good); // a person repairs the file under a running server
    const stillRefused = tryThrow(() => X.saveXToken('acct_c', 'x-c', live('tok-c')));
    ok('T6 the refusal is latched: a file repaired under a running server is still refused until a restart',
      stillRefused?.code === 'store_refused' && fs.readFileSync(file, 'utf8') === good);
    restart();
    const back = X.holdersByXUserId();
    ok('T7 ...and after the restart the repaired rows are back: both holders listed, a token served, saves work',
      back.get('x-a') === 'acct_a' && back.get('x-b') === 'acct_b'
        && (await X.getXAccessToken('acct_a', quiet)) === 'tok-a'
        && X.saveXToken('acct_c', 'x-c', live('tok-c')) === true && X.holdersByXUserId().get('x-c') === 'acct_c');
  }

  // ── H. the healthy round trip ───────────────────────────────────────────
  {
    const { dir, file } = fresh('h-roundtrip');
    ok('H1 with no file yet, the first save creates x-tokens.json', !fs.existsSync(file) && X.saveXToken('acct_h', 'x-h', live('tok-h')) === true && fs.existsSync(file));
    const raw = fs.readFileSync(file, 'utf8');
    const doc = JSON.parse(raw);
    ok('H2 on disk: the X user id in the clear, the token only sealed', doc.tokens?.acct_h?.xUserId === 'x-h' && typeof doc.tokens.acct_h.sealed === 'string'
      && !raw.includes('tok-h') && !raw.includes('tok-h-rt'));
    restart();
    ok('H3 after a restart the token is read back and the holder listed',
      (await X.getXAccessToken('acct_h', quiet)) === 'tok-h' && X.holdersByXUserId().get('x-h') === 'acct_h');
    X.saveXToken('acct_i', 'x-i', live('tok-i'));
    X.dropXToken('acct_h', quiet);
    restart();
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    ok('H4 a drop removes that row from disk and leaves the others', !after.tokens.acct_h && after.tokens.acct_i?.xUserId === 'x-i');
    ok('H5 no temp file is left behind, and nothing was refused', tmpFiles(dir).length === 0 && refusalLines() === 0);
  }
  {
    const { dir } = fresh('h-nokey', '');
    delete process.env.X_TOKEN_KEY;
    ok('H6 with no key, nothing is stored and no file is written', X.tokenStoreConfigured() === false
      && X.saveXToken('acct_n', 'x-n', live('tok-n')) === false && fs.readdirSync(dir).length === 0);
  }

  // ── D. the dead-row rules ───────────────────────────────────────────────
  {
    fresh('d-dead');
    for (const [acct, xid, rt] of [['acct_d400', 'x-400', 'rt-400'], ['acct_d401', 'x-401', 'rt-401'], ['acct_d503', 'x-503', 'rt-503'], ['acct_dnet', 'x-net', 'rt-net']]) X.saveXToken(acct, xid, expired(rt));
    const first = [await X.getXAccessToken('acct_d400', quiet), await X.getXAccessToken('acct_d401', quiet), await X.getXAccessToken('acct_d503', quiet)];
    const second = [await X.getXAccessToken('acct_d400', quiet), await X.getXAccessToken('acct_d401', quiet), await X.getXAccessToken('acct_d503', quiet)];
    const listed = X.holdersByXUserId();
    ok('D1 X refusing a refresh (400 or 401) marks the row dead: no second POST, no longer listed',
      first.every((t) => t === null) && second.every((t) => t === null) && posts.get('rt-400') === 1 && posts.get('rt-401') === 1
        && !listed.has('x-400') && !listed.has('x-401'), `POSTs 400:${posts.get('rt-400')} 401:${posts.get('rt-401')}`);
    ok('D2 ...a 503 never does: still listed, and the next check may try again', posts.get('rt-503') === 2 && listed.has('x-503'), `${posts.get('rt-503')} POSTs`);
    process.env.X_TOKEN_BASE = 'http://127.0.0.1:9'; // nothing listens: a network error, like a timeout
    const net = await X.getXAccessToken('acct_dnet', quiet);
    ok('D3 ...nor does a network error: still listed', net === null && X.holdersByXUserId().has('x-net'));
    process.env.X_TOKEN_BASE = BASE;
    restart();
    ok('D4 the dead mark is on disk: after a restart the refused holders are still not listed',
      !X.holdersByXUserId().has('x-400') && !X.holdersByXUserId().has('x-401') && X.holdersByXUserId().has('x-503'));
    X.saveXToken('acct_d400', 'x-400', live('relinked'));
    ok('D5 a new X sign-in revives a dead holder: listed, its new token served without a POST',
      X.holdersByXUserId().get('x-400') === 'acct_d400' && (await X.getXAccessToken('acct_d400', quiet)) === 'relinked' && !posts.has('relinked-rt'));
  }
  {
    const { file } = fresh('d-rotated', 'gate-key-a');
    X.saveXToken('acct_r1', 'x-r1', live('tok-r1'));
    X.saveXToken('acct_r2', 'x-r2', live('tok-r2'));
    const sealedA = JSON.parse(fs.readFileSync(file, 'utf8')).tokens;
    process.env.X_TOKEN_KEY = 'gate-key-b'; // the secret rotated
    restart();
    const underB = X.holdersByXUserId();
    const tokB = await X.getXAccessToken('acct_r1', quiet);
    ok('D6 under a rotated key the old rows are not listed and serve no token', !underB.has('x-r1') && !underB.has('x-r2') && tokB === null);
    X.saveXToken('acct_r3', 'x-r3', live('tok-r3'));
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')).tokens;
    ok('D7 ...but they stay on disk byte for byte through another holder\'s save',
      onDisk.acct_r1?.sealed === sealedA.acct_r1.sealed && onDisk.acct_r2?.sealed === sealedA.acct_r2.sealed && !!onDisk.acct_r3);
    process.env.X_TOKEN_KEY = 'gate-key-a';
    restart();
    ok('D8 ...so restoring the old key lists them again', X.holdersByXUserId().get('x-r1') === 'acct_r1' && (await X.getXAccessToken('acct_r2', quiet)) === 'tok-r2');
  }
} catch (e) {
  ok(`unexpected: ${e.stack || e.message}`, false);
} finally {
  console.error = realError;
  X._resetXTokensForTests();
  await new Promise((r) => endpoint.close(r));
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed`);
// exitCode, not process.exit(): on Windows (Node 24.12) exiting while the
// refresh path's fetch handles are still closing trips a libuv assertion and
// turns a green run into a crash exit. Nothing is left holding the loop open.
process.exitCode = fail ? 1 : 0;
