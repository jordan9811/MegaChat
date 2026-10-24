/**
 * GATE — guest-whitelist.js: reads do not write, and a damaged list is not
 * read as an empty one (stores-12, stores-2).
 *
 * WHAT IT PROVES, each case in a fresh process on its own scratch DATA_DIR
 *   G1-G2 the join path asks about 500 other streamers' lists; the next write
 *         persists ONE list (the old rawList created an empty list per owner it
 *         was asked about, and persisted all 500)
 *   G3    reading an unknown owner's list returns the empty view without
 *         creating one in memory either
 *   T1-T4 a torn guest-whitelist.json: nobody rides free (fail closed), adding
 *         a guest is refused with store_refused, and the bytes on disk are
 *         untouched (the old loader read it as empty and the add overwrote the
 *         streamer's whole list)
 *   W1    the normal path still works: add, join, remove, switch
 *
 * Spends nothing, starts no server, writes only under the OS temp dir.
 *
 *   node _gate-whitelist-store.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const wl = () => import(pathToFileURL(path.join(HERE, 'guest-whitelist.js')).href);
const FILE = () => path.join(process.env.DATA_DIR, 'guest-whitelist.json');
const tryCode = (fn) => { try { fn(); return null; } catch (e) { return e.code || e.message; } };

const CASES = {
  async grows() {
    const g = await wl();
    g.addGuest('acct_owner', 'friend_one', 'acct_friend');
    for (let i = 0; i < 500; i++) g.isWhitelisted(`acct_${randomBytes(8).toString('hex')}`, 'someone');
    g.getList('acct_never_touched');
    g.recordJoin('acct_owner', 'friend_one'); // the next write
    const lists = JSON.parse(fs.readFileSync(FILE(), 'utf8')).lists;
    return { listsOnDisk: Object.keys(lists).length, emptyOnDisk: Object.values(lists).filter((l) => !l.entries.length).length,
      joinCount: lists.acct_owner?.entries[0]?.joinCount };
  },
  async torn() {
    const g = await wl();
    return {
      freeRide: g.isWhitelisted('acct_owner', 'friend_one', 'acct_friend'),
      addErr: tryCode(() => g.addGuest('acct_owner', 'newcomer', 'acct_new')),
      enableErr: tryCode(() => g.setEnabled('acct_owner', true)),
    };
  },
  async normal() {
    const g = await wl();
    const added = g.addGuest('acct_owner', 'friend_one', 'acct_friend');
    const again = g.addGuest('acct_owner', 'friend_one', 'acct_friend');
    const rides = g.isWhitelisted('acct_owner', 'friend_one', 'acct_friend');
    const stranger = g.isWhitelisted('acct_owner', 'friend_one', 'acct_someone_else');
    const off = g.setEnabled('acct_owner', false);
    const ridesOff = g.isWhitelisted('acct_owner', 'friend_one', 'acct_friend');
    g.setEnabled('acct_owner', true);
    const removed = g.removeGuest('acct_owner', 'friend_one');
    const removedAgain = g.removeGuest('acct_owner', 'friend_one');
    const unknownRemove = g.removeGuest('acct_nobody', 'friend_one');
    return { added: added.added, again: again.added, rides, stranger, offEnabled: off.enabled, ridesOff, removed, removedAgain, unknownRemove,
      onDisk: JSON.parse(fs.readFileSync(FILE(), 'utf8')).lists };
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `mc-wl-${name}-`));
  scratch.push(dataDir);
  if (seed) seed(dataDir);
  const r = spawnSync(process.execPath, [SELF, '--case', name], { env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8', timeout: 60_000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('@@RESULT '));
  return { dataDir, out: line ? JSON.parse(line.slice(9)) : null, err: (r.stderr || '').slice(-600) };
}

console.log('\n── guest whitelist store ────────────────────────────────');
try {
  {
    const { out, err } = run('grows');
    ok('G1 500 join-path reads of other streamers\' lists persist nothing: ONE list on disk', out?.listsOnDisk === 1, out ? `${out.listsOnDisk} list(s)` : err);
    ok('G2 ...no empty lists, and the real one recorded its join', out?.emptyOnDisk === 0 && out.joinCount === 1, JSON.stringify(out));
  }
  {
    const full = JSON.stringify({ lists: { acct_owner: { enabled: true, entries: [{ handle: 'friend_one', identityKey: 'acct_friend', addedAt: '2026-10-01T00:00:00.000Z', lastJoinedAt: null, joinCount: 0 }] } } }, null, 2);
    let file = null, before = null;
    const { out, err } = run('torn', (d) => { file = path.join(d, 'guest-whitelist.json'); fs.writeFileSync(file, full.slice(0, Math.floor(full.length * 0.6))); before = sha(file); });
    ok('T1 a torn list lets nobody ride free (fails closed)', out?.freeRide === false, out ? '' : err);
    ok('T2 adding a guest is refused with store_refused', out?.addErr === 'store_refused', String(out?.addErr));
    ok('T3 so is the master switch', out?.enableErr === 'store_refused', String(out?.enableErr));
    ok('T4 ...and the bytes on disk are untouched', !!file && sha(file) === before);
  }
  {
    const { out, err } = run('normal');
    ok('W1 add / re-add / pinned identity / switch / remove all behave as before',
      out && out.added === true && out.again === false && out.rides === true && out.stranger === false
        && out.offEnabled === false && out.ridesOff === false && out.removed === true && out.removedAgain === false
        && out.unknownRemove === false && Object.keys(out.onDisk).length === 1,
      out ? JSON.stringify({ ...out, onDisk: Object.keys(out.onDisk) }) : err);
  }
} catch (e) {
  ok(`unexpected: ${e.stack || e.message}`, false);
} finally {
  for (const d of scratch) fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
