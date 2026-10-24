/**
 * GATE — the LiveKit metering state survives a torn write, forgets stale
 * stashes, and the breaker reads its budgets through env-num.js (stores-2
 * wider, server-6 part, cc-2).
 *
 * WHAT IT PROVES, each case in a fresh process on its own scratch DATA_DIR
 *   S1-S3 a torn livekit-webhook-state.json is copied aside byte for byte,
 *         reported on stats().stateRestore and logged — the old restore logged
 *         one line and the next persist overwrote the only evidence of the
 *         burn the breaker could no longer see
 *   S4    the state is written atomically and parses after every event
 *   P1    a participant_left stash whose join never came is aged out with the
 *         dedupe window: a join for that identity much later OPENS a session
 *         (the old stash closed it as an "out of order" zero-length session)
 *   A1-A2 a torn livekit-sessions.json is copied aside and said out loud
 *         before the activity ledger starts fresh (the old one started fresh
 *         silently)
 *   E1-E2 usage at ten times the budget with LK_DAILY_BUDGET_MIN and
 *         LK_MONTHLY_BUDGET_MIN set to "" reads "blocked" (the old parser read
 *         "" as 0 and switched the breaker off); an explicit "0" stays 0
 *
 * Spends nothing, starts no server, no LiveKit minutes: every event is synthetic.
 *
 *   node _gate-livekit-state.mjs
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
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const quiet = () => { const lines = []; return { lines, log: (m) => lines.push(String(m)), warn: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) }; };
const ev = (event, identity, createdAtS, id) => ({ id, event, room: { name: 'gate-room' }, participant: { identity, sid: `PA_${identity}` }, createdAt: createdAtS });

const CASES = {
  async tornState() {
    const { createWebhookTracker } = await mod('livekit-webhooks.js');
    const statePath = path.join(process.env.DATA_DIR, 'livekit-webhook-state.json');
    const full = JSON.stringify({ observingSince: 1_700_000_000_000, lastPersistedAt: 1_700_000_100_000,
      open: [{ k: 'gate-room|seat:a', startedAt: 1_700_000_000_000 }], sessions: [{ room: 'gate-room', identity: 'seat:b', start: 1, end: 60_001, durationMs: 60_000 }] });
    fs.writeFileSync(statePath, full.slice(0, Math.floor(full.length / 2)));
    const tornSha = sha(statePath);
    const L = quiet();
    const t = createWebhookTracker({ statePath, log: L });
    const copies = fs.readdirSync(process.env.DATA_DIR).filter((n) => n.startsWith('livekit-webhook-state.json.corrupt-'));
    const copyIdentical = copies.length === 1 && sha(path.join(process.env.DATA_DIR, copies[0])) === tornSha;
    t.handle(ev('participant_joined', 'seat:c', Math.floor(Date.now() / 1000), 'e1'));
    let parses = false;
    try { JSON.parse(fs.readFileSync(statePath, 'utf8')); parses = true; } catch { /* torn */ }
    return { copies: copies.length, copyIdentical, stateRestore: t.stats().stateRestore ?? null, loud: L.lines.some((l) => /⚠|could not restore/.test(l)), parses,
      tmpLeft: fs.readdirSync(process.env.DATA_DIR).filter((n) => n.endsWith('.tmp')).length };
  },

  async pendingLeft() {
    const { createWebhookTracker } = await mod('livekit-webhooks.js');
    let now = 1_800_000_000_000;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const t = createWebhookTracker({ statePath: null, log: quiet() });
      t.handle(ev('participant_left', 'seat:ghost', now / 1000, 'l1')); // a left whose join we never see
      now += 11 * 60_000;                                                // past the 10-minute dedupe window
      t.handle(ev('participant_joined', 'viewer:other', now / 1000, 'j0')); // any event runs the sweep
      const late = t.handle(ev('participant_joined', 'seat:ghost', now / 1000, 'j1'));
      return { late, open: t.stats().openCount };
    } finally { Date.now = realNow; }
  },

  async tornActivity() {
    const file = path.join(process.env.DATA_DIR, 'livekit-sessions.json');
    fs.writeFileSync(file, '[{"id":"overlay:x@1","roomId":"r","identity":"overlay:x","kind":"overlay","start":1,"end":');
    const tornSha = sha(file);
    const errors = [];
    const realError = console.error;
    console.error = (m) => errors.push(String(m));
    try { await mod('livekit-activity.js'); } finally { console.error = realError; }
    const copies = fs.readdirSync(process.env.DATA_DIR).filter((n) => n.startsWith('livekit-sessions.json.corrupt-'));
    return { copies: copies.length, copyIdentical: copies.length === 1 && sha(path.join(process.env.DATA_DIR, copies[0])) === tornSha, loud: errors.some((e) => /⚠/.test(e)) };
  },

  async breaker() {
    const { createBreaker, breakerConfig } = await mod('livekit-breaker.js');
    const b = createBreaker({ log: quiet(), getUsage: () => ({ minutesToday: 4000, minutesThisMonth: 45000, openSessions: [] }) });
    return { state: b.state(), daily: breakerConfig.dailyBudgetMin, monthly: breakerConfig.monthlyBudgetMin };
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
function run(name, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `mc-lk-${name}-`));
  scratch.push(dataDir);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(LK_|LAZY_)/.test(k)));
  const r = spawnSync(process.execPath, [SELF, '--case', name], { env: { ...clean, DATA_DIR: dataDir, ...env }, encoding: 'utf8', timeout: 60_000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('@@RESULT '));
  return { out: line ? JSON.parse(line.slice(9)) : null, err: (r.stderr || '').slice(-600) };
}

