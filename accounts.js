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
import path from 'path';
import { randomUUID } from 'crypto';
import { sanitizeHandle, getRoomByHandle } from './rooms-store.js';
import { createJsonStore, dataDir } from './json-store.js';

const storePath = () => path.join(dataDir(), 'accounts.json');

/** Providers that may be linked. `privy` is the sign-in anchor, not a platform. */
export const LINKABLE_PROVIDERS = ['twitch', 'x', 'kick', 'tiktok'];
export const PROVIDER_LABELS = { privy: 'Privy', twitch: 'Twitch', x: 'X', kick: 'Kick', tiktok: 'TikTok' };

// Written through atomically (json-store.js). An accounts.json that cannot be
// read refuses every write: a sign-in throws StoreRefused instead of minting a
// second account for a person whose record is unreadable (stores-2, D3).
const accountsStore = createJsonStore({
  file: storePath,
  name: 'accounts',
  pretty: true,
  empty: () => ({ accounts: {}, handles: {}, links: {} }),
  normalize: (doc) => {
    doc.accounts ||= {};
    doc.handles ||= {};   // handle -> accountId (canonical AND reserved)
    doc.links ||= {};     // "provider:platformId" -> accountId
    return doc;
  },
});
const load = () => accountsStore.data();
/** The document, for a change: throws StoreRefused BEFORE anything is touched. */
function loadForWrite() {
  accountsStore.assertWritable();
  return accountsStore.data();
}
function save() {
  accountsStore.save();
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

/**
 * Every refusal here is the caller's input or the account's state, never a
 * server fault, so each carries the HTTP status a route should answer with.
 * Without one, campaign-routes answered a mistyped payout address with a 500.
 */
function fail(code, message, status) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  throw err;
}

/**
 * Sign-in from any provider. Returns the existing account for that platform
 * login, or creates one with `handle` (or a suggestion) as its canonical name.
 * The FIRST link is the primary; later links attach without disturbing it.
 */
export function upsertAccountForLink({ provider, platformId, username = null, handle = null, attributes = undefined }) {
  if (!provider || platformId == null) fail('invalid_link', 'provider and platformId are required', 400);
  const store = loadForWrite();
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
  const store = loadForWrite();
  const acct = store.accounts[accountId];
  if (!acct) fail('no_account', 'No such account', 404);
  const pid = String(platformId);
  const owner = store.links[linkKey(provider, pid)];
  if (owner && owner !== accountId) fail('link_taken', `That ${PROVIDER_LABELS[provider] || provider} account is already linked to another MegaChat account.`, 409);
  if (owner === accountId) return clone(acct);
  if (acct.links.some((l) => l.provider === provider)) fail('provider_linked', `This account already has a ${PROVIDER_LABELS[provider] || provider} link. Disconnect it first.`, 409);
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
  const store = loadForWrite();
  const acct = store.accounts[accountId];
  if (!acct) fail('no_account', 'No such account', 404);
  if (acct.links.length <= 1) fail('last_link', 'That is the only way back into this account.', 409);
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
  const store = loadForWrite();
  const acct = store.accounts[accountId];
  if (!acct) fail('no_account', 'No such account', 404);
  if (!acct.links.some((l) => l.provider === provider)) fail('not_linked', 'That provider is not linked to this account.', 400);
  acct.primary = provider;
  save();
  return clone(acct);
}

/**
 * Move the canonical handle. The old name stays RESERVED to this account —
 * released only by `releaseHandle`, never by someone else's claim.
 */
export function claimHandle(accountId, handle) {
  const store = loadForWrite();
  const acct = store.accounts[accountId];
  if (!acct) fail('no_account', 'No such account', 404);
  const wanted = sanitizeHandle(handle);
  if (!wanted) fail('invalid_handle', 'Handles are 3-20 characters: letters, numbers and underscores.', 400);
  if (acct.handle === wanted) return clone(acct);
  const owner = store.handles[wanted];
  if (owner && owner !== accountId) fail('handle_taken', 'Handle already taken', 409);
  if (!owner && !isHandleFree(wanted)) fail('handle_taken', 'Handle already taken', 409);
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
  const store = loadForWrite();
  const acct = store.accounts[accountId];
  if (!acct) fail('no_account', 'No such account', 404);
  const h = sanitizeHandle(handle);
  if (!h) fail('invalid_handle', 'Invalid handle', 400);
  if (acct.handle === h) fail('handle_in_use', 'That is your current handle — claim another one first.', 409);
  if (store.handles[h] !== accountId) fail('not_yours', 'That handle is not reserved by this account.', 403);
  delete store.handles[h];
  acct.reservedHandles = (acct.reservedHandles || []).filter((x) => x !== h);
  save();
  return clone(acct);
}

