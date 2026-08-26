/**
 * SELF-CAPTURE — verification stops depending on the platform keeping a VOD.
 *
 * THE PROBLEM. Verification is VOD-first, which works on Twitch and nowhere
 * else. Kick's official API exposes no VOD listing, so Kick is live-only with
 * no retry: one failed grab and an honest streamer goes unverified. X has the
 * same shape. We do not need THEIR recording — we need A recording, and we can
 * make our own.
 *
 * THE ROLLING BUFFER IS THE WHOLE TRICK. The public stream runs 15-25s behind
 * the encoder (measured), and that delay varies per broadcast and per platform.
 * If we tried to grab "the clip" at the moment it played we would race a delay
 * we do not know yet. Instead we continuously hold the last `captureWindowMs`
 * of segments and throw away anything older. When a clip playback ENDS, the
 * content for that clip is necessarily still inside the window — because the
 * window is longer than the worst delay plus the longest clip — so we freeze
 * what we are holding and persist only that.
 *
 * The consequence worth stating: the skew never has to be known in advance to
 * know what to keep. The existing per-VOD calibration then measures where the
 * badge actually is inside the capture, exactly as it does for a Twitch
 * archive. A capture is a VOD substitute, and everything downstream is unchanged.
 *
 * WHY IN MEMORY. At 720p/3Mbps a 60s window is ~22MB per open air session —
 * small enough to hold, and holding it means the discard is real rather than a
 * cleanup job that might not run. Nothing is written to disk until a clip
 * actually ends.
 *
 * MPEG-TS CONCATENATES. HLS segments are transport-stream packets, so joining
 * the buffered segments byte-wise yields a playable stream with no re-encode.
 * That is why freezing is a copy, not a transcode.
 *
 * ⚠ CAPTURE RUNS ONLY WHILE AN AIR SESSION IS OPEN, and that is enforced here
 * rather than promised in copy: `start` is called from the air-session open
 * path, `stop` from the close path, and freezing without a running capture is
 * an error. This is a verification capture of the minutes a streamer is
 * claiming for — not a recording of anybody's broadcast.
 */
import { mkdirSync, writeFileSync, existsSync, statSync, unlinkSync, readdirSync } from 'fs';
import path from 'path';
import { bountyConfig } from './bounty-claim.config.js';
import * as evidence from './bounty-evidence.js';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const CAPTURE_DIR = path.join(DATA_DIR, 'bounty-captures');

/** airSessionId → live capture state. Only open sessions appear here. */
const active = new Map();

const ensureDir = () => { if (!existsSync(CAPTURE_DIR)) mkdirSync(CAPTURE_DIR, { recursive: true }); };

/**
 * Minimal HLS media-playlist parse: segment URIs in order, with durations and
 * the media sequence so we can tell new segments from ones we already hold.
 * Deliberately not a full m3u8 implementation — we need the segment list and
 * nothing else, and a dependency here would be a supply-chain surface for a
 * 20-line problem.
 */
export function parseMediaPlaylist(text, baseUrl) {
  const lines = String(text).split(/\r?\n/);
  let mediaSequence = 0;
  let pendingDuration = 0;
  let pendingPdtMs = null;
  const segments = [];
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.split(':')[1]) || 0;
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.split(':')[1]) || 0;
    } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      // A WALL CLOCK, when the platform stamps one (pump.fun stamps every
      // segment; Twitch and Kick stamp none). Carried per segment because it
      // is the one thing that can replace timeline calibration outright: a
      // capture whose segments know their own wall time needs no probing to
      // map a code's issue time onto media.
      const t = Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length).trim());
      pendingPdtMs = Number.isFinite(t) ? t : null;
    } else if (line && !line.startsWith('#')) {
      segments.push({
        uri: new URL(line, baseUrl).toString(),
        durationS: pendingDuration,
        seq: mediaSequence + segments.length,
        ...(pendingPdtMs != null ? { pdtMs: pendingPdtMs } : {}),
      });
      pendingDuration = 0;
      pendingPdtMs = null;
    }
  }
  return { mediaSequence, segments };
}


