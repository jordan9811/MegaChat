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
