/**
 * REAL FRAME SOURCES — frames from actual public broadcasts, implementing the
 * verifier's FrameSource contract: getFrames(platform, handle, timestamps[])
 * → [{ ref, ts, clipId, playbackId, platform, handle }], where ref is a local
 * PNG path the OCR checker can decode.
 *
 * VOD-FIRST. The cheap, robust, async path: verification runs after the
 * broadcast, pulling frames from the VOD at the logged playback timestamps.
 * Live spot-check shares every stage except VOD discovery.
 *
 * THE EXTRACTOR IS A SEAM, not a dependency. HLS access to platform media
 * goes through whatever URL-resolving tool is installed (yt-dlp today,
 * streamlink tomorrow, something else when both break — they inevitably do).
 * Nothing outside `resolveMediaUrl` knows which tool ran. Gates NEVER reach
 * this module's network path; they drive the verifier with fixtures.
 *
 * TIMESTAMP TOLERANCE: ±1.5 seconds. Derivation, not vibes: the verifier
 * samples at the MIDPOINT of a code's validity window, and the shortest
 * window is a code clamped to a 3s clip end — midpoint leaves ≥1.5s of code
 * on screen either side. ffmpeg's pre-input seek on HLS is keyframe-then-
 * exact, accurate well under that. Anything worse than ±1.5s risks sampling
 * a rotated-away code and must fail the grab, not fuzz it.
 *
 * FAILURE HONESTY: a VOD deleted, sub-only, not yet processed, or an absent
 * extractor produce a TYPED FrameSourceUnavailable with a distinct state.
 * The verifier maps it to result SOURCE_UNAVAILABLE routed to the review
 *
 queue — never FAIL, because "we could not look" must never cost a streamer
 * money the way "we looked and it was not there" does.
 */
import { spawnSync } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { bountyConfig } from './bounty-claim.config.js';
import { randomUUID } from 'crypto';
import { FrameSource } from './bounty-verifier.js';
import { twitchApiConfigured, helix } from './twitch-api.js';

export const SOURCE_STATES = {
  EXTRACTOR_UNAVAILABLE: 'EXTRACTOR_UNAVAILABLE', // no yt-dlp/streamlink on the host
  NO_VOD_COVERING_TS: 'NO_VOD_COVERING_TS',       // deleted, expired, or never archived
  VOD_SUBSCRIBER_ONLY: 'VOD_SUBSCRIBER_ONLY',
  VOD_NOT_PROCESSED: 'VOD_NOT_PROCESSED',
  CHANNEL_OFFLINE: 'CHANNEL_OFFLINE',             // live grab on a dead channel
  EXTRACTION_FAILED: 'EXTRACTION_FAILED',
  NO_CAPTURE: 'NO_CAPTURE',                        // self-capture missing for this session
  API_UNAVAILABLE: 'API_UNAVAILABLE',
  // OUR RECORDING DOES NOT REACH THIS INSTANT. Distinct from NO_CAPTURE (we
  // have nothing at all) and from a miss (we looked and the badge was absent).
  // Raised per-sample, never for the whole session: a recorder that stalls
  // mid-broadcast leaves EARLIER windows perfectly readable, and killing those
  // too would throw away the evidence that still exists.
  CAPTURE_GAP: 'CAPTURE_GAP',
};

export class FrameSourceUnavailable extends Error {
  constructor(state, detail) {
    super(`frame source unavailable: ${state}${detail ? ` (${detail})` : ''}`);
    this.code = 'frame_source_unavailable';
    this.state = state;
    this.detail = detail || null;
  }
}

export const TOLERANCE_MS = 1500;

// ── the extractor seam ──────────────────────────────────────────────────────

function haveTool(cmd, args = ['--version']) {
  try { return spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000 }).status === 0; }
  catch { return false; }
}

/**
 * Page URL → direct media URL, via whichever tool exists. Swappable on
 * purpose; classify tool errors into the typed states so a sub-only VOD is
 * never reported as a generic failure.
 */
export function resolveMediaUrl(pageUrl, { log = console } = {}) {
  if (haveTool('yt-dlp')) {
    const r = spawnSync('yt-dlp', ['--no-warnings', '-g', '-f', 'best[height<=1080]/best', pageUrl],
      { encoding: 'utf8', timeout: 60000 });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split('\n')[0];
    const err = String(r.stderr || '');
    // The extractor's own words go into the detail. Classifying the failure and
    // then discarding WHY sends the next person hunting for a cause the error
    // already knew — and a timeout misfiled as "no VOD" reads as the streamer's
    // problem when it is ours.
    const why = `${pageUrl}${err ? ` — ${err.replace(/\s+/g, ' ').trim().slice(0, 200)}` : ''}`;
    if (/subscriber|premium|paywall/i.test(err)) throw new FrameSourceUnavailable(SOURCE_STATES.VOD_SUBSCRIBER_ONLY, why);
    if (/processing|not.*available yet/i.test(err)) throw new FrameSourceUnavailable(SOURCE_STATES.VOD_NOT_PROCESSED, why);
    if (/timed out|timeout/i.test(err)) throw new FrameSourceUnavailable(SOURCE_STATES.EXTRACTION_FAILED, why);
    if (/does not exist|404|unable to download|removed/i.test(err)) throw new FrameSourceUnavailable(SOURCE_STATES.NO_VOD_COVERING_TS, why);
    if (/offline|is not currently live/i.test(err)) throw new FrameSourceUnavailable(SOURCE_STATES.CHANNEL_OFFLINE, pageUrl);
    throw new FrameSourceUnavailable(SOURCE_STATES.EXTRACTION_FAILED, err.slice(0, 200));
  }
  if (haveTool('streamlink')) {
    const r = spawnSync('streamlink', ['--stream-url', pageUrl, 'best'], { encoding: 'utf8', timeout: 60000 });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    throw new FrameSourceUnavailable(SOURCE_STATES.EXTRACTION_FAILED, String(r.stderr || '').slice(0, 200));
  }
  log.warn('[frame-source] neither yt-dlp nor streamlink is installed');
  throw new FrameSourceUnavailable(SOURCE_STATES.EXTRACTOR_UNAVAILABLE, 'install yt-dlp or streamlink');
}

