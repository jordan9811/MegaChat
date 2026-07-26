/**
 * CREATOR BOUNTY — persistence.
 *
 * Same shape as rooms-store.js / identity-store.js: one JSON file under
 * DATA_DIR, loaded once into a module cache, written on mutation. DATA_DIR
 * points at a persistent volume in production; without it Railway wipes this
 * on every deploy (see the note in rooms-store.js).
 *
 * The EscrowLedger is APPEND-ONLY by contract. Nothing in this module ever
 * mutates a ledger row — `appendLedger` is the only writer and there is no
 * update/delete counterpart. Balances are DERIVED by folding the ledger, not
 * stored, so a corrupted balance field can't silently diverge from history.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { createLedger } from './bounty-ledger.js';
import * as ev from './bounty-evidence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'bounty.json');
const LEDGER_PATH = path.join(DATA_DIR, 'bounty-ledger.jsonl');

/**
 * The EscrowLedger now lives in its own append-only JSONL file, NOT in
 * bounty.json. The mutable records below are still a rewritten document
 * (they are current-state, safe to rewrite); the ledger is the money history
 * and gets real append semantics + a validated checksum chain. See
 * bounty-ledger.js for why that distinction matters.
 */
let ledger = null;
function getLedger() {
  if (!ledger) ledger = createLedger({ filePath: LEDGER_PATH });
  return ledger;
}

const EMPTY = () => ({
  reservedHandles: {},   // key → ReservedHandle
  contributions: {},     // id  → BountyContribution
  claims: {},            // id  → Claim
  airSessions: {},       // id  → AirSession
  verifications: {},     // id  → VerificationAttempt
  reviews: {},           // id  → ReviewItem (ambiguous verifications)
});

let cache = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  if (cache) return cache;
  ensureDir();
  if (!fs.existsSync(STORE_PATH)) {
    cache = EMPTY();
    save();
    return cache;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    cache = { ...EMPTY(), ...raw };
    delete cache.ledger; // legacy field — the ledger is its own file now
  } catch {
    cache = EMPTY();
  }
  return cache;
}

/** Validate the ledger chain. Throws LedgerCorrupt on interior damage. */
export function verifyLedgerIntegrity() {
  return getLedger().load();
}

/** Validate the EVIDENCE chain (codes, playbacks, verifications). */
export function verifyEvidenceIntegrity() {
  return ev.verifyEvidenceIntegrity();
}
export function evidenceIsTrustworthy() {
  return ev.evidenceIsTrustworthy();
}
/** Evidence-vs-cache divergence check for one air session. */
export function reconcileSessionEvidence(airSessionId) {
  const rec = load().airSessions[airSessionId];
  return ev.reconcileWindows(airSessionId, rec?.playbackWindows || []);
}

