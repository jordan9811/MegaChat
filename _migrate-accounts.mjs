#!/usr/bin/env node
/**
 * identities.json → accounts.json, and the owner keys that point at them.
 *
 * WHY THIS EXISTS, AND WHY IT GREW. The identity layer replaced the old
 * `provider:platformId` owner key with a canonical account id, and this script
 * was written to move the rows. It was never run on production — and on
 * 2026-09-19 the new sign-in path created an account from scratch instead,
 * which exposed both halves of what "migrate" actually means:
 *
 *   1. A fresh account cannot take a handle a ROOM already holds, because
 *      `isHandleFree` asks WHETHER a room holds a name and never WHOSE room it
 *      is. Signing in as @jordandotfun, who owned a room called @jordandotfun,
 *      produced an account called @jordandotfun_2.
 *   2. That room's `ownerKey` was still the old composite, so it no longer
 *      matched its owner at all. With no room password set, the owner was
 *      locked out of their own room — silently, with the symptom showing up as
 *      a wrong name in the nav.
 *
 * So this script now reconciles rather than refusing, and it rewrites the
 * rooms it can prove belong to the same person.
 *
 * WHAT IT DOES. Each `provider:platformId` identity becomes an account with one
 * link — or, when an account already carries that link, ADOPTS it and keeps its
 * id, because a live session cookie seals that id and minting a new one would
 * sign the person out. The identity's handle is restored as the canonical
 * handle when it is safe to do so (below); the displaced one is kept RESERVED,
 * never freed for someone else. `roomDefaults` and `platformLogins` ride along
 * where the account has none. Every room whose `ownerKey` is one of the old
 * composites is rewritten to the account id.
 *
 * WHEN IT RESTORES A HANDLE. Only when the name is genuinely theirs: free, or
 * held by a ROOM whose owner key maps to this same account. A name held by a
 * DIFFERENT account, or by a room that maps to someone else, is reported as a
 * collision and left alone — guessing is worse than leaving them apart.
 *
 * WHAT IT CANNOT DO. It cannot merge two identities that are the same human;
 * one per platform is all the old shape recorded.
 *
 * Nothing is deleted. identities.json is left exactly where it is, and every
 * file it rewrites is copied to <name>.bak-<timestamp> first.
 *
 *   node _migrate-accounts.mjs            # report only
 *   node _migrate-accounts.mjs --write    # apply
 *
 * On production, run it through the volume: DATA_DIR=/data, from /app.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const SRC = path.join(DATA_DIR, 'identities.json');
const DEST = path.join(DATA_DIR, 'accounts.json');
const ROOMS = path.join(DATA_DIR, 'rooms.json');
const write = process.argv.includes('--write');

const read = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const sanitize = (h) => {
  const s = String(h == null ? '' : h).trim().toLowerCase();
  return /^[a-z0-9_]{3,20}$/.test(s) ? s : null;
};

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

// The CURRENT state is the base, not a blank sheet: accounts created by the new
// sign-in path are real, their ids are sealed into live cookies, and this run
// reconciles them rather than replacing them.
const current = read(DEST) || { accounts: {}, handles: {}, links: {} };
const accounts = current.accounts || {};
const handles = current.handles || {};
const links = current.links || {};
const rooms = read(ROOMS);

const adopted = [], created = [], collisions = [], restored = [], carried = [];

// ── 1. every legacy identity gets an account, existing or new ───────────────
const ownerMap = {}; // old composite key → account id
for (const [key, id] of rows) {
  const [provider, ...rest] = key.split(':');
  const platformId = rest.join(':');
  const now = id.createdAt || new Date().toISOString();
  const stamp = typeof now === 'number' ? new Date(now).toISOString() : String(now);
  const existingId = links[key];
  if (existingId && accounts[existingId]) {
    ownerMap[key] = existingId;
    adopted.push({ key, accountId: existingId, handle: accounts[existingId].handle });
    continue;
  }
  const accountId = `acct_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  accounts[accountId] = {
    id: accountId,
    handle: null, // set in pass 2, which knows who holds what
    primary: provider,
    createdAt: stamp,
    links: [{
      provider, platformId, username: id.username || null, handle: null,
      linkedAt: stamp, attributes: null, attributesFetchedAt: null,
    }],
    reservedHandles: [],
  };
  links[key] = accountId;
  ownerMap[key] = accountId;
  created.push({ key, accountId });
}

// ── 2. who holds a name, and is it really theirs? ───────────────────────────
const roomByHandle = (h) => Object.values(rooms?.rooms || {}).find((r) => r.handle === h) || null;
/** The account a room belongs to, following the rewrite this run will perform. */
const roomAccount = (room) => {
  if (!room?.ownerKey) return null;
  return ownerMap[room.ownerKey] || (accounts[room.ownerKey] ? room.ownerKey : null);
};

