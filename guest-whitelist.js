/**
 * GUEST WHITELIST — the streamer's standing free list.
 *
 * A streamer names MegaChat handles that may join their stream free, any time:
 * regular co-hosts and recurring guests who come and go without paying per
 * second or waiting for a seat. Per STREAMER, not per room — the list is keyed
 * by the owner key (`provider:platformId`, the same key rooms-store stamps on
 * a room as `ownerKey`), so it applies across every room that streamer owns
 * without re-adding anyone.
 *
 * JSON persistence, same zero-infra pattern as rooms-store / identity-store,
 * and the same DATA_DIR override so the list survives a deploy.
 *
 * This module stores and answers. It does NOT decide who is signed in: the
 * caller resolves the requester from the sealed identity cookie and passes a
 * handle it already trusts (see server.js `whitelistGuestFor`). Never pass a
 * client-supplied handle in here and treat the answer as authorization.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sanitizeHandle } from './rooms-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'guest-whitelist.json');

/**
 * How many guests one streamer may list. Capped so the whitelist can't quietly
 * become a way to run a free room at scale — 20 covers a co-host bench and a
 * circle of regulars, which is what this is for.
 */
export function whitelistMax() {
  const raw = Number(process.env.GUEST_WHITELIST_MAX || 20);
  if (!Number.isFinite(raw)) return 20;
  return Math.min(200, Math.max(1, Math.floor(raw)));
}

let cache = null;

function load() {
  if (cache) return cache;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    cache = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    cache = { lists: {} };
  }
  if (!cache.lists) cache.lists = {};
  return cache;
}

function save() {
  fs.writeFileSync(STORE_PATH, JSON.stringify(cache, null, 2));
}

function rawList(ownerKey) {
  const store = load();
  const key = String(ownerKey || '');
  if (!key) return null;
  if (!store.lists[key]) store.lists[key] = { enabled: null, entries: [] };
  const list = store.lists[key];
  if (!Array.isArray(list.entries)) list.entries = [];
  return list;
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
export function isWhitelisted(ownerKey, handle) {
  const clean = sanitizeHandle(handle);
  if (!clean || !ownerKey) return false;
  const list = rawList(ownerKey);
  if (!list || !effectiveEnabled(list)) return false;
  return list.entries.some((e) => e.handle === clean);
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
export function addGuest(ownerKey, handle) {
  const clean = sanitizeHandle(handle);
  if (!clean) {
    const err = new Error('Handles are 3-20 characters: letters, numbers and underscores.');
    err.code = 'invalid_handle';
    throw err;
  }
  const list = rawList(ownerKey);
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
  const list = rawList(ownerKey);
  const before = list.entries.length;
  list.entries = list.entries.filter((e) => e.handle !== clean);
  if (list.entries.length === before) return false;
  save();
  return true;
}

/**
 * The master switch. Writes an EXPLICIT true/false — the list itself is never
 * touched, so flipping back on restores exactly who was there.
 */
export function setEnabled(ownerKey, enabled) {
  const list = rawList(ownerKey);
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
  entry.lastJoinedAt = new Date().toISOString();
  entry.joinCount = (entry.joinCount || 0) + 1;
  save();
  return { ...entry };
}

/** Test helper — drops the in-memory cache so a fresh DATA_DIR is re-read. */
export function _resetWhitelistForTests() {
  cache = null;
}
