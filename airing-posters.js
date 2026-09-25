/**
 * AIRING POSTERS — the real picture a "Recently aired" card shows.
 *
 * WHY THIS EXISTS. The only picture path the board had (room-poster.js) runs
 * at the close of a BOUNTY air session, and only when a clip played. An
 * ordinary broadcast — the owner streaming Rocket League with guests on camera
 * for four hours — never touched it, so its card was a letter on a grey box
 * captioned "No recording" while Twitch held two full recordings of it.
 *
 * WHERE THE PICTURE COMES FROM, best first (RANK):
 *   capture                our own capture, from a bounty air session
 *   twitch-vod             a frame pulled from the recording at a chosen second
 *                          (needs ffmpeg + an extractor; production has neither,
 *                          so today this is only ever written by hand)
 *   twitch-preview         Twitch's live preview image, saved WHILE the stream
 *                          is up, picked at close from when a guest was on
 *   twitch-vod-thumbnail   the thumbnail Twitch generates for the recording —
 *                          a real frame of the broadcast, but Twitch's choice;
 *                          only for a broadcast that HAD a seat or MegaChat and
 *                          no preview that could show it
 * A poster is only ever replaced by one of equal or better rank.
 *
 * WHICH FRAME. The owner's rule: "a frame from when the MegaChat or live seat
 * was actually up" — never the last frame (an end card or black), never a
 * guess. A preview is refreshed by Twitch about every five minutes, so one
 * fetched at time T shows the stream at some point in the five minutes before
 * T. The pick is the preview nearest the middle of the longest stretch with
 * the most guests on camera (or, with no seats at all, a MegaChat playing),
 * restricted to previews that could show that stretch — and a preview from the
 * first minutes (a starting screen) or the last (an end card) only when no
 * other could. A broadcast with no seat and no MegaChat gets NO preview poster:
 * nothing happened on it that the rule would let us show.
 *
 * A RESTART ENDS EVERY SEAT. Seats live in memory; a deploy mid-broadcast drops
 * them without a seat_leave, so the server writes a `restart` moment into every
 * open airing at boot (airings-store.markRestart) and the spans stop there.
 * Without it one guest who sat for five minutes before a deploy would "stay on"
 * for the rest of the stream, and the poster would land hours after they left.
 *
 * ON DISK, per airing and never per room (a room airs many times):
 *   airing-posters/<airingId>.jpg + .json          the poster and what it is
 *   airing-posters/candidates/<airingId>/<t>.jpg   previews saved during it
 * Files, not a field on the airings store: a poster written by hand or by the
 * sweeper can never race the store's own writes. Nothing here sweeps on the
 * 14-day capture schedule — a rail that goes blank after two weeks is worse
 * than one that never had pictures.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
export const AIRING_POSTER_DIR = path.join(DATA_DIR, 'airing-posters');
const CANDIDATE_ROOT = path.join(AIRING_POSTER_DIR, 'candidates');

// Overridable for tests, like TWITCH_API_BASE — nothing in production sets it.
const PREVIEW_BASE = () => (process.env.TWITCH_PREVIEW_BASE || 'https://static-cdn.jtvnw.net').replace(/\/$/, '');

export const RANK = { capture: 4, 'twitch-vod': 3, 'twitch-preview': 2, 'twitch-vod-thumbnail': 1 };

// Twitch's offline, still-processing and missing images all live under these.
const PLACEHOLDER = /404_preview|404_processing|ttv-static|_404\//i;
// A real 640x360 frame of a broadcast is 25-45 KB. The offline placeholder is
// ~6.8 KB and a near-black frame 3-5 KB (measured 2026-09-25): neither is a
// picture of anything, and a card that shows one is worse than a card.
const MIN_BYTES = Number(process.env.POSTER_MIN_BYTES) || 12_000;
const MAX_BYTES = 2_000_000;

const SNAPSHOT_EVERY_MS = Number(process.env.POSTER_SNAPSHOT_MS) || 120_000;
const MAX_CANDIDATES = 150; // ~5 hours of distinct previews; thinned evenly past that
// Across every airing: ~40 KB each, so ~120 MB of a small volume at most. Past
// this, new previews are simply not kept until the sweep has cleared some.
const MAX_TOTAL_CANDIDATES = Number(process.env.POSTER_MAX_TOTAL_CANDIDATES) || 3000;
const MEGACHAT_SPAN_MS = 90_000; // a MegaChat is on screen for well under this
const PREVIEW_WINDOW_MS = 5 * 60_000; // a preview shows the stream up to 5 min before it was fetched
const EDGE_START_MS = 3 * 60_000; // starting screens
const EDGE_END_MS = 5 * 60_000; // end cards
const CANDIDATES_KEPT_AFTER_CLOSE_MS = 60 * 60_000; // a blip can reopen an airing; keep them that long
const SWEEP_WINDOW_MS = 14 * 24 * 60 * 60_000;
// Recordings appear minutes after the end. `??`, not `||`: a gate sets 0.
const VOD_WAIT_MS = Number(process.env.POSTER_VOD_WAIT_MS ?? 10 * 60_000);
const RETRY_STEPS_MS = [10, 30, 120, 360, 1440].map((m) => m * 60_000);

const safeId = (id) => String(id || '').replace(/[^a-z0-9-]/gi, '');
export const posterFileFor = (airingId) => path.join(AIRING_POSTER_DIR, `${safeId(airingId)}.jpg`);
const metaFileFor = (airingId) => path.join(AIRING_POSTER_DIR, `${safeId(airingId)}.json`);
const candidateDirFor = (airingId) => path.join(CANDIDATE_ROOT, safeId(airingId));

const isJpeg = (buf) => !!buf && buf.length >= MIN_BYTES && buf.length <= MAX_BYTES && buf[0] === 0xff && buf[1] === 0xd8;
const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// ── reading ────────────────────────────────────────────────────────────────

// The board asks on every poll; a poster written by the sweeper (or by hand)
// must show up without a restart — so a short memo of posters that EXIST.
// Misses are never memoised: the poster URL is public, and remembering every
// id anyone asks about is memory a stranger could fill.
const metaMemo = new Map(); // airingId → { meta, checkedAt }
const MEMO_MS = 30_000;

/** What the poster for an airing is, or null when it has none. */
export function readAiringPoster(airingId) {
  const id = safeId(airingId);
  if (!id) return null;
  const hit = metaMemo.get(id);
  if (hit && Date.now() - hit.checkedAt < MEMO_MS) return hit.meta;
  metaMemo.delete(id);
  if (!fs.existsSync(posterFileFor(id))) return null;
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(metaFileFor(id), 'utf8'));
    if (!meta || meta.kind !== 'frame' || !(meta.source in RANK)) meta = null;
  } catch {
    meta = null; // a JPEG with no readable description is not something to vouch for
  }
  if (meta) metaMemo.set(id, { meta, checkedAt: Date.now() });
  return meta;
}