/** Grab ONE frame at `offsetS` into a media URL. Pre-input seek: keyframe-
 *  fast then exact, well inside the ±1.5s tolerance. */
/**
 * @param {boolean} [opts.decodeThrough] Seek by DECODING to the offset instead
 *   of jumping via the container index.
 *
 *   Needed for a self-capture, which is HLS segments concatenated byte-wise:
 *   if those segments do not share one continuous timeline, an input-side seek
 *   trusts a container index that describes only the first segment and
 *   silently returns the wrong frame — wrong frame meaning a streamer who did
 *   the work is not paid. Decoding through is exact, and a capture is ~60s.
 *
 *   NEVER default this on: the VOD path seeks hours into a Twitch archive, and
 *   decoding through would take longer than the broadcast did.
 */
export function grabFrame(mediaUrl, offsetS, outFile, { decodeThrough = false } = {}) {
  const seek = String(Math.max(0, offsetS));
  const args = decodeThrough
    ? ['-fflags', '+genpts', '-i', mediaUrl, '-ss', seek]
    : ['-ss', seek, '-i', mediaUrl];
  const r = spawnSync('ffmpeg', [
    '-v', 'error', '-y', ...args, '-frames:v', '1', outFile,
  ], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new FrameSourceUnavailable(SOURCE_STATES.EXTRACTION_FAILED, String(r.stderr || '').slice(0, 200));
  // EXIT 0 IS NOT PROOF A FRAME EXISTS. Seeking past the end of a file makes
  // ffmpeg exit 0, print nothing to stderr, and write NO output file. This
  // returned that path anyway; the checker then failed to decode it and scored
  // `found: false`, which the hit-rate math counts as a miss — so a capture
  // that stopped short became "the streamer had no badge on screen", verdict
  // FAIL, payout zero. Measured on a real pump.fun broadcast: a stalled
  // recorder produced eight byte-identical 60s files and every seek past them
  // took this path.
  if (!existsSync(outFile)) {
    throw new FrameSourceUnavailable(SOURCE_STATES.EXTRACTION_FAILED,
      `ffmpeg wrote no frame at ${seek}s (seek past end of media?)`);
  }
  return outFile;
}

/**
 * ONE SAMPLE WE COULD NOT READ IS NOT A DEAD SESSION.
 *
 * grabFrame refuses to hand back a path ffmpeg never wrote, which is correct —
 * but it made every seek that lands outside the media FATAL, and calibration
 * exists precisely to TRY hypotheses, several of which are wrong by design.
 * A probe seeking past the end of a VOD went from "this hypothesis scored
 * nothing" to "abort the whole verification", and _gate-vod-calibration went
 * from 15/15 to 7/8 with SOURCE_UNAVAILABLE where it used to verify 6/6.
 *
 * So every source funnels its grab through here: the failure is recorded ON
 * THE SAMPLE, and the verifier decides from the aggregate. Nothing readable
 * anywhere still reports SOURCE_UNAVAILABLE; a few bad probes among good ones
 * cost nothing, which is exactly how probing is supposed to behave.
 */
function frameOrUnreadable(common, grab) {
  try {
    return { ...common, ref: grab() };
  } catch (e) {
    return {
      ...common,
      ref: null,
      unreadable: e?.state || SOURCE_STATES.EXTRACTION_FAILED,
      unreadableDetail: e?.detail || String(e?.message || e).slice(0, 120),
    };
  }
}

const workDir = () => {
  const d = path.join(tmpdir(), 'mc-frames');
  mkdirSync(d, { recursive: true });
  return d;
};

// ── Twitch ──────────────────────────────────────────────────────────────────

export class TwitchFrameSource extends FrameSource {
  constructor({ log = console, mode = 'vod' } = {}) {
    super();
    this.log = log;
    this.mode = mode; // 'vod' | 'live'
    /**
     * A VOD can be CALIBRATED: it is seekable, so probing it at known offsets
     * recovers the true wall-clock-to-media mapping instead of trusting a
     * constant. A live stream cannot — there is one addressable instant (the
     * playlist head), so its delay is absorbed by the acceptance window
     * instead. Mock sources leave this false and skip calibration entirely.
     */
    this.calibratable = mode !== 'live';
    this._media = null; // resolved once per verification; extractor calls are slow
  }

  /** Helix archive listing → the VOD whose [start, start+duration] covers ts. */
  async vodCovering(handle, tsMs) {
    if (!twitchApiConfigured()) throw new FrameSourceUnavailable(SOURCE_STATES.API_UNAVAILABLE, 'twitch credentials absent');
    const users = await helix(`/users?login=${encodeURIComponent(handle.toLowerCase())}`);
    const user = users?.data?.[0];
    if (!user) throw new FrameSourceUnavailable(SOURCE_STATES.NO_VOD_COVERING_TS, `no such user ${handle}`);
    const vids = await helix(`/videos?user_id=${user.id}&type=archive&first=20`);
    for (const v of vids?.data || []) {
      const start = Date.parse(v.created_at);
      const durS = parseTwitchDuration(v.duration);
      if (tsMs >= start && tsMs <= start + durS * 1000) {
        return { url: v.url, startMs: start };
      }
    }
    throw new FrameSourceUnavailable(SOURCE_STATES.NO_VOD_COVERING_TS,
      `${handle}: no archive covers ${new Date(tsMs).toISOString()}`);
  }

  /**
   * @param {object} [opts]
   * @param {number} [opts.skewMs] Wall-clock→media offset to seek with. The
   *   calibration pass drives this directly to probe the timeline; normal
   *   verification passes the value calibration measured. Falls back to the
   *   documented constant only when nobody supplies one.
   */
  async getFrames(platform, handle, timestamps, opts = {}) {
    const out = [];
    // Resolved media is cached for the life of this source. Calibration probes
    // the same VOD several times and each extractor call is a subprocess and a
    // network round trip; re-resolving per frame made calibration cost more
    // than the verification it corrects.
    let media = this._media, vodStart = this._vodStart ?? null;
    for (const t of timestamps) {
      const ts = typeof t === 'object' ? t.ts : t;
      if (!media) {
        if (this.mode === 'live') {
          media = { url: resolveMediaUrl(`https://www.twitch.tv/${handle.toLowerCase()}`, this), live: true };
        } else {
          const vod = await this.vodCovering(handle, ts);
          media = { url: resolveMediaUrl(vod.url, this), live: false };
          vodStart = vod.startMs;
        }
        this._media = media;
        this._vodStart = vodStart;
      }
      const file = path.join(workDir(), `tw-${randomUUID().slice(0, 8)}.png`);
      out.push(frameOrUnreadable({
        // The verifier needs to know a frame is LIVE, because live frames are
        // older than the timestamp that asked for them.
        live: !!media.live,
        ts,
        clipId: typeof t === 'object' ? t.clipId : null,
        playbackId: typeof t === 'object' ? t.playbackId : null,
        platform, handle, toleranceMs: TOLERANCE_MS,
      }, () => {
        if (media.live) {
          // Live spot-check: "now" is the only addressable instant; the caller
          // samples while the code is actually on air.
          grabFrame(media.url, 0, file);
        } else {
          // A VOD's media timeline runs BEHIND our wall clock. The offset is
          // MEASURED per broadcast by the calibration pass and handed in here;
          // the constant is only a documented fallback for when calibration
          // could not run. See bounty-timeline-calibration.js.
          const skew = Number.isFinite(opts.skewMs) ? opts.skewMs : bountyConfig.vodTimelineSkewMs;
          const offsetS = (ts - vodStart + skew) / 1000;
          grabFrame(media.url, offsetS, file);
        }
        return file;
      }));
    }
    return out;
  }
}

function parseTwitchDuration(d) {
  // "1h23m45s" → seconds
  const m = String(d || '').match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  return (Number(m?.[1]) || 0) * 3600 + (Number(m?.[2]) || 0) * 60 + (Number(m?.[3]) || 0);
}

// ── Kick ────────────────────────────────────────────────────────────────────

/**
 * KICK VOD REALITY (investigated, not assumed): the OFFICIAL public API
 * (api.kick.com/public/v1) exposes channels and livestreams but NO VOD
 * listing endpoint as of this build. VOD pages exist on the site
 * (kick.com/<slug>/videos) and yt-dlp can extract from a direct VOD URL, but
 * DISCOVERING which VOD covers a timestamp requires the unofficial v2 web
 * API, which is Cloudflare-guarded and unstable. So: Kick is LIVE-first
 * here — the live spot-check works through the same seam — and VOD
 * verification takes a direct VOD URL when an operator supplies one. That is
 * a finding about the platform, not a failure: filed in OPEN-ISSUES.
 */
export class KickFrameSource extends FrameSource {
  constructor({ log = console, mode = 'live', vodUrl = null, vodStartMs = null } = {}) {
    super();
    this.log = log;
    this.mode = mode;
    this.vodUrl = vodUrl;     // operator-supplied direct VOD page URL
    this.vodStartMs = vodStartMs; // must accompany vodUrl for offset math
    /**
     * THIS LINE WAS MISSING, and its absence was silent. Every other source
     * sets it; Kick alone left it undefined, so `calibratable` was falsy and
     * an operator-supplied Kick VOD skipped calibration entirely and fell back
     * to the documented 16s constant — the exact "trust a constant instead of
     * measuring" failure calibration exists to prevent. Nothing failed loudly
     * because a missing property is just falsy.
     */
    this.calibratable = mode !== 'live';
  }

  async getFrames(platform, handle, timestamps, opts = {}) {
    const out = [];
    let media = null;
    for (const t of timestamps) {
      const ts = typeof t === 'object' ? t.ts : t;
      if (!media) {
        if (this.mode === 'vod') {
          if (!this.vodUrl || !this.vodStartMs) {
            throw new FrameSourceUnavailable(SOURCE_STATES.NO_VOD_COVERING_TS,
              'kick VOD discovery needs the unofficial v2 API — supply vodUrl+vodStartMs or use live mode');
          }
          media = { url: resolveMediaUrl(this.vodUrl, this), live: false };
        } else {
          media = { url: resolveMediaUrl(`https://kick.com/${handle.toLowerCase()}`, this), live: true };
        }
      }
      const file = path.join(workDir(), `kick-${randomUUID().slice(0, 8)}.png`);
      out.push(frameOrUnreadable({
        // The verifier widens its acceptance window for LIVE frames, because a
        // live grab is one broadcast delay older than the timestamp that asked
        // for it. Omitting this made every live Kick frame get judged against
        // the tight post-calibration residual instead.
        live: !!media.live,
        ts,
        clipId: typeof t === 'object' ? t.clipId : null,
        playbackId: typeof t === 'object' ? t.playbackId : null,
        platform, handle, toleranceMs: TOLERANCE_MS,
      }, () => {
        if (media.live) {
          grabFrame(media.url, 0, file);
        } else {
          // The measured offset, not a raw subtraction. This used to seek to
          // (ts - vodStartMs) with no skew term at all, discarding whatever
          // calibration had just spent frame grabs to establish.
          const skew = Number.isFinite(opts.skewMs) ? opts.skewMs : bountyConfig.vodTimelineSkewMs;
          grabFrame(media.url, (ts - this.vodStartMs + skew) / 1000, file);
        }
        return file;
      }));
    }
    return out;
  }
}

// ── YouTube ─────────────────────────────────────────────────────────────────

/**
 * YouTube needs no discovery step at all: the streamer hands us their WATCH
 * URL at air-session open, that URL is the live stream while it airs, and the
 * SAME URL is the archive afterwards. The broadcast start comes from the Data
 * API's actualStartTime, so vod offset math needs nothing hand-supplied.
 *
 * `resolver` is injectable so gates exercise the URL-selection and offset
 * logic against local fixtures without shelling to yt-dlp — the resolver IS
 * the extractor seam, and the default is the shipped one.
 */
export class YouTubeFrameSource extends FrameSource {
  constructor({ log = console, mode = 'vod', watchUrl = null, vodStartMs = null,
    resolver = resolveMediaUrl } = {}) {
    super();
    this.log = log;
    this.mode = mode;           // 'vod' | 'live'
    this.watchUrl = watchUrl;   // the URL the streamer handed the air session
    this.vodStartMs = vodStartMs; // broadcast start; fetched from the API if absent
    this.resolver = resolver;
    this.calibratable = mode !== 'live';
    this._media = null;
  }

  async getFrames(platform, handle, timestamps, opts = {}) {
    if (!this.watchUrl) {
      throw new FrameSourceUnavailable(SOURCE_STATES.NO_VOD_COVERING_TS,
        'youtube verification needs the watch URL the streamer gave at session open');
    }
    const out = [];
    for (const t of timestamps) {
      const ts = typeof t === 'object' ? t.ts : t;
      if (!this._media) {
        this._media = { url: this.resolver(this.watchUrl, this), live: this.mode === 'live' };
        if (!this._media.live && !Number.isFinite(this.vodStartMs)) {
          const { getVideoLiveDetails, extractVideoId } = await import('./youtube-api.js');
          const details = await getVideoLiveDetails(extractVideoId(this.watchUrl), this);
          const started = details?.startedAt ? Date.parse(details.startedAt) : NaN;
          if (!Number.isFinite(started)) {
            throw new FrameSourceUnavailable(SOURCE_STATES.API_UNAVAILABLE,
              'youtube archive offset needs actualStartTime and the Data API could not supply it');
          }
          this.vodStartMs = started;
        }
      }
      const file = path.join(workDir(), `yt-${randomUUID().slice(0, 8)}.png`);
      out.push(frameOrUnreadable({
        live: this._media.live, ts,
        clipId: typeof t === 'object' ? t.clipId : null,
        playbackId: typeof t === 'object' ? t.playbackId : null,
        platform, handle, toleranceMs: TOLERANCE_MS,
      }, () => {
        if (this._media.live) {
          grabFrame(this._media.url, 0, file);
        } else {
          const skew = Number.isFinite(opts.skewMs) ? opts.skewMs : bountyConfig.vodTimelineSkewMs;
          grabFrame(this._media.url, (ts - this.vodStartMs + skew) / 1000, file);
        }
        return file;
      }));
    }
    return out;
  }
}

// ── Rumble ──────────────────────────────────────────────────────────────────

/**
 * Live-first, exactly like Kick and for the same reason: no sanctioned VOD
 * discovery. yt-dlp carries three dedicated Rumble extractors, so the live
 * pull is the streamer's page URL; a replay is operator-supplied
 * vodUrl+vodStartMs when one exists. Self-capture remains the primary
 * evidence on this platform — this source is the external corroboration.
 */
export class RumbleFrameSource extends FrameSource {
  constructor({ log = console, mode = 'live', watchUrl = null,
    vodUrl = null, vodStartMs = null, resolver = resolveMediaUrl } = {}) {
    super();
    this.log = log;
    this.mode = mode;
    this.watchUrl = watchUrl; // the streamer's live page URL
    this.vodUrl = vodUrl;
    this.vodStartMs = vodStartMs;
    this.resolver = resolver;
    this.calibratable = mode !== 'live';
  }

  async getFrames(platform, handle, timestamps, opts = {}) {
    const out = [];
    let media = null;
    for (const t of timestamps) {
      const ts = typeof t === 'object' ? t.ts : t;
      if (!media) {
        if (this.mode === 'vod') {
          if (!this.vodUrl || !Number.isFinite(this.vodStartMs)) {
            throw new FrameSourceUnavailable(SOURCE_STATES.NO_VOD_COVERING_TS,
              'rumble has no VOD discovery — supply vodUrl+vodStartMs or use live mode');
          }
          media = { url: this.resolver(this.vodUrl, this), live: false };
        } else {
          if (!this.watchUrl) {
            throw new FrameSourceUnavailable(SOURCE_STATES.NO_VOD_COVERING_TS,
              'rumble live verification needs the stream page URL from session open');
          }
          media = { url: this.resolver(this.watchUrl, this), live: true };
        }
      }
      const file = path.join(workDir(), `rum-${randomUUID().slice(0, 8)}.png`);
      out.push(frameOrUnreadable({
        live: media.live, ts,
        clipId: typeof t === 'object' ? t.clipId : null,
        playbackId: typeof t === 'object' ? t.playbackId : null,
        platform, handle, toleranceMs: TOLERANCE_MS,
      }, () => {
        // Same omission as Kick's: this source is `calibratable`, so calibration
        // measures a skew for it and then handed the result to a signature that
        // did not accept it.
        const skew = Number.isFinite(opts.skewMs) ? opts.skewMs : bountyConfig.vodTimelineSkewMs;
        grabFrame(media.url, media.live ? 0 : (ts - this.vodStartMs + skew) / 1000, file);
        return file;
      }));
    }
    return out;
  }
}

// ── pump.fun ────────────────────────────────────────────────────────────────

/**
 * pump.fun serves plain public HLS (measured 2026-08-25 across eight live
 * streams: 1080p60 ladder, 2s MPEG-TS segments, no auth) with TWO properties
 * no other platform here has at once:
 *
 *   1. the media playlist is APPEND-ONLY — MEDIA-SEQUENCE pinned at 0, no
 *      ENDLIST, the full broadcast history stays listed while it serves; and
 *   2. EVERY segment carries EXT-X-PROGRAM-DATE-TIME.
 *
 * Together they make external verification a LOOKUP, not a search: parse the
 * playlist, find the segment whose wall-clock window covers the code's issue
 * time, download that one segment, read the frame. No VOD discovery, no
 * timeline calibration (wallClockSkew tells the calibrator the offset is
 * known), no seeking through gigabytes.
 *
 * What this source does NOT solve, on purpose: DISCOVERY. The mint→playlist
 * mapping rides pump.fun's undocumented frontend API, and building the money
 * path on a reverse-engineered endpoint is a business risk, not a technical
 * one. The playlist URL arrives via the session's watch URL; anything else is
 * a typed refusal that names the gap.
 */
/**
 * A pump.fun coin mint out of whatever the streamer pasted: a bare mint, a
 * coin page, or a /live link. Returns null rather than guessing — a wrong mint
 * verifies somebody else's broadcast.
 */
export function extractPumpFunMint(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  // Base58, and pump.fun mints conventionally end in "pump".
  if (/^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(s)) return s;
  const m = /pump\.fun\/(?:coin\/|live\/|board\/)?([1-9A-HJ-NP-Za-km-z]{32,48})/.exec(s);
  return m ? m[1] : null;
}

export class PumpFunFrameSource extends FrameSource {
  constructor({ log = console, watchUrl = null, mint = null, fetchImpl = fetch } = {}) {
    super();
    this.log = log;
    this.watchUrl = watchUrl;
    // A MINT IS ENOUGH NOW. livestream-api.pump.fun turns it into the stream's
    // own directory, so the playlist is derived rather than discovered — which
    // is why this source no longer has to refuse everything but a hand-supplied
    // .m3u8. See pumpfun-api.js for the measurement behind that.
    this.mint = mint;
    this.fetchImpl = fetchImpl;
    /**
     * CALIBRATED, like every other seeking source. This read `false` with the
     * comment "wallClockSkew supersedes probing entirely" — the same bypass
     * that was deleted from CaptureFrameSource after it cost three real Kick
     * broadcasts, left behind here because that fix was applied to one source
     * and not to its sibling.
     *
     * It failed worse here than it did there. wallClockSkew() cannot answer
     * until `_segments` is populated, and `_segments` is only populated by
     * loadPlaylist() inside getFrames() — but calibrateTimeline consults
     * wallClockSkew() BEFORE any frame is grabbed. So it always returned null,
     * `calibratable: false` sent it to the fallback, and the fallback hands
     * back vodTimelineSkewMs: a constant measured on TWITCH VODs, injected as
     * pump.fun's seek offset. Every sample then lands 16s from where the code
     * was, verifiedClips is 0, and the verdict is FAIL — which names no review
     * cause, so the streamer is paid zero and no human is told.
     */
    this.calibratable = true;
    this._segments = null;     // parsed once per verification
  }

  /**
   * NULL ON PURPOSE — a PDT stamp is an ANCHOR, not an answer.
   *
   * This returned {skewMs: 0}. PROGRAM-DATE-TIME records when a segment was
   * PACKAGED, and the overlay rendered its code one broadcast delay earlier,
   * so a code issued at T lands in a segment stamped T + D. Measured at 12.1s
   * on Kick. Keeping PDT as the seek anchor is a real gain — it removes the
   * frozenAt/duration estimate error — but D still has to be measured, which
   * is what `calibratable: true` above now allows.
   */
  wallClockSkew() {
    return null;
  }

  async loadPlaylist() {
    if (this._segments) return this._segments;
    let url = this.watchUrl;
    // Not a playlist URL? Derive one from the mint. This used to be a hard
    // refusal on the belief that the mapping was undiscoverable; it is one
    // unauthenticated GET keyed by the mint.
    if (!/\.m3u8(\?|$)/i.test(String(url || ''))) {
      const mint = this.mint || extractPumpFunMint(url);
      if (!mint) {
        throw new FrameSourceUnavailable(SOURCE_STATES.API_UNAVAILABLE,
          'pump.fun verification needs the coin mint (or a clips.pump.fun playlist URL)');
      }
      const { getStreamByMint } = await import('./pumpfun-api.js');
      // getStreamByMint's second parameter is an OPTIONS object, `{ log }`.
      // Passing the logger itself destructured to `this.log.log`, so every
      // 'could not ask' warning from that module was silently dropped.
      const info = await getStreamByMint(mint, { log: this.log });
      if (!info) {
        throw new FrameSourceUnavailable(SOURCE_STATES.API_UNAVAILABLE,
          `pump.fun livestream api could not be asked about ${String(mint).slice(0, 12)}…`);
      }
      if (!info.playlistUrl) {
        // The stream exists but has published no media directory yet — a
        // could-not-look, distinct from "the badge was not there".
        throw new FrameSourceUnavailable(SOURCE_STATES.NO_VOD_COVERING_TS,
          `pump.fun reports ${info.live ? 'live' : 'offline'} with no playlist published yet`);
      }
      url = info.playlistUrl;
      this.log?.log?.(`[pumpfun] derived playlist for ${String(mint).slice(0, 8)}… from the livestream api`);
    }
    const { parseMediaPlaylist } = await import('./bounty-capture.js');
    let body = await (await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) })).text();
    if (/#EXT-X-STREAM-INF/i.test(body)) {
      // A master playlist: take the top rendition and fetch its media playlist.
      const rel = body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#'));
      url = new URL(rel, url).toString();
      body = await (await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) })).text();
    }
    const { segments } = parseMediaPlaylist(body, url);
    if (!segments.length) {
      throw new FrameSourceUnavailable(SOURCE_STATES.EXTRACTION_FAILED, 'playlist listed no segments');
    }
    if (!segments.every((x) => Number.isFinite(x.pdtMs))) {
      throw new FrameSourceUnavailable(SOURCE_STATES.EXTRACTION_FAILED,
        'pump.fun playlist without PROGRAM-DATE-TIME — cannot map wall clock to media');
    }
    this._segments = segments;
    return segments;
  }

  async getFrames(platform, handle, timestamps, opts = {}) {
    const segments = await this.loadPlaylist();
    const out = [];
    for (const t of timestamps) {
      const ts = typeof t === 'object' ? t.ts : t;
      const skew = Number.isFinite(opts.skewMs) ? opts.skewMs : 0;
      const want = ts + skew;
      // The segment whose [pdt, pdt+duration) window covers the instant.
      const seg = segments.find((x) => want >= x.pdtMs && want < x.pdtMs + x.durationS * 1000)
        // Half-open windows leave the final edge uncovered; take the last
        // segment when the instant sits within one duration past it.
        || (want >= segments[segments.length - 1].pdtMs ? segments[segments.length - 1] : null);
      const common = {
        live: false, ts,
        clipId: typeof t === 'object' ? t.clipId : null,
        playbackId: typeof t === 'object' ? t.playbackId : null,
        platform, handle, toleranceMs: TOLERANCE_MS,
      };
      /**
       * PER-SAMPLE, NOT A THROW. This threw on the FIRST instant no segment
       * covered, which returned SOURCE_UNAVAILABLE for the entire session at
       * grab 0 of 36 — before a single real clip was ever sampled.
       *
       * That is not hypothetical. pump.fun rotates its media directory
       * mid-broadcast (observed twice in one stream, ~33-53 min apart, with no
       * operator action), and the playlist is derived from the API's CURRENT
       * thumbnail, so a retired directory cannot be named. Any window older
       * than the last rotation is therefore uncoverable — and it aborted the
       * windows that WERE still covered. Measured on the same broadcast: the
       * five real clips sat inside the surviving playlist and were readable,
       * while the run died on a setup window half an hour older.
       */
      if (!seg) {
        out.push({
          ...common,
          ref: null,
          unreadable: SOURCE_STATES.NO_VOD_COVERING_TS,
          unreadableDetail: `no listed segment covers ${new Date(ts).toISOString()}`,
        });
        continue;
      }
      // ONE segment, not the stream: download just the 2s of media that
      // carries the instant, then read the frame at the intra-segment offset.
      let file;
      try {
        const segRes = await this.fetchImpl(seg.uri, { signal: AbortSignal.timeout(15_000) });
        if (!segRes.ok) {
          throw new FrameSourceUnavailable(SOURCE_STATES.EXTRACTION_FAILED, `segment ${segRes.status}`);
        }
        const segFile = path.join(workDir(), `pf-seg-${randomUUID().slice(0, 8)}.ts`);
        const fsMod = await import('fs');
        fsMod.writeFileSync(segFile, Buffer.from(await segRes.arrayBuffer()));
        file = path.join(workDir(), `pf-${randomUUID().slice(0, 8)}.png`);
        grabFrame(segFile, Math.max(0, (want - seg.pdtMs) / 1000), file, { decodeThrough: true });
      } catch (e) {
        out.push({
          ...common,
          ref: null,
          unreadable: e?.state || SOURCE_STATES.EXTRACTION_FAILED,
          unreadableDetail: e?.detail || String(e?.message || e).slice(0, 120),
        });
        continue;
      }
      out.push({ ...common, ref: file });
    }
    return out;
  }
}

