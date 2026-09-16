/**
 * AIRINGS — one record per broadcast a room went through, and the moments
 * inside it worth showing someone.
 *
 * This is the record nothing else could be built on. The pieces a "recently
 * aired" board needs already existed and were proven on real broadcasts — VOD
 * discovery (frame-sources.js, Helix /videos?type=archive), our own rolling
 * HLS capture when a platform keeps no replay (bounty-capture.js), and clip
 * playback times (bounty-clips.js) — but every one of them is keyed to a
 * BOUNTY AIR SESSION. A room that never touched the bounty program left no
 * trace at all, so the board had nothing to show and the front end fell back
 * to a branded animated thumb.
 *
 * WHAT A MOMENT IS FOR. `at` is absolute wall-clock, and the offset into the
 * recording is `at - startedAt`. That is the whole point of the feature: a
 * card does not open a two-hour VOD at zero, it opens at the second a
 * MegaChat played or a guest took a seat, and that same frame is the
 * thumbnail. Storing an absolute time rather than a pre-computed offset means
 * a VOD attached later — they show up minutes after a broadcast ends — is
 * still seekable without rewriting anything.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It never fetches. Resolving a VOD,
 * capturing HLS and rendering a card all belong to their own layers; this
 * file only remembers what happened and when. It is also append-mostly: a
 * closed airing is history, and history that rewrites itself is not evidence.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'airings.json');

// Per room, because the interesting question is "what did THIS room do
// lately", and an unbounded file on a small volume is a slow outage.
const KEEP_PER_ROOM = 20;
// A broadcast that produced nothing to look at is not worth a card. Kept
// anyway (it is cheap, and "you aired and nobody came" is real information
// the dashboard may want), but callers asking for board content filter it.
const MAX_MOMENTS = 200;

/** @type {{ airings: any[] }} */
let state = { airings: [] };
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (raw && Array.isArray(raw.airings)) state.airings = raw.airings;
  } catch {
    state = { airings: [] }; // absent or corrupt → start clean, never throw at boot
  }
}

function persist() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    // A board that cannot remember is a degraded board, not a broken room —
    // never let this take a broadcast down with it.
    console.warn(`[airings] could not persist: ${e.message}`);
  }
}

function prune(roomId) {
  const mine = state.airings.filter((a) => a.roomId === roomId);
  if (mine.length <= KEEP_PER_ROOM) return;
  const doomed = new Set(
    mine.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(KEEP_PER_ROOM).map((a) => a.id),
  );
  state.airings = state.airings.filter((a) => !doomed.has(a.id));
}

/** The airing currently open for a room, or null. */
export function openAiringFor(roomId) {
  load();
  return state.airings.find((a) => a.roomId === roomId && a.endedAt == null) || null;
}

/**
 * Begin an airing. Idempotent: a room already on air keeps the record it has,
 * so a restart or a double edge cannot split one broadcast into two cards.
 */
export function openAiring({ roomId, channel = null, platform = 'twitch', resumeWithinMs = 0 }) {
  load();
  const existing = openAiringFor(roomId);
  if (existing) return existing;
  // A blip is not an ending — the same principle the pause logic runs on. A
  // stream that drops and returns inside the grace window REOPENS the airing
  // it just closed instead of starting a second one, because two cards for
  // one broadcast is exactly the noise a "recently aired" board cannot
  // afford. The moments already recorded keep their offsets, which stay
  // correct because startedAt never moved.
  if (resumeWithinMs > 0) {
    const last = state.airings
      .filter((a) => a.roomId === roomId && a.endedAt != null)
      .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))[0];
    if (last && Date.now() - last.endedAt <= resumeWithinMs) {
      last.endedAt = null;
      persist();
      return last;
    }
  }
  const airing = {
    id: randomUUID(),
    roomId,
    platform,
    channel: channel ? String(channel).trim().replace(/^@/, '').toLowerCase() : null,
    startedAt: Date.now(),
    endedAt: null,
    // Filled in by whoever resolves it, minutes to hours later. Null is a
    // real answer: plenty of broadcasts never get a replay.
    vodId: null,
    vodUrl: null,
    /** Our own capture, when the platform kept nothing. */
    captureRef: null,
    moments: [],
  };
  state.airings.push(airing);
  prune(roomId);
  persist();
  return airing;
}

/** End the open airing for a room. No-op when none is open. */
export function closeAiring(roomId, endedAt = Date.now()) {
  load();
  const a = openAiringFor(roomId);
  if (!a) return null;
  a.endedAt = endedAt;
  persist();
  return a;
}

/**
 * Record something worth seeking to. Silently does nothing when the room is
 * not on air — a seat taken in a room whose owner never streams is a normal
 * thing that happens, not an error, and this must never be in a position to
 * throw inside a seat or letter path.
 */
export function addMoment(roomId, { kind, label = null, at = Date.now() }) {
  load();
  const a = openAiringFor(roomId);
  if (!a) return null;
  if (a.moments.length >= MAX_MOMENTS) return null;
  const moment = { at, kind, label, offsetMs: Math.max(0, at - a.startedAt) };
  a.moments.push(moment);
  persist();
  return moment;
}

/** Attach a replay to an airing once something has resolved one. */
export function attachRecording(airingId, { vodId = null, vodUrl = null, captureRef = null }) {
  load();
  const a = state.airings.find((x) => x.id === airingId);
  if (!a) return null;
  if (vodId !== null) a.vodId = vodId;
  if (vodUrl !== null) a.vodUrl = vodUrl;
  if (captureRef !== null) a.captureRef = captureRef;
  persist();
  return a;
}

/** Everything known about one room, newest first. */
export function listAirings(roomId, { limit = KEEP_PER_ROOM } = {}) {
  load();
  return state.airings
    .filter((a) => a.roomId === roomId)
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    .slice(0, limit);
}

/**
 * Board content: finished airings across all rooms, newest first.
 *
 * `withContent` is the default because the board's job is to look alive. An
 * airing with no moment and no recording has nothing to put on a card, and
 * showing it would be the empty board wearing a costume.
 */
export function recentAirings({ limit = 12, withContent = true } = {}) {
  load();
  return state.airings
    .filter((a) => a.endedAt != null)
    .filter((a) => (withContent ? a.moments.length > 0 || a.vodUrl || a.captureRef : true))
    .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))
    .slice(0, limit);
}

/** Test seam — the gates run several servers against one process-wide module. */
export function _resetForTests() {
  state = { airings: [] };
  loaded = true;
}