/**
 * Save a poster unless a better one is already there. Returns the meta that
 * now describes the airing's poster (the new one, or the one it lost to).
 */
export function saveAiringPoster(airingId, buf, meta, { log = console } = {}) {
  const id = safeId(airingId);
  if (!id || !isJpeg(buf) || !(meta?.source in RANK)) return readAiringPoster(id);
  metaMemo.delete(id);
  const current = readAiringPoster(id);
  if (current && RANK[current.source] > RANK[meta.source]) return current;
  const full = { kind: 'frame', ...meta, at: Date.now(), bytes: buf.length };
  writeAtomic(posterFileFor(id), buf);
  writeAtomic(metaFileFor(id), JSON.stringify(full, null, 2));
  metaMemo.delete(id);
  log.log?.(`[poster] airing ${id}: ${meta.source} (${buf.length} bytes)`);
  return full;
}

// ── fetching ───────────────────────────────────────────────────────────────

/** A JPEG from Twitch's CDN, or null for a placeholder, a black frame, or a miss. */
export async function fetchFrame(url, { timeoutMs = 8000 } = {}) {
  try {
    let target = url;
    for (let hop = 0; hop < 4; hop++) {
      if (PLACEHOLDER.test(target)) return null;
      const r = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (!loc) return null;
        target = new URL(loc, target).toString();
        continue;
      }
      if (r.status !== 200) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      return isJpeg(buf) ? buf : null;
    }
  } catch { /* network/timeout: a miss, never an error for a broadcast */ }
  return null;
}

