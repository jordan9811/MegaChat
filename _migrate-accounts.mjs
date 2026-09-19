#!/usr/bin/env node
/**
 * identities.json → accounts.json.
 *
 * There is nobody to migrate — the app is in stealth with zero users, and this
 * script found nothing on production when it ran. It exists anyway because the
 * SHAPE has to exist before it is needed: the first time somebody does have an
 * identity row, the person holding the pager should be running a script that
 * was written calmly, not writing one.
 *
 * WHAT IT DOES. Each `provider:platformId` identity becomes an account with
 * one link. The identity's handle becomes the account's canonical handle and
 * the old handle registry is carried across. `roomDefaults` and
 * `platformLogins` ride along. Nothing is deleted: `identities.json` is left
 * exactly where it is, so a bad run is undone by deleting `accounts.json`.
 *
 * WHAT IT CANNOT DO. It cannot merge two identities that are the same human —
 * one per platform is all the old shape recorded, and guessing is worse than
 * leaving them apart. It reports any handle collision instead of resolving it.
 *
 *   node _migrate-accounts.mjs            # report only
 *   node _migrate-accounts.mjs --write    # write accounts.json
 *   DATA_DIR=/data railway ssh -- node _migrate-accounts.mjs   # production
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const SRC = path.join(DATA_DIR, 'identities.json');
const DEST = path.join(DATA_DIR, 'accounts.json');
const write = process.argv.includes('--write');

const read = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

const src = read(SRC);
if (!src) {
  console.log(`[migrate-accounts] no identities.json at ${SRC} — nothing to migrate`);
  process.exit(0);
}
const identities = src.identities || {};
const oldHandles = src.handles || {};
const rows = Object.entries(identities);
if (!rows.length) {
  console.log('[migrate-accounts] identities.json holds no identities — nothing to migrate');
  process.exit(0);
}

const existing = read(DEST);
if (existing && Object.keys(existing.accounts || {}).length) {
  console.log(`[migrate-accounts] accounts.json already has ${Object.keys(existing.accounts).length} account(s) — refusing to overwrite. Delete it first if this is deliberate.`);
  process.exit(1);
}

const accounts = {}, handles = {}, links = {};
const collisions = [];
for (const [key, id] of rows) {
  const [provider, ...rest] = key.split(':');
  const platformId = rest.join(':');
  const accountId = `acct_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = id.createdAt || new Date().toISOString();
  const handle = id.handle || null;
  if (handle && handles[handle]) { collisions.push({ handle, keys: [key] }); continue; }
  accounts[accountId] = {
    id: accountId,
    handle,
    primary: provider,
    createdAt: typeof now === 'number' ? new Date(now).toISOString() : String(now),
    links: [{
      provider, platformId, username: id.username || null, handle,
      linkedAt: typeof now === 'number' ? new Date(now).toISOString() : String(now),
      attributes: null, attributesFetchedAt: null,
    }],
    reservedHandles: [],
    ...(id.roomDefaults ? { roomDefaults: id.roomDefaults } : {}),
    ...(id.platformLogins ? { platformLogins: id.platformLogins } : {}),
  };
  if (handle) handles[handle] = accountId;
  links[key] = accountId;
}

// Handles the old registry knew but no identity claimed: carry them as reserved
// so a name that was in use cannot be taken by somebody else after the move.
for (const [h, key] of Object.entries(oldHandles)) {
  if (handles[h]) continue;
  const accountId = links[key];
  if (!accountId) continue;
  handles[h] = accountId;
  accounts[accountId].reservedHandles.push(h);
}

console.log(`[migrate-accounts] ${rows.length} identity row(s) → ${Object.keys(accounts).length} account(s), ${Object.keys(handles).length} handle(s)`);
for (const c of collisions) console.log(`  COLLISION: handle @${c.handle} claimed by more than one identity — left unmigrated, resolve by hand`);
console.log('[migrate-accounts] owner keys change from provider:platformId to the account id:');
for (const [key, accountId] of Object.entries(links)) console.log(`    ${key}  →  ${accountId}`);
console.log('  Rooms, whitelist entries and bounty ownership carry the OLD key and must be rewritten with the map above.');

if (!write) {
  console.log('[migrate-accounts] report only — pass --write to create accounts.json');
  process.exit(0);
}
fs.writeFileSync(DEST, JSON.stringify({ accounts, handles, links }, null, 2));
console.log(`[migrate-accounts] wrote ${DEST}. identities.json left untouched; delete accounts.json to undo.`);