/**
 * Only the tail of a playlist is worth fetching.
 *
 * A rolling buffer holds `windowMs` of media, so anything older than that is
 * evicted the moment it arrives — downloading it is pure waste. On a Twitch or
 * Kick playlist that costs nothing either way, because their playlists SLIDE
 * and list about six segments.
 *
 * It is not nothing everywhere. MEASURED on a real pump.fun broadcast
 * (2026-08-25): their media playlist is APPEND-ONLY — `EXT-X-MEDIA-SEQUENCE`
 * stays at 0, there is no `EXT-X-ENDLIST`, and the list simply grows. A
 * stream 100 minutes in listed 3,063 segments in a 320 kB playlist, and at
 * ~800 kB per 1080p60 segment a naive first poll would have tried to download
 * ~2.4 GB of back catalogue before reaching the live edge.
 *
 * Taking the tail makes the first poll start AT the live edge on any playlist
 * shape, which is the only place a live capture should ever start.
 *
 * @param {number} keepMs how much media to keep. A margin over the window is
 *   deliberate: eviction is by media duration, and starting exactly at the
 *   boundary would leave the buffer one segment short of a full window.
 */
export function liveEdgeSlice(segments, keepMs) {
  if (!Array.isArray(segments) || !segments.length) return [];
  let acc = 0;
  let i = segments.length;
  while (i > 0 && acc < keepMs) {
    i -= 1;
    acc += (segments[i].durationS || 0) * 1000;
  }
  return segments.slice(i);
}

/**
 * The in-memory ring for one air session. Holds at most `windowMs` of media
 * and drops the oldest as new segments arrive.
 */
export class RollingBuffer {
  constructor({ windowMs = bountyConfig.captureWindowMs } = {}) {
    this.windowMs = windowMs;
    this.segments = []; // { seq, uri, durationS, bytes: Buffer, fetchedAt }
    this.highWaterSeq = -1; // highest seq ever pushed — see has()
  }

  /** Total media duration currently held, in ms. */
  get spanMs() {
    return this.segments.reduce((a, s) => a + s.durationS * 1000, 0);
  }

  get bytes() {
    return this.segments.reduce((a, s) => a + s.bytes.length, 0);
  }

  /**
   * "Already fetched?" must cover EVICTED segments, not just held ones.
   *
   * The first implementation checked only the live ring. On a SLIDING
   * playlist (Twitch, Kick) that was accidentally sufficient — old segments
   * leave the playlist and never resurface. On an APPEND-ONLY playlist
   * (pump.fun) every past segment stays listed forever, so the moment the
   * window evicted one, the next poll saw it as new and re-downloaded it —
   * measured at 205 fetches of 40 backlog segments in under ten seconds,
   * every 250ms, for the length of the broadcast. The high-water mark is the
   * fix: sequence numbers only move forward, so anything at or below it has
   * been fetched once already, held or not.
   */
  has(seq) {
    return seq <= this.highWaterSeq || this.segments.some((s) => s.seq === seq);
  }

  /** Append and evict, oldest first, until the window fits. */
  push(seg) {
    if (Number.isFinite(seg?.seq)) this.highWaterSeq = Math.max(this.highWaterSeq, seg.seq);
    this.segments.push(seg);
    // Evict by MEDIA duration, not by wall clock: a stall that stops segments
    // arriving must not silently empty the buffer we are about to freeze.
    while (this.segments.length > 1 && this.spanMs > this.windowMs) {
      this.segments.shift();
    }
    return this;
  }

  /** One playable MPEG-TS byte range covering everything held. */
  concat() {
    return Buffer.concat(this.segments.map((s) => s.bytes));
  }
}

/**
 * Begin capturing for an OPEN air session. No-op if already running, so a
 * retried open cannot start two pollers against one session.
 */
