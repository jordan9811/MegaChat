/**
 * RUMBLE LIVE STREAM API — live status + concurrent viewers for a creator.
 *
 * ── The credential is a URL, and that is worth staring at ─────────────────
 * Rumble's free Live Stream API works nothing like Twitch's or Kick's: the
 * CREATOR generates a URL in their dashboard that embeds their own id and
 * key, and anyone holding that URL can read their live status. So possession
 * of the URL is simultaneously:
 *
 *   1. the live-status feed (what this module reads), and
 *   2. OWNERSHIP PROOF — only the channel owner can mint it.
 *
 * Say the sharp part plainly: possession is TRANSFERABLE in a way OAuth is
 * not. A streamer can paste it in chat, an assistant can walk off with it, a
 * leaked .env exposes it — and the holder "is" the channel until the creator
 * regenerates the URL. Anything that treats this URL as identity must treat
 * it like a bearer token: store it like a secret, show it to nobody, and let
 * the streamer revoke by regenerating. That design decision belongs to the
 * claim layer and is deliberately NOT made here — this module only reads.
 *
 * Configured EITHER by env (RUMBLE_LIVESTREAM_API_URL — single-tenant
 * rehearsals) or per call ({ apiUrl }) for the future per-claim path.
 *
 * ── Response shape: designed from docs, not yet proven on the wire ────────
 * The parse below expects { livestreams: [{ is_live, watching_now,
 * created_on, ... }] } and tolerates the field variants Rumble's docs and
 * examples disagree on (is_live/live, watching_now/viewers). The stub gate
 * encodes this ASSUMPTION; the first real creator URL is the test that
 * counts, and until one runs this module is shipped-unproven exactly like
 * Kick was.
 *
 * Null-object when unconfigured or unreachable — "we could not ask" and
 * "nobody is watching" stay different facts.
 */

export const rumbleApiConfigured = () => !!process.env.RUMBLE_LIVESTREAM_API_URL;

/**
 * ⚠ THE FIELDS WE DELIBERATELY DO NOT RETURN, AND WHY ⚠
 *
 * MEASURED ON THE REAL WIRE 2026-08-26 (not inferred): every entry in
 * `livestreams` carries the channel's INGEST CREDENTIALS in plaintext —
 *
 *     "server_url": "rtmp://ls__.live.rmbl.ws/slot-__",
 *     "stream_key": "____-____-____"
 *
 * So the creator's API URL is not a read token. Whoever holds it can BROADCAST
 * AS THAT CHANNEL. That is a strictly larger power than "check if they are
 * live", and it changes the threat model this module was written under: the
 * header above says possession is transferable, which was right and far too
 * mild.
 *
 * The allowlist below is therefore a SECURITY BOUNDARY, not tidiness. Four
 * scalar fields are copied out by name; the raw response is never returned,
 * never logged, never persisted, and goes out of scope here. Do not "just log
 * the body" to debug this — one such line publishes a broadcast credential to
 * wherever logs go.
 *
 * The URL itself is equally sensitive: nothing derived from it (including
 * error messages that might embed it) may reach a log.
 *
 * @param {object} [opts]
 * @param {string} [opts.apiUrl] creator-generated URL; defaults to the env.
 * @returns {Promise<{live:boolean, viewerCount:number, startedAt:string|null,
 *   title:string|null}|null>} null when unconfigured/unreachable.
 */
export async function getRumbleLiveStatus({ apiUrl, log = console } = {}) {
  const url = apiUrl || process.env.RUMBLE_LIVESTREAM_API_URL || '';
  if (!url) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) {
      log.warn?.(`[rumble-api] live-stream api ${r.status}`);
      return null;
    }
    const j = await r.json();
    const streams = Array.isArray(j?.livestreams) ? j.livestreams : [];
    // The API returns every recent livestream; the one that matters is the
    // one that is live NOW. None live is a real answer, not a failure.
    const liveNow = streams.find((s) => s?.is_live === true || s?.live === true) || null;
    if (!liveNow) return { live: false, viewerCount: 0, startedAt: null, title: null };
    // Copied field by field, by name. Never spread the source object.
    return {
      live: true,
      viewerCount: Number(liveNow.watching_now ?? liveNow.viewers ?? 0) || 0,
      startedAt: liveNow.created_on || liveNow.started_on || null,
      title: liveNow.title || null,
    };
  } catch (e) {
    // NOT e.message: a fetch failure can carry the request URL, and that URL is
    // the broadcast credential. The error name is enough to tell "unreachable"
    // from "malformed", which is all this log ever needed to say.
    log.warn?.(`[rumble-api] could not ask (${e?.name || 'Error'})`);
    return null;
  }
}
