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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'bounty.json');

const EMPTY = () => ({
  reservedHandles: {},   // key → ReservedHandle
  contributions: {},     // id  → BountyContribution
  claims: {},            // id  → Claim
  airSessions: {},       // id  → AirSession
  verifications: {},     // id  → VerificationAttempt
  ledger: [],            // append-only EscrowLedger rows
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
    if (!Array.isArray(cache.ledger)) cache.ledger = [];
  } catch {
    cache = EMPTY();
  }
  return cache;
}

function save() {
  ensureDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

/** Test seam — drops the in-memory cache so a gate can start from disk. */
export function _resetCache() {
  cache = null;
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
    codes: [],            // { code, issuedAt, expiresAt }
    status: 'OPEN',
    violations: [],       // e.g. { type:'BADGE_TOO_SMALL', at, detail }
    startedAt: Date.now(),
    endedAt: null,
    verifiedMinutes: 0,
  };
  store.airSessions[rec.id] = rec;
  save();
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

export function pushAirSessionCode(id, codeRec) {
  const store = load();
  const rec = store.airSessions[id];
  if (!rec) throw new Error(`No air session ${id}`);
  rec.codes.push(codeRec);
  save();
  return rec;
}

export function pushAirSessionViolation(id, violation) {
  const store = load();
  const rec = store.airSessions[id];
  if (!rec) throw new Error(`No air session ${id}`);
  rec.violations.push(violation);
  save();
  return rec;
}

/** Every code currently issued across ALL open sessions — collision guard. */
export function allIssuedCodes() {
  return Object.values(load().airSessions).flatMap((s) => s.codes.map((c) => c.code));
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
  const store = load();
  if (idempotencyKey) {
    const dup = store.ledger.find((r) => r.idempotencyKey === idempotencyKey);
    if (dup) return { row: dup, deduped: true };
  }
  const row = {
    id: randomUUID(),
    seq: store.ledger.length + 1,
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
  };
  store.ledger.push(row);
  save();
  return { row, deduped: false };
}

export function listLedger(filter = {}) {
  let rows = load().ledger;
  if (filter.handleKey) rows = rows.filter((r) => r.handleKey === filter.handleKey);
  if (filter.claimId) rows = rows.filter((r) => r.claimId === filter.claimId);
  if (filter.type) rows = rows.filter((r) => r.type === filter.type);
  return rows;
}

export function findByIdempotencyKey(k) {
  if (!k) return null;
  return load().ledger.find((r) => r.idempotencyKey === k) || null;
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