function save() {
  ensureDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

/** Test seam — drops the in-memory cache so a gate can start from disk. */
export function _resetCache() {
  cache = null;
  if (ledger) ledger._reset();
  ledger = null;
  ev._reset();
}

// ── Handle keys ─────────────────────────────────────────────────────────────

/**
 * Normalized lookup key for a reserved handle.
 *
 * NOTE (recon): MegaChat's own sanitizeHandle() allows 3-20 chars while
 * Twitch logins allow 3-25, so a reserved TARGET handle is deliberately
 * validated more loosely here than a claimable MegaChat room handle. A
 * streamer whose platform name is 21-25 chars can still have a bounty pool
 * reserved against them; what they can't do is take a matching MegaChat room
 * handle. That mismatch is logged in OPEN-ISSUES.md rather than papered over.
 */
export function handleKey(platform, handle) {
  const p = String(platform || '').trim().toLowerCase();
  const h = String(handle || '').trim().replace(/^@/, '').toLowerCase();
  if (!p || !h) return null;
  if (!/^[a-z0-9_.-]{1,40}$/.test(h)) return null;
  return `${p}:${h}`;
}

// ── ReservedHandle ──────────────────────────────────────────────────────────

export function getReservedHandle(platform, handle) {
  const key = handleKey(platform, handle);
  if (!key) return null;
  return load().reservedHandles[key] || null;
}

export function listReservedHandles() {
  return Object.values(load().reservedHandles);
}

export function reserveHandle({ platform, handle, reservedBy = null, ttlMs }) {
  const key = handleKey(platform, handle);
  if (!key) throw new Error('Invalid platform/handle');
  const store = load();
  const existing = store.reservedHandles[key];
  if (existing) return existing;
  const now = Date.now();
  const rec = {
    key,
    platform: String(platform).toLowerCase(),
    handle: String(handle).replace(/^@/, '').toLowerCase(),
    claimStatus: 'ACCUMULATING',
    claimedBy: null,
    reservedBy,
    reservedAt: now,
    expiresAt: now + ttlMs,
  };
  store.reservedHandles[key] = rec;
  save();
  return rec;
}

export function updateReservedHandle(key, patch) {
  const store = load();
  const rec = store.reservedHandles[key];
  if (!rec) throw new Error(`No reserved handle ${key}`);
  Object.assign(rec, patch);
  save();
  return rec;
}

// ── BountyContribution ──────────────────────────────────────────────────────

export function addContribution({ handleKey: key, contributor, amount, letterRef }) {
  const store = load();
  if (!store.reservedHandles[key]) throw new Error(`No reserved handle ${key}`);
  const rec = {
    id: randomUUID(),
    handleKey: key,
    contributor,
    amount: String(amount),
    letterRef: letterRef || null,
    createdAt: Date.now(),
    status: 'HELD',
  };
  store.contributions[rec.id] = rec;
  save();
  return rec;
}

export function listContributions(key) {
  return Object.values(load().contributions).filter((c) => c.handleKey === key);
}

export function updateContribution(id, patch) {
  const store = load();
  const rec = store.contributions[id];
  if (!rec) throw new Error(`No contribution ${id}`);
  Object.assign(rec, patch);
  save();
  return rec;
}

// ── Claim ───────────────────────────────────────────────────────────────────

export function createClaim({ handleKey: key, claimant, ttlMs }) {
  const store = load();
  const now = Date.now();
  const rec = {
    id: randomUUID(),
    handleKey: key,
    claimant,
    verificationState: 'PENDING',
    createdAt: now,
    expiresAt: now + ttlMs,
  };
  store.claims[rec.id] = rec;
  save();
  return rec;
}

export function getClaim(id) {
  return load().claims[id] || null;
}

export function listClaims(key) {
  const all = Object.values(load().claims);
  return key ? all.filter((c) => c.handleKey === key) : all;
}

export function updateClaim(id, patch) {
  const store = load();
  const rec = store.claims[id];
  if (!rec) throw new Error(`No claim ${id}`);
  Object.assign(rec, patch);
  save();
  return rec;
}

// ── AirSession ──────────────────────────────────────────────────────────────

export function createAirSession({ claimId, roomId, platform }) {
  const store = load();
  const rec = {
    id: randomUUID(),
    claimId,
    roomId: roomId || null,
    platform: platform || null,
    // Codes now live INSIDE playback windows — a code with no clip is not a
    // thing that can exist. { clipId, startedAt, endsAt, durationS,
    // belowSamplingFloor, codes: [{ code, clipId, issuedAt, expiresAt }] }
    playbackWindows: [],
    status: 'OPEN',
    violations: [],       // e.g. { type:'BADGE_TOO_SMALL', at, detail }
    startedAt: Date.now(),
    endedAt: null,
    verifiedMinutes: 0,
  };
  store.airSessions[rec.id] = rec;
  save();
  ev.recordAirSessionOpened(rec.id, claimId, roomId || null, platform || null);
  return rec;
}

export function getAirSession(id) {
  return load().airSessions[id] || null;
}

export function listAirSessions(claimId) {
  const all = Object.values(load().airSessions);
  return claimId ? all.filter((s) => s.claimId === claimId) : all;
}

export function updateAirSession(id, patch) {
  const store = load();
  const rec = store.airSessions[id];
  if (!rec) throw new Error(`No air session ${id}`);
  Object.assign(rec, patch);
  save();
  return rec;
}

export function pushPlaybackWindow(id, win) {
  const store = load();
  const rec = store.airSessions[id];
  if (!rec) throw new Error(`No air session ${id}`);
  if (!Array.isArray(rec.playbackWindows)) rec.playbackWindows = [];
  rec.playbackWindows.push(win);
  save();
  ev.recordPlaybackStarted(id, win); // authoritative copy
  return rec;
}

export function updatePlaybackWindow(id, playbackId, patch) {
  const store = load();
  const rec = store.airSessions[id];
  if (!rec) throw new Error(`No air session ${id}`);
  // Keyed on the PLAYBACK, not the clip — the same clip can air twice and each
  // airing is separate evidence.
  const win = (rec.playbackWindows || []).find((w) => w.playbackId === playbackId);
  if (!win) return rec;
  Object.assign(win, patch);
  save();
  // A window only ever closes (endsAt truncation) — record it as evidence.
  if (patch.endsAt != null) ev.recordPlaybackEnded(id, playbackId, patch.endsAt);
  return rec;
}

export function pushWindowCode(id, playbackId, codeRec) {
  const store = load();
  const rec = store.airSessions[id];
  if (!rec) throw new Error(`No air session ${id}`);
  const win = (rec.playbackWindows || []).find((w) => w.playbackId === playbackId);
  if (!win) throw new Error(`No playback window ${playbackId}`);
  win.codes.push(codeRec);
  save();
  ev.recordCodeIssued(id, codeRec); // THE evidence a payout rests on
  return rec;
}

export function pushAirSessionViolation(id, violation) {
  const store = load();
  const rec = store.airSessions[id];
  if (!rec) throw new Error(`No air session ${id}`);
  rec.violations.push(violation);
  save();
  ev.recordViolation(id, violation);
  return rec;
}

/** Every code issued across ALL sessions and windows — collision guard. */
export function allIssuedCodes() {
  return Object.values(load().airSessions)
    .flatMap((s) => (s.playbackWindows || []).flatMap((w) => w.codes.map((c) => c.code)));
}

// ── Review queue (ambiguous verifications) ──────────────────────────────────

export function createReview({ airSessionId, claimId, handleKey: key, verificationId, confidence, reason }) {
  const store = load();
  const rec = {
    id: randomUUID(),
    airSessionId, claimId, handleKey: key, verificationId,
    confidence, reason: reason || null,
    state: 'OPEN',            // OPEN | RESOLVED_APPROVE | RESOLVED_REJECT
    assignee: null,
    openedAt: Date.now(),
    resolvedAt: null,
    resolvedBy: null,
    resolutionReason: null,
  };
  store.reviews[rec.id] = rec;
  save();
  return rec;
}

export function getReview(id) { return load().reviews[id] || null; }

export function listReviews(filter = {}) {
  let rows = Object.values(load().reviews);
  if (filter.state) rows = rows.filter((r) => r.state === filter.state);
  if (filter.airSessionId) rows = rows.filter((r) => r.airSessionId === filter.airSessionId);
  return rows;
}

export function updateReview(id, patch) {
  const store = load();
  const rec = store.reviews[id];
  if (!rec) throw new Error(`No review ${id}`);
  Object.assign(rec, patch);
  save();
  return rec;
}

/** Is this session blocked pending human review? */
export function hasOpenReview(airSessionId) {
  return listReviews({ airSessionId, state: 'OPEN' }).length > 0;
}

// ── VerificationAttempt ─────────────────────────────────────────────────────

export function recordVerification({
  airSessionId, checker, evidenceRef, result, confidence, verifiedMinutes,
}) {
  const store = load();
  const rec = {
    id: randomUUID(),
    airSessionId,
    checker,
    evidenceRef: evidenceRef || null,
    result,
    confidence,
    verifiedMinutes: verifiedMinutes ?? 0,
    checkedAt: Date.now(),
  };
  store.verifications[rec.id] = rec;
  save();
  ev.recordVerificationEvidence(rec);
  return rec;
}

export function listVerifications(airSessionId) {
  const all = Object.values(load().verifications);
  return airSessionId ? all.filter((v) => v.airSessionId === airSessionId) : all;
}

// ── EscrowLedger (APPEND-ONLY) ──────────────────────────────────────────────

/**
 * The only ledger writer. There is deliberately no update or delete: a
 * correction is a new compensating row, never an edit. Balances fold this.
 */
export function appendLedger({
  handleKey: key, claimId = null, airSessionId = null,
  type, fromState = null, toState = null,
  amount = '0', bucket = 'contributor', actor, reason = null,
  idempotencyKey = null, meta = null,
}) {
  const L = getLedger();
  if (idempotencyKey) {
    const dup = L.find((r) => r.idempotencyKey === idempotencyKey);
    if (dup) return { row: dup, deduped: true };
  }
  // seq + sum are assigned by the ledger itself so they cannot be forged here.
  const row = L.append({
    id: randomUUID(),
    handleKey: key,
    claimId,
    airSessionId,
    type,
    fromState,
    toState,
    amount: String(amount),
    bucket, // 'contributor' | 'platform_match' — never blended
    actor,
    reason,
    idempotencyKey,
    meta,
    at: Date.now(),
  });
  return { row, deduped: false };
}

export function listLedger(filter = {}) {
  let rows = getLedger().all();
  if (filter.handleKey) rows = rows.filter((r) => r.handleKey === filter.handleKey);
  if (filter.claimId) rows = rows.filter((r) => r.claimId === filter.claimId);
  if (filter.type) rows = rows.filter((r) => r.type === filter.type);
  return rows;
}

export function findByIdempotencyKey(k) {
  if (!k) return null;
  return getLedger().find((r) => r.idempotencyKey === k);
}

/**
 * BountyPool is DERIVED, never stored — fold the ledger + contributions.
 * Keeping it computed means a stale/incorrect cached balance cannot exist.
 */
export function getPool(key) {
  const contributions = listContributions(key);
  const held = contributions
    .filter((c) => c.status === 'HELD')
    .reduce((a, c) => a + parseFloat(c.amount || '0'), 0);
  const refunded = contributions
    .filter((c) => c.status === 'REFUNDED')
    .reduce((a, c) => a + parseFloat(c.amount || '0'), 0);
  const rows = listLedger({ handleKey: key });
  const releasedContributor = rows
    .filter((r) => r.type === 'RELEASE' && r.bucket === 'contributor')
    .reduce((a, r) => a + parseFloat(r.amount || '0'), 0);
  const releasedMatch = rows
    .filter((r) => r.type === 'RELEASE' && r.bucket === 'platform_match')
    .reduce((a, r) => a + parseFloat(r.amount || '0'), 0);
  const reserved = getReservedHandleByKey(key);
  return {
    handleKey: key,
    platform: reserved?.platform || null,
    handle: reserved?.handle || null,
    status: reserved?.claimStatus || null,
    contributionCount: contributions.length,
    totalContributed: +held.toFixed(6),
    refunded: +refunded.toFixed(6),
    releasedContributor: +releasedContributor.toFixed(6),
    releasedPlatformMatch: +releasedMatch.toFixed(6),
    remaining: +(held - releasedContributor).toFixed(6),
  };
}

export function getReservedHandleByKey(key) {
  return load().reservedHandles[key] || null;
}

export function listPools() {
  return listReservedHandles().map((r) => getPool(r.key));
}
