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
import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
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
  API_UNAVAILABLE: 'API_UNAVAILABLE',
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
    if (/subscriber|premium|paywall/i.test(err)) throw new FrameSourceUnavailable(SOURCE_STATES.VOD_SUBSCRIBER_ONLY, pageUrl);
    if (/processing|not.*available yet/i.test(err)) throw new FrameSourceUnavailable(SOURCE_STATES.VOD_NOT_PROCESSED, pageUrl);
    if (/does not exist|404|unable to download|removed/i.test(err)) throw new FrameSourceUnavailable(SOURCE_STATES.NO_VOD_COVERING_TS, pageUrl);
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
export function grabFrame(mediaUrl, offsetS, outFile) {
  const r = spawnSync('ffmpeg', [
    '-v', 'error', '-y',
    '-ss', String(Math.max(0, offsetS)),
    '-i', mediaUrl, '-frames:v', '1', outFile,
  ], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new FrameSourceUnavailable(SOURCE_STATES.EXTRACTION_FAILED, String(r.stderr || '').slice(0, 200));
  return outFile;
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

  async getFrames(platform, handle, timestamps) {
    const out = [];
    let media = null, vodStart = null;
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
      }
      const file = path.join(workDir(), `tw-${randomUUID().slice(0, 8)}.png`);
      if (media.live) {
        // Live spot-check: "now" is the only addressable instant; the caller
        // samples while the code is actually on air.
        grabFrame(media.url, 0, file);
      } else {
        const offsetS = (ts - vodStart) / 1000;
        grabFrame(media.url, offsetS, file);
      }
      out.push({
        ref: file, ts,
        clipId: typeof t === 'object' ? t.clipId : null,
        playbackId: typeof t === 'object' ? t.playbackId : null,
        platform, handle, toleranceMs: TOLERANCE_MS,
      });
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
  constructor({ log = console, mode = 'live', vodUrl = null } = {}) {
    super();
    this.log = log;
    this.mode = mode;
    this.vodUrl = vodUrl;     // operator-supplied direct VOD page URL
    this.vodStartMs = null;   // must accompany vodUrl for offset math
  }

  async getFrames(platform, handle, timestamps) {
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
      grabFrame(media.url, media.live ? 0 : (ts - this.vodStartMs) / 1000, file);
      out.push({
        ref: file, ts,
        clipId: typeof t === 'object' ? t.clipId : null,
        playbackId: typeof t === 'object' ? t.playbackId : null,
        platform, handle, toleranceMs: TOLERANCE_MS,
      });
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
export function frameSourceFor(platform, opts = {}) {
  if (opts.mode === 'files') return new LocalFileFrameSource(opts);
  if (platform === 'twitch') return new TwitchFrameSource(opts);
  if (platform === 'kick') return new KickFrameSource(opts);
  throw new FrameSourceUnavailable(SOURCE_STATES.API_UNAVAILABLE, `no frame source for ${platform}`);
}
