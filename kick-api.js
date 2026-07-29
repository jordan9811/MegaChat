/**
 * KICK API — the two server-side reads the bounty program needs: is this
 * channel live, and how many people are watching. Mirror of twitch-api.js.
 *
 * App access token via client credentials (public channel data must not
 * depend on a user token staying fresh), cached until shortly before expiry.
 *
 * THE HOSTS DIFFER: tokens come from id.kick.com, data comes from
 * api.kick.com. Both overridable for tests, defaults always the real hosts.
 *
 * Null-object when unconfigured or unreachable — "we could not ask" and
 * "nobody is watching" are different facts and nothing downstream may
 * conflate them.
 */

const ID_BASE = () => (process.env.KICK_ID_BASE || process.env.KICK_AUTH_BASE?.replace(/\/oauth$/, '') || 'https://id.kick.com').replace(/\/$/, '');
const API_BASE = () => (process.env.KICK_API_BASE || 'https://api.kick.com/public/v1').replace(/\/$/, '');

let cached = { token: null, expiresAt: 0 };

export const kickApiConfigured = () =>
  !!(process.env.KICK_CLIENT_ID && process.env.KICK_CLIENT_SECRET);

async function appToken() {
  if (cached.token && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const r = await fetch(`${ID_BASE()}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.KICK_CLIENT_ID,
      client_secret: process.env.KICK_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`kick token ${r.status}`);
  const j = await r.json();
  cached = { token: j.access_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 };
  return cached.token;
}

/**
 * Live status + concurrent viewers in one call — Kick's channels endpoint
 * returns both on the embedded `stream` object.
 *
 * @returns {Promise<{live: boolean, viewerCount: number, startedAt: string|null}|null>}
 *   null when unconfigured or the API could not be asked.
 */
export async function getChannelBySlug(slug, { log = console } = {}) {
  if (!kickApiConfigured() || !slug) return null;
  try {
    const token = await appToken();
    const r = await fetch(
      `${API_BASE()}/channels?slug=${encodeURIComponent(String(slug).toLowerCase())}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!r.ok) throw new Error(`kick channels ${r.status}`);
    const ch = (await r.json()).data?.[0] || null;
    if (!ch) return { live: false, viewerCount: 0, startedAt: null };
    // Kick has shipped this sub-object under both `stream` and `livestream`
    // across API revisions, and the live flag as is_live / isLive. Reading
    // only one spelling silently reports every channel offline — which is
    // indistinguishable from a quiet night, so it must not be guessed at.
    const stream = ch.stream || ch.livestream || {};
    const live = stream.is_live ?? stream.isLive ?? ch.is_live ?? false;
    const viewers = stream.viewer_count ?? stream.viewerCount ?? stream.viewers ?? 0;
    return {
      live: !!live,
      viewerCount: Number(viewers) || 0,
      startedAt: stream.start_time || stream.startTime || null,
      // Shape actually observed, for diagnostics — never any credential.
      _shape: { keys: Object.keys(ch), streamKeys: Object.keys(stream) },
    };
  } catch (e) {
    log.warn(`[kick-api] channel lookup failed for ${slug}: ${e.message}`);
    return null; // "could not ask", never "offline"
  }
}
