/**
 * Twitch Helix — the user endpoint, plus the follower TOTAL when the token
 * happens to carry the scope for it.
 *
 * SCOPE. `GET /helix/users` needs no scope beyond the login we already did,
 * and carries account age, broadcaster type and view count.
 * `GET /helix/channels/followers` returns a `total` but requires
 * `moderator:read:followers`; this app's OAuth asks for NO scopes (auth.js:
 * "identity comes from /users with the app token"), so that call is attempted
 * and its failure is normal, not an error. Adding the scope would change what
 * the consent screen says at sign-in, which the design constraint forbids —
 * an important person connecting an account must see nothing beyond the round
 * trip they are already in.
 *
 * So: a Twitch link reliably carries age, broadcaster type and view count, and
 * carries a follower count only when Twitch volunteers it. The classifier is
 * written to work without it.
 */
import { attr } from './index.js';

const API_BASE = () => process.env.TWITCH_API_BASE || 'https://api.twitch.tv/helix';

export async function fetchAttributes({ accessToken, platformId, log = console } = {}) {
  if (!accessToken) return { ok: false, records: [], error: 'not-configured' };
  const clientId = process.env.TWITCH_CLIENT_ID || '';
  const headers = { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId };
  const r = await fetch(`${API_BASE()}/users`, { headers });
  if (!r.ok) {
    log.warn?.(`[attestation:twitch-helix] users ${r.status}`);
    return { ok: false, records: [], error: `http_${r.status}` };
  }
  const u = (await r.json())?.data?.[0];
  if (!u) return { ok: false, records: [], error: 'no-data' };
  const at = new Date().toISOString();
  const records = [
    attr('accountCreatedAt', u.created_at ? String(u.created_at) : null, 'twitch-helix', { fetchedAt: at, log }),
    attr('broadcasterType', typeof u.broadcaster_type === 'string' ? u.broadcaster_type : null, 'twitch-helix', { fetchedAt: at, log }),
    attr('viewCount', typeof u.view_count === 'number' ? u.view_count : null, 'twitch-helix', { fetchedAt: at, log }),
    // A partner or affiliate is a Twitch-verified broadcaster; nothing else is.
    attr('verified', u.broadcaster_type === 'partner' ? true : null, 'twitch-helix', { fetchedAt: at, log }),
  ].filter(Boolean);

  // Optional, scope-dependent, and its absence is expected. Never fails the link.
  const id = platformId || u.id;
  if (id) {
    try {
      const fr = await fetch(`${API_BASE()}/channels/followers?broadcaster_id=${encodeURIComponent(id)}&first=1`, { headers });
      if (fr.ok) {
        const total = (await fr.json())?.total;
        const rec = attr('followersCount', typeof total === 'number' ? total : null, 'twitch-helix', { fetchedAt: at, log });
        if (rec) records.push(rec);
      } else {
        log.log?.(`[attestation:twitch-helix] follower total unavailable (${fr.status}) — expected without moderator:read:followers`);
      }
    } catch (err) {
      log.log?.(`[attestation:twitch-helix] follower total unavailable: ${err.message}`);
    }
  }
  return { ok: true, records, error: null };
}
