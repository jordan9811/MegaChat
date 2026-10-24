/**
 * GATE — airings-store.js: moments stop rewriting the whole file, a damaged
 * file is not read as empty, and a deleted room's airings go (stores-9,
 * stores-2, DECISIONS D9).
 *
 * WHAT IT PROVES, each case in a fresh process on its own scratch DATA_DIR
 *   W1-W3 with a few megabytes of airings on disk, twenty moments write the
 *         file zero times at once and once within a second (the old store
 *         rewrote all of it, pretty-printed, per moment)
 *   X1    closing an airing writes through, with the moments still held
 *   R1    the boot's restart mark writes through (a reader right after boot
 *         sees it)
 *   P1-P2 pruneToRooms drops the airings of rooms that no longer exist and
 *         keeps the rest
 *   T1-T3 a torn airings.json: recording calls quietly do nothing (never a
 *         throw inside a seat or letter path), and the bytes are untouched
 *
 * Spends nothing, starts no server, writes only under the OS temp dir.
 *
 *   node _gate-airings-store.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILE = () => path.join(process.env.DATA_DIR, 'airings.json');
const load = () => import(pathToFileURL(path.join(HERE, 'airings-store.js')).href);

function countWrites() {
  let n = 0;
  const realWrite = fs.writeFileSync, realRename = fs.renameSync;
  fs.writeFileSync = function (f, ...rest) { if (f === FILE()) n++; return realWrite.call(this, f, ...rest); };
  fs.renameSync = function (a, b) { if (b === FILE()) n++; return realRename.call(this, a, b); };
  return { count: () => n, reset: () => { n = 0; } };
}
const onDisk = () => JSON.parse(fs.readFileSync(FILE(), 'utf8')).airings;

const CASES = {
  async cost() {
    const a = await load();
    const w = countWrites();
    a.openAiring({ roomId: 'live0001', channel: 'live0001' });
    w.reset();
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) a.addMoment('live0001', { kind: i % 2 ? 'seat' : 'seat_leave', label: '@x' });
    const perMomentMs = (performance.now() - t0) / 20;
    const immediate = w.count();
    await sleep(1_300);
    const mine = onDisk().find((x) => x.roomId === 'live0001');
    return { immediate, after: w.count(), perMomentMs: +perMomentMs.toFixed(2), moments: mine?.moments.length, fileMB: +(fs.statSync(FILE()).size / 1048576).toFixed(2) };
  },
  async close() {
    const a = await load();
    a.openAiring({ roomId: 'r1' });
    for (let i = 0; i < 5; i++) a.addMoment('r1', { kind: 'seat', label: `@g${i}` });
    a.closeAiring('r1');
    const mine = onDisk().find((x) => x.roomId === 'r1');
    return { moments: mine?.moments.length, closed: mine?.endedAt != null };
  },
  async restart() {
    const a = await load();
    a.openAiring({ roomId: 'r1' });
    const marked = a.markRestart();
    return { marked, onDisk: onDisk()[0]?.moments.some((m) => m.kind === 'restart') };
  },
  async prune() {
    const a = await load();
    for (const room of ['keep-a', 'gone-b', 'gone-c']) { a.openAiring({ roomId: room }); a.closeAiring(room); }
    if (typeof a.pruneToRooms !== 'function') return { missing: true };
    const dropped = a.pruneToRooms(['keep-a', 'default']);
    return { dropped, rooms: onDisk().map((x) => x.roomId) };
  },
  async torn() {
    const a = await load();
    const out = {};
    try {
      out.open = a.openAiring({ roomId: 'r1', channel: 'c' });
      out.moment = a.addMoment('r1', { kind: 'seat' });
      out.restart = a.markRestart();
      out.closed = a.closeAiring('r1');
    } catch (e) { out.threw = e.message; }
    await sleep(1_300);
    return out;
  },
};

if (process.argv[2] === '--case') {
  const out = await CASES[process.argv[3]]();
  process.stdout.write(`@@RESULT ${JSON.stringify(out)}\n`);
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const scratch = [];
function run(name, seed = null) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `mc-airings-${name}-`));
  scratch.push(dataDir);
  if (seed) seed(dataDir);
  const r = spawnSync(process.execPath, [SELF, '--case', name], { env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8', timeout: 120_000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('@@RESULT '));
  return { out: line ? JSON.parse(line.slice(9)) : null, err: (r.stderr || '').slice(-600) };
}
/** 50 rooms × 20 airings × 40 moments: a quarter of the retention bound. */
function seedBig(dir) {
  const airings = [];
  for (let r = 0; r < 50; r++) {
    for (let k = 0; k < 20; k++) {
      const startedAt = Date.now() - (r * 20 + k + 1) * 3_600_000;
      airings.push({ id: randomUUID(), roomId: `room${r}`, platform: 'twitch', channel: `streamer_${r}`, startedAt, endedAt: startedAt + 3_000_000,
        vodId: null, vodUrl: null, captureRef: null,
        moments: Array.from({ length: 40 }, (_, m) => ({ at: startedAt + m * 60_000, kind: m % 3 ? 'seat' : 'megachat', label: `@viewer_${m}`, offsetMs: m * 60_000 })) });
    }
  }
  fs.writeFileSync(path.join(dir, 'airings.json'), JSON.stringify({ airings }, null, 2));
}

console.log('\n── airings store ────────────────────────────────────────');
try {
  {
    const { out, err } = run('cost', seedBig);
    ok('W1 twenty moments write airings.json zero times at once', out?.immediate === 0, out ? `${out.immediate} write(s), ${out.perMomentMs} ms/moment` : err);
    ok('W2 ...and once within a second, holding all twenty', out?.after === 1 && out.moments === 20, JSON.stringify(out));
    ok('W3 ...a moment costs well under a millisecond, not a whole-file rewrite', out?.perMomentMs < 1, `${out?.perMomentMs} ms`);
  }
  {
    const { out } = run('close');
    ok('X1 closing an airing writes through, with every held moment', out?.moments === 5 && out.closed === true, JSON.stringify(out));
  }
  {
    const { out } = run('restart');
    ok('R1 the boot restart mark is on disk at once', out?.marked === 1 && out.onDisk === true, JSON.stringify(out));
  }
  {
    const { out } = run('prune');
    ok('P1 pruneToRooms drops the airings of rooms that are gone', out && !out.missing && out.dropped === 2, JSON.stringify(out));
    ok('P2 ...and keeps the rest', JSON.stringify(out?.rooms) === '["keep-a"]');
  }
  {
    let file = null, before = null;
    const { out, err } = run('torn', (d) => {
      file = path.join(d, 'airings.json');
      const full = JSON.stringify({ airings: [{ id: 'a1', roomId: 'r9', startedAt: 1, endedAt: 2, moments: [] }] }, null, 2);
      fs.writeFileSync(file, full.slice(0, 40));
      before = sha(file);
    });
    ok('T1 a torn airings.json: recording calls do not throw', out && !out.threw, out ? String(out.threw || '') : err);
    ok('T2 ...they quietly record nothing', out && out.open === null && out.moment === null && out.restart === 0 && out.closed === null, JSON.stringify(out));
    ok('T3 ...and the bytes on disk are untouched', !!file && sha(file) === before);
  }
} catch (e) {
  ok(`unexpected: ${e.stack || e.message}`, false);
} finally {
  for (const d of scratch) fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
