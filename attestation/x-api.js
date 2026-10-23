/**
 * X (Twitter) API v2 — the profile lookup, plus the three reads targeted
 * campaigns need. Nothing here stores anything; callers decide what is kept.
 *
 * COST. The X API is pay-per-use against prepaid credits: no subscription
 * tier, no free tier, and reads are billed per resource returned (docs.x.com,
 * "Pricing"). Figures this module is written against (checked 2026-10-23):
 *   - user lookup                $0.01 per user returned
 *   - followers / following list $0.01 per user returned, up to 1,000 a page,
 *                                300 requests per 15 minutes per app
 *   - there is no v2 relationship-lookup endpoint; `connection_status` on a
 *     user lookup is the only cheap relationship signal, and it describes
 *     the relationship between the TOKEN HOLDER and the looked-up user
 * `X_COST_PER_USER_USD` below is that $0.01, in one place.
 *
 * WHAT EACH READ IS FOR
 *   fetchAttributes      the link-time profile read, with the user's own token
 *                        inside the OAuth round trip (unchanged in spirit:
 *                        ONE call, every field asked for in that call)
 *   fetchUserById        the same fields by id with the APP bearer token —
 *                        how a campaign check refreshes a stale link
 *   lookupConnection     a token holder looks up one or more ids with
 *                        user.fields=connection_status (followedByFromSet)
 *   pageUsers            one page of a following / followers / list-members
 *                        list (reference-set snapshots; the capped fallback of
 *                        followedByFromSet)
 *
 * X DEVELOPER POLICY. Paying people to take actions ON X (follow, reply,
 * repost, quote, like) is forbidden. Nothing that calls this module may make
 * an action on X the condition of a reward; these reads only OBSERVE facts
 * that already exist (see campaign-eligibility.js).
 *
 * TOKENS. The app bearer token is `X_BEARER_TOKEN` (name only — the value is
 * never logged or echoed). A user token is passed in by the caller and never
 * logged either.
 */
import { attr } from './index.js';

const API_BASE = () => process.env.X_API_BASE || 'https://api.twitter.com/2';
export const X_COST_PER_USER_USD = 0.01;

/** Every profile field a rule can read, asked for in ONE request. */
export const PROFILE_FIELDS = [
  'public_metrics', 'created_at', 'verified', 'verified_type', 'verified_followers_count',
  'is_identity_verified', 'parody', 'protected', 'profile_image_url', 'description',
].join(',');

export const appBearerConfigured = () => !!process.env.X_BEARER_TOKEN;

const numeric = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v) => (typeof v === 'boolean' ? v : null);

/** A v2 user object → attribute records. Shared by both profile reads. */
export function recordsFromUser(me, { log = console } = {}) {
  const m = me.public_metrics || {};
  const at = new Date().toISOString();
  const img = typeof me.profile_image_url === 'string' ? me.profile_image_url : null;
  const vfc = numeric(me.verified_followers_count) ?? numeric(m.verified_followers_count);
  return [
    attr('followersCount', numeric(m.followers_count), 'x-api', { fetchedAt: at, log }),
    attr('followingCount', numeric(m.following_count), 'x-api', { fetchedAt: at, log }),
    attr('postCount', numeric(m.tweet_count), 'x-api', { fetchedAt: at, log }),
    attr('listedCount', numeric(m.listed_count), 'x-api', { fetchedAt: at, log }),
    attr('accountCreatedAt', me.created_at ? String(me.created_at) : null, 'x-api', { fetchedAt: at, log }),
    attr('verified', bool(me.verified), 'x-api', { fetchedAt: at, log }),
    attr('verifiedType', typeof me.verified_type === 'string' ? me.verified_type : null, 'x-api', { fetchedAt: at, log }),
    attr('verifiedFollowersCount', vfc, 'x-api', { fetchedAt: at, log }),
    attr('identityVerified', bool(me.is_identity_verified), 'x-api', { fetchedAt: at, log }),
    attr('parody', bool(me.parody), 'x-api', { fetchedAt: at, log }),
    attr('protected', bool(me.protected), 'x-api', { fetchedAt: at, log }),
    // X serves a stock egg/silhouette from default_profile_images/ to anyone
    // who never uploaded a photo; that is "no profile image".
    attr('hasProfileImage', img == null ? null : !/default_profile_images/.test(img), 'x-api', { fetchedAt: at, log }),
    attr('hasDescription', typeof me.description === 'string' ? me.description.trim().length > 0 : null, 'x-api', { fetchedAt: at, log }),
  ].filter(Boolean);
}