/**
 * Store what a source returned for one link.
 *
 * `platformId` names the login the records are ABOUT. When it is not this
 * link's own, nothing is written (`provider_linked`): the OAuth callback once
 * wrote a second X account's follower count onto the first one's link, so one
 * big X account could make any number of Holler accounts eligible for the same
 * campaign. Every caller that knows the id should pass it.
 *
 * `username` refreshes the login's name in the same write, because platform
 * logins can be renamed and bounty ownership reads them. `attributes` null
 * leaves the stored records alone: a failed read never erases a good one.
 */
export function setLinkAttributes(accountId, provider, attributes, { platformId = null, username = null } = {}) {
  const store = loadForWrite();
  const acct = store.accounts[accountId];
  if (!acct) fail('no_account', 'No such account', 404);
  const link = acct.links.find((l) => l.provider === provider);
  if (!link) fail('not_linked', 'That provider is not linked to this account.', 400);
  if (platformId != null && link.platformId !== String(platformId)) {
    fail('provider_linked', `This account's ${PROVIDER_LABELS[provider] || provider} link is a different login. Disconnect it first.`, 409);
  }
  const renamed = !!username && link.username !== String(username).slice(0, 60);
  if (renamed) link.username = String(username).slice(0, 60);
  if (attributes != null) {
    link.attributes = attributes;
    link.attributesFetchedAt = new Date().toISOString();
  }
  if (renamed || attributes != null) save(); // a sign-in that changed nothing rewrites nothing
  return clone(acct);
}

/**
 * Names an AGGREGATOR (Privy) reports for platforms this person has linked
 * there. Names without platform ids: not links, so they carry no attributes
 * and cannot be proven. Ownership checks read them; connecting the same
 * platform through our own OAuth upgrades one into a real link.
 */
export function setAccountPlatformLogins(accountId, logins) {
  const store = loadForWrite();
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

/**
 * Where this account is PAID: a campaign reward (campaign-engine.js) is
 * released to this address through the settlement door. Chosen by the
 * signed-in account holder, like a room's payout address is chosen by its
 * owner; receiving needs no signature, so none is asked for. null clears it.
 * An intent already recorded keeps the address it was recorded with.
 */
export function setAccountPayoutWallet(accountId, address) {
  const store = loadForWrite();
  const acct = store.accounts[accountId];
  if (!acct) fail('no_account', 'No such account', 404);
  if (address === null) delete acct.payoutWallet;
  else if (/^0x[0-9a-fA-F]{40}$/.test(String(address || ''))) acct.payoutWallet = String(address);
  else fail('invalid_wallet', 'That is not a wallet address (0x followed by 40 hex characters).', 400);
  save();
  return clone(acct);
}

/** Room-create prefill. Display data only; every room revalidates its config. */
export function setAccountDefaults(accountId, defaults) {
  const store = loadForWrite();
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

/**
 * Every name platform P's own login has proven for this person, strongest
 * first: the username on a real link (our OAuth, with a platform id), then the
 * name the aggregator (Privy) reports for P. Primary or not: `primary` is a
 * display setting and never decides who owns a channel, which it did in
 * bounty-auth until a Privy-primary streamer with a real Twitch link failed
 * every STREAMER route and passed after switching primary.
 * Takes an account or an identity view; both carry links and platformLogins.
 */
export function provenLoginsFor(account, platform) {
  const names = [
    (account?.links || []).find((l) => l.provider === platform && l.username)?.username,
    account?.platformLogins?.[platform],
  ].map((n) => (typeof n === 'string' ? n.trim() : '')).filter(Boolean);
  return [...new Set(names)];
}

/** The display name: the primary link's username, else the handle. */
export function displayNameFor(account) {
  if (!account) return null;
  const primary = account.links?.find((l) => l.provider === account.primary);
  return primary?.username || account.handle;
}

export function _resetAccountsForTests() {
  accountsStore.reset();
}