// ── during the broadcast: save previews ────────────────────────────────────

const lastSnap = new Map(); // airingId → { at, hash }
let totalCandidates = null; // counted by the sweep; null until the first count

function countAllCandidates() {
  let n = 0;
  try {
    for (const d of fs.readdirSync(CANDIDATE_ROOT)) n += listCandidates(d).length;
  } catch { /* none yet */ }
  totalCandidates = n;
  return n;
}

export function listCandidates(airingId) {
  const dir = candidateDirFor(airingId);
  try {
    return fs.readdirSync(dir)
      .filter((f) => /^\d+\.jpg$/.test(f))
      .map((f) => ({ at: Number(f.slice(0, -4)), file: path.join(dir, f) }))
      .sort((a, b) => a.at - b.at);
  } catch {
    return [];
  }
}

/** Past the cap, drop the candidate whose neighbours are closest together, so
 *  what remains still covers the whole broadcast evenly. */
function thin(airingId) {
  const c = listCandidates(airingId);
  while (c.length > MAX_CANDIDATES) {
    let best = 1;
    for (let i = 2; i < c.length - 1; i++) {
      if (c[i + 1].at - c[i - 1].at < c[best + 1].at - c[best - 1].at) best = i;
    }
    try { fs.unlinkSync(c[best].file); if (totalCandidates) totalCandidates--; } catch { /* already gone */ }
    c.splice(best, 1);
  }
}

/**
 * Called on every follow tick while a broadcast is live; saves at most one
 * preview per SNAPSHOT_EVERY_MS, and only when Twitch has refreshed it. Never
 * throws and never blocks the tick that calls it.
 */
export async function snapshotLivePreview(airing, login, { now = Date.now(), log = console } = {}) {
  if (!airing?.id || !login) return null;
  const prev = lastSnap.get(airing.id);
  if (prev && now - prev.at < SNAPSHOT_EVERY_MS) return null;
  lastSnap.set(airing.id, { at: now, hash: prev?.hash || null });
  const url = `${PREVIEW_BASE()}/previews-ttv/live_user_${encodeURIComponent(String(login).toLowerCase())}-640x360.jpg`;
  const buf = await fetchFrame(url);
  if (!buf) return null;
  const hash = sha1(buf);
  if (prev?.hash === hash) return null; // Twitch has not refreshed it yet
  lastSnap.set(airing.id, { at: now, hash });
  if ((totalCandidates ?? countAllCandidates()) >= MAX_TOTAL_CANDIDATES) {
    log.warn?.(`[poster] preview not kept for ${airing.id}: ${MAX_TOTAL_CANDIDATES} previews already on disk`);
    return null;
  }
  try {
    writeAtomic(path.join(candidateDirFor(airing.id), `${now}.jpg`), buf);
    totalCandidates = (totalCandidates ?? 0) + 1;
    thin(airing.id);
  } catch (e) {
    log.warn?.(`[poster] could not keep a preview for ${airing.id}: ${e.message}`);
    return null;
  }
  return { at: now, bytes: buf.length };
}

// ── choosing ───────────────────────────────────────────────────────────────

/** Did anything happen on this broadcast that the owner's rule lets us show?
 *  A seat or a MegaChat, or our own capture. The board shows nothing else. */
export function hasContent(airing) {
  return !!airing && ((airing.moments || []).some((m) => m.kind === 'seat' || m.kind === 'megachat') || !!airing.captureRef);
}

