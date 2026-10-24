/**
 * GATE — cross-cutting housekeeping (audit 2026-10-24, cc-2 / cc-4 / cc-9 / cc-39).
 *
 * WHAT THIS PROVES
 *   E. env-num.js reads an empty, blank or malformed variable as UNSET (the
 *      caller's default), keeps an explicit '0' as 0, and applies a floor only
 *      where one is asked for. Every row runs beside the reader the four config
 *      modules carried at 1f06bef, and the rows that matter show the two
 *      disagree.
 *   B. End to end through the REAL livekit-breaker.js, usage at ten times the
 *      default budget: an empty budget and a malformed '95%' threshold must
 *      still read "blocked". At 1f06bef both read "ok" (the breaker was off).
 *   L. The real livekit-lazy.config.js: an empty LAZY_GRACE_MS is the 60 s
 *      default, not a 0 ms grace window.
 *   A. The real airing-posters.js sweep: an empty or malformed
 *      POSTER_VOD_WAIT_MS still waits for the recording; an explicit '0' (what
 *      the airing gates set) still does not.
 *   D. No root script imports dotenv, which no package.json declares.
 *   P. Nothing can rebuild public/passkey-wallet.bundle.js, the Circle bundle
 *      Gate H requires to 404.
 *   G. .gitignore covers every runtime store under data/, keeps data/.gitkeep,
 *      and nothing under data/ but .gitkeep is tracked.
 *
 * WHAT IT DOES NOT PROVE: that any OTHER module reads its numbers through
 * env-num.js. bounty-claim.config.js, seat-escrow.js, server.js and the rest
 * adopt it in their own lanes; this gate covers the two LiveKit configs and
 * airing-posters.js only.
 *
 * No server, no network, no funds: B, L and A run each case in a child
 * process so the import-time config is fresh (A in a throwaway DATA_DIR).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.basename(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};

console.log('\n── Gate: cross-cutting housekeeping ─────────────────────────');

// ── E. env-num, row by row, against the old reader ─────────────────────────
{
  const { envNum } = await import(pathToFileURL(path.join(ROOT, 'env-num.js')).href);
  // The reader livekit-breaker.js, livekit-lazy.config.js and
  // bounty-claim.config.js each carried at 1f06bef.
  const oldNum = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  const read = (raw, d, opts) => {
    const name = `GATE_CC_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    if (raw === undefined) delete process.env[name]; else process.env[name] = raw;
    const before = warnings.length;
    const value = envNum(name, d, opts);
    const again = envNum(name, d, opts);
    const said = warnings.slice(before);
    delete process.env[name];
    return { name, value, again, said };
  };
  try {
    let r = read(undefined, 400);
    ok('E1. unset reads as the default', r.value === 400, String(r.value));
    r = read('', 400);
    ok('E2. empty reads as the default, not 0', r.value === 400 && r.said.length === 0, `new ${r.value}`);
    ok('E2. DISCRIMINATES: the old reader gave 0 for the same empty value', oldNum('', 400) === 0);
    r = read('   ', 4500);
    ok('E3. whitespace reads as the default', r.value === 4500 && oldNum('   ', 4500) === 0, `new ${r.value}, old ${oldNum('   ', 4500)}`);
    r = read('abc', 60);
    ok('E4. a non-number reads as the default', r.value === 60);
    ok('E4. ...with ONE warning that names the variable and not its value',
      r.said.length === 1 && r.said[0].includes(r.name) && !r.said[0].includes('abc'), r.said.join(' | '));
    r = read('95%', 0.95);
    ok('E5. "95%" reads as the default', r.value === 0.95, String(r.value));
    r = read('Infinity', 5);
    ok('E6. a non-finite number reads as the default', r.value === 5);
    r = read('0', 400);
    ok('E7. an explicit "0" stays 0 (gates set five variables to 0 on purpose)', r.value === 0 && oldNum('0', 400) === 0);
    r = read('12', 400);
    ok('E8. "12" reads as 12', r.value === 12);
    r = read(' 12 ', 400);
    ok('E8. ...and " 12 " as 12', r.value === 12);
    r = read('5', 60_000, { min: 1000 });
    ok('E9. with a floor, a positive value below it is raised to it, once-warned', r.value === 1000 && r.again === 1000 && r.said.length === 1, `${r.value}, ${r.said.length} warning(s)`);
    r = read('0', 60_000, { min: 1000 });
    ok('E9. ...0 is raised too (a 0 ms interval is a 1 ms timer)', r.value === 1000);
    r = read('-5', 60_000, { min: 0 });
    ok('E9. ...a negative value is unusable: the default, as seat-escrow.js already did', r.value === 60_000 && r.said.length === 1);
    r = read('250', 60_000, { min: 100 });
    ok('E9. ...a value at or above the floor is left alone, silently', r.value === 250 && r.said.length === 0);
    r = read('', 60_000, { min: 1000 });
    ok('E9. ...and empty is still the default, not the floor', r.value === 60_000);
  } finally {
    console.warn = realWarn;
  }
}

// ── B / L. The real config modules, each case in a fresh child ─────────────
function child(code, env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(LK_|LAZY_)/.test(k)));
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT, env: { ...clean, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out.trim().split('\n').pop());
}
{
  const breakerUrl = pathToFileURL(path.join(ROOT, 'livekit-breaker.js')).href;
  const code = `
const { createBreaker, breakerConfig } = await import(${JSON.stringify(breakerUrl)});
const b = createBreaker({ log: { log() {}, warn() {}, error() {} }, getUsage: () => ({ minutesToday: 4000, minutesThisMonth: 45000, openSessions: [] }) });
console.log(JSON.stringify({ state: b.state(), daily: breakerConfig.dailyBudgetMin, monthly: breakerConfig.monthlyBudgetMin, blockAt: breakerConfig.blockAt }));`;
  let r = child(code, {});
  ok('B1. defaults, usage at 10x budget: blocked', r.state === 'blocked', JSON.stringify(r));
  r = child(code, { LK_DAILY_BUDGET_MIN: '', LK_MONTHLY_BUDGET_MIN: '' });
  ok('B2. empty budgets: still blocked (1f06bef read "ok": both budgets 0, breaker off)', r.state === 'blocked' && r.daily === 400 && r.monthly === 4500, JSON.stringify(r));
  r = child(code, { LK_BREAKER_WARN_AT: '75%', LK_BREAKER_BLOCK_AT: '95%' });
  ok('B3. "95%" thresholds: still blocked (1f06bef read "ok": NaN never compares true)', r.state === 'blocked' && r.blockAt === 0.95, JSON.stringify(r));
  r = child(code, { LK_DAILY_BUDGET_MIN: '0' });
  ok('B4. an explicit "0" budget stays 0 (the breaker documents 0 as "no daily budget")', r.daily === 0 && r.state === 'blocked', JSON.stringify(r));

  const lazyUrl = pathToFileURL(path.join(ROOT, 'livekit-lazy.config.js')).href;
  const lazy = `
const { lazyConfig } = await import(${JSON.stringify(lazyUrl)});
console.log(JSON.stringify({ graceMs: lazyConfig.graceMs, abandonMs: lazyConfig.abandonMs }));`;
  r = child(lazy, { LAZY_GRACE_MS: '', LAZY_ABANDON_MS: ' ' });
  ok('L1. empty LAZY_GRACE_MS / LAZY_ABANDON_MS: the 60 s / 90 s defaults, not 0 ms', r.graceMs === 60_000 && r.abandonMs === 90_000, JSON.stringify(r));
  r = child(lazy, { LAZY_GRACE_MS: '0' });
  ok('L2. ...and an explicit "0" is still 0', r.graceMs === 0, JSON.stringify(r));

  // A. airing-posters.js: a broadcast that ended a minute ago, with a seat on
  // it. POSTER_VOD_WAIT_MS decides whether the sweep asks Twitch for its
  // recording yet (default: wait 10 min). Count the Helix calls.
  const postersUrl = pathToFileURL(path.join(ROOT, 'airing-posters.js')).href;
  const sweep = `
const now = Date.now();
const { sweepAiringPosters } = await import(${JSON.stringify(postersUrl)});
const a = { id: 'gate-cc-a1', roomId: 'r1', channel: 'somechannel', platform: 'twitch', startedAt: now - 30 * 60_000, endedAt: now - 60_000, moments: [{ kind: 'seat', at: now - 20 * 60_000 }] };
let calls = 0;
await sweepAiringPosters({ airings: [a], allAirings: () => [a], roomIds: () => ['r1'], helix: async () => { calls++; return { data: [] }; }, apiConfigured: true, attachRecording: () => {}, now, log: { log() {}, warn() {} } });
console.log(JSON.stringify({ calls }));`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-cc-posters-'));
  try {
    const asked = (v) => child(sweep, { DATA_DIR: dataDir, ...(v === undefined ? {} : { POSTER_VOD_WAIT_MS: v }) }).calls;
    ok('A1. unset POSTER_VOD_WAIT_MS: a broadcast one minute old is not looked up yet', asked(undefined) === 0);
    ok('A2. empty: still waits (1f06bef read "" as a 0 ms wait and asked at once)', asked('') === 0);
    ok('A3. malformed "10m": still waits (1f06bef: NaN, so no wait at all)', asked('10m') === 0);
    ok('A4. an explicit "0" asks at once — the airing gates set it on purpose', asked('0') === 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

// ── D. dotenv is not imported (nothing declares it) ────────────────────────
{
  const DOTENV = /^\s*import\s+(?:[\w{},\s*]+\s+from\s+)?['"]dotenv(?:\/config)?['"]|require\(\s*['"]dotenv/m;
  const files = [
    ...fs.readdirSync(ROOT).filter((f) => /\.(m?js|cjs)$/.test(f) && f !== SELF),
    ...(fs.existsSync(path.join(ROOT, 'scripts')) ? fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => /\.(m?js|cjs)$/.test(f)).map((f) => `scripts/${f}`) : []),
  ];
  const offenders = files.filter((f) => DOTENV.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  ok('D1. no root module, gate or script imports dotenv', offenders.length === 0, offenders.join(', ') || `${files.length} files`);
  ok('D1. DISCRIMINATES: the 1f06bef line is caught', DOTENV.test("import 'dotenv/config';"));
}

// ── P. nothing rebuilds the deleted passkey bundle ─────────────────────────
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const scripts = Object.entries(pkg.scripts || {});
  ok('P1. no npm script is build:passkey', !scripts.some(([k]) => k === 'build:passkey'));
  const writers = fs.existsSync(path.join(ROOT, 'scripts'))
    ? fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8').includes('passkey-wallet.bundle'))
    : [];
  ok('P2. no script under scripts/ names public/passkey-wallet.bundle.js', writers.length === 0, writers.join(', ') || 'none');
}

// ── G. data/ is runtime state, all of it ───────────────────────────────────
{
  const ignored = (p) => {
    try { execFileSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: ROOT, stdio: 'ignore' }); return true; } catch (e) { if (e.status === 1) return false; throw e; }
  };
  const RUNTIME = [
    'accounts.json', 'x-tokens.json', 'settlement.jsonl', 'seat-ledger.jsonl', 'escrow-chain.jsonl',
    'campaigns.json', 'campaign-ledger.jsonl', 'campaign-claims.json', 'guest-whitelist.json',
    'site-settings.json', 'airings.json', 'reference-sets.json', 'recognized-accounts.json',
    'aired-clips/a.mp4', 'airing-posters/a.png', 'room-posters/a.png', 'bounty.json', 'rooms.json',
    'some-store-added-next-year.json',
  ];
  const missed = RUNTIME.filter((f) => !ignored(`data/${f}`));
  ok(`G1. every runtime path under data/ is ignored (${RUNTIME.length} checked, x-tokens.json and settlement.jsonl among them)`, missed.length === 0, missed.join(', ') || 'all');
  ok('G2. data/.gitkeep is NOT ignored, so the folder stays in git', !ignored('data/.gitkeep'));
  const tracked = execFileSync('git', ['ls-files', 'data/'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  ok('G3. nothing under data/ is tracked except .gitkeep', tracked.length === 1 && tracked[0] === 'data/.gitkeep', tracked.join(', '));
  ok('G4. root screenshots, audit captures and session prompt files are ignored',
    ignored('a-new-shot.png') && ignored('audit-anything-1440x900.png') && ignored('megachat-next-prompt.md'));
  ok('G4. ...but only at the root: a PNG in a folder and blender_mcp.py are not',
    !ignored('screens/a-new-shot.png') && !ignored('docs/a.png') && !ignored('blender_mcp.py'));
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
