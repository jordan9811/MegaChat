/**
 * GUEST WHITELIST — the streamer's standing free list.
 *
 * A streamer names MegaChat handles that may join their stream free, any time:
 * regular co-hosts and recurring guests who come and go without paying per
 * second or waiting for a seat. Per STREAMER, not per room — the list is keyed
 * by the owner key (the ACCOUNT id, `acct_…`, the same key rooms-store stamps
 * on a room as `ownerKey`), so it applies across every room that streamer owns
 * without re-adding anyone.
 *
 * One JSON document under DATA_DIR, written through atomically on every change
 * (json-store.js); a file that cannot be read refuses writes rather than
 * reading as an empty list (DECISIONS D3).
 *
 * This module stores and answers. It does NOT decide who is signed in: the
 * caller resolves the requester from the sealed identity cookie and passes a
 * handle it already trusts (see server.js `whitelistGuestFor`). Never pass a
 * client-supplied handle in here and treat the answer as authorization.
 */
import path from 'path';
import { sanitizeHandle } from './rooms-store.js';
import { createJsonStore, dataDir } from './json-store.js';
import { envNum } from './env-num.js';

/**
 * How many guests one streamer may list. Capped so the whitelist can't quietly
 * become a way to run a free room at scale — 20 covers a co-host bench and a
 * circle of regulars, which is what this is for.
 */
export function whitelistMax() {
  return Math.min(200, Math.max(1, Math.floor(envNum('GUEST_WHITELIST_MAX', 20))));
}

const store = createJsonStore({
  file: () => path.join(dataDir(), 'guest-whitelist.json'),
  name: 'guest-whitelist',
  pretty: true,
  empty: () => ({ lists: {} }),
  normalize: (doc) => {
    if (!doc.lists || typeof doc.lists !== 'object') doc.lists = {};
    for (const list of Object.values(doc.lists)) if (list && !Array.isArray(list.entries)) list.entries = [];
    return doc;
  },
});

const save = () => store.save();

// What a streamer who never touched the list has. Shared and frozen: a read
// must never create a list — it used to insert one per owner key the join
// path asked about, and the next write persisted all of them (stores-12).
const NO_LIST = Object.freeze({ enabled: null, entries: Object.freeze([]) });

/**
 * The list for `ownerKey`. Reads get the stored list or NO_LIST; only the two
 * writers that genuinely create one (`addGuest`, `setEnabled`) pass
 * `create: true`, and they check the store is writable first.
 */
function rawList(ownerKey, { create = false } = {}) {
  const key = String(ownerKey || '');
  if (!key) return null;
  if (create) store.assertWritable();
  const doc = store.data();
  if (doc.lists[key]) return doc.lists[key];
  if (!create) return NO_LIST;
  doc.lists[key] = { enabled: null, entries: [] };
  return doc.lists[key];
}

/**
 * Is the list live right now?
 *
 * `enabled` is tri-state on disk. `null` means the streamer has never touched
 * the master switch, and then the sane default applies: ON while the list has
 * anyone on it, OFF while it's empty — so adding your first guest works
 * without a second click, and an empty list is never a live feature. An
 * explicit `true`/`false` is the streamer's own decision and always wins,
 * which is what lets "off" survive adding someone.
 */
function effectiveEnabled(list) {
  if (list.enabled === true) return true;
  if (list.enabled === false) return false;
  return list.entries.length > 0;
}

/** The streamer-facing view: entries, the switch, and the cap. */
export function getList(ownerKey) {
  const list = rawList(ownerKey);
  if (!list) return { enabled: false, explicit: null, entries: [], max: whitelistMax() };
  return {
    enabled: effectiveEnabled(list),
    explicit: list.enabled === true || list.enabled === false ? list.enabled : null,
    entries: list.entries.map((e) => ({ ...e })),
    max: whitelistMax(),
  };
}

/**
 * The join-path question: may this handle ride free in this streamer's rooms?
 *
 * Returns false when the master switch is off, which is the whole point of the
 * switch — the list stays on disk, everyone on it is simply treated as a
 * normal paying viewer until it comes back on.
 */
