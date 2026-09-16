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
 */
import fs from 'node:fs';
import path from 'node:path';
import { getIdentityByHandle } from './identity-store.js';
import { roomOwnerKey } from './auth.js';

const WRITE = process.argv.includes('--write');
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STORE = path.join(DATA_DIR, 'guest-whitelist.json');

if (!fs.existsSync(STORE)) {
  console.log(`\n  Nothing to migrate — no guest list at ${STORE}\n`);
  process.exit(0);
}

const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
const lists = raw?.lists || raw || {};

let pinned = 0, already = 0, unresolved = 0;
const orphans = [];

for (const [ownerKey, list] of Object.entries(lists)) {
  for (const entry of list?.entries || []) {
    if (entry.identityKey) { already++; continue; }
    const identity = getIdentityByHandle(entry.handle);
    const key = identity ? roomOwnerKey(identity) : null;
    if (!key) {
      unresolved++;
      orphans.push(`${ownerKey} → @${entry.handle}`);
      continue;
    }
    entry.identityKey = key;
    pinned++;
  }
}

console.log(`\n── guest whitelist: pin identityKey ───────────────────────────`);
console.log(`  store              ${STORE}`);
console.log(`  already pinned     ${already}`);
console.log(`  newly pinned       ${pinned}`);
console.log(`  left handle-only   ${unresolved}`);
if (orphans.length) {
  console.log(`\n  These resolve to no live account and were NOT touched. They stay`);
  console.log(`  squattable until the person signs in and the streamer re-adds them:`);
  orphans.forEach((o) => console.log(`    · ${o}`));
}

if (!WRITE) {
  console.log(`\n  Report only. Re-run with --write to apply.\n`);
  process.exit(0);
}
if (!pinned) {
  console.log(`\n  Nothing to write.\n`);
  process.exit(0);
}

// Write through a temp file: a torn guest list is a room that silently stops
// honouring its own guests.
const tmp = `${STORE}.migrating`;
fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
fs.renameSync(tmp, STORE);
console.log(`\n  Written. ${pinned} entr${pinned === 1 ? 'y' : 'ies'} pinned.\n`);
