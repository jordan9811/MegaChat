/**
 * GATE — json-store.js: a JSON store can no longer wipe itself (stores-2).
 *
 * THE DEFECT. Five stores wrote in place (`fs.writeFileSync`) and read ANY
 * failure as "empty", so one torn write became total, silent loss at the next
 * save — for rooms.json at the next boot.
 *
 * WHAT IT PROVES
 *   A. TORN WRITES. A child rewrites a ~2 MB document in a loop and is killed
 *      at a random moment, again and again. With `fs.writeFileSync` some kills
 *      leave a file that does not parse; with `writeJsonAtomic`, none do.
 *      This case runs the OLD writer beside the new one and asserts they
 *      disagree, so it discriminates by itself.
 *   B. THE LOADER. Missing, zero-byte, unparsable and wrong-shaped files are
 *      told apart. Every one but "missing" refuses writes: the original bytes
 *      survive a save attempt, the view is frozen, and the refusal is logged
 *      once. The old loader pattern (copied here) serves `{}` and the next save
 *      destroys the file — run side by side, they disagree.
 *   C. A FAILED WRITE leaves the previous file whole and no temp file behind.
 *   D. DEBOUNCED SAVES (D9) coalesce a burst into one write, flush on
 *      `process.exit()`, and flushPendingWrites() writes what is held.
 *
 * Spends nothing, starts no server, touches no chain, writes only under the
 * OS temp dir.
 *
 *   node _gate-store-atomic.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── child roles ─────────────────────────────────────────────────────────────
if (process.argv[2] === '--writer') {
  // Rewrite one big document forever; announce the first complete write.
  const [mode, file] = process.argv.slice(3);
  const { writeJsonAtomic } = await import(pathToFileURL(path.join(HERE, 'json-store.js')).href);
  const doc = { rows: Array.from({ length: 20000 }, (_, i) => ({ i, s: 'x'.repeat(80) })) };
  let n = 0;
  for (;;) {
    doc.n = ++n;
    try {
      if (mode === 'old') fs.writeFileSync(file, JSON.stringify(doc, null, 2));
      else writeJsonAtomic(file, doc, { pretty: true });
    } catch { /* a scanner holding the file for a moment; keep going */ }
    if (n === 1) process.stdout.write('ready\n');
  }
}
if (process.argv[2] === '--exit-flush') {
  const { createJsonStore } = await import(pathToFileURL(path.join(HERE, 'json-store.js')).href);
  const s = createJsonStore({ file: process.argv[3], name: 'gate', empty: () => ({ v: 0 }), debounceMs: 60_000 });
  s.data().v = 42;
  s.saveSoon();
  process.exit(0); // the held write must land anyway
}

// ── parent ──────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-store-atomic-'));
const { writeJsonAtomic, readJsonFile, createJsonStore, flushPendingWrites, StoreRefused } =
  await import(pathToFileURL(path.join(HERE, 'json-store.js')).href);

console.log('\n── json-store: atomic writes, refused loads ─────────────');

