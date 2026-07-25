/**
 * CREATOR BOUNTY — watermark issuance.
 *
 * Proof-of-broadcast without hosting video: the server issues a short code
 * per air session on a rotating interval, the overlay renders it, and the
 * verifier later checks public stream frames at those exact timestamps.
 *
 * Two properties the whole scheme rests on:
 *
 *  1. NO CROSS-SESSION COLLISION. Every code carries a per-session namespace
 *     prefix, and the random body is additionally checked against every code
 *     currently live anywhere. If two concurrent sessions could emit the same
 *     code, streamer A's frame would verify streamer B's airtime.
 *  2. CODES ARE NOT GUESSABLE AHEAD OF TIME. They're random per rotation, so
 *     a streamer cannot pre-render a fake badge for a future window.
 *
 * The alphabet deliberately drops visually ambiguous glyphs — these get read
 * back off a downscaled, re-compressed stream frame, where O/0 and I/1/L are
 * exactly where a checker loses accuracy.
 */

import { randomInt } from 'crypto';
import { bountyConfig } from './bounty-claim.config.js';
import * as store from './bounty-store.js';

/** No 0/O, 1/I/L, 5/S, 8/B, 2/Z — unambiguous when downscaled. */
const ALPHABET = '34679ACDEFGHJKMNPQRTUVWXY';

function randomBody(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[randomInt(0, ALPHABET.length)];
  return s;
}

/**
 * Per-session namespace. Derived from the session id so it is stable for the
 * session's lifetime and distinct between concurrent sessions — the prefix
 * alone makes cross-session collision impossible even before the global
 * uniqueness check.
 */
export function namespaceFor(airSessionId) {
  const hex = String(airSessionId).replace(/[^a-f0-9]/gi, '').toUpperCase();
  let ns = '';
  for (const ch of hex) {
    if (ALPHABET.includes(ch)) ns += ch;
    if (ns.length === 2) break;
  }
  while (ns.length < 2) ns += ALPHABET[randomInt(0, ALPHABET.length)];
  return ns;
}

/**
 * Issue the next code for an air session. Returns the code record, or null if
 * the session is closed or currently in violation (a too-small badge stops
 * issuance — see below).
 */
export function issueCode(airSessionId, { now = Date.now() } = {}) {
  const session = store.getAirSession(airSessionId);
  if (!session) throw new Error(`No air session ${airSessionId}`);
  if (session.status !== 'OPEN') return null;

  // Anti-malicious-compliance: while the badge is too small to be read, we
  // stop issuing. The streamer's own payout is what stops, which is the point
  // — shrinking the source zeroes their money instead of fooling the check.
  if (session.badgeTooSmall) return null;

  const ns = namespaceFor(airSessionId);
  const live = new Set(store.allIssuedCodes());
  let code = null;
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = `${ns}-${randomBody(bountyConfig.codeLength)}`;
    if (!live.has(candidate)) { code = candidate; break; }
  }
  if (!code) throw new Error('Could not allocate a unique watermark code');

  const rec = {
    code,
    issuedAt: now,
    expiresAt: now + bountyConfig.codeValidityMs,
  };
  store.pushAirSessionCode(airSessionId, rec);
  return rec;
}

/** The code that should be on screen right now, or null. */
export function activeCode(airSessionId, { now = Date.now() } = {}) {
  const session = store.getAirSession(airSessionId);
  if (!session || session.status !== 'OPEN' || session.badgeTooSmall) return null;
  const live = session.codes.filter((c) => c.issuedAt <= now && c.expiresAt > now);
  return live.length ? live[live.length - 1] : null;
}

/**
 * Issue on demand if the current code has aged past the rotation interval.
 * Called by the overlay's poll — keeps rotation server-authoritative instead
 * of trusting a client timer.
 */
export function currentOrRotate(airSessionId, { now = Date.now() } = {}) {
  const session = store.getAirSession(airSessionId);
  if (!session || session.status !== 'OPEN' || session.badgeTooSmall) return null;
  const last = session.codes[session.codes.length - 1];
  if (!last || now - last.issuedAt >= bountyConfig.codeRotateMs) {
    return issueCode(airSessionId, { now });
  }
  return last;
}

/** Codes valid at a given instant — what the verifier checks a frame against. */
export function codesValidAt(airSessionId, ts) {
  const session = store.getAirSession(airSessionId);
  if (!session) return [];
  return session.codes.filter((c) => c.issuedAt <= ts && c.expiresAt > ts);
}

/**
 * Record a badge-size violation reported by the overlay.
 *
 * Trust note (honest): this is a CLIENT self-report, exactly the weakness the
 * watermark scheme exists to avoid elsewhere. It is safe here only because
 * the incentive points the right way — a client that lies by NOT reporting
 * still fails verification, since a badge too small to read is also too small
 * for the checker to find. Reporting simply makes the failure legible to the
 * streamer instead of silent. See OPEN-ISSUES.md.
 */
export function reportBadgeTooSmall(airSessionId, detail) {
  const session = store.getAirSession(airSessionId);
  if (!session) throw new Error(`No air session ${airSessionId}`);
  store.pushAirSessionViolation(airSessionId, {
    type: 'BADGE_TOO_SMALL',
    at: Date.now(),
    detail: detail || null,
  });
  store.updateAirSession(airSessionId, { badgeTooSmall: true });
  return store.getAirSession(airSessionId);
}

/** Badge is legible again — resume issuing. */
export function clearBadgeViolation(airSessionId) {
  const session = store.getAirSession(airSessionId);
  if (!session) throw new Error(`No air session ${airSessionId}`);
  store.updateAirSession(airSessionId, { badgeTooSmall: false });
  return store.getAirSession(airSessionId);
}
