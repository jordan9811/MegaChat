/**
 * YOUTUBE DATA API — the one server-side read the bounty program needs:
 * is this VIDEO live right now, since when, and for how many viewers.
 * Mirror of twitch-api.js / kick-api.js in shape and in honesty rules.
 *
 * ── The quota shape, stated so nobody "optimises" this into a search ──────
 * We never hunt for a stream. The streamer opens an air session and hands us
 * their WATCH URL, so every call here is `videos.list` on a KNOWN id —
 * 1 quota unit against the free 10,000/day. A `search.list` costs 100 units
 * and answers a question we never ask. If this file ever grows a search call,
 * that is the wrong fix for whatever prompted it.
 *
 * Null-object when unconfigured or unreachable — "we could not ask" and
 * "nobody is watching" are different facts and nothing downstream may
 * conflate them.
 */

const API_BASE = () => (process.env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3').replace(/\/$/, '');

export const youtubeApiConfigured = () => !!process.env.YOUTUBE_API_KEY;

/**
 * The video id out of any of the URL shapes a streamer will actually paste.
 * Returns null rather than guessing — a wrong id would make us verify
 * somebody else's broadcast.
 */
export function extractVideoId(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  // A bare 11-char id pasted on its own.
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  let u;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.split('/').filter(Boolean)[0] || '';
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }
  if (host === 'youtube.com') {
    const v = u.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    const parts = u.pathname.split('/').filter(Boolean);
    // /live/<id> and /shorts/<id> both address a single video.
    if ((parts[0] === 'live' || parts[0] === 'shorts') && /^[A-Za-z0-9_-]{11}$/.test(parts[1] || '')) {
      return parts[1];
    }
  }
  return null;
}

/**
 * Live status + viewers + the broadcast start for one KNOWN video id.
 *
 * The same id is the live stream while it airs and the archive after — which
 * is what makes YouTube's VOD path unusually clean: no discovery step, the
 * watch URL the streamer handed us at session open is also the replay.
 *
 * @returns {Promise<{live:boolean, viewerCount:number, startedAt:string|null,
 *   endedAt:string|null, title:string|null}|null>} null when unconfigured,
 *   unreachable, or the video does not exist.
 */
export async function getVideoLiveDetails(videoId, { log = console } = {}) {
  if (!youtubeApiConfigured() || !videoId) return null;
  try {
    const r = await fetch(
      `${API_BASE()}/videos?part=liveStreamingDetails,snippet&id=${encodeURIComponent(videoId)}`
      + `&key=${encodeURIComponent(process.env.YOUTUBE_API_KEY)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!r.ok) {
      log.warn?.(`[youtube-api] videos.list ${r.status} for ${videoId}`);
      return null;
    }
    const j = await r.json();
    const item = j?.items?.[0];
    if (!item) return null; // deleted/private/nonexistent — could not observe
    const d = item.liveStreamingDetails || {};
    // liveBroadcastContent: 'live' | 'upcoming' | 'none'. actualEndTime set
    // means the broadcast is over even if a cache still says 'live'.
    const live = item.snippet?.liveBroadcastContent === 'live' && !d.actualEndTime;
    return {
      live,
      viewerCount: Number(d.concurrentViewers) || 0,
      startedAt: d.actualStartTime || null,
      endedAt: d.actualEndTime || null,
      title: item.snippet?.title || null,
    };
  } catch (e) {
    log.warn?.(`[youtube-api] could not ask: ${e.message}`);
    return null;
  }
}