/**
 * Stretches with somebody on camera, and how many, from the airing's moments.
 * Counted per name (a null name counts as one anonymous guest), so a second
 * guest with the same name, or a leave with no join, cannot make the crowd go
 * wrong; a `restart` moment ends every seat (see the header).
 */
export function seatSpans(airing, end = airing?.endedAt ?? Date.now()) {
  const moments = [...(airing?.moments || [])]
    .filter((m) => m.kind === 'seat' || m.kind === 'seat_leave' || m.kind === 'restart')
    .sort((a, b) => a.at - b.at);
  const on = new Map(); // name → how many of them are seated
  let count = 0;
  const spans = [];
  let from = null;
  const close = (t) => { if (from != null && count > 0 && t > from) spans.push({ from, to: t, count }); };
  for (const m of moments) {
    // Anything after the end (a boot's restart marker, when the stream ended
    // while the server was down) is not part of this broadcast.
    if (m.at >= end) break;
    close(m.at);
    if (m.kind === 'restart') {
      on.clear();
    } else {
      const who = m.label || '\u0000anon';
      const n = on.get(who) || 0;
      if (m.kind === 'seat') on.set(who, n + 1);
      else if (n > 0) on.set(who, n - 1);
    }
    count = [...on.values()].reduce((a, b) => a + b, 0);
    from = m.at;
  }
  close(end);
  return spans;
}

/** A MegaChat is on screen for a short while after it starts playing. */
function megachatSpans(airing, end) {
  return (airing?.moments || [])
    .filter((m) => m.kind === 'megachat')
    .map((m) => ({ from: m.at, to: Math.min(end, m.at + MEGACHAT_SPAN_MS), count: 1 }))
    .filter((s) => s.to > s.from);
}

/**
 * The second the poster should show: the middle of the longest stretch with
 * the most people on camera; with no seats at all, the first MegaChat. Null
 * when neither happened — there is then nothing the rule lets us show.
 */
export function posterTarget(airing) {
  const end = airing?.endedAt ?? Date.now();
  const seats = seatSpans(airing, end);
  if (seats.length) {
    const peak = Math.max(...seats.map((s) => s.count));
    const best = seats.filter((s) => s.count === peak).reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a));
    return { at: best.from + (best.to - best.from) / 2, spans: seats };
  }
  const chats = megachatSpans(airing, end);
  if (chats.length) return { at: chats[0].from + (chats[0].to - chats[0].from) / 2, spans: chats };
  return null;
}

/**
 * Pick among previews fetched at `at` (ms). Pure, so a gate can drive it.
 * Only a preview that could show a seat or a MegaChat is ever picked; one from
 * the opening or closing minutes only when no other could.
 */
export function pickCandidate(candidates, airing) {
  if (!candidates?.length) return null;
  const t = posterTarget(airing);
  if (!t) return null;
  const end = airing.endedAt ?? Date.now();
  const lo = airing.startedAt + EDGE_START_MS;
  const hi = end - EDGE_END_MS;
  // A preview fetched at T shows some instant in [T - 5min, T]: it can show
  // the stretch only if that window overlaps it.
  const couldShow = (c) => t.spans.some((s) => c.at > s.from && c.at - PREVIEW_WINDOW_MS < s.to);
  const shows = candidates.filter(couldShow);
  if (!shows.length) return null;
  const inner = shows.filter((c) => c.at >= lo && c.at <= hi);
  const from = inner.length ? inner : shows;
  // Aim half a window after the target — that preview most likely shows it —
  // but never past the closing minutes when the broadcast is long enough to
  // have a middle.
  let aim = t.at + PREVIEW_WINDOW_MS / 2;
  if (hi > lo) aim = Math.min(Math.max(aim, lo), hi);
  return from.reduce((a, b) => (Math.abs(b.at - aim) < Math.abs(a.at - aim) ? b : a));
}

