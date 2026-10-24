/**
 * CREATOR BOUNTY — persistence.
 *
 * One JSON document under DATA_DIR (bounty.json), loaded once into a module
 * cache and written atomically by json-store.js, like rooms-store.js. DATA_DIR
 * points at a persistent volume in production; without it Railway wipes this
 * on every deploy (see the note in rooms-store.js). A bounty.json that cannot
 * be read refuses writes rather than reading as empty (DECISIONS D3).
 *
 * WHEN IT IS WRITTEN. Every change writes through, except the two that come
 * in bursts: a code issued every few seconds per playing clip, and a badge or
 * sampling violation. Those coalesce into one write within a second
 * (DECISIONS D9), because each used to rewrite the whole board — megabytes,
 * per code. A hard kill can lose that last second from this file; the
 * evidence log (bounty-evidence.js) has already recorded both, and it is the
 * authority a payout is computed from. Closing a session writes through.
 *
 * The EscrowLedger is APPEND-ONLY by contract. Nothing in this module ever
 * mutates a ledger row — `appendLedger` is the only writer and there is no
 * update/delete counterpart. Balances are DERIVED by folding the ledger, not
 * stored, so a corrupted balance field can't silently diverge from history.
 */

import path from 'path';
import { randomUUID } from 'crypto';
import { createLedger } from './bounty-ledger.js';
import * as ev from './bounty-evidence.js';
import { createJsonStore, dataDir } from './json-store.js';

// Resolved once, at import, as the evidence log resolves its own: the board,
// the ledger and the evidence must never land in two different directories.
const DATA_DIR = dataDir();
const STORE_PATH = path.join(DATA_DIR, 'bounty.json');
const LEDGER_PATH = path.join(DATA_DIR, 'bounty-ledger.jsonl');

/**
 * The EscrowLedger lives in its own append-only JSONL file, NOT in
 * bounty.json. The records below are current state, rewritten as a document;
 * the ledger is the money history and gets real append semantics and a
 * per-row checksum (bounty-ledger.js says what that covers and what it does
 * not).
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

const board = createJsonStore({
  file: STORE_PATH,
  name: 'bounty',
  pretty: true,
  writeIfMissing: true,
  empty: EMPTY,
  normalize: (raw) => {
    const doc = { ...EMPTY(), ...raw };
    delete doc.ledger; // legacy field — the ledger is its own file now
    return doc;
  },
});

const load = () => board.data();

/** The document, for a change. Throws StoreRefused (changing nothing) when
 *  bounty.json could not be read. */
function loadForWrite() {
  board.assertWritable();
  return board.data();
}

// Every issued code, for the collision check on each rotation. Built once
// from the board and kept current by pushWindowCode; dropped by any other
// write, because a window can arrive with codes through other paths.
let codeSet = null;

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
  codeSet = null;
  board.save();
}

/** Write within a second, coalescing (D9). Only for changes the evidence log
 *  has already recorded. */
function saveSoon() {
  board.saveSoon();
}

/** Test seam — drops the in-memory cache so a gate can start from disk. */
export function _resetCache() {
  board.reset();
  codeSet = null;
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
  // ...and where the identifier IS an address, validate it as one. base58
  // excludes 0, O, I and l, which the generic handle pattern above accepts
  // happily — and a handleKey that is not a real mint is a pool that can be
  // reserved and never pledged against, the same class of silent dead end the
  // 40-character cap created.
  if (p === 'pumpfun' && !normalizePumpFunMint(h)) return null;
  return `${p}:${h}`;
}

/**
 * A pump.fun identity is a SOLANA MINT, and it is CASE-SENSITIVE.
 *
 * The rule above is right for every other platform and wrong for this one, in
 * two ways that both silently returned null: a mint is 32-44 base58 characters
 * so it overruns the 40-char cap, and `.toLowerCase()` does not normalise a
 * base58 address, it DESTROYS it — `GnBQjwQ…` and `gnbqjwq…` are not the same
 * coin, and the second is not a valid address at all. reserveHandle lowercased
 * the stored handle too, so there was no round-trip back to the real mint:
 * sessionHandle() would have handed pump.fun verification a corrupted address.
 *
 * Case-folding usernames is CORRECT and stays — `Foo` and `foo` are one
 * streamer and must share one pool. Case-folding a mint is the opposite: it
 * would collide two different coins onto one pool.
 *
 * Base58 excludes 0, O, I and l precisely so humans cannot confuse them, which
 * is why this cannot be relaxed into a general alphanumeric rule.
 */
function normalizePumpFunMint(raw) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw) ? raw : null;
}

// ── ReservedHandle ──────────────────────────────────────────────────────────

