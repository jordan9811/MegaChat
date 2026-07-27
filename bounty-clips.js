/**
 * DURABLE CLIP STORAGE FOR THE BOUNTY MECHANIC.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * The bounty pitch is: fans record MegaChats for a streamer who is not on the
 * platform yet, those stack up against a reserved handle, and when the
 * streamer claims it and plays them on stream they get paid.
 *
 * Before this module, none of that content existed. `BountyContribution` had
 * a `letterRef` string that nothing ever read; `/api/bounty/contribute` took
 * an amount and never touched media; and ordinary MegaChats live in an
 * in-memory Map in letters.js that drops the buffer 60s after playback and
 * loses everything on restart. A MegaChat is also recorded INTO a room, and
 * an unclaimed streamer has no room — so there was not even a place to put
 * one. The escrow, the watermark and the verifier were all real; the thing
 * they were accounting for was not.
 *
 * ── What a clip is here ──────────────────────────────────────────────────
 * A fan's money and a fan's recording are the same promise. So a stored clip
 * is treated as evidence, not cache: the index is append-only with the same
 * seq+checksum chain as the escrow ledger, media is content-addressed by
 * SHA-256, and a purge appends a record rather than erasing history. We must
 * always be able to answer "a fan paid for a clip — where did it go?", even
 * after the bytes are legitimately gone.
 *
 * ── Storage choice, and what it costs ────────────────────────────────────
 * Local filesystem on the Railway volume. Chosen because it is the smallest
 * correct thing that is actually durable, needs no new credentials (S3/R2
 * keys do not exist and cannot be created unattended), and reuses the
 * append-only primitives already proven in this codebase.
 *
 * The cost is capacity. Clips are capped at 25MB and held for the 90-day
 * reservation TTL, so ~2GB of default headroom is roughly 80 clips at worst
 * case, or several hundred at realistic 5–8MB sizes. That is fine for early
 * onboarding and NOT fine at scale.
 *
 * To scale, replace `readMedia`/`writeMedia`/`deleteMedia` with an object
 * store (R2 or S3) and keep this index exactly as it is — the index holds no
 * bytes, only paths and hashes, so the swap is three functions and a config
 * flag. Do not move the index off local disk; its durability guarantees are
 * the point. See docs/decisions/bounty-clip-storage.md.
 */
import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { createLedger } from './bounty-ledger.js';
import { bountyConfig } from './bounty-claim.config.js';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const CLIP_ROOT = path.join(DATA_DIR, 'bounty-clips');
const MEDIA_DIR = path.join(CLIP_ROOT, 'media');
const INDEX_PATH = path.join(CLIP_ROOT, 'index.jsonl');

export const CLIP_EVENTS = {
  STORED: 'CLIP_STORED',
  PLAYED: 'CLIP_PLAYED',
  PURGED: 'CLIP_PURGED',
  /** A multi-target pledge was claimed by a non-anchor streamer — the clip
   *  follows the money to the winner. Append-only: the original STORED row
   *  keeps the history, this row changes the current owner. */
  REASSIGNED: 'CLIP_REASSIGNED',
  /** Graded moderation verdict. Part of the clip's evidence record because a
   *  refund decision (policy strike vs clean decline) is computed FROM it. */
  MODERATED: 'CLIP_MODERATED',
  /** Streamer approval-queue outcomes. */
  APPROVED: 'CLIP_APPROVED',
  REJECTED: 'CLIP_REJECTED',
};

let ledger = createLedger({ filePath: INDEX_PATH, kind: 'clip-index' });
let integrity = { ok: true, error: null, checkedAt: null };

/** Validate the index chain. Mirrors the evidence log: a payout must never
 *  rest on a store we cannot vouch for. */
export function verifyClipIndexIntegrity() {
  try {
    ledger.load();
    integrity = { ok: true, error: null, checkedAt: Date.now() };
  } catch (e) {
    integrity = { ok: false, error: e.message, checkedAt: Date.now() };
  }
  return integrity;
}

export function clipStoreIsTrustworthy() {
  if (integrity.checkedAt === null) verifyClipIndexIntegrity();
  return integrity;
}