/** At close (and again if a blip reopens and re-closes it): pick and save. */
export function finalizeAiringPoster(airing, { log = console } = {}) {
  try {
    const pick = pickCandidate(listCandidates(airing.id), airing);
    if (!pick) return null;
    const buf = fs.readFileSync(pick.file);
    return saveAiringPoster(airing.id, buf, { source: 'twitch-preview', fetchedAt: pick.at }, { log });
  } catch (e) {
    log.warn?.(`[poster] could not finalize ${airing?.id}: ${e.message}`);
    return null;
  }
}

/**
 * The last moment we KNOW the broadcast was up: its newest moment or kept
 * preview. Where an airing is closed when the stream ended while the server
 * was down — the real end is somewhere after this and we cannot know where.
 */
export function lastEvidenceAt(airing) {
  let t = airing?.startedAt || 0;
  for (const m of airing?.moments || []) if (m.kind !== 'restart' && m.at > t) t = m.at;
  const c = listCandidates(airing?.id);
  if (c.length && c[c.length - 1].at > t) t = c[c.length - 1].at;
  return t;
}

// ── after the broadcast: the recording ─────────────────────────────────────

function parseTwitchDuration(s) {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(String(s || ''));
  return m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : 0;
}

/**
 * Find the recording(s) of an airing on Twitch, attach the link, and — when
 * the airing has no poster yet — save the recording's thumbnail.
 * @returns {'saved'|'attached'|'pending'|'none'}
 */
export async function resolveFromRecording(airing, { helix, attachRecording, log = console }) {
  const login = String(airing.channel || '').toLowerCase();
  if (!login || airing.platform !== 'twitch') return 'none';
  const users = await helix(`/users?login=${encodeURIComponent(login)}`);
  const user = users?.data?.[0];
  if (!user) return 'none';
  const vids = await helix(`/videos?user_id=${encodeURIComponent(user.id)}&type=archive&first=20`);
  const end = airing.endedAt ?? Date.now();
  const target = posterTarget(airing)?.at ?? null;
  const overlapping = (vids?.data || []).map((v) => {
    const s = Date.parse(v.created_at);
    const e = s + parseTwitchDuration(v.duration) * 1000;
    return { v, s, e, overlap: Math.min(e, end) - Math.max(s, airing.startedAt - 5 * 60_000) };
  }).filter((x) => Number.isFinite(x.s) && x.overlap > 0);
  if (!overlapping.length) {
    // Looked up, and Twitch has none (VODs off, or not yet): say so, so the
    // replay can fall back to the kept clip or the picture instead of waiting
    // on a lookup forever. The sweep keeps retrying on its backoff.
    if (!Array.isArray(airing.recordings)) attachRecording(airing.id, { recordings: [] });
    return 'none';
  }
  const longest = overlapping.reduce((a, b) => (b.overlap > a.overlap ? b : a));
  // Every overlapping recording, with its start: the replay opens each moment
  // in the one that covers it (/api/rooms/:id/replay).
  const recordings = overlapping
    .sort((a, b) => a.s - b.s)
    .map((x) => ({ vodId: String(x.v.id), url: x.v.url, startMs: x.s, durationS: Math.round((x.e - x.s) / 1000) }));
  attachRecording(airing.id, {
    ...(airing.vodUrl ? {} : { vodId: String(longest.v.id), vodUrl: longest.v.url }),
    recordings,
  });
  if (readAiringPoster(airing.id)) return 'attached';
  // The recording that covers the moment the poster should show, if any.
  // Its thumbnail is Twitch's choice of frame, NOT one from that moment — the
  // last resort for a broadcast that had guests but no usable preview (a
  // restart ate them, or Twitch never refreshed one). DECISIONS.md records it.
  const covering = (target != null && overlapping.find((x) => target >= x.s && target <= x.e)) || longest;
  const raw = String(covering.v.thumbnail_url || '');
  if (!raw || PLACEHOLDER.test(raw)) return 'pending'; // still processing
  const url = raw.replace('%{width}', '640').replace('%{height}', '360');
  const buf = await fetchFrame(url);
  if (!buf) return 'pending';
  saveAiringPoster(airing.id, buf, { source: 'twitch-vod-thumbnail', vodId: String(covering.v.id) }, { log });
  return 'saved';
}