// ── Local files ─────────────────────────────────────────────────────────────

/**
 * Frames already on disk — two real consumers:
 *  - the pipeline gate, which feeds platform-grade re-encoded frames through
 *    the ENTIRE HTTP verification path with zero network;
 *  - the rehearsal, verifying from a recorded screencast of the broadcast.
 * Each requested instant maps to the nearest provided frame. When the frames
 * carry timestamps the ±tolerance applies; untimestamped frames are matched
 * in order, which is honest for a single-code window where the same code is
 * on screen throughout.
 */
export class LocalFileFrameSource extends FrameSource {
  constructor({ frames = [] } = {}) {
    super();
    this.frames = frames; // [{ts?, file}]
  }

  async getFrames(platform, handle, timestamps) {
    if (!this.frames.length) {
      throw new FrameSourceUnavailable(SOURCE_STATES.EXTRACTION_FAILED, 'no frames supplied');
    }
    const out = [];
    let cursor = 0;
    for (const t of timestamps) {
      const ts = typeof t === 'object' ? t.ts : t;
      let pick;
      if (this.frames.some((f) => Number.isFinite(f.ts))) {
        pick = this.frames.reduce((a, b) =>
          Math.abs((b.ts ?? Infinity) - ts) < Math.abs((a.ts ?? Infinity) - ts) ? b : a);
      } else {
        pick = this.frames[Math.min(cursor++, this.frames.length - 1)];
      }
      out.push({
        ref: pick.file, ts,
        clipId: typeof t === 'object' ? t.clipId : null,
        playbackId: typeof t === 'object' ? t.playbackId : null,
        platform, handle, toleranceMs: TOLERANCE_MS,
      });
    }
    return out;
  }
}

