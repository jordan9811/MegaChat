/**
 * PUMP.FUN LIVESTREAM API — live status, viewers, broadcast start, AND the
 * playlist URL, all from a mint address.
 *
 * ── This supersedes two earlier, wronger filings ──────────────────────────
 * The platform-feasibility note said pump.fun stream discovery was
 * "undocumented, reverse-engineered from traffic, not something to put a
 * payout behind", and PumpFunFrameSource refused a coin-page URL because the
 * mint → playlist mapping was believed to need the frontend API's private
 * surfaces. Both were written from the /coins/currently-live listing, which is
 * indeed a scraped surface.
 *
 * MEASURED 2026-08-26, and it is a different endpoint entirely:
 *
 *   GET https://livestream-api.pump.fun/livestream?mintId=<mint>
 *
 * returns, with no auth, no cookie and no referer:
 *
 *   { id, mintId, creatorAddress, streamStartTimestamp, numParticipants,
 *     isLive, thumbnail, title, mode }
 *
 * That is a complete live-status feed — the same three facts Twitch's Helix
 * and Kick's channels endpoint give us — plus two things neither gives:
 *
 *  1. `thumbnail` encodes the STREAM DIRECTORY:
 *       https://clips.pump.fun/<mint>/<id>_<YYYYMMDD>_<HHMMSS>/thumb.jpg
 *     and the HLS master sits beside it as master_playlist_<stamp>.m3u8.
 *     So the playlist is DERIVED, not discovered — verified end to end against
 *     a live stream: the derived URL returned a real 1080p60/720p30/360p20
 *     master. No scraping, no private API, no guessing.
 *
 *  2. `creatorAddress` is the wallet that created the mint — the on-chain
 *     identity a pump.fun ownership check would compare against. It does NOT
 *     by itself prove the claimant CONTROLS that wallet; that still needs a
 *     signature over a server nonce, which only the human can produce in their
 *     own wallet. But it is the other half of that check, and it is free.
 *
 * ── `live` DOES NOT MEAN "PUBLISHING". READ `playlistUrl` FOR THAT ──────────
 * MEASURED 2026-08-27, and it is the sharpest edge on this endpoint: an
 * ffmpeg push ABORTED AT THE TLS LAYER, which never delivered a single frame,
 * still flipped `isLive` true within seconds — with no media directory and so
 * no derivable playlist. This flag tracks INGRESS STATE, not content. Twitch's
 * Helix and Kick's channels endpoint do not behave this way, so code ported
 * from either will be wrong here.
 *
 * Anything gating on "is the streamer actually broadcasting" — opening an air
 * session, starting a capture, deciding a session is worth verifying — must
 * require `playlistUrl`, not `live`. A session opened on the flag alone can
 * run a whole clip schedule against a stream publishing nothing and verify
 * 0/5, which reads exactly like a capture bug and is not one.
 *
 * Still true, and worth keeping in view: this host is not publicly documented.
 * It is a far smaller and more stable surface than the scraped listing — one
 * GET keyed by a mint — but it can change without notice, so treat a shape
 * change as "could not ask", never as "not live".
 *
 * Null-object when unreachable — "we could not ask" and "nobody is watching"
 * stay different facts.
 */

const API_BASE = () => (process.env.PUMPFUN_API_BASE || 'https://livestream-api.pump.fun').replace(/\/$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

/** Always available: the endpoint needs no credential of ours. */
export const pumpfunApiConfigured = () => true;

/**
 * The HLS master playlist for a stream, derived from its thumbnail URL.
 *
 * Exported and pure so the derivation is unit-testable without a network call
 * — it is the one piece of string surgery standing between a mint address and
 * verifiable frames, and it should never be guessed at again.
 *
 * @param {string} thumbnail e.g. https://clips.pump.fun/<mint>/<id>_<stamp>/thumb.jpg
 * @returns {string|null} the master playlist URL, or null if the shape changed.
 */
export function playlistFromThumbnail(thumbnail) {
  const t = String(thumbnail || '').trim();
  if (!t) return null;
  const dir = t.replace(/\/[^/]*$/, '');
  const folder = dir.split('/').pop() || '';
  // "<streamId>_<YYYYMMDD>_<HHMMSS>" — the stamp is everything after the id.
  const m = /^\d+_(\d{8}_\d{6})$/.exec(folder);
  if (!m) return null;
  return `${dir}/master_playlist_${m[1]}.m3u8`;
}

/**
 * Live status + viewers + start + playlist for one mint.
 *
 * @returns {Promise<{live:boolean, viewerCount:number, startedAt:string|null,
 *   title:string|null, creatorAddress:string|null, playlistUrl:string|null,
 *   streamId:number|null}|null>} null when unreachable or no such stream.
 */
export async function getStreamByMint(mint, { log = console } = {}) {
  if (!mint) return null;
  try {
    const r = await fetch(`${API_BASE()}/livestream?mintId=${encodeURIComponent(mint)}`, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      log.warn?.(`[pumpfun-api] livestream ${r.status} for ${String(mint).slice(0, 12)}…`);
      return null;
    }
    /**
     * OFFLINE IS AN EMPTY 200, AND THAT IS NOT THE SAME AS "COULD NOT ASK".
     *
     * MEASURED 2026-08-27, watching a real stream end: this endpoint does NOT
     * return 404, and it does NOT return `isLive: false`. It returns HTTP 200
     * with a COMPLETELY EMPTY BODY. Calling .json() on that throws, which the
     * catch below turned into null — collapsing "nobody is streaming" into
     * "we could not reach the API", the exact two facts this file's header
     * promises to keep apart.
     *
     * It matters in both directions. A watcher waiting for live === false
     * waits forever, because null never equals false; and a payout path that
     * reads null as offline would treat an API outage as proof the streamer
     * was not there. Reporting a real offline object fixes the first without
     * creating the second: a genuine failure still returns null below.
     */
    const text = await r.text();
    if (!text.trim()) {
      return {
        live: false, viewerCount: 0, startedAt: null, title: null,
        creatorAddress: null, playlistUrl: null, streamId: null,
      };
    }
    let j = null;
    try { j = JSON.parse(text); } catch {
      // A NON-empty body we cannot parse is a shape change, not an answer.
      log.warn?.(`[pumpfun-api] unparseable body for ${String(mint).slice(0, 12)}…`);
      return null;
    }
    if (!j || !j.mintId) return null;
    const startMs = Number(j.streamStartTimestamp);
    return {
      live: j.isLive === true,
      viewerCount: Number(j.numParticipants) || 0,
      startedAt: Number.isFinite(startMs) && startMs > 0 ? new Date(startMs).toISOString() : null,
      title: j.title || null,
      creatorAddress: j.creatorAddress || null,
      playlistUrl: playlistFromThumbnail(j.thumbnail),
      streamId: Number(j.id) || null,
    };
  } catch (e) {
    log.warn?.(`[pumpfun-api] could not ask (${e?.name || 'Error'})`);
    return null;
  }
}
