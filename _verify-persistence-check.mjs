/**
 * VERIFY — the persistence check reports EVIDENCE, not configuration.
 *
 * Boots a server twice against the same DATA_DIR (proves survival) and once
 * against a fresh one (proves it does not overclaim). The old check returned
 * `!!process.env.DATA_DIR`, which is true in both cases and therefore told us
 * nothing.
 */
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(port, dataDir) {
  const p = spawn(process.execPath, ['server.js', '--prod'], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, KEEP_ORPHAN_ROOMS: 'true' },
    stdio: 'ignore', cwd: process.cwd(),
  });
  await sleep(9000);
  const health = await fetch(`http://localhost:${port}/api/health`).then((r) => r.json());
  p.kill();
  await sleep(1500);
  return health;
}

const persistentDir = mkdtempSync(path.join(tmpdir(), 'mc-persist-'));

const first = await boot(3291, persistentDir);
ok('FIRST boot on a fresh dir does not claim persistence',
  first.persistentData === false && first.persistence.status === 'unproven',
  `${first.persistentData} / ${first.persistence.status}`);
ok('...and says so honestly rather than implying the volume is missing',
  /does NOT mean the volume is missing/i.test(first.persistence.note || ''),
  (first.persistence.note || '').slice(0, 70));
ok('...while still reporting that DATA_DIR was configured',
  first.dataDirConfigured === true);

const second = await boot(3292, persistentDir);
ok('SECOND boot on the SAME dir PROVES persistence',
  second.persistentData === true && second.persistence.status === 'proven',
  `${second.persistentData} / ${second.persistence.status}`);
ok('...and reports how many prior boots it saw',
  second.persistence.priorBoots === 1, `priorBoots=${second.persistence.priorBoots}`);
ok('...and when the directory was first seen',
  !!second.persistence.firstSeenAt, second.persistence.firstSeenAt);

const third = await boot(3293, persistentDir);
ok('a THIRD boot accumulates history rather than overwriting it',
  third.persistence.priorBoots === 2, `priorBoots=${third.persistence.priorBoots}`);

// The case the old check got wrong: DATA_DIR set, but pointing somewhere that
// does not survive. A fresh dir per boot is exactly that scenario.
const ephemeralA = await boot(3294, mkdtempSync(path.join(tmpdir(), 'mc-eph-')));
const ephemeralB = await boot(3295, mkdtempSync(path.join(tmpdir(), 'mc-eph-')));
ok('DATA_DIR set but NOT surviving is never reported as persistent',
  ephemeralA.persistentData === false && ephemeralB.persistentData === false,
  `${ephemeralA.persistentData}/${ephemeralB.persistentData}`);
ok('...even though the OLD check (env var set) would have said true for both',
  ephemeralA.dataDirConfigured === true && ephemeralB.dataDirConfigured === true);

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
