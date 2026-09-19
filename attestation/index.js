/**
 * attestation/ — where an attribute came from, and how much that is worth.
 *
 * One shape, whatever the source:
 *
 *   { attribute, value, source, trust, fetchedAt, proof? }
 *
 * `attribute` is a name from ATTRIBUTES below. `value` is a number, string or
 * boolean — never a list of people. `source` is one of SOURCES. `trust` is an
 * ordinal this app assigns, not something a source claims about itself.
 * `proof` is opaque and stored as-is; only zkTLS sources set it.
 *
 * TRUST ORDERING, and the reasoning. A platform's own API is the highest
 * authority ON ITS OWN DATA: X is definitionally correct about an X follower
 * count, and we reached it over an authenticated channel we opened ourselves.
 * A zkTLS proof is next: it says a real session with that platform returned
 * this value, which is strong, but it arrives through a third party and a
 * verifier we did not write. `manual` is last — an operator typing a number is
 * useful for seeding and worthless as evidence. Equal `trust` is a real tie:
 * the classifier prefers the FRESHER record, never the luckier one.
 *
 * ADDING A SOURCE is one file: export `fetchAttributes` with the signature
 * below and register it in ADAPTERS. The two zkTLS adapters are deliberately
 * unimplemented — see their files for the exact SDK boundary.
 */

/** Every attribute this layer knows how to store. Nothing here is a graph. */
export const ATTRIBUTES = {
  followersCount: 'number',
  followingCount: 'number',
  accountCreatedAt: 'string',   // ISO date
  verified: 'boolean',
  broadcasterType: 'string',    // twitch: '', 'affiliate', 'partner'
  postCount: 'number',
  listedCount: 'number',
  viewCount: 'number',
};

export const SOURCES = ['x-api', 'twitch-helix', 'opacity', 'reclaim', 'manual'];

/** Higher wins. See the header for why the order is this way. */
export const TRUST = {
  'x-api': 100,
  'twitch-helix': 100,
  opacity: 60,
  reclaim: 60,
  manual: 10,
};

/** Which provider each source is authoritative for. */
export const SOURCE_PROVIDER = { 'x-api': 'x', 'twitch-helix': 'twitch', opacity: null, reclaim: null, manual: null };

/** Build one attribute record. Unknown names and bad types are dropped, loudly. */
export function attr(attribute, value, source, { proof = undefined, fetchedAt = null, log = console } = {}) {
  const want = ATTRIBUTES[attribute];
  if (!want) { log.warn?.(`[attestation] unknown attribute "${attribute}" from ${source} — dropped`); return null; }
  if (value === null || value === undefined) return null;
  if (typeof value !== want) { log.warn?.(`[attestation] ${attribute} from ${source} is ${typeof value}, expected ${want} — dropped`); return null; }
  if (!SOURCES.includes(source)) { log.warn?.(`[attestation] unknown source "${source}" — dropped`); return null; }
  const rec = { attribute, value, source, trust: TRUST[source] ?? 0, fetchedAt: fetchedAt || new Date().toISOString() };
  if (proof !== undefined) rec.proof = proof;
  return rec;
}

/**
 * Collapse a list of attribute records to one per attribute: highest trust
 * wins, then the freshest. Used by the classifier and the account page so both
 * read the same value.
 */
export function bestAttributes(records) {
  const out = {};
  for (const r of records || []) {
    if (!r || !r.attribute) continue;
    const cur = out[r.attribute];
    if (!cur) { out[r.attribute] = r; continue; }
    if (r.trust > cur.trust) { out[r.attribute] = r; continue; }
    if (r.trust === cur.trust && String(r.fetchedAt || '') > String(cur.fetchedAt || '')) out[r.attribute] = r;
  }
  return out;
}

/** Every attribute record across an account's links, newest-first per link. */
export function accountAttributes(account) {
  const all = [];
  for (const l of account?.links || []) for (const r of l.attributes || []) all.push(r);
  return all;
}

/**
 * The adapter contract. Each returns `{ ok, records[], error }` and NEVER
 * throws: a metrics call must not be able to fail a sign-in (see the callers).
 *
 *   fetchAttributes({ platformId, accessToken, username, log }) -> Promise<Result>
 */
import * as xApi from './x-api.js';
import * as twitchHelix from './twitch-helix.js';
import * as opacity from './opacity.js';
import * as reclaim from './reclaim.js';

export const ADAPTERS = {
  'x-api': xApi,
  'twitch-helix': twitchHelix,
  opacity,
  reclaim,
};

/** The source that speaks for a provider's own data, or null. */
export function sourceForProvider(provider) {
  if (provider === 'x') return 'x-api';
  if (provider === 'twitch') return 'twitch-helix';
  return null;
}

/**
 * Fetch a provider's attributes through its authoritative source. Returns
 * `{ ok: false }` rather than throwing — every caller is on a sign-in path.
 */
export async function fetchForProvider(provider, params = {}) {
  const source = sourceForProvider(provider);
  if (!source) return { ok: false, records: [], error: 'no-source-for-provider' };
  const adapter = ADAPTERS[source];
  if (!adapter?.fetchAttributes) return { ok: false, records: [], error: 'not-configured' };
  try {
    return await adapter.fetchAttributes(params);
  } catch (err) {
    (params.log || console).warn?.(`[attestation] ${source} threw: ${err.message}`);
    return { ok: false, records: [], error: err.message };
  }
}
