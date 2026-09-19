/**
 * identity-store.js — the legacy identity SHAPE, over the canonical account.
 *
 * An "identity" used to be the record: `provider:platformId`, one row per
 * platform login, its own handle registry. It is now a VIEW of an account
 * (accounts.js) through one of its links, kept because half a dozen callers
 * speak this shape and none of them should have to care that a person can now
 * carry several platforms.
 *
 * WHAT MOVED. The store of record is `accounts.json`. The handle registry
 * moved with it, and with it the squatting hole this file used to have: a
 * handle is owned by an account id and is never freed by a re-claim, only by
 * an explicit release (accounts.js explains the attack). `identityKey` — what
 * rooms, the whitelist and the sealed cookie key on — is now the ACCOUNT ID,
 * exposed here as `identity.accountId` and returned by `roomOwnerKey`.
 *
 * WHAT DID NOT MOVE. Every exported name and signature below, so `auth.js`,
 * `privy-identity.js`, `whitelist-routes.js` and `dashboard-routes.js` read
 * exactly as they did.
 */
import {
  accountForLink, accountByCanonicalHandle, isHandleTakenByAccount, isHandleFree as accountsHandleFree,
  suggestHandle as accountsSuggestHandle, upsertAccountForLink, claimHandle, setAccountDefaults,
  setAccountPlatformLogins, getAccount, displayNameFor, _resetAccountsForTests, listAccounts,
} from './accounts.js';
import { sanitizeHandle } from './rooms-store.js';

/**
 * Render an account as the legacy identity shape, seen through `provider`
 * (its primary link when no provider is named).
 */
export function identityView(account, provider = null) {
  if (!account) return null;
  const link = account.links.find((l) => l.provider === (provider || account.primary)) || account.links[0];
  return {
    accountId: account.id,
    provider: link?.provider || account.primary,
    platformId: link?.platformId || null,
    username: link?.username || displayNameFor(account) || account.handle,
    handle: account.handle,
    createdAt: account.createdAt,
    primary: account.primary,
    links: account.links,
    ...(account.roomDefaults ? { roomDefaults: account.roomDefaults } : {}),
    ...(account.platformLogins ? { platformLogins: account.platformLogins } : {}),
  };
}

export function getIdentity(provider, platformId) {
  return identityView(accountForLink(provider, platformId), provider);
}

/** Handle -> identity. Only the CANONICAL handle resolves; a reserved one does not. */
export function getIdentityByHandle(handle) {
  return identityView(accountByCanonicalHandle(handle));
}

export function isHandleTakenByIdentity(handle) {
  return isHandleTakenByAccount(handle);
}

export const isHandleFree = accountsHandleFree;
export const suggestHandle = accountsSuggestHandle;

/**
 * Sign-in from a platform. Creates the account on first sight, or moves the
 * canonical handle when an existing account asks for a different (free) one.
 * Throws `{ code: 'handle_taken' | 'invalid_handle' }` exactly as before.
 */
export function claimIdentity({ provider, platformId, username, handle }) {
  const wanted = sanitizeHandle(handle);
  if (!wanted) {
    const err = new Error('Invalid handle: 3-20 chars, letters/numbers/underscore');
    err.code = 'invalid_handle';
    throw err;
  }
  const existing = accountForLink(provider, platformId);
  if (existing) {
    if (existing.handle === wanted) return identityView(existing, provider);
    return identityView(claimHandle(existing.id, wanted), provider);
  }
  if (!accountsHandleFree(wanted)) {
    const err = new Error('Handle already taken');
    err.code = 'handle_taken';
    throw err;
  }
  return identityView(upsertAccountForLink({ provider, platformId, username, handle: wanted }), provider);
}

/** Room-create prefill. `null` clears. */
export function setIdentityDefaults(provider, platformId, defaults) {
  const acct = accountForLink(provider, platformId);
  if (!acct) return null;
  return identityView(setAccountDefaults(acct.id, defaults), provider);
}

/**
 * What each platform's OWN login says this person is called, as reported by an
 * AGGREGATOR (Privy). These are names without platform ids, so they are not
 * links — they cannot carry attributes and cannot be proven to be this person.
 * Connecting the same platform through our own OAuth turns one into a real
 * link with an id and attributes. Ownership checks read this map; the display
 * name ladder does not.
 */
export function setPlatformLogins(provider, platformId, logins) {
  const acct = accountForLink(provider, platformId);
  if (!acct) return null;
  const clean = {};
  for (const [k, v] of Object.entries(logins || {})) {
    if (typeof v === 'string' && v.trim()) clean[String(k).toLowerCase()] = v.trim().slice(0, 60);
  }
  return identityView(setAccountPlatformLogins(acct.id, clean), provider);
}

export function _resetIdentitiesForTests() {
  _resetAccountsForTests();
}

/** Every account, as identity views. The migration script and the gate read it. */
export function _allIdentities() {
  return listAccounts().map((a) => identityView(a));
}

export { getAccount };
