/**
 * accounts.js — the canonical account: one person, N linked platforms.
 *
 * WHAT CHANGED AND WHY. Before this, an identity WAS `provider:platformId`:
 * one row per platform login, and the room owner key, the whitelist pin and
 * the sealed cookie all carried that string. Linking a second platform would
 * have minted a second person. Now an account has its own stable id
 * (`acct_…`) and a list of links; every platform login resolves to an
 * account, and everything that used to key on `provider:platformId` keys on
 * the account id instead.
 *
 * THE HANDLE IS OWNED BY THE ACCOUNT, AND NEVER AUTO-FREED. The old store
 * released a handle the moment its owner claimed a different one, so a name
 * somebody had used — and that a whitelist entry or a room link may still
 * refer to — could be taken by a stranger. Here a handle maps to an account
 * id forever unless that account explicitly releases it: `claimHandle` moves
 * the canonical name and leaves the old one RESERVED to the same account, and
 * `releaseHandle` is the only way out. `isHandleFree` treats reserved names as
 * taken. (`OPEN-ISSUES.md`, "A HANDLE IS NOT AN AUTHORIZATION TOKEN".)
 *
 * WHAT A LINK HOLDS. `{provider, platformId, handle, username, linkedAt,
 * attributes, attributesFetchedAt}`. `attributes` is whatever the platform
 * returned at link time, in the shape `attestation/` defines — never a graph:
 * no follower lists, no following lists, no mutuals (see the data-model page's
 * "deliberately absent" list).
 *
 * ONE LINK PER PROVIDER PER ACCOUNT, and one account per platform login: a
 * provider identity already linked elsewhere is refused (`link_taken`), never
 * moved or merged. There is nobody to merge — the app has zero users — and a
 * merge flow that nobody needs is a security surface nobody reviewed.
 *
 * WHAT DOES NOT CHANGE WHEN LINKS CHANGE. The canonical handle is the account's
 * own, not the primary link's. Adding a link or switching `primary` changes the
 * DISPLAY name only, so the room slug, the `/username` link and the OBS overlay
 * URL stay put. A handle moves only through `claimHandle`.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { sanitizeHandle, getRoomByHandle } from './rooms-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = () => process.env.DATA_DIR || path.join(__dirname, 'data');
const storePath = () => path.join(dataDir(), 'accounts.json');

/** Providers that may be linked. `privy` is the sign-in anchor, not a platform. */
export const LINKABLE_PROVIDERS = ['twitch', 'x', 'kick', 'tiktok'];
export const PROVIDER_LABELS = { privy: 'Privy', twitch: 'Twitch', x: 'X', kick: 'Kick', tiktok: 'TikTok' };

let cache = null;

function load() {
  if (cache) return cache;
  const dir = dataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try {
    cache = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
  } catch {
    cache = { accounts: {}, handles: {}, links: {} };
  }
  cache.accounts ||= {};
  cache.handles ||= {};   // handle -> accountId (canonical AND reserved)
  cache.links ||= {};     // "provider:platformId" -> accountId
  return cache;
}

function save() {
  fs.writeFileSync(storePath(), JSON.stringify(cache, null, 2));
}

const linkKey = (provider, platformId) => `${provider}:${platformId}`;
const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

// ── reads ───────────────────────────────────────────────────────────────────

export function getAccount(accountId) {
  return clone(load().accounts[accountId] || null);
}

/** The account a platform login belongs to, or null. */
export function accountForLink(provider, platformId) {
  const store = load();
  const id = store.links[linkKey(provider, String(platformId))];
  return id ? clone(store.accounts[id] || null) : null;
}

/** The account that owns a handle — canonical OR reserved. */
export function accountForHandle(handle) {
  const store = load();
  const h = sanitizeHandle(handle);
  if (!h) return null;
  const id = store.handles[h];
  return id ? clone(store.accounts[id] || null) : null;
}

/** The account whose CANONICAL handle this is (a reserved name answers null). */
export function accountByCanonicalHandle(handle) {
  const acct = accountForHandle(handle);
  return acct && acct.handle === sanitizeHandle(handle) ? acct : null;
}

export function isHandleTakenByAccount(handle) {
  const h = sanitizeHandle(handle);
  return !!h && !!load().handles[h];
}

/** Free across BOTH registries, and reserved names count as taken. */
export function isHandleFree(handle) {
  const h = sanitizeHandle(handle);
  if (!h) return false;
  return !isHandleTakenByAccount(h) && !getRoomByHandle(h);
}

