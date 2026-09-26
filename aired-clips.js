/**
 * AIRED CLIPS — a copy of each MegaChat as it goes out on a broadcast, so the
 * broadcast's replay can still show it when the platform's recording cannot.
 *
 * WHY. A MegaChat's video is deleted minutes after it plays (letters.js,
 * MEDIA_TTL_MS): it was a one-shot, and the queue's disk budget is for clips
 * waiting to air. But the replay of a broadcast (/api/rooms/:id/replay) opens
 * at the MegaChat, and when Twitch has no recording to open — VODs off, or
 * expired after a week — the clip itself is the only picture of that moment
 * left. The owner, 2026-09-25: "pull the clip … as fallback".
 *
 * WHAT IS KEPT. Only a clip whose play COMPLETED on a recorded broadcast of a
 * room whose owner proved the channel, while the overlay did not report itself
 * hidden (letters.js, playLetter's end; server.js canKeepAiredClip) — never a
 * bounty clip, which has its own retention and refund purge. The fan is told
 * so before sending (join page: "stays in that stream's replay for up to N
 * days", N from the owner's /dev page — site-settings.js replayKeepDays).
 * One file plus a small description per clip, keyed by the letter id the
 * moment carries as `ref`.
 *
 * HOW LONG. Never longer than the fan was told when they sent it (the letter
 * carries the days its page showed, and so does the copy), and never longer
 * than the setting says NOW: shortening it, or turning it off (0), applies to
 * every clip already kept, and raising it again never takes a clip past what
 * its fan was told.
 *
 * WHAT GOES. A refunded clip at once (letters.js refundLetter); one the room's
 * owner removes (DELETE /api/dashboard/rooms/:roomId/aired-clips/:id); every
 * clip past its days (above); clips no kept airing refers to (the airing was pruned,
 * or its room is gone); and, past the budgets — per room and in total — the
 * oldest first.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getSetting } from './site-settings.js';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
export const AIRED_CLIP_DIR = path.join(DATA_DIR, 'aired-clips');
const MAX_TOTAL_BYTES = Number(process.env.AIRED_CLIPS_MAX_BYTES) > 0 ? Number(process.env.AIRED_CLIPS_MAX_BYTES) : 400 * 1024 * 1024;
// One room can never take more than this share: a busy free room must not
// evict every other room's replays.
const MAX_ROOM_BYTES = Number(process.env.AIRED_CLIPS_ROOM_MAX_BYTES) > 0 ? Number(process.env.AIRED_CLIPS_ROOM_MAX_BYTES) : 100 * 1024 * 1024;
const MAX_CLIP_BYTES = 40 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60_000;
// What a clip archived before it carried its own days was promised: the send
// screen said "up to 30 days" from the day keeping began.
const PROMISED_BEFORE_DAYS_WERE_KEPT = 30;

/** How long this clip may be kept: the days it was sent under, capped by the
 *  setting in force now. 0 means it goes. */
export function keepMsFor(meta, days = getSetting('replayKeepDays')) {
  const promised = Number.isFinite(Number(meta?.keepDays)) && meta?.keepDays != null ? Number(meta.keepDays) : PROMISED_BEFORE_DAYS_WERE_KEPT;
  return Math.max(0, Math.min(promised, Number(days) || 0)) * DAY_MS;
}

const expired = (meta, now) => {
  const keep = keepMsFor(meta);
  return keep <= 0 || now - (Number(meta?.at) || 0) > keep;
};

/** Exactly one of two content types, whatever a client claimed: a clip is
 *  served back with this, and "video/webm,text/html" would render as a page. */
export function cleanVideoMime(mime) {
  return /^video\/mp4\b/i.test(String(mime || '')) ? 'video/mp4' : 'video/webm';
}

const safeId = (id) => String(id || '').replace(/[^a-z0-9-]/gi, '');
export const airedClipFile = (id) => path.join(AIRED_CLIP_DIR, `${safeId(id)}.clip`);
const metaFile = (id) => path.join(AIRED_CLIP_DIR, `${safeId(id)}.json`);

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** Every archived clip, oldest first: [{ id, roomId, at, bytes, keepDays }]. */
function listClips() {
  let names = [];
  try { names = fs.readdirSync(AIRED_CLIP_DIR); } catch { return []; }
  const out = [];
  for (const f of names) {
    const m = /^([a-z0-9-]+)\.json$/i.exec(f);
    if (!m) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(AIRED_CLIP_DIR, f), 'utf8'));
      out.push({ id: m[1], roomId: meta.roomId || null, at: Number(meta.at) || 0, bytes: Number(meta.bytes) || 0, keepDays: meta.keepDays ?? null });
    } catch { out.push({ id: m[1], roomId: null, at: 0, bytes: 0, keepDays: 0 }); }
  }
  return out.sort((a, b) => a.at - b.at);
}