// ── the sweep ──────────────────────────────────────────────────────────────

const retry = new Map(); // airingId → { tries, next }
let sweeping = false;

/**
 * Every few minutes: attach recordings, fall back to the recording's
 * thumbnail, and clear previews nobody needs any more.
 *
 * `allAirings` and `roomIds` are FUNCTIONS, read at cleanup time: the loop
 * above awaits Twitch, and a broadcast that starts meanwhile must not have its
 * first previews deleted for being newer than the list.
 */
export async function sweepAiringPosters({ airings, allAirings, roomIds, helix, apiConfigured, attachRecording, now = Date.now(), log = console }) {
  if (sweeping) return; // a slow Twitch must not stack sweeps on each other
  sweeping = true;
  try {
    for (const a of airings) {
      if (a.endedAt == null || now - a.endedAt > SWEEP_WINDOW_MS) continue;
      const cands = listCandidates(a.id);
      const content = hasContent(a);
      // A close finalizes at once; this catches one a crash interrupted.
      if (content && !readAiringPoster(a.id) && cands.length) finalizeAiringPoster(a, { log });
      // Previews are kept an hour past the end, in case a blip reopens it.
      if (cands.length && now - a.endedAt > CANDIDATES_KEPT_AFTER_CLOSE_MS) {
        try { fs.rmSync(candidateDirFor(a.id), { recursive: true, force: true }); } catch { /* next sweep */ }
      }
      // Nothing the rule lets us show happened on it: no recording lookup, no
      // thumbnail, and it never reaches the board (airings-store recentAirings).
      if (!content) continue;
      // `recordings` came later than vodUrl: an airing resolved before it has
      // a link but not the starts a replay needs to open a moment.
      const needsRecording = !a.vodUrl || !Array.isArray(a.recordings) || !readAiringPoster(a.id);
      if (!needsRecording || !apiConfigured || !a.channel || now - a.endedAt < VOD_WAIT_MS) continue;
      const r = retry.get(a.id) || { tries: 0, next: 0 };
      if (now < r.next || r.tries > RETRY_STEPS_MS.length) continue;
      let status = 'pending';
      try {
        status = await resolveFromRecording(a, { helix, attachRecording, log });
      } catch (e) {
        log.warn?.(`[poster] recording lookup failed for ${a.id}: ${e.message}`);
      }
      if (status === 'saved' || status === 'attached') retry.delete(a.id);
      else retry.set(a.id, { tries: r.tries + 1, next: now + RETRY_STEPS_MS[Math.min(r.tries, RETRY_STEPS_MS.length - 1)] });
    }
    // Posters and previews of airings the store no longer keeps, or whose room
    // is gone (a deleted room's airing can stay open forever — no tick closes it).
    try {
      const rooms = new Set(roomIds());
      const keep = new Set(allAirings().filter((a) => rooms.has(a.roomId)).map((a) => safeId(a.id)));
      for (const f of fs.existsSync(AIRING_POSTER_DIR) ? fs.readdirSync(AIRING_POSTER_DIR) : []) {
        const m = /^([a-z0-9-]+)\.(jpg|json)$/i.exec(f);
        if (m && !keep.has(m[1])) { fs.rmSync(path.join(AIRING_POSTER_DIR, f), { force: true }); metaMemo.delete(m[1]); }
      }
      for (const d of fs.existsSync(CANDIDATE_ROOT) ? fs.readdirSync(CANDIDATE_ROOT) : []) {
        if (!keep.has(d)) fs.rmSync(path.join(CANDIDATE_ROOT, d), { recursive: true, force: true });
      }
    } catch (e) {
      log.warn?.(`[poster] cleanup skipped: ${e.message}`);
    }
    countAllCandidates();
  } finally {
    sweeping = false;
  }
}

/** Test seam. */
export function _resetForTests() {
  metaMemo.clear();
  lastSnap.clear();
  retry.clear();
  totalCandidates = null;
}