/** GET /2/users/me with every profile field, in one request (link time). */
export async function fetchAttributes({ accessToken, log = console } = {}) {
  if (!accessToken) return { ok: false, records: [], error: 'not-configured' };
  const url = `${API_BASE()}/users/me?user.fields=${encodeURIComponent(PROFILE_FIELDS)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    log.warn?.(`[attestation:x-api] users/me ${r.status} ${body.slice(0, 160)}`);
    return { ok: false, records: [], error: `http_${r.status}` };
  }
  const me = (await r.json())?.data;
  if (!me) return { ok: false, records: [], error: 'no-data' };
  return { ok: true, records: recordsFromUser(me, { log }), error: null, user: { id: String(me.id || ''), username: me.username || null } };
}

/** GET /2/users/:id with the app bearer token. $0.01. */
export async function fetchUserById({ userId, log = console } = {}) {
  const bearer = process.env.X_BEARER_TOKEN;
  if (!bearer) return { ok: false, records: [], error: 'not-configured', costUsd: 0 };
  if (!/^\d{1,20}$/.test(String(userId || ''))) return { ok: false, records: [], error: 'bad-id', costUsd: 0 };
  try {
    const r = await fetch(`${API_BASE()}/users/${userId}?user.fields=${encodeURIComponent(PROFILE_FIELDS)}`, {
      headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      log.warn?.(`[attestation:x-api] users/:id ${r.status}`);
      return { ok: false, records: [], error: `http_${r.status}`, costUsd: 0 };
    }
    const me = (await r.json())?.data;
    if (!me) return { ok: false, records: [], error: 'no-data', costUsd: 0 };
    return { ok: true, records: recordsFromUser(me, { log }), error: null, costUsd: X_COST_PER_USER_USD,
      user: { id: String(me.id), username: me.username || null, followingCount: me.public_metrics?.following_count ?? null } };
  } catch (e) {
    return { ok: false, records: [], error: e.name === 'TimeoutError' ? 'timeout' : 'network', costUsd: 0 };
  }
}

/** GET /2/users/by/username/:u with the app bearer token. $0.01. */
export async function fetchUserByUsername({ username, log = console } = {}) {
  const bearer = process.env.X_BEARER_TOKEN;
  if (!bearer) return { ok: false, error: 'not-configured', costUsd: 0 };
  const u = String(username || '').replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(u)) return { ok: false, error: 'bad-username', costUsd: 0 };
  try {
    const r = await fetch(`${API_BASE()}/users/by/username/${u}?user.fields=public_metrics`, {
      headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) { log.warn?.(`[attestation:x-api] users/by/username ${r.status}`); return { ok: false, error: `http_${r.status}`, costUsd: 0 }; }
    const d = (await r.json())?.data;
    if (!d) return { ok: false, error: 'no-data', costUsd: 0 };
    return { ok: true, costUsd: X_COST_PER_USER_USD,
      user: { id: String(d.id), username: d.username, followingCount: d.public_metrics?.following_count ?? null, followersCount: d.public_metrics?.followers_count ?? null } };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'timeout' : 'network', costUsd: 0 };
  }
}

/** GET /2/lists/:id with member_count, app bearer. Treated as one lookup. */
export async function fetchList({ listId, log = console } = {}) {
  const bearer = process.env.X_BEARER_TOKEN;
  if (!bearer) return { ok: false, error: 'not-configured', costUsd: 0 };
  if (!/^\d{1,20}$/.test(String(listId || ''))) return { ok: false, error: 'bad-id', costUsd: 0 };
  try {
    const r = await fetch(`${API_BASE()}/lists/${listId}?list.fields=member_count`, {
      headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) { log.warn?.(`[attestation:x-api] lists/:id ${r.status}`); return { ok: false, error: `http_${r.status}`, costUsd: 0 }; }
    const d = (await r.json())?.data;
    if (!d) return { ok: false, error: 'no-data', costUsd: 0 };
    return { ok: true, costUsd: X_COST_PER_USER_USD, list: { id: String(d.id), name: d.name || null, memberCount: d.member_count ?? null } };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'timeout' : 'network', costUsd: 0 };
  }
}

/**
 * One page of a user list. `kind` is 'following' | 'followers' |
 * 'list-members'. Bearer is the app token unless `accessToken` is given.
 * Returns the ids and usernames only — nothing else is read or kept — plus
 * the rate-limit reset when X answers 429.
 */
export async function pageUsers({ kind, id, maxResults = 1000, paginationToken = null, accessToken = null, log = console } = {}) {
  const bearer = accessToken || process.env.X_BEARER_TOKEN;
  if (!bearer) return { ok: false, users: [], error: 'not-configured', costUsd: 0 };
  if (!/^\d{1,20}$/.test(String(id || ''))) return { ok: false, users: [], error: 'bad-id', costUsd: 0 };
  const path = kind === 'list-members' ? `lists/${id}/members` : kind === 'followers' ? `users/${id}/followers` : `users/${id}/following`;
  const cap = kind === 'list-members' ? 100 : 1000;
  const n = Math.max(1, Math.min(cap, Math.floor(maxResults)));
  const qs = new URLSearchParams({ max_results: String(n) });
  if (paginationToken) qs.set('pagination_token', paginationToken);
  try {
    const r = await fetch(`${API_BASE()}/${path}?${qs}`, { headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(15000) });
    if (r.status === 429) {
      const reset = Number(r.headers.get('x-rate-limit-reset')) || null;
      return { ok: false, users: [], error: 'rate_limited', resetAt: reset ? reset * 1000 : null, costUsd: 0 };
    }
    if (!r.ok) { log.warn?.(`[attestation:x-api] ${path} ${r.status}`); return { ok: false, users: [], error: `http_${r.status}`, costUsd: 0 }; }
    const body = await r.json();
    const users = (body?.data || []).map((u) => ({ id: String(u.id), username: u.username || null })).filter((u) => /^\d{1,20}$/.test(u.id));
    return { ok: true, users, nextToken: body?.meta?.next_token || null, costUsd: users.length * X_COST_PER_USER_USD, error: null };
  } catch (e) {
    return { ok: false, users: [], error: e.name === 'TimeoutError' ? 'timeout' : 'network', costUsd: 0 };
  }
}

/**
 * A TOKEN HOLDER looks up `ids` (≤100) with user.fields=connection_status.
 * For each id: `following` true means the token holder follows that user —
 * the relationship a followedByFromSet rule counts. (`followed_by` is the
 * other direction: that user follows the token holder. Counting it would let
 * an applicant qualify by following people, which is paying for a follow.)
 * $0.01 per user returned.
 */
export async function lookupConnection({ accessToken, ids = [], log = console } = {}) {
  if (!accessToken) return { ok: false, byId: {}, error: 'no-token', costUsd: 0 };
  const clean = ids.map(String).filter((x) => /^\d{1,20}$/.test(x)).slice(0, 100);
  if (!clean.length) return { ok: true, byId: {}, error: null, costUsd: 0 };
  try {
    const r = await fetch(`${API_BASE()}/users?ids=${clean.join(',')}&user.fields=connection_status`, {
      headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(8000),
    });
    if (r.status === 401) return { ok: false, byId: {}, error: 'token_expired', costUsd: 0 };
    if (!r.ok) { log.warn?.(`[attestation:x-api] users?ids ${r.status}`); return { ok: false, byId: {}, error: `http_${r.status}`, costUsd: 0 }; }
    const body = await r.json();
    const byId = {};
    for (const u of body?.data || []) {
      const cs = Array.isArray(u.connection_status) ? u.connection_status : [];
      byId[String(u.id)] = { following: cs.includes('following'), followedBy: cs.includes('followed_by') };
    }
    return { ok: true, byId, error: null, costUsd: Object.keys(byId).length * X_COST_PER_USER_USD };
  } catch (e) {
    return { ok: false, byId: {}, error: e.name === 'TimeoutError' ? 'timeout' : 'network', costUsd: 0 };
  }
}