export function removeAiredClip(id) { removeClip(safeId(id)); }

function removeClip(id) {
  for (const f of [airedClipFile(id), metaFile(id)]) {
    try { fs.rmSync(f, { force: true }); } catch { /* next sweep */ }
  }
}

/**
 * Keep a copy of a clip that just aired. `keepDays` is the days its fan was
 * told; the setting caps it on every read and sweep (keepMsFor). Never throws:
 * a replay extra must not be able to break a MegaChat going out on air.
 */
export function archiveAiredClip({ id, roomId, username = null, mime = 'video/webm', durationS = null, at = Date.now(), keepDays }, bytes, { log = console } = {}) {
  try {
    if (!safeId(id) || !Buffer.isBuffer(bytes) || bytes.length < 1024 || bytes.length > MAX_CLIP_BYTES) return false;
    if (!Number.isInteger(keepDays) || keepDays <= 0) return false;
    writeAtomic(airedClipFile(id), bytes);
    writeAtomic(metaFile(id), JSON.stringify({ id, roomId, username, mime: cleanVideoMime(mime), durationS, at, bytes: bytes.length, keepDays }));
    // Over budget — this room's own first, then everyone's: the oldest go.
    const all = listClips();
    let roomTotal = all.filter((c) => c.roomId === roomId).reduce((n, c) => n + c.bytes, 0);
    for (const c of all) {
      if (roomTotal <= MAX_ROOM_BYTES) break;
      if (c.roomId !== roomId || c.id === safeId(id)) continue;
      removeClip(c.id);
      roomTotal -= c.bytes;
    }
    const left = listClips();
    let total = left.reduce((n, c) => n + c.bytes, 0);
    for (const c of left) {
      if (total <= MAX_TOTAL_BYTES) break;
      if (c.id === safeId(id)) continue;
      removeClip(c.id);
      total -= c.bytes;
    }
    return true;
  } catch (e) {
    log.warn?.(`[aired-clips] could not keep ${id}: ${e.message}`);
    return false;
  }
}

/** The description of an archived clip, or null when there is none. */
export function readAiredClip(id) {
  if (!safeId(id) || !fs.existsSync(airedClipFile(id))) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile(id), 'utf8'));
    return expired(meta, Date.now()) ? null : { ...meta, mime: cleanVideoMime(meta.mime) };
  } catch { return null; }
}

/** Drop every archived clip whose id is not in `keep` (the refs of kept
 *  airings), and every clip past its days (keepMsFor). */
export function sweepAiredClips(keep, { now = Date.now(), log = console } = {}) {
  try {
    const ids = new Set([...keep].map(safeId));
    for (const c of listClips()) if (!ids.has(c.id) || expired(c, now)) removeClip(c.id);
    // Files with no description (a crash between the two writes).
    let names = [];
    try { names = fs.readdirSync(AIRED_CLIP_DIR); } catch { return; }
    for (const f of names) {
      const m = /^([a-z0-9-]+)\.clip$/i.exec(f);
      if (m && !fs.existsSync(metaFile(m[1]))) removeClip(m[1]);
    }
  } catch (e) {
    log.warn?.(`[aired-clips] sweep skipped: ${e.message}`);
  }
}

/** For the owner's /dev page: how many clips are kept, how big, and when each
 *  goes — nothing that says who sent one. */
export function airedClipStats({ now = Date.now() } = {}) {
  const clips = listClips();
  return {
    count: clips.length,
    bytes: clips.reduce((n, c) => n + c.bytes, 0),
    // Age and the days each was sent under: enough for the page to say how
    // many a shorter setting would delete, before it is saved.
    clips: clips.map((c) => ({ ageMs: Math.max(0, now - c.at), keepDays: c.keepDays ?? PROMISED_BEFORE_DAYS_WERE_KEPT })),
  };
}
