/**
 * GATE — overlay-visibility.js answers the meter from memory, and a damaged
 * chain stays refused (stores-3 + server-1, DECISIONS D4's meter half).
 *
 * THE DEFECT. `shouldCharge` runs for every metered seat every second, and
 * each call re-read and re-hashed the whole overlay-visibility.jsonl — 31-37
 * ms at 10,000 rows, growing with every transition ever recorded.
 *
 * WHAT IT PROVES, on a seeded chain of 10,000 rows over 200 rooms
 *   F1    1,000 shouldCharge calls read the file at most once (old: every call)
 *   E1-E5 latestFor (per room and per session), signalsFor (with `since`),
 *         hiddenWindows and shouldCharge return EXACTLY what the old
 *         read-everything functions (copied below) return, for every room
 *   E6    a signal recorded after the index is built is seen at once, and a
 *         repeat is still not a new row
 *   S1    a call costs under 0.1 ms (old: tens of ms)
 *   L1-L4 an interior row damaged: the first read throws LedgerCorrupt, so
 *         does every later one, recordSignal appends nothing, the file is
 *         untouched, and visibilityVerdict answers known:false — the meter's
 *         "cannot tell", which must not charge (D4)
 *
 * Spends nothing, starts no server, writes only under the OS temp dir.
 *
 *   node _gate-visibility-index.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const mod = (f) => import(pathToFileURL(path.join(HERE, f)).href);
const LEDGER = () => path.join(process.env.DATA_DIR, 'overlay-visibility.jsonl');

// ── the read-everything functions, as they were (the reference) ─────────────
const old = {
  signalsFor: (rows, roomId, { sessionKey = null, since = null } = {}) => rows.filter((r) =>
    r.type === 'overlay_visibility'
    && r.roomId === String(roomId)
    && (sessionKey == null || r.sessionKey === String(sessionKey))
    && (since == null || r.at >= since)),
  latestFor(rows, roomId, sessionKey = null) {
    const x = old.signalsFor(rows, roomId, { sessionKey });
    return x.length ? x[x.length - 1] : null;
  },
  hiddenWindows(rows, roomId, { sessionKey = null } = {}) {
    const windows = [];
    let open = null;
    for (const r of old.signalsFor(rows, roomId, { sessionKey })) {
      const isDark = r.signal === 'overlay_hidden' || r.signal === 'overlay_scaled_below_floor';
      if (isDark && !open) open = { signal: r.signal, reason: r.reason, startedAt: r.at, endedAt: null, detail: r.detail };
      else if (!isDark && open) { open.endedAt = r.at; open.closedBy = r.signal; windows.push(open); open = null; }
    }
    if (open) windows.push(open);
    return windows;
  },
  shouldCharge(rows, roomId) { const l = old.latestFor(rows, roomId); return !(l && l.signal === 'overlay_hidden'); },
};

const ROOMS = 200, ROWS = 10_000;
const room = (i) => `room${String(i).padStart(3, '0')}`;
async function seed() {
  const { checksum } = await mod('bounty-ledger.js');
  const signals = ['overlay_visible', 'overlay_hidden', 'overlay_scaled_below_floor', 'obs_disconnected'];
  const reasons = ['scene', 'disabled', 'offcanvas', 'covered'];
  let x = 12345; const rnd = (n) => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x % n; };
  let buf = '';
  for (let i = 0; i < ROWS; i++) {
    const signal = signals[rnd(4)];
    const sk = rnd(3);
    const rec = { type: 'overlay_visibility', roomId: room(rnd(ROOMS)), sessionKey: sk ? `air-${sk}` : null, signal,
      reason: signal === 'overlay_hidden' ? reasons[rnd(4)] : null, at: 1_000_000 + i * 1000, detail: null, measurement: null, seq: i + 1 };
    buf += JSON.stringify({ ...rec, sum: checksum(rec) }) + '\n';
  }
  fs.writeFileSync(LEDGER(), buf);
  return buf.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const CASES = {
  async index() {
    const rows = await seed();
    const vis = await mod('overlay-visibility.js');
    const seat = await mod('seat-escrow.js');
    let reads = 0;
    const real = fs.readFileSync;
    fs.readFileSync = function (f, ...rest) { if (String(f).endsWith('overlay-visibility.jsonl')) reads++; return real.call(this, f, ...rest); };
    for (let i = 0; i < 1000; i++) seat.shouldCharge(room(i % ROOMS));
    fs.readFileSync = real;

    const mism = { latest: 0, session: 0, since: 0, windows: 0, charge: 0 };
    for (let i = 0; i < ROOMS; i++) {
      const id = room(i);
      if (JSON.stringify(vis.latestFor(id)) !== JSON.stringify(old.latestFor(rows, id))) mism.latest++;
      for (const sk of ['air-1', 'air-2', 'never']) if (JSON.stringify(vis.latestFor(id, sk)) !== JSON.stringify(old.latestFor(rows, id, sk))) mism.session++;
      const since = 1_000_000 + 5_000_000;
      if (JSON.stringify(vis.signalsFor(id, { since })) !== JSON.stringify(old.signalsFor(rows, id, { since }))) mism.since++;
      if (JSON.stringify(vis.hiddenWindows(id)) !== JSON.stringify(old.hiddenWindows(rows, id))
        || JSON.stringify(vis.hiddenWindows(id, { sessionKey: 'air-2' })) !== JSON.stringify(old.hiddenWindows(rows, id, { sessionKey: 'air-2' }))) mism.windows++;
      if (seat.shouldCharge(id) !== old.shouldCharge(rows, id)) mism.charge++;
    }
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) seat.shouldCharge(room(i % ROOMS));
    const perCallMs = (performance.now() - t0) / 2000;

    const target = room(7);
    const latest = vis.latestFor(target);
    const next = latest?.signal === 'overlay_hidden' ? 'overlay_visible' : 'overlay_hidden';
    const rec = vis.recordSignal(target, { signal: next, reason: next === 'overlay_hidden' ? 'scene' : null, at: 9e12 });
    const seen = vis.latestFor(target)?.seq === rec.row?.seq;
    const repeat = vis.recordSignal(target, { signal: next, reason: next === 'overlay_hidden' ? 'scene' : null, at: 9e12 + 1 }).appended;
    return { reads, mism, perCallMs: +perCallMs.toFixed(4), appended: rec.appended, seen, repeat, lines: fs.readFileSync(LEDGER(), 'utf8').trim().split('\n').length };
  },

  async corrupt() {
    await seed();
    // Damage an INTERIOR row: change a field, keep its old checksum.
    const lines = fs.readFileSync(LEDGER(), 'utf8').split('\n');
    lines[100] = lines[100].replace('"at":1100000', '"at":1100001');
    fs.writeFileSync(LEDGER(), lines.join('\n'));
    const before = createHash('sha256').update(fs.readFileSync(LEDGER())).digest('hex');
    const vis = await mod('overlay-visibility.js');
    const codeOf = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code || e.message; } };
    const out = {
      first: codeOf(() => vis.latestFor(room(1))),
      second: codeOf(() => vis.latestFor(room(1))),
      signals: codeOf(() => vis.signalsFor(room(2))),
      record: codeOf(() => vis.recordSignal(room(3), { signal: 'overlay_hidden', reason: 'scene' })),
      verdict: typeof vis.visibilityVerdict === 'function' ? vis.visibilityVerdict(room(1)) : 'missing',
    };
    out.untouched = createHash('sha256').update(fs.readFileSync(LEDGER())).digest('hex') === before;
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
const scratch = [];
function run(name) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `mc-visidx-${name}-`));
  scratch.push(dataDir);
  const r = spawnSync(process.execPath, [SELF, '--case', name], { env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8', timeout: 600_000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('@@RESULT '));
  return { out: line ? JSON.parse(line.slice(9)) : null, err: (r.stderr || '').slice(-600) };
}

console.log('\n── overlay visibility: in-memory index ──────────────────');
try {
  {
    const { out, err } = run('index');
    ok('F1 1,000 shouldCharge calls read overlay-visibility.jsonl at most once', out && out.reads <= 1, out ? `${out.reads} read(s)` : err);
    ok('E1 latestFor matches the old function for all 200 rooms', out?.mism.latest === 0, JSON.stringify(out?.mism));
    ok('E2 ...per session too (including a session that never signalled)', out?.mism.session === 0);
    ok('E3 signalsFor with `since` matches', out?.mism.since === 0);
    ok('E4 hiddenWindows matches, per room and per session', out?.mism.windows === 0);
    ok('E5 shouldCharge matches', out?.mism.charge === 0);
    ok('E6 a new signal is seen at once; a repeat is still not a row', out?.appended === true && out.seen === true && out.repeat === false && out.lines === 10_001, JSON.stringify(out && { appended: out.appended, seen: out.seen, repeat: out.repeat, lines: out.lines }));
    ok('S1 a shouldCharge call at 10,000 rows costs under 0.1 ms', out?.perCallMs < 0.1, `${out?.perCallMs} ms`);
  }
  {
    const { out, err } = run('corrupt');
    ok('L1 a damaged interior row: the first read throws LedgerCorrupt', out?.first === 'ledger_corrupt', out ? out.first : err);
    ok('L2 ...and so does every later read — never an empty record', out?.second === 'ledger_corrupt' && out.signals === 'ledger_corrupt', JSON.stringify(out && [out.second, out.signals]));
    ok('L3 recordSignal refuses too, and the file is untouched', out?.record === 'ledger_corrupt' && out.untouched === true, JSON.stringify(out && [out.record, out.untouched]));
    ok('L4 visibilityVerdict answers known:false — the meter must not charge on it (D4)', out?.verdict?.known === false, JSON.stringify(out?.verdict));
  }
} catch (e) {
  ok(`unexpected: ${e.stack || e.message}`, false);
} finally {
  for (const d of scratch) fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
