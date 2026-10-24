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
 * IDEMPOTENT, AND RUN AT BOOT. `migrateAccounts()` is what the server calls
 * before any store is read (DECISIONS D6): run beside a live server — the old
 * `railway ssh` procedure — the server's caches wrote the pre-migration rooms
 * and accounts straight back (stores-6). A second run over its own output
 * finds every identity adopted and every owner key rewritten, and writes
 * nothing. A file it must read that exists but cannot be parsed refuses the
 * run rather than being treated as empty (DECISIONS D3).
 *
 *   node _migrate-accounts.mjs            # report only
 *   node _migrate-accounts.mjs --write    # apply (stop the server first)
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { dataDir as defaultDataDir, readJsonFile, writeJsonAtomic } from './json-store.js';

const sanitize = (h) => {
  const s = String(h == null ? '' : h).trim().toLowerCase();
  return /^[a-z0-9_]{3,20}$/.test(s) ? s : null;
};

/**
 * identities.json → accounts.json, plus the room owner keys that point at the
 * old composites. Reports always; writes only with `write`, and only when
 * something would change.
 *
 * @returns {{ status: 'nothing' | 'refused' | 'unchanged' | 'report' | 'written',
 *   reason?: string, rows?: number, adopted?: any[], created?: any[], collisions?: any[],
 *   restored?: any[], carried?: any[], reserved?: string[], roomRewrites?: any[],
 *   noRooms?: boolean, backups?: string[] }}
 */
export function migrateAccounts({ dataDir = defaultDataDir(), write = false } = {}) {
  const SRC = path.join(dataDir, 'identities.json');
  const DEST = path.join(dataDir, 'accounts.json');
  const ROOMS = path.join(dataDir, 'rooms.json');

  const src = readJsonFile(SRC);
  if (src.state === 'missing') return { status: 'nothing', reason: `no identities.json at ${SRC}` };
  if (src.state !== 'ok') return { status: 'refused', reason: `${SRC} is ${src.state} (${src.why})` };
  const identities = src.data?.identities || {};
  const oldHandles = src.data?.handles || {};
  const rows = Object.entries(identities);
  if (!rows.length) return { status: 'nothing', reason: 'identities.json holds no identities' };

  // The CURRENT state is the base, not a blank sheet: accounts created by the new
  // sign-in path are real, their ids are sealed into live cookies, and this run
  // reconciles them rather than replacing them. An accounts.json or rooms.json
  // that exists but cannot be read is NOT a blank sheet either.
  const dest = readJsonFile(DEST);
  if (dest.state !== 'ok' && dest.state !== 'missing') return { status: 'refused', reason: `${DEST} is ${dest.state} (${dest.why})` };
  const roomsFile = readJsonFile(ROOMS);
  if (roomsFile.state !== 'ok' && roomsFile.state !== 'missing') return { status: 'refused', reason: `${ROOMS} is ${roomsFile.state} (${roomsFile.why})` };
  const current = dest.state === 'ok' ? dest.data : { accounts: {}, handles: {}, links: {} };
  const accounts = current.accounts || {};
  const handles = current.handles || {};
  const links = current.links || {};
  const rooms = roomsFile.state === 'ok' ? roomsFile.data : null;

  const adopted = [], created = [], collisions = [], restored = [], carried = [], reserved = [];

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
    reserved.push(h);
  }

  // ── 4. the rooms that point at an old composite ─────────────────────────────
  const roomRewrites = [];
  for (const [id, rec] of Object.entries(rooms?.rooms || {})) {
    if (!rec.ownerKey || !ownerMap[rec.ownerKey]) continue;
    roomRewrites.push({ id, from: rec.ownerKey, to: ownerMap[rec.ownerKey], name: rec.name });
  }

  const report = { rows: rows.length, adopted, created, collisions, restored, carried, reserved, roomRewrites, noRooms: !rooms };
  // Adopting is not a change: a second run over this run's output adopts every
  // identity, finds nothing else to do, and writes nothing.
  const changed = created.length + restored.length + carried.length + reserved.length + roomRewrites.length > 0;
  if (!changed) return { status: 'unchanged', ...report };
  if (!write) return { status: 'report', ...report };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backups = [];
  for (const p of [DEST, ...(roomRewrites.length ? [ROOMS] : [])]) {
    if (!fs.existsSync(p)) continue;
    fs.copyFileSync(p, `${p}.bak-${stamp}`);
    backups.push(`${p}.bak-${stamp}`);
  }
  // Fields this script does not know about are carried, not dropped.
  writeJsonAtomic(DEST, { ...current, accounts, handles, links }, { pretty: true });
  if (roomRewrites.length) {
    for (const r of roomRewrites) rooms.rooms[r.id].ownerKey = r.to;
    writeJsonAtomic(ROOMS, rooms, { pretty: true });
  }
  return { status: 'written', ...report, backups };
}

function printReport(r) {
  const say = (s) => console.log(`[migrate-accounts] ${s}`);
  if (r.status === 'nothing' || r.status === 'refused') {
    say(`${r.status === 'refused' ? 'REFUSED: ' : ''}${r.reason} — nothing written`);
    return;
  }
  say(`${r.rows} identity row(s): ${r.adopted.length} adopted, ${r.created.length} created`);
  for (const a of r.adopted) console.log(`    ADOPT   ${a.key}  ->  ${a.accountId}  (@${a.handle})`);
  for (const c of r.created) console.log(`    CREATE  ${c.key}  ->  ${c.accountId}`);
  for (const x of r.restored) {
    console.log(`    HANDLE  ${x.accountId}: @${x.from} -> @${x.to}${x.viaRoom ? `  (name was held by their own room ${x.viaRoom})` : ''}`);
    if (x.from !== '(none)') console.log(`              @${x.from} kept RESERVED to them, not freed`);
  }
  for (const c of r.collisions) console.log(`    COLLISION @${c.handle} NOT restored for ${c.key} — ${c.why}`);
  for (const c of r.carried) console.log(`    CARRY   ${c.accountId}.${c.field}`);
  if (r.roomRewrites.length) {
    say(`${r.roomRewrites.length} room owner key(s) to rewrite:`);
    for (const x of r.roomRewrites) console.log(`    ${x.id} ${JSON.stringify(x.name)}  ${x.from}  ->  ${x.to}`);
  } else {
    say('no room carries an old composite owner key');
  }
  if (r.noRooms) say('WARNING: no rooms.json — owner keys NOT checked');
  if (r.status === 'unchanged') say('already migrated — nothing to write');
  else if (r.status === 'report') say('report only — pass --write to apply');
  else {
    for (const b of r.backups) say(`backed up -> ${b}`);
    say(`wrote accounts.json${r.roomRewrites.length ? ` and rooms.json (${r.roomRewrites.length} owner key(s))` : ''}`);
    say('identities.json left untouched; restore the .bak files to undo.');
  }
}

// As a script: report only, or apply with --write. Imported (the boot hook,
// the gate), it does nothing until called.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const r = migrateAccounts({ write: process.argv.includes('--write') });
  printReport(r);
  if (r.status === 'refused') process.exitCode = 1;
}