/** The right source for an air session, VOD-first where the platform allows. */
/**
 * SELF-CAPTURE AS A FRAME SOURCE — the platform-independent path.
 *
 * A frozen capture is just a seekable local video whose timeline offset is
 * unknown, which is exactly the shape the per-VOD calibration already solves.
 * So this needs no special verifier handling: it is `calibratable`, and
 * calibration measures where the badge actually sits inside the window.
 *
 * That is the whole point of T1 — Kick and X have no VOD to discover, but a
 * capture is ours, so the verifier path is identical on every platform.
 */
export class CaptureFrameSource extends FrameSource {
  /**
   * A session holds ONE capture PER CLIP PLAYBACK — roughly a 60s window each,
   * minutes apart. So this source is a set of windows, not a file, and every
   * timestamp has to be routed to the window that actually contains it.
   *
   * Handing it a single file was a real bug: calibration probes several
   * playbacks spread across the session, every probe after the first seeked
   * past the end of the only file present, and self-capture verification —
   * the PRIMARY path, the one that exists so Kick works at all — came back
   * SOURCE_UNAVAILABLE / TIMELINE_UNCALIBRATED for any session with more than
   * one clip. It looked like a platform problem and was ours.
   *
   * @param {Array<{file:string, playbackId:string|null, frozenAt:number}>} captures
   *   Preferred. `capturePath`/`anchorMs` remain for a single known window.
   */
  constructor({ log = console, capturePath, anchorMs = null, captures = null } = {}) {
    super();
    this.log = log;
    this.captures = (captures && captures.length)
      ? [...captures].sort((a, b) => a.frozenAt - b.frozenAt)
      : (capturePath ? [{ file: capturePath, playbackId: null, frozenAt: anchorMs ?? Date.now() }] : []);
    this.calibratable = true;
    this._durationS = new Map();
  }