function ensureDirs() {
  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

const mediaPath = (clipId) => path.join(MEDIA_DIR, `${clipId}.bin`);

// ── media I/O — the three functions an object store would replace ─────────
function writeMedia(clipId, buf) {
  ensureDirs();
  const p = mediaPath(clipId);
  const fd = fs.openSync(p, 'w');
  try {
    fs.writeSync(fd, buf);
    fs.fsyncSync(fd); // the bytes are on disk before the index claims they are
  } finally {
    fs.closeSync(fd);
  }
  return p;
}
function readMedia(clipId) {
  const p = mediaPath(clipId);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}
function deleteMedia(clipId) {
  try {
    const p = mediaPath(clipId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  } catch { return false; }
}

/** Current state of every clip, folded from the append-only index. */
function fold() {
  const byId = new Map();
  for (const r of ledger.all()) {
    if (r.type === CLIP_EVENTS.STORED) {
      byId.set(r.clipId, {
        clipId: r.clipId,
        handleKey: r.handleKey,
        contributionId: r.contributionId || null,
        contributor: r.contributor || null,
        mime: r.mime,
        durationS: r.durationS,
        bytes: r.bytes,
        sha256: r.sha256,
        storedAt: r.at,
        playedAt: null,
        playCount: 0,
        purgedAt: null,
        purgeReason: null,
        reassignedAt: null,
        reassignedFrom: null,
        moderation: null,   // graded verdict, written at upload time
        approval: null,     // streamer approve/reject, written from the queue
      });
    } else if (r.type === CLIP_EVENTS.PLAYED) {
      const c = byId.get(r.clipId);
      if (c) { c.playedAt = r.at; c.playCount += 1; }
    } else if (r.type === CLIP_EVENTS.PURGED) {
      const c = byId.get(r.clipId);
      if (c) { c.purgedAt = r.at; c.purgeReason = r.reason; }
    } else if (r.type === CLIP_EVENTS.REASSIGNED) {
      const c = byId.get(r.clipId);
      if (c) { c.handleKey = r.toHandleKey; c.reassignedAt = r.at; c.reassignedFrom = r.fromHandleKey; }
    } else if (r.type === CLIP_EVENTS.MODERATED) {
      const c = byId.get(r.clipId);
      if (c) {
        c.moderation = {
          grade: r.grade, confidence: r.confidence,
          topCategory: r.topCategory || null, at: r.at,
        };
      }
    } else if (r.type === CLIP_EVENTS.APPROVED) {
      const c = byId.get(r.clipId);
      if (c) { c.approval = { state: 'APPROVED', by: r.by, at: r.at }; }
    } else if (r.type === CLIP_EVENTS.REJECTED) {
      const c = byId.get(r.clipId);
      if (c) { c.approval = { state: 'REJECTED', by: r.by, reasonCode: r.reasonCode, reason: r.reason || null, at: r.at }; }
    }
  }
  return byId;
}

const isLive = (c) => !c.purgedAt;

/**
 * Store a fan's recording against a reserved handle.
 *
 * Rejects rather than truncates on every limit: a clip we cannot keep whole
 * is worse than no clip, because the fan is charged either way and the
 * streamer gets something broken.
 */
export function storeClip({ handleKey, contributionId, contributor, mime, durationS, data }) {
  const trust = clipStoreIsTrustworthy();
  if (!trust.ok) throw new Error(`Clip index is not trustworthy: ${trust.error}`);
  if (!handleKey) throw new Error('handleKey required');
  if (!Buffer.isBuffer(data) || data.length === 0) throw new Error('Clip data required');
  if (!/^video\/(webm|mp4)/.test(String(mime || ''))) {
    throw new Error('Unsupported recording format');
  }
  const dur = Number(durationS);
  if (!Number.isFinite(dur) || dur <= 0) throw new Error('durationS required');
  // Same floor as a room recording, and derived from the same place — a clip
  // too short to verify must not enter the store either.
  if (dur < bountyConfig.minClipSeconds) {
    const e = new Error(`Clips must be at least ${bountyConfig.minClipSeconds} seconds`);
    e.code = 'below_min_duration';
    throw e;
  }
  if (data.length > bountyConfig.clipMaxBytes) {
    const e = new Error(`Clip exceeds ${Math.round(bountyConfig.clipMaxBytes / 1e6)}MB`);
    e.code = 'clip_too_large';
    throw e;
  }

  const clips = [...fold().values()].filter(isLive);
  const used = clips.reduce((a, c) => a + c.bytes, 0);
  if (used + data.length > bountyConfig.clipStoreMaxBytes) {
    const e = new Error('Bounty clip storage is full');
    e.code = 'store_full';
    throw e;
  }
  const forHandle = clips.filter((c) => c.handleKey === handleKey).length;
  if (forHandle >= bountyConfig.clipsPerHandleMax) {
    const e = new Error(`This handle already has ${forHandle} clips waiting`);
    e.code = 'handle_clip_cap';
    throw e;
  }

  const clipId = randomUUID();
  const sha256 = createHash('sha256').update(data).digest('hex');
  // Bytes first, index second. The reverse order can claim a clip exists
  // when it does not; this order can at worst orphan a file, which the
  // sweeper cleans and which never overstates what we hold.
  writeMedia(clipId, data);
  ledger.append({
    type: CLIP_EVENTS.STORED,
    clipId, handleKey, contributionId: contributionId || null,
    contributor: contributor || null,
    mime: String(mime), durationS: Math.ceil(dur),
    bytes: data.length, sha256, at: Date.now(),
  });
  return { clipId, bytes: data.length, sha256, durationS: Math.ceil(dur) };
}

/** Clips still held for a handle — what a claiming streamer gets to play. */
export function listClips(handleKey) {
  return [...fold().values()]
    .filter((c) => isLive(c) && (!handleKey || c.handleKey === handleKey))
    .sort((a, b) => a.storedAt - b.storedAt);
}

export function getClip(clipId) {
  const c = fold().get(clipId);
  return c && isLive(c) ? c : null;
}

/**
 * Read a clip back, verifying it is the same bytes we were given.
 * A hash mismatch is reported, never silently served — a streamer playing a
 * corrupted clip would fail verification and blame the wrong thing.
 */
export function readClip(clipId) {
  const rec = getClip(clipId);
  if (!rec) return { ok: false, error: 'not_found' };
  const data = readMedia(clipId);
  if (!data) return { ok: false, error: 'media_missing', record: rec };
  const sha256 = createHash('sha256').update(data).digest('hex');
  if (sha256 !== rec.sha256) {
    return { ok: false, error: 'media_corrupt', record: rec, expected: rec.sha256, actual: sha256 };
  }
  return { ok: true, record: rec, data };
}

export function markPlayed(clipId, airSessionId = null) {
  if (!getClip(clipId)) return null;
  return ledger.append({
    type: CLIP_EVENTS.PLAYED, clipId, airSessionId, at: Date.now(),
  });
}

/**
 * Drop a clip's bytes. The index record survives — "a fan paid for this and
 * it is gone, here is why" must stay answerable forever.
 */
export function purgeClip(clipId, reason = 'unspecified') {
  const rec = fold().get(clipId);
  if (!rec) return null;
  if (rec.purgedAt) return rec; // idempotent
  deleteMedia(clipId);
  ledger.append({ type: CLIP_EVENTS.PURGED, clipId, reason, at: Date.now() });
  return getClipRecord(clipId);
}

/** Including purged ones — for audit surfaces. */
export function getClipRecord(clipId) {
  return fold().get(clipId) || null;
}

/** The clip (live or purged) attached to one contribution. Status surfaces
 *  need the purged record too — "your clip was refunded" must still show
 *  WHICH clip. */
export function clipForContribution(contributionId, { includePurged = true } = {}) {
  const hit = [...fold().values()].find((c) => c.contributionId === contributionId);
  if (!hit) return null;
  return includePurged || isLive(hit) ? hit : null;
}

export function purgeForHandle(handleKey, reason = 'handle_refunded') {
  const purged = [];
  for (const c of listClips(handleKey)) {
    purgeClip(c.clipId, reason);
    purged.push(c.clipId);
  }
  return purged;
}

/** The pledge was claimed by a non-anchor streamer — the clip follows the
 *  money. Appends, never rewrites; the STORED row keeps the history. */
export function reassignClip(clipId, toHandleKey, { pledgeId = null } = {}) {
  const rec = getClip(clipId);
  if (!rec) return null;
  if (rec.handleKey === toHandleKey) return rec; // idempotent
  ledger.append({
    type: CLIP_EVENTS.REASSIGNED, clipId,
    fromHandleKey: rec.handleKey, toHandleKey, pledgeId, at: Date.now(),
  });
  return getClip(clipId);
}

/** Graded moderation verdict — evidence, because refund math reads it. */
export function recordModeration(clipId, { grade, confidence, topCategory }) {
  if (!getClipRecord(clipId)) return null;
  ledger.append({
    type: CLIP_EVENTS.MODERATED, clipId,
    grade, confidence, topCategory: topCategory || null, at: Date.now(),
  });
  return getClipRecord(clipId);
}

export function approveClip(clipId, { by }) {
  if (!getClip(clipId)) return null;
  ledger.append({ type: CLIP_EVENTS.APPROVED, clipId, by, at: Date.now() });
  return getClip(clipId);
}

/**
 * @param {string} reasonCode STREAMER_DECLINED | POLICY_VIOLATION — the split
 *   that decides whether the contributor takes a reputation strike.
 */
export function rejectClip(clipId, { by, reasonCode, reason }) {
  if (!getClip(clipId)) return null;
  ledger.append({
    type: CLIP_EVENTS.REJECTED, clipId, by,
    reasonCode, reason: reason || null, at: Date.now(),
  });
  return getClip(clipId);
}

/** Purge the clip attached to a single contribution (used by refunds). */
export function purgeForContribution(contributionId, reason = 'contribution_refunded') {
  const hit = [...fold().values()].find((c) => isLive(c) && c.contributionId === contributionId);
  if (!hit) return null;
  purgeClip(hit.clipId, reason);
  return hit.clipId;
}

/**
 * Clips past the reservation TTL. These are only ever purged alongside a
 * refund — the money and the recording go back together, never separately.
 */
export function expiredClips(now = Date.now()) {
  return listClips().filter((c) => now - c.storedAt > bountyConfig.reservationTtlMs);
}

/**
 * Orphan sweep, both directions:
 *  - media on disk with no live index record → delete (safe: nothing owns it)
 *  - index record with no media on disk      → REPORT, never auto-purge,
 *    because that is data loss and someone has to know rather than have it
 *    tidied away.
 */
export function sweepOrphans() {
  ensureDirs();
  const clips = fold();
  const live = new Set([...clips.values()].filter(isLive).map((c) => c.clipId));
  const onDisk = fs.readdirSync(MEDIA_DIR).filter((f) => f.endsWith('.bin'))
    .map((f) => f.replace(/\.bin$/, ''));

  const deleted = [];
  for (const id of onDisk) {
    if (!live.has(id)) { deleteMedia(id); deleted.push(id); }
  }
  const missing = [...live].filter((id) => !fs.existsSync(mediaPath(id)));
  return { deletedOrphanFiles: deleted, missingMedia: missing };
}

export function stats() {
  const all = [...fold().values()];
  const live = all.filter(isLive);
  const bytes = live.reduce((a, c) => a + c.bytes, 0);
  const byHandle = {};
  for (const c of live) byHandle[c.handleKey] = (byHandle[c.handleKey] || 0) + 1;
  return {
    clips: live.length,
    purged: all.length - live.length,
    bytes,
    maxBytes: bountyConfig.clipStoreMaxBytes,
    pctUsed: +((bytes / bountyConfig.clipStoreMaxBytes) * 100).toFixed(1),
    byHandle,
    integrity: clipStoreIsTrustworthy(),
    storageRoot: CLIP_ROOT,
  };
}

/** Test seam — drops in-process state, never touches disk. */
export function _reset() {
  ledger = createLedger({ filePath: INDEX_PATH, kind: 'clip-index' });
  integrity = { ok: true, error: null, checkedAt: null };
}

export const _paths = { CLIP_ROOT, MEDIA_DIR, INDEX_PATH };