export function listReservedHandles() {
  return Object.values(load().reservedHandles);
}

export function reserveHandle({ platform, handle, reservedBy = null, ttlMs }) {
  const key = handleKey(platform, handle);
  if (!key) throw new Error('Invalid platform/handle');
  const store = loadForWrite();
  const existing = store.reservedHandles[key];
  if (existing) return existing;
  const now = Date.now();
  const rec = {
    key,
    platform: String(platform).toLowerCase(),
    // Same rule as handleKey: a case-sensitive platform keeps its casing, or
    // the stored handle stops being the thing it identifies. This value is what
    // sessionHandle() hands to the frame sources and the live-status lookers,
    // and a lowercased base58 address is not a real address.
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
  const store = loadForWrite();
  const rec = store.reservedHandles[key];
  if (!rec) throw new Error(`No reserved handle ${key}`);
  Object.assign(rec, patch);
  save();
  return rec;
}

// ── BountyContribution ──────────────────────────────────────────────────────

export function addContribution({ handleKey: key, contributor, amount, letterRef, pledgeId }) {
  const store = loadForWrite();
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
  const store = loadForWrite();
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
  const store = loadForWrite();
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
  const store = loadForWrite();
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
  const store = loadForWrite();
  const rec = store.contributions[id];
  if (!rec) throw new Error(`No contribution ${id}`);
  Object.assign(rec, patch);
  save();
  return rec;
}

// ── Claim ───────────────────────────────────────────────────────────────────

export function createClaim({ handleKey: key, claimant, ttlMs }) {
  const store = loadForWrite();
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
  const store = loadForWrite();
  const rec = store.claims[id];
  if (!rec) throw new Error(`No claim ${id}`);
  Object.assign(rec, patch);
  save();
  return rec;
}

// ── AirSession ──────────────────────────────────────────────────────────────

export function createAirSession({ claimId, roomId, platform, watchUrl }) {
  const store = loadForWrite();
  const rec = {
    id: randomUUID(),
    claimId,
    roomId: roomId || null,
    platform: platform || null,
    // The streamer's own watch/stream-page URL, handed over at session open.
    // YouTube cannot be observed without it (live status is per-VIDEO, not
    // per-channel), and on every platform it beats guessing a channel URL.
    watchUrl: typeof watchUrl === 'string' ? watchUrl.slice(0, 300) : null,
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
  const store = loadForWrite();
  const rec = store.airSessions[id];
  if (!rec) throw new Error(`No air session ${id}`);
  // A patch that changes nothing writes nothing: every badge self-report
  // re-sends `badgeTooSmall: true`, and each one used to rewrite the board.
  if (Object.entries(patch).every(([k, v]) => rec[k] === v)) return rec;
  Object.assign(rec, patch);
  save();
  return rec;
}

export function pushPlaybackWindow(id, win) {
  const store = loadForWrite();
  const rec = store.airSessions[id];
  if (!rec) throw new Error(`No air session ${id}`);
  if (!Array.isArray(rec.playbackWindows)) rec.playbackWindows = [];
  rec.playbackWindows.push(win);
  save();
  ev.recordPlaybackStarted(id, win); // authoritative copy
  return rec;
}

export function updatePlaybackWindow(id, playbackId, patch) {
  const store = loadForWrite();
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
  const store = loadForWrite();
  const rec = store.airSessions[id];
  if (!rec) throw new Error(`No air session ${id}`);
  const win = (rec.playbackWindows || []).find((w) => w.playbackId === playbackId);
  if (!win) throw new Error(`No playback window ${playbackId}`);
  win.codes.push(codeRec);
  saveSoon(); // one rotation per few seconds per clip: coalesced (D9)
  codeSet?.add(codeRec.code);
  ev.recordCodeIssued(id, codeRec); // THE evidence a payout rests on
  return rec;
}

export function pushAirSessionViolation(id, violation) {
  const store = loadForWrite();
  const rec = store.airSessions[id];
  if (!rec) throw new Error(`No air session ${id}`);
  rec.violations.push(violation);
  saveSoon(); // a client can post these in a loop: coalesced (D9)
  ev.recordViolation(id, violation);
  return rec;
}

/** Every code issued across ALL sessions and windows. */
export function allIssuedCodes() {
  return Object.values(load().airSessions)
    .flatMap((s) => (s.playbackWindows || []).flatMap((w) => w.codes.map((c) => c.code)));
}

/** Has this code ever been issued? The rotation's collision guard, O(1): it
 *  used to rebuild a Set of every code ever issued on each rotation. */
export function isCodeIssued(code) {
  if (!codeSet) codeSet = new Set(allIssuedCodes());
  return codeSet.has(code);
}

// ── Review queue (ambiguous verifications) ──────────────────────────────────

export function createReview({ airSessionId, claimId, handleKey: key, verificationId, confidence, reason }) {
  const store = loadForWrite();
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
  const store = loadForWrite();
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
  detectionRate = null,
  timelineSkewMs = null, timelineState = null, timelineSpreadMs = null,
  timelineResidualMs = null, timelineFellBack = null,
}) {
  const store = loadForWrite();
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
    // PRESENCE, by the same rule. detectionRate is not a diagnostic: it is a
    // release gate in its own right (bounty-escrow.release returns
    // skipped:'low_detection_rate' on it), so a record that omits it cannot
    // explain its own outcome. It was dropped here silently the moment it was
    // added, because this destructure is a fixed whitelist and a field absent
    // from it fails by simply not appearing.
    //
    // RESTORED 2026-08-27 after a SECOND silent drop. This block existed,
    // committed, proven — and then a LATER commit (b4638ff, whose message
    // claimed to touch only OPEN-ISSUES.md) deleted it without that diff ever
    // being reviewed. Caught by a fresh live Kick broadcast that verified PASS
    // with confidence 0.857 and then showed release(stub): 0 of 25 — a
    // MEASURED calibration DISAGREEMENT had opened a review, and the
    // verification record carried none of the timeline evidence that would
    // explain why to a reviewer, because this exact code was gone again. Gate
    // coverage (_gate-record-flow.mjs section on round-tripping these fields)
    // now exists specifically so a future silent drop fails loudly instead of
    // waiting for someone to notice a payout that didn't happen.
    detectionRate,
    timelineSkewMs,
    timelineState,
    timelineSpreadMs,
    timelineResidualMs,
    timelineFellBack,
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

/** Pool money is exact to 6 places, so it is counted in integer micro-units. */
export const toMicros = (x) => Math.round(parseFloat(x || '0') * 1e6);
export const fromMicros = (m) => +(m / 1e6).toFixed(6);

/**
 * What each HELD contribution can still give, and what the pool as a whole
 * still holds (money-9). A release is drawn from the contributions pro rata
 * and says so (`meta.allocations` on its RELEASE row, bounty-escrow.js); a
 * refund returns only what was NOT released. Before, a release drew on the
 * whole pool and left every contribution whole on paper, so refunding one
 * afterwards paid its face value again: $1 + $100, A's clip released $7.07,
 * B's refund paid $100 — $107.07 out of $101.
 *
 * `balance` is money in − refunded − released, over the ledger itself, so it
 * also bounds pools written before allocations existed (their RELEASE rows
 * carry none): nothing paid from such a pool can exceed what came in.
 */
export function poolBalances(key, { contributions = listContributions(key), rows = listLedger({ handleKey: key }) } = {}) {
  const releasedBy = new Map();
  let released = 0;
  let refunded = 0;
  for (const r of rows) {
    if (r.type === 'REFUND' && r.bucket === 'contributor') refunded += toMicros(r.amount);
    if (r.type !== 'RELEASE' || r.bucket !== 'contributor') continue;
    released += toMicros(r.amount);
    for (const a of r.meta?.allocations || []) releasedBy.set(a.contributionId, (releasedBy.get(a.contributionId) || 0) + toMicros(a.amount));
  }
  // A forfeit row is a refunded contribution's withheld share, still in the
  // pool: the money came in once, with the contribution it was withheld from.
  const moneyIn = contributions.filter((c) => !c.forfeitOfClip).reduce((a, c) => a + toMicros(c.amount), 0);
  const left = new Map();
  for (const c of contributions) {
    if (c.status === 'HELD') left.set(c.id, Math.max(0, toMicros(c.amount) - (releasedBy.get(c.id) || 0)));
  }
  return { left, balance: moneyIn - refunded - released, moneyIn, released, refunded };
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
  // Never more than the contributions still hold, nor than the ledger says
  // the pool holds: the second is what keeps an older pool honest (money-9).
  const b = poolBalances(key, { contributions, rows });
  const heldLeft = [...b.left.values()].reduce((a, m) => a + m, 0);
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
    remaining: fromMicros(Math.max(0, Math.min(heldLeft, b.balance))),
    // True when releases + refunds already exceed what came in: a pool paid
    // under the old arithmetic. Nothing more leaves it; a person looks.
    overdrawn: b.balance < 0,
  };
}

export function getReservedHandleByKey(key) {
  return load().reservedHandles[key] || null;
}

export function listPools() {
  return listReservedHandles().map((r) => getPool(r.key));
}