  /**
   * How much media a capture holds. Every seek is relative to this, so getting
   * it wrong points every frame grab at the wrong instant.
   *
   * PREFER THE SPAN THE BUFFER MEASURED, not the container's own answer. A
   * capture is HLS segments concatenated byte-wise, and ffprobe reports
   * `format=duration` from the timestamps it finds — which is the FIRST
   * segment's duration alone whenever the segments do not share a continuous
   * timeline. A 20-second window then measures as 2 seconds, every seek
   * clamps to zero, and verification decodes nothing while reporting a
   * perfectly healthy capture on disk. `spanMs` is summed from the playlist's
   * own EXTINF values at freeze time and cannot be wrong in that way.
   *
   * ffprobe stays as the fallback for captures recorded before the span was
   * carried through, and its answer is sanity-checked rather than trusted.
   */
  durationS(file) {
    if (this._durationS.has(file)) return this._durationS.get(file);
    const rec = this.captures.find((c) => c.file === file);
    let d = Number(rec?.spanMs) > 0 ? rec.spanMs / 1000 : 0;
    if (!d) {
      const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
        '-of', 'csv=p=0', file], { encoding: 'utf8' });
      d = r.status === 0 ? (parseFloat(r.stdout.trim()) || 0) : 0;
      this.log?.warn?.(`[capture] no recorded span for ${path.basename(file)}; `
        + `falling back to the container's ${d}s, which under-reports a concatenated stream`);
    }
    this._durationS.set(file, d);
    return d;
  }

  /**
   * Which window covers this instant?
   *
   * By PLAYBACK ID when we have one, because a capture is frozen for exactly
   * one playback and the mapping is then exact rather than inferred. Otherwise
   * fall back to the window whose freeze is nearest after the timestamp — a
   * capture ends at its freeze, so the one that contains `ts` is the earliest
   * that was frozen after it.
   */
  pick(ts, playbackId) {
    if (!this.captures.length) return null;
    if (playbackId) {
      const exact = this.captures.find((c) => c.playbackId === playbackId);
      if (exact) return exact;
    }
    const after = this.captures.find((c) => c.frozenAt >= ts);
    return after || this.captures[this.captures.length - 1];
  }

  /**
   * Does EVERY capture window know its own wall clock? True only when each
   * carries a PROGRAM-DATE-TIME anchor (pump.fun stamps every segment). Then
   * the wall-clock→media mapping is exact by construction and calibration
   * has nothing left to measure — bounty-timeline-calibration consults this
   * and skips its probe ladder entirely.
   *
   * The residual is the stamp's own granularity: one segment duration of
   * quantization plus encoder stamping slack. It is NOT the broadcast delay
   * — PDT names when the media was ENCODED, which is exactly the clock our
   * code-issue timestamps live on.
   */
  /**
   * DELIBERATELY RETURNS NULL — a PDT stamp is an ANCHOR, not an answer.
   *
   * This used to report {skewMs: 0} and skip calibration outright, on the
   * reasoning that a segment carrying its own wall clock needs no probing.
   * The stamp is exact; the inference from it was not. PROGRAM-DATE-TIME marks
   * when a segment was PACKAGED, and the overlay rendered its code one
   * broadcast delay EARLIER — so content showing a code issued at T lands in a
   * segment stamped T + D.
   *
   * MEASURED on Kick's first real broadcasts: the PDT seek computed 19.69s
   * while the badge actually began at 20.0s in the same file, and the gap
   * between a code's issue time and its first appearance was 12.1s — the
   * broadcast delay, unmeasured because the bypass had already declared the
   * timeline solved. Three Kick attempts verified 1/5, 0/5, 0/5 with the badge
   * legible at 28px throughout, and two fixes aimed at the estimate branch
   * changed nothing because a PDT-stamped capture never executes that branch.
   *
   * Every gate agreed with the bypass because every stub publishes segments
   * the instant it writes them, making D ~= 0 and the bypass accidentally
   * right. Same blind spot that hid the freeze-timing bug.
   *
   * So: keep PDT as the anchor in getFrames — it removes the frozenAt/duration
   * estimate error entirely, which is a real gain — and let calibration
   * MEASURE the delay on top of it. The residual it searches for is then just
   * D, which is positive and well inside the ladder.
   */
  wallClockSkew() {
    return null;
  }

  async getFrames(platform, handle, timestamps, opts = {}) {
    const present = this.captures.filter((c) => existsSync(c.file));
    if (!present.length) {
      throw new FrameSourceUnavailable(SOURCE_STATES.NO_CAPTURE,
        this.captures.length ? `capture files missing for ${this.captures.length} window(s)` : 'no captures for this session');
    }
    const out = [];
    for (const t of timestamps) {
      const ts = typeof t === 'object' ? t.ts : t;
      const playbackId = typeof t === 'object' ? t.playbackId : null;
      const cap = this.pick(ts, playbackId);
      const dur = this.durationS(cap.file);
      const skew = Number.isFinite(opts.skewMs) ? opts.skewMs : bountyConfig.vodTimelineSkewMs;
      let offsetS;
      if (Number.isFinite(cap.firstPdtMs)) {
        // EXACT: the window's first segment names its own wall clock, so a
        // code issued at `ts` sits (ts - firstPdtMs) into the media. No
        // estimate, no broadcast-delay guess — the anchor IS the mapping.
        offsetS = Math.max(0, (ts + skew - cap.firstPdtMs) / 1000);
      } else {
        // ESTIMATE, ANCHORED ON ENCODE TIME — not on the freeze instant.
        //
        // THE BUG THIS FIXES, which cost Kick two real broadcasts (1/5 then
        // 0/5 while the badge was legible at 28px in 9 of 13 samples): the
        // newest media in the buffer was PUBLISHED at ~frozenAt but ENCODED
        // D = 12-25s earlier. Treating the file's end as "frozenAt" therefore
        // put every seek D seconds too late, and recovering that needed
        // skewMs = -D — a NEGATIVE value, while the calibration ladder is
        // built non-negative (0 … calibrationLadderMaxMs). The correct
        // hypothesis was not merely missed, it was outside the search space,
        // so the failure was deterministic rather than flaky and no number of
        // probes could ever have found it.
        //
        // Anchoring on (frozenAt - liveBroadcastDelayMs) states the delay we
        // already know about, and leaves calibration to measure only the
        // residual — which lands at (liveBroadcastDelayMs - actual D), i.e.
        // POSITIVE and inside the existing ladder for every delay we have
        // measured. Calibration still does the real work; it is just no longer
        // asked to search for it in the wrong direction.
        const encodeAnchor = cap.frozenAt - bountyConfig.liveBroadcastDelayMs;
        const back = (encodeAnchor - ts + skew) / 1000;
        offsetS = Math.max(0, dur - back);
      }
      const clipId = typeof t === 'object' ? t.clipId : null;
      const common = {
        live: false, ts, clipId, playbackId,
        platform, handle, toleranceMs: TOLERANCE_MS, source: 'capture',
      };
      /**
       * DOES OUR RECORDING ACTUALLY REACH THIS INSTANT?
       *
       * `dur` was computed here and used only by the estimate branch; NEITHER
       * branch bounded the seek from above, both clamping low with
       * Math.max(0, …). A recorder that stalls keeps writing files — the same
       * stale media under each new name — so `offsetS` walks past the end of a
       * 60s file while the code politely asks for 195s. ffmpeg then exits 0
       * writing nothing, and the miss was scored against the STREAMER.
       *
       * Measured on a real pump.fun broadcast: the ring stopped ingesting at
       * 22:03:21 and eight windows froze onto byte-identical media. Replayed
       * against those files with calibration forced good, the old code returns
       * FAIL 0/5 — our outage, recorded as an accusation, paying zero.
       *
       * This is per-sample and NEVER a throw: windows recorded before the
       * stall are still perfectly readable, and aborting the session would
       * discard the very evidence that survived.
       */
      const covers = Number.isFinite(dur) && dur > 0 && offsetS < dur;
      if (!covers) {
        out.push({
          ...common,
          ref: null,
          unreadable: SOURCE_STATES.CAPTURE_GAP,
          unreadableDetail: `seek ${offsetS.toFixed(1)}s into a `
            + `${Number.isFinite(dur) ? dur.toFixed(1) : '?'}s recording`,
        });
        continue;
      }
      const file = path.join(workDir(), `cap-${randomUUID().slice(0, 8)}.png`);
      try {
        grabFrame(cap.file, offsetS, file, { decodeThrough: true });
      } catch (e) {
        // Also per-sample. If the failure is systemic every sample lands here
        // and the verifier reports SOURCE_UNAVAILABLE from the aggregate — the
        // same verdict as before, reached without throwing away good windows.
        out.push({
          ...common,
          ref: null,
          unreadable: e?.state || SOURCE_STATES.EXTRACTION_FAILED,
          unreadableDetail: e?.detail || String(e?.message || e).slice(0, 120),
        });
        continue;
      }
      out.push({ ...common, ref: file });
    }
    return out;
  }
}