for (const [key, id] of rows) {
  const accountId = ownerMap[key];
  const acct = accounts[accountId];
  const wanted = sanitize(id.handle);
  if (!wanted) continue;
  if (acct.handle === wanted) continue;

  const holder = handles[wanted];
  if (holder && holder !== accountId) {
    collisions.push({ handle: wanted, why: `held by account ${holder}`, key });
    continue;
  }
  const room = roomByHandle(wanted);
  if (room && !holder) {
    const owner = roomAccount(room);
    if (owner && owner !== accountId) {
      collisions.push({ handle: wanted, why: `room ${room.id} belongs to account ${owner}`, key });
      continue;
    }
    if (!owner) {
      collisions.push({ handle: wanted, why: `room ${room.id} has no owner this run can resolve`, key });
      continue;
    }
  }

  const previous = acct.handle;
  acct.handle = wanted;
  handles[wanted] = accountId;
  for (const l of acct.links) if (l.provider === key.split(':')[0]) l.handle = wanted;
  if (previous && previous !== wanted) {
    acct.reservedHandles = [...new Set([...(acct.reservedHandles || []), previous])];
    handles[previous] = accountId; // still theirs — never freed for someone else
  }
  acct.reservedHandles = (acct.reservedHandles || []).filter((h) => h !== wanted);
  restored.push({ accountId, from: previous || '(none)', to: wanted, viaRoom: room ? room.id : null });
}

// ── 3. carry the old extras where the account has none ──────────────────────
for (const [key, id] of rows) {
  const acct = accounts[ownerMap[key]];
  for (const field of ['roomDefaults', 'platformLogins']) {
    if (id[field] && !acct[field]) { acct[field] = id[field]; carried.push({ accountId: acct.id, field }); }
  }
}

// Handles the old registry knew but no identity claimed: carry them as reserved
// so a name that was in use cannot be taken by somebody else after the move.
for (const [h, key] of Object.entries(oldHandles)) {
  const accountId = ownerMap[key];
  if (!accountId || handles[h]) continue;
  handles[h] = accountId;
  accounts[accountId].reservedHandles = [...new Set([...(accounts[accountId].reservedHandles || []), h])];
}

// ── 4. the rooms that point at an old composite ─────────────────────────────
const roomRewrites = [];
for (const [id, rec] of Object.entries(rooms?.rooms || {})) {
  if (!rec.ownerKey || !ownerMap[rec.ownerKey]) continue;
  roomRewrites.push({ id, from: rec.ownerKey, to: ownerMap[rec.ownerKey], name: rec.name });
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`[migrate-accounts] ${rows.length} identity row(s): ${adopted.length} adopted, ${created.length} created`);
for (const a of adopted) console.log(`    ADOPT   ${a.key}  ->  ${a.accountId}  (@${a.handle})`);
for (const c of created) console.log(`    CREATE  ${c.key}  ->  ${c.accountId}`);
for (const r of restored) {
  console.log(`    HANDLE  ${r.accountId}: @${r.from} -> @${r.to}${r.viaRoom ? `  (name was held by their own room ${r.viaRoom})` : ''}`);
  if (r.from !== '(none)') console.log(`              @${r.from} kept RESERVED to them, not freed`);
}
for (const c of collisions) console.log(`    COLLISION @${c.handle} NOT restored for ${c.key} — ${c.why}`);
for (const c of carried) console.log(`    CARRY   ${c.accountId}.${c.field}`);
if (roomRewrites.length) {
  console.log(`[migrate-accounts] ${roomRewrites.length} room owner key(s) to rewrite:`);
  for (const r of roomRewrites) console.log(`    ${r.id} ${JSON.stringify(r.name)}  ${r.from}  ->  ${r.to}`);
} else {
  console.log('[migrate-accounts] no room carries an old composite owner key');
}
if (!rooms) console.log(`[migrate-accounts] WARNING: no rooms.json at ${ROOMS} — owner keys NOT checked`);

if (!write) {
  console.log('[migrate-accounts] report only — pass --write to apply');
  process.exit(0);
}

const backup = (p) => {
  if (!fs.existsSync(p)) return null;
  const to = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(p, to);
  return to;
};
for (const b of [backup(DEST), backup(ROOMS)].filter(Boolean)) console.log(`[migrate-accounts] backed up -> ${b}`);

fs.writeFileSync(DEST, JSON.stringify({ accounts, handles, links }, null, 2));
console.log(`[migrate-accounts] wrote ${DEST}`);
if (roomRewrites.length && rooms) {
  for (const r of roomRewrites) rooms.rooms[r.id].ownerKey = r.to;
  fs.writeFileSync(ROOMS, JSON.stringify(rooms, null, 2));
  console.log(`[migrate-accounts] wrote ${ROOMS} (${roomRewrites.length} owner key(s))`);
}
console.log('[migrate-accounts] identities.json left untouched; restore the .bak files to undo.');