console.log('\n── LiveKit metering state ───────────────────────────────');
try {
  {
    const { out, err } = run('tornState');
    ok('S1 a torn webhook state file is copied aside, byte for byte', out?.copies === 1 && out.copyIdentical === true, out ? JSON.stringify({ copies: out.copies, identical: out.copyIdentical }) : err);
    ok('S2 ...the failure is on stats().stateRestore, not only in a log line', !!out?.stateRestore && out.stateRestore.state === 'corrupt' && !!out.stateRestore.keptAt, JSON.stringify(out?.stateRestore));
    ok('S3 ...and logged loudly', out?.loud === true);
    ok('S4 the next persist writes a file that parses, with no temp file left', out?.parses === true && out.tmpLeft === 0);
  }
  {
    const { out, err } = run('pendingLeft');
    ok('P1 a stale left-before-join stash is aged out: a much later join OPENS a session',
      out?.late?.opened === true && !out.late.closed && out.open === 2, out ? JSON.stringify(out) : err);
  }
  {
    const { out, err } = run('tornActivity');
    ok('A1 a torn activity ledger is copied aside, byte for byte', out?.copies === 1 && out.copyIdentical === true, out ? JSON.stringify(out) : err);
    ok('A2 ...and said out loud before the ledger starts fresh', out?.loud === true);
  }
  {
    const empty = run('breaker', { LK_DAILY_BUDGET_MIN: '', LK_MONTHLY_BUDGET_MIN: '' });
    ok('E1 usage at 10x budget, budgets set to "": the breaker reads "blocked" (the defaults apply)',
      empty.out?.state === 'blocked' && empty.out.daily === 400 && empty.out.monthly === 4500, empty.out ? JSON.stringify(empty.out) : empty.err);
    const zero = run('breaker', { LK_DAILY_BUDGET_MIN: '0' });
    ok('E2 an explicit "0" daily budget stays 0 (documented as "no daily budget")', zero.out?.daily === 0 && zero.out.state === 'blocked', JSON.stringify(zero.out));
  }
} catch (e) {
  ok(`unexpected: ${e.stack || e.message}`, false);
} finally {
  for (const d of scratch) fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
