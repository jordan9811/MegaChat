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
 * Public profile picture for a channel, WITHOUT the streamer's credentials.
 *
 * SHAPE CONFIRMED BY REAL CALLS (2026-09-01), not guessed from docs:
 *   GET /public/v1/channels?slug=xqc  → { data: [{ broadcaster_user_id: 676,
 *       slug, channel_description, banner_picture, stream{…}, category{…} }] }
 *   THE CHANNELS ROW CARRIES NO PROFILE PICTURE. `banner_picture` is the
 *   channel banner and `stream.thumbnail` is a live-stream still; neither is
 *   a face, and substituting one would look like a bug, not a fallback.
 *   GET /public/v1/users?id=676       → { data: [{ user_id, name, email,
 *       profile_picture }] }
 * So it takes two hops: slug → broadcaster_user_id → profile_picture.
 * Verified on xqc/trainwreckstv/adinross that the users row echoes the id we
 * asked for (not the token owner), that an unknown slug is HTTP 200 with an
 * EMPTY data array, and that `email` comes back empty under an app token.
 * NOTE `?id[]=676` returns zero rows — the working spelling is `?id=`.
 *
 * Only the picture is read out of that row. The users response also carries
 * an email field and the channels response carries stream credentials; both
 * stay inside this function and are never returned, cached, or logged.
 *
 * @returns {Promise<{url: string|null}|null>}
 *   null            — we could not ask (unconfigured, HTTP error, timeout).
 *   { url: null }   — we asked: no such channel, or no picture set.
 *   { url: string } — found.
 *   The distinction is the caller's whole caching policy, so it is a shape
 *   rather than a bare null.
 */
export async function getProfilePictureBySlug(slug, { log = console } = {}) {
  if (!kickApiConfigured() || !slug) return null;
  try {
    const token = await appToken();
    const headers = { Authorization: `Bearer ${token}` };
    const cr = await fetch(
      `${API_BASE()}/channels?slug=${encodeURIComponent(String(slug).toLowerCase())}`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
    if (!cr.ok) throw new Error(`kick channels ${cr.status}`);
    const id = (await cr.json()).data?.[0]?.broadcaster_user_id;
    if (!id) return { url: null }; // asked and answered: no such channel
    const ur = await fetch(`${API_BASE()}/users?id=${encodeURIComponent(id)}`, {
      headers, signal: AbortSignal.timeout(10_000),
    });
    if (!ur.ok) throw new Error(`kick users ${ur.status}`);
    const row = (await ur.json()).data?.[0];
    // Defend the id echo: if Kick ever answers with a different user, that is
    // someone else's face on this streamer's pool. Refuse it.
    if (!row || Number(row.user_id) !== Number(id)) return { url: null };
    const url = typeof row.profile_picture === 'string' ? row.profile_picture.trim() : '';
    // A streamer who never set a picture gets Kick's own placeholder
    // (kick.com/img/default-profile-pictures/default-avatar-N.webp). That is
    // an answer, but it is not a face — served as-is it puts a grey stranger
    // from Kick's asset folder on the pool. Treat it as "no picture" so the
    // caller falls through to our monogram, which is at least keyed to the
    // handle and wears our own skin.
    const isPlaceholder = /\/default-profile-pictures\//.test(url);
    return { url: /^https:\/\//.test(url) && !isPlaceholder ? url : null };
  } catch (e) {
    log.warn(`[kick-api] profile picture lookup failed for ${slug}: ${e.message}`);
    return null; // "could not ask", never "no picture"
  }
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