/**
 * A source for platforms with NO pullable external stream (X). Construction
 * succeeds; USE reports the typed unavailability — so a verification with no
 * self-capture lands SOURCE_UNAVAILABLE → human review through the normal
 * pipeline instead of 500ing in the route while building its options.
 */
export class UnavailableFrameSource extends FrameSource {
  constructor({ detail } = {}) {
    super();
    this.calibratable = false;
    this.detail = detail || 'this platform exposes no pullable stream';
  }

  async getFrames() {
    throw new FrameSourceUnavailable(SOURCE_STATES.API_UNAVAILABLE, this.detail);
  }
}

export function frameSourceFor(platform, opts = {}) {
  if (opts.mode === 'files') return new LocalFileFrameSource(opts);
  // SELF-CAPTURE IS PRIMARY. It works on every platform, including the ones
  // with no VOD at all; the Twitch archive stays as a secondary path for
  // sessions captured before this existed, or where capture failed.
  if (opts.mode === 'capture' || opts.capturePath) return new CaptureFrameSource(opts);
  if (platform === 'twitch') return new TwitchFrameSource(opts);
  if (platform === 'kick') return new KickFrameSource(opts);
  if (platform === 'youtube') return new YouTubeFrameSource(opts);
  if (platform === 'rumble') return new RumbleFrameSource(opts);
  if (platform === 'pumpfun') return new PumpFunFrameSource(opts);
  if (platform === 'x') {
    return new UnavailableFrameSource({
      detail: 'X exposes no pullable stream at any tier — verification on X uses '
        + 'self-capture (+ obs-websocket corroboration); this session has no capture to read',
    });
  }
  throw new FrameSourceUnavailable(SOURCE_STATES.API_UNAVAILABLE, `no frame source for ${platform}`);
}
