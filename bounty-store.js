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
  pledges: {},           // id  → Pledge (one escrow, up to N target streamers)
  strikes: {},           // contributor → { policyRejections, history: [] }
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
/**
 * Platforms whose identifier is CASE-SENSITIVE. A pump.fun target is a Solana
 * mint — base58, where `G` and `g` are different characters — so lowercasing
 * it does not normalise the address, it destroys it, and the lowered form
 * cannot be converted back to verify against the chain. Twitch, Kick and X
 * handles are genuinely case-insensitive and keep the old behaviour.
 */
const CASE_SENSITIVE_PLATFORMS = new Set(['pumpfun']);

export function handleKey(platform, handle) {
  const p = String(platform || '').trim().toLowerCase();
  const raw = String(handle || '').trim().replace(/^@/, '');
  const h = CASE_SENSITIVE_PLATFORMS.has(p) ? raw : raw.toLowerCase();
  if (!p || !h) return null;
  // 48, not 40: a pump.fun target is a Solana mint address, which is base58
  // and 43-44 characters. At 40 every mint failed handleKey, so a pump.fun
  // pool could be reserved by other paths but never pledged against — the
  // one platform whose identifier is an address was silently unbountyable.
  if (!/^[a-zA-Z0-9_.-]{1,48}$/.test(h)) return null;
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
    // Same rule as handleKey: a case-sensitive platform keeps its casing, or
    // the stored handle stops being the thing it identifies.
    handle: CASE_SENSITIVE_PLATFORMS.has(String(platform).trim().toLowerCase())
      ? String(handle).trim().replace(/^@/, '')
      : String(handle).replace(/^@/, '').toLowerCase(),
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

export function addContribution({ handleKey: key, contributor, amount, letterRef, pledgeId }) {
  const store = load();
  if (!store.reservedHandles[key]) throw new Error(`No reserved handle ${key}`);
  const rec = {
    id: randomUUID(),
    handleKey: key,
    contributor,
    amount: String(amount),
    letterRef: letterRef || null,
    pledgeId: pledgeId || null,
    createdAt: Date.now(),
    status: 'HELD',
  };
  store.contributions[rec.id] = rec;
  save();
  return rec;
}

// ── Pledge ──────────────────────────────────────────────────────────────────
//
// A pledge is ONE escrow offered across up to N streamers. The escrowed money
// lives as a single Contribution row on the ANCHOR handle (targets[0]); the
// pledge record is what makes the same money visible — as contested — on the
// other targets. First claim wins; the rest see it vanish, which is why pool
// DISPLAY leads with guaranteed money (see escrow.poolView).

export function addPledge({ contributor, amount, targets, contributionId, expiresAt }) {
  const store = load();
  const rec = {
    id: randomUUID(),
    contributor,
    amount: String(amount),
    targets: [...targets],       // handleKeys, anchor first
    contributionId,              // the ONE escrow row (lives on the anchor)
    expiresAt,
    status: 'OPEN',              // OPEN | CLAIMED | EXPIRED
    winner: null,
    claimedAt: null,
    createdAt: Date.now(),
  };
  store.pledges[rec.id] = rec;
  save();
  return rec;
}

export function getPledge(id) {
  return load().pledges[id] || null;
}

export function listPledges(filter = {}) {
  let all = Object.values(load().pledges);
  if (filter.status) all = all.filter((p) => p.status === filter.status);
  if (filter.handleKey) all = all.filter((p) => p.targets.includes(filter.handleKey));
  if (filter.contributor) all = all.filter((p) => p.contributor === filter.contributor);
  return all;
}

export function updatePledge(id, patch) {
  const store = load();
  const rec = store.pledges[id];
  if (!rec) throw new Error(`No pledge ${id}`);
  Object.assign(rec, patch);
  save();
  return rec;
}

// ── Rejection strikes (account-level reputation) ────────────────────────────

export function getStrikes(contributor) {
  const s = load().strikes[String(contributor)] || null;
  return s || { policyRejections: 0, history: [] };
}

export function addStrike(contributor, { clipId, reason, confidence, by }) {
  const store = load();
  const key = String(contributor);
  const s = store.strikes[key] || (store.strikes[key] = { policyRejections: 0, history: [] });
  s.policyRejections += 1;
  s.history.push({ clipId, reason, confidence, by, at: Date.now() });
  if (s.history.length > 50) s.history.splice(0, s.history.length - 50);
  save();
  return { ...s };
}

export function listContributions(key) {
  return Object.values(load().contributions).filter((c) => c.handleKey === key);
}

/** Look up a contribution without knowing its handle — the clip upload route
 *  is handed only a contribution id. */
export function getContribution(id) {
  return load().contributions[id] || null;
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
    // Platform truth about the BROADCAST — distinct from startedAt/endedAt,
    // which describe this air session and are controlled by whoever opens it.
    // Written only from live observations (see the stream-context gate); null
    // means "never observed", which routes to review rather than passing.
    broadcastStartedAt: null,
    broadcastEndedAt: null,
    lastLiveObservedAt: null,
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
  verifiedClips = 0, verifiedClipSeconds = 0,
  belowQualityFloorClips = 0, smallestBadgePx = null, samplingDensity = null,
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
    verifiedClips,
    verifiedClipSeconds,
    // QUALITY TRAVELS WITH THE RECORD, not just the response of the moment.
    // These decide whether a human is called in, so by the project's own rule
    // — anything a payout is computed FROM is evidence — they have to survive
    // the request. Without them a streamer paid short at 480p could never be
    // shown why, and neither could the reviewer.
    belowQualityFloorClips,
    smallestBadgePx,
    samplingDensity,
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
