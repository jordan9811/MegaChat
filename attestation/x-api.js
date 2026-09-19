/**
 * X (Twitter) API v2 — one profile lookup per link, and nothing else.
 *
 * COST. The X API is pay-per-use against prepaid credits: no subscription
 * tier, no free tier, and user reads are billed per resource returned
 * (docs.x.com, "Pricing — The X API uses pay-per-usage pricing… Credit-based:
 * purchase credits upfront"). This adapter therefore makes exactly ONE call,
 * at link time and on an explicit refresh, and asks for the fields in that
 * same call rather than following up. It never reads follower or following
 * LISTS — those are per-page charges for data this app has decided not to
 * store at all (see the data-model page's "deliberately absent" list).
 *
 * AUTH. The user's own OAuth access token from the link round trip. No app
 * bearer token is required and none is stored; the token is used once and
 * dropped.
 */
import { attr } from './index.js';

const API_BASE = () => process.env.X_API_BASE || 'https://api.twitter.com/2';

/** GET /2/users/me with the profile fields, in one request. */
export async function fetchAttributes({ accessToken, log = console } = {}) {
  if (!accessToken) return { ok: false, records: [], error: 'not-configured' };
  const url = `${API_BASE()}/users/me?user.fields=${encodeURIComponent('public_metrics,created_at,verified,verified_type')}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    log.warn?.(`[attestation:x-api] users/me ${r.status} ${body.slice(0, 160)}`);
    return { ok: false, records: [], error: `http_${r.status}` };
  }
  const me = (await r.json())?.data;
  if (!me) return { ok: false, records: [], error: 'no-data' };
  const m = me.public_metrics || {};
  const at = new Date().toISOString();
  const records = [
    attr('followersCount', numeric(m.followers_count), 'x-api', { fetchedAt: at, log }),
    attr('followingCount', numeric(m.following_count), 'x-api', { fetchedAt: at, log }),
    attr('postCount', numeric(m.tweet_count), 'x-api', { fetchedAt: at, log }),
    attr('listedCount', numeric(m.listed_count), 'x-api', { fetchedAt: at, log }),
    attr('accountCreatedAt', me.created_at ? String(me.created_at) : null, 'x-api', { fetchedAt: at, log }),
    attr('verified', typeof me.verified === 'boolean' ? me.verified : null, 'x-api', { fetchedAt: at, log }),
  ].filter(Boolean);
  return { ok: true, records, error: null };
}

const numeric = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