export async function startCapture(airSessionId, {
  hlsUrl, platform, handle, log = console, fetchImpl = fetch,
} = {}) {
  if (!bountyConfig.selfCaptureEnabled) return null;
  if (active.has(airSessionId)) return active.get(airSessionId);
  if (!hlsUrl) throw new Error('startCapture requires a live HLS url');

  const state = {
    airSessionId, platform, handle, hlsUrl,
    buffer: new RollingBuffer(),
    stopped: false,
    pollTimer: null,
    errors: 0,
    startedAt: Date.now(),
  };
  active.set(airSessionId, state);

  const poll = async () => {
    if (state.stopped) return;
    try {
      const res = await fetchImpl(state.hlsUrl, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`playlist ${res.status}`);
      const { segments } = parseMediaPlaylist(await res.text(), state.hlsUrl);
      // START AT THE LIVE EDGE. Everything older than the window is evicted on
      // arrival, so fetching it buys nothing — and on an append-only playlist
      // it is the difference between a few hundred kB and a few gigabytes.
      const fresh = liveEdgeSlice(segments, bountyConfig.captureWindowMs * 1.5);
      if (fresh.length < segments.length && !state.trimmedOnce) {
        state.trimmedOnce = true;
        log.log?.(`[capture] playlist lists ${segments.length} segments; starting at the `
          + `live edge with the last ${fresh.length}`);
      }
      for (const seg of fresh) {
        if (state.stopped) return;
        if (state.buffer.has(seg.seq)) continue;
        const r = await fetchImpl(seg.uri, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) continue;
        const bytes = Buffer.from(await r.arrayBuffer());
        state.buffer.push({ ...seg, bytes, fetchedAt: Date.now() });
      }
      state.errors = 0;
    } catch (e) {
      // A capture that dies silently is worse than one that never ran: the
      // streamer would be verified against nothing and told nothing.
      state.errors += 1;
      if (state.errors === 1 || state.errors % 10 === 0) {
        log.warn?.(`[capture] ${airSessionId} poll failed (${state.errors}): ${e.message}`);
      }
    } finally {
      if (!state.stopped) {
        state.pollTimer = setTimeout(poll, bountyConfig.capturePollMs);
      }
    }
  };
  void poll();
  log.log?.(`[capture] rolling ${Math.round(bountyConfig.captureWindowMs / 1000)}s buffer started for ${airSessionId}`);
  return state;
}

/**
 * Freeze what is currently buffered and persist it as the capture for one
 * playback. Called when a clip playback ENDS — by then the segments carrying
 * it have had time to arrive despite the broadcast delay.
 */
export function freezeWindow(airSessionId, { playbackId, clipId, log = console } = {}) {
  const state = active.get(airSessionId);
  if (!state) {
    // Not an assertion failure to report upward — but never silently "succeed".
    log.warn?.(`[capture] freeze requested for ${airSessionId} with no running capture`);
    return null;
  }
  if (!state.buffer.segments.length) {
    log.warn?.(`[capture] nothing buffered for ${airSessionId} at freeze time`);
    return null;
  }
  ensureDir();
  const file = path.join(CAPTURE_DIR, `${airSessionId}__${playbackId || clipId || 'window'}.ts`);
  const bytes = state.buffer.concat();
  writeFileSync(file, bytes);
  const first = state.buffer.segments[0];
  const record = {
    airSessionId, playbackId: playbackId || null, clipId: clipId || null,
    file, bytes: bytes.length,
    segments: state.buffer.segments.length,
    spanMs: Math.round(state.buffer.spanMs),
    frozenAt: Date.now(),
    // The first held segment's PROGRAM-DATE-TIME, when the platform stamps
    // one: the capture's media t=0 in WALL CLOCK, exact. Null on platforms
    // that do not stamp (Twitch, Kick) — calibration measures those instead.
    firstPdtMs: Number.isFinite(first?.pdtMs) ? first.pdtMs : null,
  };
  // Evidence, same append-only treatment as the clip index and the ledger:
  // a payout computed FROM this capture must be able to point at it.
  evidence.recordCaptureFrozen(airSessionId, record);
  log.log?.(`[capture] froze ${(bytes.length / 1e6).toFixed(1)}MB / ${record.spanMs}ms for ${playbackId || clipId}`);
  return record;
}

/** Stop capturing and release the buffer. Idempotent. */
export function stopCapture(airSessionId, { log = console } = {}) {
  const state = active.get(airSessionId);
  if (!state) return false;
  state.stopped = true;
  if (state.pollTimer) clearTimeout(state.pollTimer);
  state.buffer.segments = []; // the held media goes away with the session
  active.delete(airSessionId);
  log.log?.(`[capture] stopped for ${airSessionId}`);
  return true;
}

/** Is a capture running for this session? The gate asserts on this. */
export const isCapturing = (airSessionId) => active.has(airSessionId);
export const activeCount = () => active.size;
/** Test seam: the live buffer, for asserting the window really rolls. */
export const _bufferFor = (airSessionId) => active.get(airSessionId)?.buffer || null;

/** Every persisted capture for a session. */
export function capturesFor(airSessionId) {
  ensureDir();
  return readdirSync(CAPTURE_DIR)
    .filter((f) => f.startsWith(`${airSessionId}__`))
    .map((f) => path.join(CAPTURE_DIR, f));
}