/** First free variant of a platform username: name, name_2 … name_99. */
export function suggestHandle(platformUsername) {
  const base = sanitizeHandle(platformUsername)
    || sanitizeHandle('user_' + String(platformUsername).replace(/[^a-z0-9]/gi, '').slice(0, 10))
    || 'user_' + Math.random().toString(36).slice(2, 8);
  if (isHandleFree(base)) return base;
  for (let i = 2; i < 100; i++) {
    const alt = sanitizeHandle(`${base.slice(0, 17)}_${i}`);
    if (alt && isHandleFree(alt)) return alt;
  }
  return sanitizeHandle(base.slice(0, 12) + '_' + Math.random().toString(36).slice(2, 6));
}

export function listAccounts() {
  return Object.values(load().accounts).map(clone);
}

// ── writes ──────────────────────────────────────────────────────────────────

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

/**
 * Sign-in from any provider. Returns the existing account for that platform
 * login, or creates one with `handle` (or a suggestion) as its canonical name.
 * The FIRST link is the primary; later links attach without disturbing it.
 */
export function upsertAccountForLink({ provider, platformId, username = null, handle = null, attributes = undefined }) {
  if (!provider || platformId == null) fail('invalid_link', 'provider and platformId are required');
  const store = load();
  const pid = String(platformId);
  const existingId = store.links[linkKey(provider, pid)];
  if (existingId) {
    const acct = store.accounts[existingId];
    const link = acct.links.find((l) => l.provider === provider && l.platformId === pid);
    if (link) {
      if (username) link.username = String(username).slice(0, 60);
      if (attributes !== undefined) { link.attributes = attributes; link.attributesFetchedAt = new Date().toISOString(); }
      save();
    }
    return clone(acct);
  }

  const wanted = sanitizeHandle(handle) || sanitizeHandle(username);
  const name = (wanted && isHandleFree(wanted)) ? wanted : suggestHandle(username || provider);
  const id = `acct_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();
  const account = {
    id,
    handle: name,
    primary: provider,
    createdAt: now,
    links: [{
      provider, platformId: pid, username: username ? String(username).slice(0, 60) : null,
      handle: name, linkedAt: now,
      attributes: attributes === undefined ? null : attributes,
      attributesFetchedAt: attributes === undefined ? null : now,
    }],
    reservedHandles: [],
    roomDefaults: undefined,
  };
  delete account.roomDefaults;
  store.accounts[id] = account;
  store.handles[name] = id;
  store.links[linkKey(provider, pid)] = id;
  save();
  return clone(account);
}

/**
 * Attach a platform login to an EXISTING account. Refuses when that login
 * already belongs to another account (`link_taken`) or when this account
 * already has that provider (`provider_linked`) — one link per provider.
 */
export function attachLink(accountId, { provider, platformId, username = null, attributes = undefined }) {
  const store = load();
  const acct = store.accounts[accountId];
  if (!acct) fail('no_account', 'No such account');
  const pid = String(platformId);
  const owner = store.links[linkKey(provider, pid)];
  if (owner && owner !== accountId) fail('link_taken', `That ${PROVIDER_LABELS[provider] || provider} account is already linked to another MegaChat account.`);
  if (owner === accountId) return clone(acct);
  if (acct.links.some((l) => l.provider === provider)) fail('provider_linked', `This account already has a ${PROVIDER_LABELS[provider] || provider} link. Disconnect it first.`);
  const now = new Date().toISOString();
  acct.links.push({
    provider, platformId: pid, username: username ? String(username).slice(0, 60) : null,
    handle: acct.handle, linkedAt: now,
    attributes: attributes === undefined ? null : attributes,
    attributesFetchedAt: attributes === undefined ? null : now,
  });
  store.links[linkKey(provider, pid)] = accountId;
  save();
  return clone(acct);
}

/** Remove a link. The last link cannot be removed — it is the way back in. */
export function detachLink(accountId, provider) {
  const store = load();
  const acct = store.accounts[accountId];
  if (!acct) fail('no_account', 'No such account');
  if (acct.links.length <= 1) fail('last_link', 'That is the only way back into this account.');
  const link = acct.links.find((l) => l.provider === provider);
  if (!link) return clone(acct);
  acct.links = acct.links.filter((l) => l.provider !== provider);
  delete store.links[linkKey(provider, link.platformId)];
  if (acct.primary === provider) acct.primary = acct.links[0].provider;
  save();
  return clone(acct);
}

/** Which link supplies the display name. Never moves the canonical handle. */
export function setPrimary(accountId, provider) {
  const store = load();
  const acct = store.accounts[accountId];
  if (!acct) fail('no_account', 'No such account');
  if (!acct.links.some((l) => l.provider === provider)) fail('not_linked', 'That provider is not linked to this account.');
  acct.primary = provider;
  save();
  return clone(acct);
}

/**
 * Move the canonical handle. The old name stays RESERVED to this account —
 * released only by `releaseHandle`, never by someone else's claim.
 */
export function claimHandle(accountId, handle) {
  const store = load();
  const acct = store.accounts[accountId];
  if (!acct) fail('no_account', 'No such account');
  const wanted = sanitizeHandle(handle);
  if (!wanted) fail('invalid_handle', 'Handles are 3-20 characters: letters, numbers and underscores.');
  if (acct.handle === wanted) return clone(acct);
  const owner = store.handles[wanted];
  if (owner && owner !== accountId) fail('handle_taken', 'Handle already taken');
  if (!owner && !isHandleFree(wanted)) fail('handle_taken', 'Handle already taken');
  const previous = acct.handle;
  acct.handle = wanted;
  store.handles[wanted] = accountId;
  if (previous && previous !== wanted) {
    acct.reservedHandles = [...new Set([...(acct.reservedHandles || []), previous])];
    store.handles[previous] = accountId; // still ours; not free for anyone else
  }
  acct.reservedHandles = (acct.reservedHandles || []).filter((h) => h !== wanted);
  save();
  return clone(acct);
}

/** Give a reserved handle back to the pool. The canonical one cannot be released. */
export function releaseHandle(accountId, handle) {
  const store = load();
  const acct = store.accounts[accountId];
  if (!acct) fail('no_account', 'No such account');
  const h = sanitizeHandle(handle);
  if (!h) fail('invalid_handle', 'Invalid handle');
  if (acct.handle === h) fail('handle_in_use', 'That is your current handle — claim another one first.');
  if (store.handles[h] !== accountId) fail('not_yours', 'That handle is not reserved by this account.');
  delete store.handles[h];
  acct.reservedHandles = (acct.reservedHandles || []).filter((x) => x !== h);
  save();
  return clone(acct);
}

/** Store the attributes a source returned for one link. */
export function setLinkAttributes(accountId, provider, attributes) {
  const store = load();
  const acct = store.accounts[accountId];
  if (!acct) fail('no_account', 'No such account');
  const link = acct.links.find((l) => l.provider === provider);
  if (!link) fail('not_linked', 'That provider is not linked to this account.');
  link.attributes = attributes ?? null;
  link.attributesFetchedAt = new Date().toISOString();
  save();
  return clone(acct);
}

/**
 * Names an AGGREGATOR (Privy) reports for platforms this person has linked
 * there. Names without platform ids: not links, so they carry no attributes
 * and cannot be proven. Ownership checks read them; connecting the same
 * platform through our own OAuth upgrades one into a real link.
 */
export function setAccountPlatformLogins(accountId, logins) {
  const store = load();
  const acct = store.accounts[accountId];
  if (!acct) return null;
  const clean = {};
  for (const [k, v] of Object.entries(logins || {})) {
    if (typeof v === 'string' && v.trim()) clean[String(k).toLowerCase()] = v.trim().slice(0, 60);
  }
  if (Object.keys(clean).length) acct.platformLogins = clean;
  else delete acct.platformLogins;
  save();
  return clone(acct);
}

/** Room-create prefill. Display data only; every room revalidates its config. */
export function setAccountDefaults(accountId, defaults) {
  const store = load();
  const acct = store.accounts[accountId];
  if (!acct) return null;
  if (defaults === null) delete acct.roomDefaults;
  else acct.roomDefaults = defaults;
  save();
  return clone(acct);
}

/**
 * What each platform's OWN login says this person is called. Ownership checks
 * read this rather than the display name: someone with Twitch and X linked
 * displays as one of them, and that name proves nothing about the other.
 */
export function platformLoginsFor(account) {
  const out = {};
  for (const l of account?.links || []) if (l.username) out[l.provider] = l.username;
  return out;
}

/** The display name: the primary link's username, else the handle. */
export function displayNameFor(account) {
  if (!account) return null;
  const primary = account.links?.find((l) => l.provider === account.primary);
  return primary?.username || account.handle;
}

export function _resetAccountsForTests() {
  cache = null;
}
