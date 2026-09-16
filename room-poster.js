/**
 * ROOM POSTERS — the frame a finished room shows on the recent rail.
 *
 * A recent-room card should show what the room looked like when somebody was
 * actually on camera, not a placeholder and not the last frame of the stream
 * (which is an end card or black).
 *
 * WHERE THE POSTER LIVES, and why it is not in bounty-captures/. The capture
 * directory is swept by `purgeExpiredCaptures` at 14 days and emptied per
 * session by `purgeCaptures` when a pledge is refunded. A poster that lived
 * there would vanish on either, and a recent rail that goes blank after two
 * weeks is worse than one that never had pictures. Posters get their own
 * directory that nothing sweeps, and the JPEG is extracted ONCE at air-session
 * close — after that the source capture can be purged on schedule and the card
 * is unaffected.
 *
 * WHICH FRAME. The requirement prefers peak seat count and falls back to the
 * midpoint of the longest clip playback. The rule here is the fallback. When it
 * was written, peak was not derivable: `moments` recorded joins and not leaves,
 * so the running count was monotonic and "peak" degenerated to "the last person
 * who joined". server.js records `seat_leave` now, so peak IS derivable from
 * any airing written after that landed. Switching the rule over is a deliberate
 * follow-up, not done here: nothing has yet measured whether the two rules pick
 * different seconds on a real capture, and until they are shown to disagree the
 * midpoint of the longest playback stands — the deepest point of the longest
 * stretch the room was in use, and far from both the join stinger and the end
 * card.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
export const POSTER_DIR = path.join(DATA_DIR, 'room-posters');

/** Small on purpose: this is a card thumbnail, not an archive. */
const POSTER_W = 640;
const JPEG_Q = 4; // ffmpeg -q:v, 2..31, lower is better

const ensureDir = () => { if (!fs.existsSync(POSTER_DIR)) fs.mkdirSync(POSTER_DIR, { recursive: true }); };

export function posterPathFor(roomId) {
  return path.join(POSTER_DIR, `${String(roomId).replace(/[^a-z0-9_-]/gi, '')}.jpg`);
}

/**
 * Pick the capture to poster from, and the offset within it.
 *
 * `spanMs` is the buffer's own measurement and the only trustworthy duration —
 * a byte-concatenated MPEG-TS reports whatever its first segment claims when
 * the segments do not share a continuous timeline, so a seek computed from the
 * container lands nowhere (see CaptureFrameSource.durationS).
 */
export function chooseFrame(records) {
  const usable = (records || []).filter((r) => Number.isFinite(r.spanMs) && r.spanMs > 0);
  if (!usable.length) return null;
  const longest = usable.reduce((a, b) => (b.spanMs > a.spanMs ? b : a));
  return { file: longest.file, offsetS: (longest.spanMs / 2) / 1000, playbackId: longest.playbackId, spanMs: longest.spanMs };
}

/**
 * Extract the poster. Returns a descriptor, or null when there is nothing to
 * extract from — a room with no capture is a normal case, not a failure, and
 * the caller draws a card instead.
 */
export function buildPoster(roomId, records, { log = console } = {}) {
  const pick = chooseFrame(records);
  if (!pick) return null;
  ensureDir();
  const out = posterPathFor(roomId);
  const r = spawnSync('ffmpeg', [
    '-v', 'error', '-y',
    '-ss', String(pick.offsetS), '-i', pick.file,
    '-frames:v', '1', '-vf', `scale=${POSTER_W}:-2`, '-q:v', String(JPEG_Q),
    out,
  ], { encoding: 'utf8', timeout: 60000 });
  // EXIT 0 IS NOT PROOF A FRAME EXISTS — ffmpeg seeking past the end of a file
  // exits 0, prints nothing, and writes no output. The same trap frame-sources
  // documents at grabFrame; checking the file is the only honest test.
  if (r.status !== 0 || !fs.existsSync(out) || fs.statSync(out).size === 0) {
    log.warn?.(`[poster] no frame for room ${roomId}: ${String(r.stderr || 'ffmpeg wrote nothing').slice(0, 160)}`);
    return null;
  }
  return {
    kind: 'frame',
    at: Date.now(),
    source: 'capture',
    playbackId: pick.playbackId || null,
    offsetMs: Math.round(pick.offsetS * 1000),
    spanMs: pick.spanMs,
    bytes: fs.statSync(out).size,
  };
}

/**
 * The no-capture case: a SNAPSHOT of the room at close, not a screenshot.
 *
 * Capture only runs during a bounty air session, so a plain MegaChat room or a
 * live-seat room has no real frame and never will. Rendering something
 * photographic would be a lie about what we have, so the card is explicitly a
 * card — the rail draws it in the house style with no video treatment, and the
 * `kind` field is what tells it which to draw.
 *
 * The values are FROZEN HERE rather than derived at render time, so the rail
 * reads one field off the room record and never walks a seat list: the same
 * single-source rule effectiveMaxSeats follows.
 */
export function buildCard(airing, { title = null } = {}) {
  // Leaves are bookkeeping for the seat count, never a moment in their own right.
  const shown = (airing?.moments || []).filter((m) => m.kind !== 'seat_leave');
  const guests = [];
  for (const m of shown) {
    if (m.label && !guests.includes(m.label)) guests.push(m.label);
    if (guests.length >= 4) break;
  }
  return {
    kind: 'card',
    at: Date.now(),
    source: null,
    title: title || null,
    guests,
    momentCount: shown.length,
    durationMs: airing?.endedAt && airing?.startedAt ? Math.max(0, airing.endedAt - airing.startedAt) : null,
  };
}