export function isWhitelisted(ownerKey, handle, identityKey = null) {
  const clean = sanitizeHandle(handle);
  if (!clean || !ownerKey) return false;
  const list = rawList(ownerKey);
  if (!list || !effectiveEnabled(list)) return false;
  return list.entries.some((e) => {
    if (e.handle !== clean) return false;
    // An entry that knows WHICH account it meant requires that account. A
    // handle can be released and re-claimed by someone else, so matching on
    // the string alone lets a stranger inherit a free seat by taking a name.
    // Entries written before identityKey existed have null and keep the old
    // handle-only behaviour rather than locking their owner out.
    if (!e.identityKey) return true;
    return !!identityKey && e.identityKey === identityKey;
  });
}

/**
 * Add a guest. Idempotent: re-adding someone already listed is a success, not
 * an error, so a double-click can't produce a scary message or a duplicate row.
 *
 * Throws `{ code }` for the two real failures — `invalid_handle` and
 * `list_full`. Whether the handle belongs to a REAL account is the caller's
 * check (it owns the identity store), because this module deliberately knows
 * nothing about identities.
 */
export function addGuest(ownerKey, handle, identityKey = null) {
  const clean = sanitizeHandle(handle);
  if (!clean) {
    const err = new Error('Handles are 3-20 characters: letters, numbers and underscores.');
    err.code = 'invalid_handle';
    throw err;
  }
  const list = rawList(ownerKey, { create: true });
  const existing = list.entries.find((e) => e.handle === clean);
  if (existing) return { added: false, entry: { ...existing } };
  const max = whitelistMax();
  if (list.entries.length >= max) {
    const err = new Error(`Your whitelist is full (${max} guests). Remove someone first.`);
    err.code = 'list_full';
    throw err;
  }
  const entry = {
    handle: clean,
    // WHO the handle was when it was added. A handle is a display name, and
    // one its account explicitly releases (accounts.js releaseHandle) can be
    // claimed by somebody else, so an entry that stores only the string is an
    // authorization token somebody else can later take. Pinning the identity
    // means a re-claimed handle stops matching instead of silently inheriting
    // a free seat. Null for entries written before this existed — those fall
    // back to handle-only matching and are flagged in the UI.
    identityKey: identityKey || null,
    addedAt: new Date().toISOString(),
    lastJoinedAt: null,
    joinCount: 0,
  };
  list.entries.push(entry);
  save();
  return { added: true, entry: { ...entry } };
}

/** Remove a guest. Returns false when they weren't on the list. */
export function removeGuest(ownerKey, handle) {
  const clean = sanitizeHandle(handle);
  if (!clean) return false;
  store.assertWritable();
  const list = rawList(ownerKey);
  if (!list || !list.entries.some((e) => e.handle === clean)) return false;
  list.entries = list.entries.filter((e) => e.handle !== clean);
  save();
  return true;
}

/**
 * The master switch. Writes an EXPLICIT true/false — the list itself is never
 * touched, so flipping back on restores exactly who was there.
 */
export function setEnabled(ownerKey, enabled) {
  const list = rawList(ownerKey, { create: true });
  if (!list) return null;
  list.enabled = !!enabled;
  save();
  return getList(ownerKey);
}

/**
 * The audit record. A whitelisted join writes nothing to any ledger — this
 * line is the entire trace, and it is what the streamer's list shows as "last
 * seen" so they can tell a live regular from a name they added and forgot.
 */
export function recordJoin(ownerKey, handle) {
  const clean = sanitizeHandle(handle);
  if (!clean) return null;
  const list = rawList(ownerKey);
  const entry = list?.entries.find((e) => e.handle === clean);
  if (!entry) return null;
  store.assertWritable();
  entry.lastJoinedAt = new Date().toISOString();
  entry.joinCount = (entry.joinCount || 0) + 1;
  save();
  return { ...entry };
}
