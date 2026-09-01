/**
 * TWITCH HELIX — minimal server-side client for the two reads the bounty
 * program needs: is this channel live, and how many people are watching.
 *
 * Uses the app's own client-credentials token (TWITCH_CLIENT_ID/SECRET),
 * cached until shortly before expiry. Null-object when unconfigured: every
 * call resolves `null` and nothing downstream may treat that as "offline" —
 * "we could not ask" and "nobody is watching" are different facts, the same
 * distinction the boot reconciliation learned the hard way.
 */

// Overridable for tests, exactly like MODERATION_API_BASE — the default is
// always the real host and nothing in production sets these.
const ID_BASE = () => (process.env.TWITCH_ID_BASE || 'https://id.twitch.tv').replace(/\/$/, '');
const API_BASE = () => (process.env.TWITCH_API_BASE || 'https://api.twitch.tv').replace(/\/$/, '');

let cached = { token: null, expiresAt: 0 };

export const twitchApiConfigured = () =>
  !!(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET);

async function appToken() {
  if (cached.token && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const r = await fetch(`${ID_BASE()}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`twitch token ${r.status}`);
  const j = await r.json();
  cached = { token: j.access_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 };
  return cached.token;
}

/** Generic Helix GET with the cached app token — VOD discovery and user
 *  lookup ride this. Throws on HTTP errors; callers classify. */
export async function helix(pathAndQuery) {
  const token = await appToken();
  const r = await fetch(`${API_BASE()}/helix${pathAndQuery}`, {
    headers: { 'Client-Id': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`helix ${pathAndQuery.split('?')[0]} ${r.status}`);
  return r.json();
}

/**
 * Public profile images for up to 100 logins in ONE Helix call.
 *
 * WE DO NOT NEED THE STREAMER'S CREDENTIALS. `/helix/users` is public data
 * read with OUR app token, so a bountied channel that has never heard of us
 * still has a face on the leaderboard.
 *
 * The batching is the point: a leaderboard of 40 pools is one request, not
 * 40. Helix caps `login` at 100 per call — callers chunk.
 *
 * @returns {Promise<Map<string,string>|null>} login (lowercased) → image URL.
 *   null means "we could not ask" (unconfigured, HTTP error, timeout). A login
 *   ABSENT from a non-null map is a genuine miss — no such channel — and the
 *   two must not be conflated: one is worth retrying in a minute, the other
 *   is worth remembering for hours.
 */
export async function getProfileImagesByLogin(logins, { log = console } = {}) {
  if (!twitchApiConfigured()) return null;
  const list = [...new Set(
    (logins || []).map((l) => String(l || '').trim().replace(/^@/, '').toLowerCase()).filter(Boolean),
  )].slice(0, 100);
  if (!list.length) return new Map();
  try {
    const j = await helix(`/users?${list.map((l) => `login=${encodeURIComponent(l)}`).join('&')}`);
    const out = new Map();
    for (const u of j.data || []) {
      if (u?.login && u.profile_image_url) out.set(String(u.login).toLowerCase(), u.profile_image_url);
    }
    return out;
  } catch (e) {
    log.warn(`[twitch-api] profile image lookup failed (${list.length} logins): ${e.message}`);
    return null; // "could not ask", never "no such channel"
  }
}

/**
 * @returns {Promise<{live: boolean, viewerCount: number|null, startedAt: string|null}|null>}
 *   null when unconfigured or the API could not be asked.
 */
export async function getStreamByLogin(login, { log = console } = {}) {
  if (!twitchApiConfigured() || !login) return null;
  try {
    const token = await appToken();
    const r = await fetch(
      `${API_BASE()}/helix/streams?user_login=${encodeURIComponent(String(login).toLowerCase())}`,
      {
        headers: { 'Client-Id': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!r.ok) throw new Error(`helix streams ${r.status}`);
    const s = (await r.json()).data?.[0] || null;
    return s
      ? { live: true, viewerCount: Number(s.viewer_count) || 0, startedAt: s.started_at || null }
      : { live: false, viewerCount: 0, startedAt: null };
  } catch (e) {
    log.warn(`[twitch-api] stream lookup failed for ${login}: ${e.message}`);
    return null; // "could not ask", never "offline"
  }
}
