/**
 * GATE — bounty-store.js: the board is written atomically, refuses a damaged
 * file, and stops rewriting itself per code (stores-2, stores-9, DECISIONS D9).
 *
 * WHAT IT PROVES, each case in a fresh process on its own scratch DATA_DIR
 *   C1-C3 twenty code rotations write bounty.json ZERO times at once and ONCE
 *         within a second (the old store rewrote the whole board per code),
 *         while the evidence log has every code immediately
 *   B1-B2 300 badge self-reports (violation + `badgeTooSmall: true`, what the
 *         /badge route does) cost at most a few board writes, not 600
 *   N1    an update that changes nothing writes nothing
 *   X1    closing the session writes through, taking the held codes with it
 *   K1    a hard kill inside the debounce window loses nothing from the
 *         evidence log — the authority a payout is computed from (a guard:
 *         the old store passes it too)
 *   I1-I2 isCodeIssued answers the rotation's collision check from a kept set
 *   T1-T3 a torn bounty.json refuses writes, store_refused, bytes untouched
 *
 * Spends nothing, starts no server, writes only under the OS temp dir.
 *
 *   node _gate-bounty-board.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scene() {
  const store = await import(pathToFileURL(path.join(HERE, 'bounty-store.js')).href);
  const BOARD = path.join(process.env.DATA_DIR, 'bounty.json');
  // Count whole-board writes, whichever way the module writes: in place
  // (writeFileSync on the path) or atomically (rename onto the path).
  let writes = 0;
  const realWrite = fs.writeFileSync, realRename = fs.renameSync;
  fs.writeFileSync = function (f, ...rest) { if (f === BOARD) writes++; return realWrite.call(this, f, ...rest); };
  fs.renameSync = function (a, b) { if (b === BOARD) writes++; return realRename.call(this, a, b); };
  const r = store.reserveHandle({ platform: 'twitch', handle: 'gateboard', ttlMs: 1e9 });
  const claim = store.createClaim({ handleKey: r.key, claimant: 'gate', ttlMs: 1e9 });
  const s = store.createAirSession({ claimId: claim.id, roomId: 'gate-room', platform: 'twitch' });
  const now = Date.now();
  const win = { clipId: 'clip-1', playbackId: 'clip-1#gate', startedAt: now, endsAt: now + 600_000, durationS: 600, belowSamplingFloor: false, codes: [] };
  store.pushPlaybackWindow(s.id, win);
  const code = (i) => ({ code: `GB-${String(i).padStart(4, '0')}`, clipId: 'clip-1', playbackId: win.playbackId, issuedAt: now + i, expiresAt: now + 8_000 + i });
  const evidenceCodes = () => store.reconcileSessionEvidence(s.id).evidenceCodes;
  const boardCodes = () => (JSON.parse(fs.readFileSync(BOARD, 'utf8')).airSessions[s.id].playbackWindows[0].codes || []).length;
  return { store, s, win, code, BOARD, writes: () => writes, resetWrites: () => { writes = 0; }, evidenceCodes, boardCodes };
}

const CASES = {
  async coalesce() {
    const t = await scene();
    t.resetWrites();
    for (let i = 0; i < 20; i++) t.store.pushWindowCode(t.s.id, t.win.playbackId, t.code(i));
    const immediate = t.writes();
    const evidenceNow = t.evidenceCodes();
    await sleep(1_300);
    return { immediate, after: t.writes(), evidenceNow, boardAfter: t.boardCodes(), diverged: t.store.reconcileSessionEvidence(t.s.id).diverged };
  },
  async badge300() {
    const t = await scene();
    t.resetWrites();
    const t0 = performance.now();
    for (let i = 0; i < 300; i++) {
      t.store.pushAirSessionViolation(t.s.id, { type: 'BADGE_TOO_SMALL_SELF_REPORT', at: Date.now(), detail: { i } });
      t.store.updateAirSession(t.s.id, { badgeTooSmall: true });
    }
    const ms = performance.now() - t0;
    const immediate = t.writes();
    await sleep(1_300);
    const onDisk = JSON.parse(fs.readFileSync(t.BOARD, 'utf8')).airSessions[t.s.id].violations.length;
    return { immediate, after: t.writes(), ms: +ms.toFixed(1), onDisk };
  },
  async noop() {
    const t = await scene();
    t.store.updateAirSession(t.s.id, { badgeTooSmall: true });
    t.resetWrites();
    t.store.updateAirSession(t.s.id, { badgeTooSmall: true, status: 'OPEN' });
    return { writes: t.writes() };
  },
  async close() {
    const t = await scene();
    for (let i = 0; i < 5; i++) t.store.pushWindowCode(t.s.id, t.win.playbackId, t.code(i));
    t.store.updateAirSession(t.s.id, { status: 'CLOSED', endedAt: Date.now() });
    return { boardCodes: t.boardCodes() };
  },
  async kill() {
    const t = await scene();
    for (let i = 0; i < 3; i++) t.store.pushWindowCode(t.s.id, t.win.playbackId, t.code(i));
    process.stdout.write(`@@RESULT ${JSON.stringify({ sessionId: t.s.id })}\n`);
    process.kill(process.pid, 'SIGKILL'); // no exit hooks: the hard kill D9 accepts
  },
  async afterKill() {
    const store = await import(pathToFileURL(path.join(HERE, 'bounty-store.js')).href);
    store.verifyEvidenceIntegrity();
    const id = process.env.GATE_SESSION;
    const rec = store.reconcileSessionEvidence(id);
    return { evidenceCodes: rec.evidenceCodes, boardCodes: rec.cachedCodes };
  },
  async codes() {
    const t = await scene();
    if (typeof t.store.isCodeIssued !== 'function') return { missing: true };
    t.store.pushWindowCode(t.s.id, t.win.playbackId, t.code(1));
    const before = [t.store.isCodeIssued('GB-0001'), t.store.isCodeIssued('GB-0002')];
    t.store.pushWindowCode(t.s.id, t.win.playbackId, t.code(2));
    return { before, after: t.store.isCodeIssued('GB-0002'), fresh: t.store.isCodeIssued('ZZ-9999') };
  },
  async torn() {
    const store = await import(pathToFileURL(path.join(HERE, 'bounty-store.js')).href);
    let err = null;
    try { store.createClaim({ handleKey: 'twitch:gate', claimant: 'gate', ttlMs: 1e9 }); } catch (e) { err = e.code || e.message; }
    return { err, claims: store.listClaims().length };
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
function run(name, { dir = null, seed = null, env = {} } = {}) {
  const dataDir = dir || fs.mkdtempSync(path.join(os.tmpdir(), `mc-board-${name}-`));
  if (!dir) scratch.push(dataDir);
  if (seed) seed(dataDir);
  const r = spawnSync(process.execPath, [SELF, '--case', name], { env: { ...process.env, DATA_DIR: dataDir, ...env }, encoding: 'utf8', timeout: 120_000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('@@RESULT '));
  return { dataDir, status: r.status, out: line ? JSON.parse(line.slice(9)) : null, err: (r.stderr || '').slice(-600) };
}

console.log('\n── bounty board store ───────────────────────────────────');
try {
  {
    const { out, err } = run('coalesce');
    ok('C1 twenty code rotations write the board zero times at once', out?.immediate === 0, out ? `${out.immediate} write(s)` : err);
    ok('C2 ...and once within a second, with all twenty codes', out?.after === 1 && out.boardAfter === 20, JSON.stringify(out && { after: out.after, board: out.boardAfter }));
    ok('C3 ...while the evidence log had every code at once, and the two agree after the write',
      out?.evidenceNow === 20 && out.diverged === false, JSON.stringify(out && { evidence: out.evidenceNow, diverged: out.diverged }));
  }
  {
    const { out, err } = run('badge300');
    ok('B1 300 badge self-reports cost at most two board writes, not 600', !!out && out.immediate <= 2 && out.after <= 2, out ? JSON.stringify(out) : err);
    ok('B2 ...and every report is on disk after the debounce', out?.onDisk === 300, String(out?.onDisk));
  }
  {
    const { out } = run('noop');
    ok('N1 an air-session update that changes nothing writes nothing', out?.writes === 0, String(out?.writes));
  }
  {
    const { out } = run('close');
    ok('X1 closing the session writes through, taking the held codes with it', out?.boardCodes === 5, String(out?.boardCodes));
  }
  {
    const killed = run('kill');
    const after = killed.out ? run('afterKill', { dir: killed.dataDir, env: { GATE_SESSION: killed.out.sessionId } }) : { out: null };
    ok('K1 a hard kill inside the debounce window loses no code from the evidence log',
      after.out?.evidenceCodes === 3, JSON.stringify(after.out) + (after.err ? ` ${after.err}` : ''));
  }
  {
    const { out } = run('codes');
    ok('I1 isCodeIssued knows an issued code and not an unissued one', out && !out.missing && out.before[0] === true && out.before[1] === false && out.fresh === false, JSON.stringify(out));
    ok('I2 ...and learns each new code as it is issued', out?.after === true);
  }
  {
    const full = JSON.stringify({ reservedHandles: {}, contributions: { c1: { id: 'c1', amount: '5', status: 'HELD' } }, claims: { k1: { id: 'k1' } }, airSessions: {}, verifications: {}, reviews: {}, pledges: {}, strikes: {} }, null, 2);
    let file = null, before = null;
    const { out, err } = run('torn', { seed: (d) => { file = path.join(d, 'bounty.json'); fs.writeFileSync(file, full.slice(0, Math.floor(full.length / 2))); before = sha(file); } });
    ok('T1 a torn bounty.json refuses a new claim with store_refused', out?.err === 'store_refused', out ? String(out.err) : err);
    ok('T2 ...serves no records rather than inventing an empty board on disk', out?.claims === 0);
    ok('T3 ...and leaves the bytes untouched', !!file && sha(file) === before);
  }
} catch (e) {
  ok(`unexpected: ${e.stack || e.message}`, false);
} finally {
  for (const d of scratch) fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