try {
  // ── A. torn writes: kill a writer mid-loop, many times ───────────────────
  // On Windows a 2 MB writeFileSync is one write call, so the old writer tears
  // only when a kill lands between its truncate and that write: ~1 kill in 30
  // here. 200 kills put the odds of the old path showing no tear near 0.1%.
  const KILLS = Number(process.env.GATE_KILLS || 200);
  async function tornCount(mode) {
    const file = path.join(work, `torn-${mode}.json`);
    let torn = 0, killed = 0;
    for (let k = 0; k < KILLS; k++) {
      const child = spawn(process.execPath, [SELF, '--writer', mode, file], { stdio: ['ignore', 'pipe', 'ignore'] });
      const ready = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 15_000);
        child.stdout.on('data', (d) => { if (String(d).includes('ready')) { clearTimeout(t); resolve(true); } });
        child.on('exit', () => { clearTimeout(t); resolve(false); });
      });
      if (!ready) { child.kill(); continue; }
      await sleep(Math.floor(Math.random() * 40));
      child.kill('SIGKILL');
      await new Promise((r) => (child.exitCode !== null || child.signalCode ? r() : child.on('exit', r)));
      killed++;
      if (readJsonFile(file).state !== 'ok') torn++;
    }
    return { torn, killed };
  }
  const old = await tornCount('old');
  const neu = await tornCount('new');
  ok('A1 the OLD writer (writeFileSync in place), killed mid-loop, leaves files that do not parse',
    old.torn > 0, `${old.torn} torn of ${old.killed} kills`);
  ok('A2 writeJsonAtomic, killed the same way, never does', neu.killed > 0 && neu.torn === 0, `${neu.torn} torn of ${neu.killed} kills`);
  ok('A3 ...so the two disagree: this case discriminates on its own', old.torn > neu.torn);

  // ── B. the loader ────────────────────────────────────────────────────────
  const valid = JSON.stringify({ rooms: { a: { id: 'a', name: 'kept' }, b: { id: 'b' } } }, null, 2);
  const cases = {
    missing: null,
    empty: '',
    torn: valid.slice(0, Math.floor(valid.length / 2)),
    shape: '[1, 2, 3]',
  };
  const states = {};
  for (const [name, bytes] of Object.entries(cases)) {
    const f = path.join(work, `load-${name}.json`);
    if (bytes !== null) fs.writeFileSync(f, bytes);
    states[name] = readJsonFile(f).state;
  }
  ok('B1 readJsonFile tells missing, zero-byte and unparsable apart',
    states.missing === 'missing' && states.empty === 'empty' && states.torn === 'corrupt' && states.shape === 'ok',
    JSON.stringify(states));

  for (const name of ['empty', 'torn', 'shape']) {
    const f = path.join(work, `load-${name}.json`);
    const before = sha(f);
    const errors = [];
    const s = createJsonStore({ file: f, name: `gate-${name}`, empty: () => ({ rooms: {} }), log: { error: (m) => errors.push(m), warn() {} } });
    const view = s.data();
    let threw = null;
    try { view.rooms.x = 1; } catch (e) { threw = e; }
    let refused = null;
    try { s.save(); } catch (e) { refused = e; }
    try { s.saveSoon(); } catch { /* refused too */ }
    s.data(); s.refusal();
    ok(`B2 ${name}: refused for writing — save() throws StoreRefused`, refused instanceof StoreRefused && refused.code === 'store_refused', refused?.message?.slice(0, 80));
    ok(`B3 ${name}: the original bytes survive the write attempt`, sha(f) === before);
    ok(`B4 ${name}: the served view is empty and frozen, so a missed check cannot drift from disk`,
      Object.keys(view.rooms).length === 0 && threw instanceof TypeError);
    ok(`B5 ${name}: logged once, loudly`, errors.length === 1 && /REFUSING WRITES/.test(errors[0]));
  }

  // The OLD loader, as rooms-store/accounts/whitelist/bounty/airings had it.
  {
    const f = path.join(work, 'old-loader.json');
    fs.writeFileSync(f, cases.torn);
    let cache;
    try { cache = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { cache = { rooms: {} }; }
    cache.rooms.default = { id: 'default' };
    fs.writeFileSync(f, JSON.stringify(cache, null, 2));
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    ok('B6 the OLD loader on the same torn file: served as empty, and the next save erased it — the new one disagrees',
      !after.rooms.a && Object.keys(after.rooms).length === 1);
  }

  {
    const f = path.join(work, 'fresh', 'store.json');
    const s = createJsonStore({ file: f, name: 'gate-fresh', writeIfMissing: true, empty: () => ({ items: [] }) });
    s.data();
    ok('B7 a MISSING file is a first boot: empty, writable, and created when asked',
      !s.refusal() && fs.existsSync(f) && readJsonFile(f).state === 'ok');
    s.data().items.push(1);
    s.save();
    ok('B8 ...and a save writes the document', JSON.parse(fs.readFileSync(f, 'utf8')).items[0] === 1);
  }

  // ── C. a failed write leaves the previous file whole ────────────────────
  {
    const f = path.join(work, 'fail.json');
    writeJsonAtomic(f, { v: 'previous' });
    const realFsync = fs.fsyncSync;
    fs.fsyncSync = () => { throw Object.assign(new Error('EIO: simulated'), { code: 'EIO' }); };
    let threw = null;
    try { writeJsonAtomic(f, { v: 'next' }); } catch (e) { threw = e; }
    fs.fsyncSync = realFsync;
    const leftovers = fs.readdirSync(work).filter((n) => n.startsWith('fail.json.') && n.endsWith('.tmp'));
    ok('C1 a write that fails throws', threw?.code === 'EIO');
    ok('C2 ...and leaves the previous document whole', JSON.parse(fs.readFileSync(f, 'utf8')).v === 'previous');
    ok('C3 ...with no temp file behind', leftovers.length === 0, leftovers.join(','));
  }

  // ── D. debounced saves ───────────────────────────────────────────────────
  {
    const f = path.join(work, 'debounce.json');
    const s = createJsonStore({ file: f, name: 'gate-debounce', empty: () => ({ n: 0 }), debounceMs: 300 });
    let renames = 0;
    const realRename = fs.renameSync;
    fs.renameSync = (a, b) => { if (b === f) renames++; return realRename(a, b); };
    for (let i = 0; i < 50; i++) { s.data().n = i + 1; s.saveSoon(); }
    const immediate = renames;
    await sleep(700);
    fs.renameSync = realRename;
    ok('D1 fifty saveSoon() calls write nothing at once', immediate === 0, `${immediate} writes`);
    ok('D2 ...and exactly one write after the debounce, holding the last value',
      renames === 1 && JSON.parse(fs.readFileSync(f, 'utf8')).n === 50, `${renames} write(s)`);

    s.data().n = 51;
    s.saveSoon();
    ok('D3 flushPendingWrites() writes what is held', flushPendingWrites() === 1 && JSON.parse(fs.readFileSync(f, 'utf8')).n === 51);

    const g = path.join(work, 'exit-flush.json');
    const r = spawnSync(process.execPath, [SELF, '--exit-flush', g], { encoding: 'utf8' });
    ok('D4 a held write lands when the process exits (every gate ends in process.exit)',
      r.status === 0 && readJsonFile(g).state === 'ok' && JSON.parse(fs.readFileSync(g, 'utf8')).v === 42, r.stderr.slice(-200));
  }
} catch (e) {
  ok(`unexpected: ${e.stack || e.message}`, false);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
