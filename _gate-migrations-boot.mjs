/**
 * GATE — the two data migrations are importable, idempotent functions the
 * server can run at boot (stores-6, DECISIONS D6).
 *
 * THE DEFECT. The migrations ran over `railway ssh` BESIDE the live server,
 * whose caches never re-read the files: the server's next write put the
 * pre-migration rooms and accounts straight back. And `--write` rewrote and
 * re-backed-up everything on every run, so running one twice was not safe.
 *
 * WHAT IT PROVES, on a fixture: a legacy identities.json, an account the new
 * sign-in path already made (its handle displaced to @name_2), rooms owned by
 * the old composite keys, and an unpinned whitelist entry
 *   M1-M4 the first run adopts the existing account, creates the missing one,
 *         restores the displaced handle, keeps the old name reserved,
 *         rewrites both rooms' owner keys, and pins the whitelist entry
 *   M5-M6 a second run, in a fresh process, changes NOTHING: both report
 *         'unchanged', every file is byte-identical, no new backup appears
 *   M7    signing in after the boot-order migration keeps the migrated data
 *   H1    the hazard the boot hook exists for, shown: a process that loaded
 *         its accounts cache BEFORE the migration erases it on its next write
 *   C1-C2 the CLI is still a CLI: report-only by default, and `--write` run
 *         twice backs up and writes once (the old script did both every time)
 *   R1    an accounts.json that cannot be parsed refuses the run, untouched
 *
 * Spends nothing, starts no server, writes only under the OS temp dir.
 *
 *   node _gate-migrations-boot.mjs
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
const DATA = () => process.env.DATA_DIR;
const readJ = (f) => JSON.parse(fs.readFileSync(path.join(DATA(), f), 'utf8'));

function seed(dir) {
  const w = (f, v) => fs.writeFileSync(path.join(dir, f), JSON.stringify(v, null, 2));
  w('identities.json', {
    identities: {
      'twitch:111': { username: 'jordandotfun', handle: 'jordandotfun', createdAt: '2026-09-01T00:00:00.000Z', roomDefaults: { maxSeats: 2 } },
      'kick:222': { username: 'kicky', handle: 'kicky', createdAt: 1756684800000 },
    },
    handles: { jordandotfun: 'twitch:111', kicky: 'kick:222', oldname: 'twitch:111' },
  });
  w('accounts.json', {
    accounts: { acct_existing0001: { id: 'acct_existing0001', handle: 'jordandotfun_2', primary: 'twitch', createdAt: '2026-09-19T00:00:00.000Z',
      links: [{ provider: 'twitch', platformId: '111', username: 'jordandotfun', handle: 'jordandotfun_2', linkedAt: '2026-09-19T00:00:00.000Z', attributes: null, attributesFetchedAt: null }],
      reservedHandles: [] } },
    handles: { jordandotfun_2: 'acct_existing0001' },
    links: { 'twitch:111': 'acct_existing0001' },
  });
  w('rooms.json', { rooms: {
    default: { id: 'default', name: 'Default Room', active: true, config: {} },
    r1: { id: 'r1', name: 'Jordan room', active: true, handle: 'jordandotfun', ownerKey: 'twitch:111', config: {} },
    r2: { id: 'r2', name: 'Kick room', active: true, ownerKey: 'kick:222', config: {} },
  } });
  w('guest-whitelist.json', { lists: { acct_existing0001: { enabled: null, entries: [
    { handle: 'kicky', identityKey: null, addedAt: '2026-09-02T00:00:00.000Z', lastJoinedAt: null, joinCount: 0 },
    { handle: 'nobody_here', identityKey: null, addedAt: '2026-09-02T00:00:00.000Z', lastJoinedAt: null, joinCount: 0 },
  ] } } });
}

async function bootMigrations() {
  const { migrateAccounts } = await mod('_migrate-accounts.mjs');
  const { migrateWhitelistIdentity } = await mod('_migrate-whitelist-identity.mjs');
  const a = migrateAccounts({ dataDir: DATA(), write: true });
  const w = migrateWhitelistIdentity({ dataDir: DATA(), write: true });
  return { a, w };
}

const CASES = {
  async first() {
    const { a, w } = await bootMigrations();
    const acc = readJ('accounts.json');
    const rooms = readJ('rooms.json').rooms;
    const kickId = acc.links['kick:222'];
    return {
      a: { status: a.status, adopted: a.adopted?.length, created: a.created?.length, restored: a.restored?.map((r) => `${r.from}->${r.to}`), reserved: a.reserved, rewrites: a.roomRewrites?.length },
      w: { status: w.status, pinned: w.pinned, unresolved: w.unresolved },
      existingHandle: acc.accounts.acct_existing0001.handle,
      existingReserved: acc.accounts.acct_existing0001.reservedHandles,
      handleOwners: { jordandotfun: acc.handles.jordandotfun, jordandotfun_2: acc.handles.jordandotfun_2, oldname: acc.handles.oldname },
      owners: { r1: rooms.r1.ownerKey, r2: rooms.r2.ownerKey }, kickId,
      pinned: readJ('guest-whitelist.json').lists.acct_existing0001.entries.map((e) => e.identityKey),
    };
  },
  async second() {
    const { a, w } = await bootMigrations();
    return { a: a.status, w: w.status };
  },
  async signIn() {
    await bootMigrations(); // boot order: migrations first, then any store
    const accounts = await mod('accounts.js');
    accounts.upsertAccountForLink({ provider: 'kick', platformId: '222', username: 'kicky' });
    const acc = readJ('accounts.json');
    return { accounts: Object.keys(acc.accounts).length, kick: !!acc.links['kick:222'], jordan: acc.accounts.acct_existing0001?.handle };
  },
  async beside() {
    const accounts = await mod('accounts.js');
    accounts.accountForLink('twitch', '111'); // a running server: cache loaded first
    await bootMigrations();
    accounts.upsertAccountForLink({ provider: 'twitch', platformId: '111', username: 'jordandotfun' }); // its next write
    const acc = readJ('accounts.json');
    return { kickSurvived: !!acc.links['kick:222'], jordan: acc.accounts.acct_existing0001?.handle };
  },
  async refused() {
    const { migrateAccounts } = await mod('_migrate-accounts.mjs');
    return migrateAccounts({ dataDir: DATA(), write: true });
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
const fresh = (name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `mc-migrate-${name}-`)); scratch.push(d); return d; };
function run(name, dir) {
  const r = spawnSync(process.execPath, [SELF, '--case', name], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8', timeout: 60_000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('@@RESULT '));
  return { out: line ? JSON.parse(line.slice(9)) : null, err: (r.stderr || '').slice(-600) };
}
const snapshot = (dir) => Object.fromEntries(fs.readdirSync(dir).sort().map((f) => [f, createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')]));
const cli = (script, dir, args = []) => spawnSync(process.execPath, [path.join(HERE, script), ...args], { cwd: HERE, env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8', timeout: 60_000 });
const baks = (dir) => fs.readdirSync(dir).filter((f) => f.includes('.bak-')).length;

console.log('\n── migrations at boot ───────────────────────────────────');
try {
  {
    const dir = fresh('idem');
    seed(dir);
    const { out, err } = run('first', dir);
    const a = out?.a || {};
    ok('M1 first run: adopts the existing account, creates the missing one, rewrites both rooms',
      a.status === 'written' && a.adopted === 1 && a.created === 1 && a.rewrites === 2
        && out.owners.r1 === 'acct_existing0001' && out.owners.r2 === out.kickId, out ? JSON.stringify(a) : err);
    ok('M2 ...restores @jordandotfun to its owner and keeps @jordandotfun_2 reserved to them',
      out?.existingHandle === 'jordandotfun' && out.existingReserved.includes('jordandotfun_2')
        && out.handleOwners.jordandotfun === 'acct_existing0001' && out.handleOwners.jordandotfun_2 === 'acct_existing0001', JSON.stringify(out?.handleOwners));
    ok('M3 ...carries an old registry name nobody claimed as reserved', out?.handleOwners.oldname === 'acct_existing0001' && a.reserved?.includes('oldname'));
    ok('M4 ...and pins the whitelist entry that resolves, leaving the one that does not',
      out?.w.status === 'written' && out.w.pinned === 1 && out.w.unresolved === 1 && out.pinned[0] === out.kickId && out.pinned[1] === null, JSON.stringify(out?.w));
    const before = snapshot(dir);
    const second = run('second', dir);
    ok('M5 a second run in a fresh process reports both migrations unchanged',
      second.out?.a === 'unchanged' && second.out?.w === 'unchanged', second.out ? JSON.stringify(second.out) : second.err);
    ok('M6 ...and every file is byte-identical, with no new backup', JSON.stringify(snapshot(dir)) === JSON.stringify(before));
    const s = run('signIn', dir);
    ok('M7 a sign-in after the boot-order migration keeps the migrated accounts', s.out?.accounts === 2 && s.out.kick === true && s.out.jordan === 'jordandotfun', s.out ? JSON.stringify(s.out) : s.err);
  }
  {
    const dir = fresh('beside');
    seed(dir);
    const { out, err } = run('beside', dir);
    ok('H1 (the hazard, shown) a process whose accounts cache loaded BEFORE the migration erases it on its next write — why it runs at boot, first',
      out?.kickSurvived === false && out.jordan === 'jordandotfun_2', out ? JSON.stringify(out) : err);
  }
  {
    const dir = fresh('cli');
    seed(dir);
    const report = cli('_migrate-accounts.mjs', dir);
    ok('C1 the CLI reports without writing by default', report.status === 0 && /report only/.test(report.stdout) && baks(dir) === 0, report.stdout.split('\n').slice(-2).join(' | '));
    cli('_migrate-accounts.mjs', dir, ['--write']);
    const afterFirst = baks(dir);
    const again = cli('_migrate-accounts.mjs', dir, ['--write']);
    ok('C2 --write twice: backs up and writes ONCE; the second run says it is already migrated',
      afterFirst === 2 && baks(dir) === 2 && /already migrated/.test(again.stdout), `${afterFirst} then ${baks(dir)} backups`);
  }
  {
    const dir = fresh('refused');
    seed(dir);
    const file = path.join(dir, 'accounts.json');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(0, 120));
    const before = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const { out, err } = run('refused', dir);
    ok('R1 an unparsable accounts.json refuses the run and stays untouched',
      out?.status === 'refused' && createHash('sha256').update(fs.readFileSync(file)).digest('hex') === before && baks(dir) === 0, out ? out.reason : err);
  }
} catch (e) {
  ok(`unexpected: ${e.stack || e.message}`, false);
} finally {
  for (const d of scratch) fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