/**
 * Every capture a session holds, WITH the playback each one covers.
 *
 * `capturesFor` returns bare paths, which is enough to purge but not enough to
 * verify: one capture covers ONE clip playback's ~60s window, so a verifier
 * handed only the first file can read nothing about any other clip. That was a
 * real failure — a multi-clip session could never calibrate its timeline,
 * because every probe after the first seeked outside the only file it had, so
 * self-capture verification returned SOURCE_UNAVAILABLE on the path that is
 * supposed to be primary.
 *
 * The playback id is in the filename by construction (see freezeWindow), and
 * `frozenAt` comes from the evidence chain, falling back to the file's mtime
 * for captures written before that record existed.
 */
export function captureRecordsFor(airSessionId, { log = console } = {}) {
  const files = capturesFor(airSessionId);
  if (!files.length) return [];
  let frozenByFile = new Map();
  try {
    // Keyed on the FILE, which the evidence row records verbatim. Keying on
    // the playback id looked tidier and did not work: a capture frozen from a
    // clipId-only call recorded a null playbackId while its filename carried
    // the clip id, so nothing matched and every capture lost its anchor.
    frozenByFile = new Map(evidence.evidenceFor(airSessionId)
      .filter((r) => r.type === evidence.EVIDENCE_TYPES.CAPTURE_FROZEN && r.file)
      .map((r) => [path.basename(String(r.file)), r]));
  } catch (e) {
    // A verification must not die because the evidence chain is unreadable —
    // mtime is a worse anchor, not a useless one, and calibration measures the
    // residual anyway.
    log.warn?.(`[capture] could not read evidence for ${airSessionId}: ${e?.message}`);
  }
  return files.map((file) => {
    const base = path.basename(file).replace(/\.ts$/, '');
    const rec = frozenByFile.get(path.basename(file));
    // The evidence row is authoritative for which playback this covers; the
    // filename is the fallback for captures written before it was recorded.
    const playbackId = rec?.playbackId || base.slice(`${airSessionId}__`.length) || null;
    let frozenAt = rec?.at || rec?.frozenAt || null;
    if (!frozenAt) {
      try { frozenAt = statSync(file).mtimeMs; } catch { frozenAt = null; }
    }
    // spanMs is the buffer's OWN measurement, summed from the playlist's
    // EXTINF durations at freeze time. It is the trustworthy duration: a
    // byte-concatenated MPEG-TS reports whatever its FIRST segment claims when
    // the segments do not share a continuous timeline, and a seek computed
    // from that lands nowhere. See CaptureFrameSource.durationS.
    return {
      file, playbackId, clipId: rec?.clipId || null, frozenAt,
      spanMs: rec?.spanMs ?? null,
      firstPdtMs: Number.isFinite(rec?.firstPdtMs) ? rec.firstPdtMs : null,
    };
  }).filter((r) => r.frozenAt);
}

/**
 * Delete a session's captures. Called when its pledge is refunded or purged —
 * a verification capture outlives neither the claim it proves nor the money it
 * proved it for.
 */
export function purgeCaptures(airSessionId, { log = console } = {}) {
  const files = capturesFor(airSessionId);
  let bytes = 0;
  for (const f of files) {
    try { bytes += statSync(f).size; unlinkSync(f); } catch { /* already gone */ }
  }
  if (files.length) log.log?.(`[capture] purged ${files.length} capture(s), ${(bytes / 1e6).toFixed(1)}MB`);
  return { files: files.length, bytes };
}

/** Age-based sweep, so an abandoned session cannot leave media forever. */
export function purgeExpiredCaptures({ now = Date.now(), log = console } = {}) {
  ensureDir();
  const ttl = bountyConfig.captureRetentionMs;
  let purged = 0, bytes = 0;
  for (const f of readdirSync(CAPTURE_DIR)) {
    const full = path.join(CAPTURE_DIR, f);
    try {
      const st = statSync(full);
      if (now - st.mtimeMs > ttl) { bytes += st.size; unlinkSync(full); purged += 1; }
    } catch { /* raced with another sweep */ }
  }
  if (purged) log.log?.(`[capture] retention sweep removed ${purged} capture(s), ${(bytes / 1e6).toFixed(1)}MB`);
  return { purged, bytes };
}

export const captureDir = () => CAPTURE_DIR;
