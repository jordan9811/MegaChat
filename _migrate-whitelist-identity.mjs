/**
 * MIGRATION — pin `identityKey` on guest-whitelist entries written before it
 * existed.
 *
 * WHY IT IS SAFE TO RUN, which is the only interesting question here. Entries
 * added before the squatting fix store a bare lowercase handle, and
 * `isWhitelisted` falls back to handle-only matching when `identityKey` is
 * null — so those entries are still squattable: release a handle, someone else
 * claims it, and they inherit a free seat.
 *
 * The migration resolves each handle through the SAME index the add route
 * validates against (`getIdentityByHandle`) and pins the identity that holds
 * it now. That is the strictly-narrowing direction: an entry that matched
 * "anyone called @x" becomes "the account that is @x today". It can only ever
 * refuse somebody it previously admitted, never admit somebody it previously
 * refused — so the worst case is a streamer re-adding a guest, not a stranger
 * getting a free ride.
 *
 * UNRESOLVABLE ENTRIES ARE LEFT EXACTLY AS THEY ARE. A handle nobody currently
 * holds might be a guest who has not signed in since, and deleting them would
 * silently empty somebody's list; pinning them to nothing would be a lie. They
 * stay handle-only and are listed at the end so the gap is visible rather than
 * assumed away.
 *
 *   node _migrate-whitelist-identity.mjs            # report only
 *   node _migrate-whitelist-identity.mjs --write    # actually write
 *
 * IDEMPOTENT, AND RUN AT BOOT. `migrateWhitelistIdentity()` is what the server
 * calls before any store is read, after the accounts migration (DECISIONS D6):
 * run beside a live server — the old `railway ssh` procedure — the server's
 * cached list would write the unpinned entries straight back (stores-6). An
 * entry already pinned is skipped, so a second run over its own output pins
 * nothing and writes nothing. A guest list that exists but cannot be parsed
 * refuses the run (DECISIONS D3).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getIdentityByHandle } from './identity-store.js';
import { roomOwnerKey } from './auth.js';
import { dataDir as defaultDataDir, readJsonFile, writeJsonAtomic } from './json-store.js';

/**
 * Pin `identityKey` on every guest-whitelist entry that lacks one and whose
 * handle resolves to a live account. Writes only with `write`, and only when
 * something was pinned.
 *
 * `identityKeyFor` resolves a handle to the account id that holds it now; the
 * default asks the same index the add route validates against, which reads
 * DATA_DIR itself — so the boot hook passes the same directory.
 *
 * @returns {{ status: 'nothing' | 'refused' | 'unchanged' | 'report' | 'written',
 *   reason?: string, store?: string, already?: number, pinned?: number, unresolved?: number, orphans?: string[] }}
 */
export function migrateWhitelistIdentity({
  dataDir = defaultDataDir(),
  write = false,
  identityKeyFor = (handle) => roomOwnerKey(getIdentityByHandle(handle)),
} = {}) {
  const STORE = path.join(dataDir, 'guest-whitelist.json');
  const file = readJsonFile(STORE);
  if (file.state === 'missing') return { status: 'nothing', reason: `no guest list at ${STORE}` };
  if (file.state !== 'ok') return { status: 'refused', reason: `${STORE} is ${file.state} (${file.why})` };
  const raw = file.data;
  const lists = raw?.lists || raw || {};

  let pinned = 0, already = 0, unresolved = 0;
  const orphans = [];
  for (const [ownerKey, list] of Object.entries(lists)) {
    for (const entry of list?.entries || []) {
      if (entry.identityKey) { already++; continue; }
      const key = identityKeyFor(entry.handle) || null;
      if (!key) {
        unresolved++;
        orphans.push(`${ownerKey} → @${entry.handle}`);
        continue;
      }
      entry.identityKey = key;
      pinned++;
    }
  }
  const report = { store: STORE, already, pinned, unresolved, orphans };
  if (!pinned) return { status: 'unchanged', ...report };
  if (!write) return { status: 'report', ...report };
  // Atomic: a torn guest list is a room that silently stops honouring its own guests.
  writeJsonAtomic(STORE, raw, { pretty: true });
  return { status: 'written', ...report };
}

function printReport(r) {
  if (r.status === 'nothing' || r.status === 'refused') {
    console.log(`
  ${r.status === 'refused' ? 'REFUSED: ' : 'Nothing to migrate — '}${r.reason}
`);
    return;
  }
  console.log(`
── guest whitelist: pin identityKey ───────────────────────────`);
  console.log(`  store              ${r.store}`);
  console.log(`  already pinned     ${r.already}`);
  console.log(`  newly pinned       ${r.pinned}`);
  console.log(`  left handle-only   ${r.unresolved}`);
  if (r.orphans.length) {
    console.log(`
  These resolve to no live account and were NOT touched. They stay`);
    console.log(`  squattable until the person signs in and the streamer re-adds them:`);
    r.orphans.forEach((o) => console.log(`    · ${o}`));
  }
  if (r.status === 'unchanged') console.log(`
  Nothing to write.
`);
  else if (r.status === 'report') console.log(`
  Report only. Re-run with --write to apply.
`);
  else console.log(`
  Written. ${r.pinned} entr${r.pinned === 1 ? 'y' : 'ies'} pinned.
`);
}

// As a script: report only, or apply with --write. Imported (the boot hook,
// the gate), it does nothing until called.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const r = migrateWhitelistIdentity({ write: process.argv.includes('--write') });
  printReport(r);
  if (r.status === 'refused') process.exitCode = 1;
}
