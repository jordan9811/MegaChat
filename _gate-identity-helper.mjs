/**
 * Mint a REAL sealed mc_identity cookie for gates.
 *
 * The seal is HMAC-SHA256 over a base64url payload with AUTH_SECRET — the
 * exact construction auth.js uses. Reimplemented here rather than exported
 * from auth.js on purpose: this is test scaffolding, and giving production
 * code a "make me any identity" export is precisely the kind of convenience
 * that becomes an auth bypass. Two implementations of a four-line HMAC is the
 * cheaper risk, and if they ever diverge every auth gate fails loudly.
 *
 * ONE SHAPE: `{accountId, iat}`, what auth.js startSession seals. auth.js
 * refuses the pre-account `{provider, platformId}` shape (its ids are public,
 * so with a leaked secret it forged anyone) and any session without iat or
 * older than 30 days. A gate still names a person by platform login; the
 * helper turns that into the account id the way the retired legacy cookie did
 * on every request: the `links` table of accounts.json, which is what
 * accounts.js accountForLink reads.
 *
 * It reads accounts.json itself rather than importing accounts.js: that
 * import chain reaches bounty-claim.config.js, which reads its env ONCE at
 * load, and _gate-helpers.mjs imports this file, so every gate would freeze
 * the bounty config before it had set it (_gate-bounty-auth explains the
 * cost). Harness modules import no product code.
 */
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The secret the gate server seals with. There is no fallback: a gate server
 *  runs --prod, where runtime-env.js never accepts the public dev constant, so
 *  a cookie sealed with it signed nobody in and the gate ran signed out with no
 *  error. Pass { secret } or set AUTH_SECRET to the value the server boots with. */
const secret = () => {
  const s = process.env.AUTH_SECRET || process.env.MPP_SECRET_KEY;
  if (!s) throw new Error('[gate-identity] no secret to seal with: pass { secret } or set AUTH_SECRET to the value the gate server boots with');
  return s;
};

/** The sealed session value for an account. `iat` is ms, as auth.js writes it. */
export function sealSessionValue(accountId, { secret: s = secret(), iat = Date.now() } = {}) {
  const payload = Buffer.from(JSON.stringify({ accountId, iat })).toString('base64url');
  return `${payload}.${createHmac('sha256', s).update(payload).digest('base64url')}`;
}

/** A `Cookie:` header value signing in as that account. */
export const sessionCookieFor = (accountId, opts) => `mc_identity=${encodeURIComponent(sealSessionValue(accountId, opts))}`;

const readAccounts = (dataDir) => {
  try { return JSON.parse(readFileSync(path.join(dataDir, 'accounts.json'), 'utf8')); } catch { return {}; }
};

/** accountForLink over `dataDir`'s accounts.json: the account behind a login, or null. */
function accountIdForLink(dataDir, provider, platformId) {
  const s = readAccounts(dataDir);
  const id = s.links?.[`${provider}:${platformId}`];
  return id && s.accounts?.[id] ? id : null;
}

/**
 * The account behind a login, created in the store's own shape when there is
 * none: one link, primary, canonical handle = `handle`. Seed BEFORE the server
 * starts — it reads accounts.json once and keeps it.
 */
export function seedAccountForLink(dataDir, { provider, platformId, username, handle = username }) {
  const existing = accountIdForLink(dataDir, provider, platformId);
  if (existing) return existing;
  const s = readAccounts(dataDir);
  const id = `acct_gate${provider}${String(platformId).replace(/[^A-Za-z0-9]/g, '')}`;
  const now = new Date().toISOString();
  s.accounts = { ...s.accounts, [id]: {
    id, handle, primary: provider, createdAt: now, reservedHandles: [],
    links: [{ provider, platformId: String(platformId), username, handle, linkedAt: now, attributes: null, attributesFetchedAt: null }],
  } };
  s.handles = { ...s.handles, ...(handle ? { [handle]: id } : {}) };
  s.links = { ...s.links, [`${provider}:${platformId}`]: id };
  writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify(s, null, 2));
  return id;
}

/**
 * The sealed value for a platform login's account in `dataDir` (the server's
 * data dir). Throws when no account holds the login: a cookie for nobody is a
 * fixture bug, and quietly minting one is how five scripts that seeded
 * identities.json (which no server has read since the account layer) ran
 * signed out.
 */
function sealIdentityValue({ provider, platformId, dataDir = process.env.DATA_DIR }) {
  if (!dataDir) throw new Error(`[gate-identity] sealing ${provider}:${platformId} needs the server's dataDir`);
  const accountId = accountIdForLink(dataDir, provider, platformId);
  if (!accountId) throw new Error(`[gate-identity] no account holds ${provider}:${platformId} in ${dataDir}/accounts.json — seed it first`);
  return sealSessionValue(accountId);
}

/** A `Cookie:` header value carrying that login's account. */
export function sealIdentityForTests({ provider, platformId, dataDir }) {
  return `mc_identity=${encodeURIComponent(sealIdentityValue({ provider, platformId, dataDir }))}`;
}
