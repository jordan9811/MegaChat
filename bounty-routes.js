/**
 * CREATOR BOUNTY — HTTP surface.
 *
 * EVERY route here is behind BOUNTY_CLAIM. With the flag off, `attachBountyRoutes`
 * mounts nothing at all — not a 403 handler, nothing — so an unflagged deploy
 * is byte-identical to today and the routes 404 like any unknown path.
 *
 * ⚠ No route in this file moves funds. Releases go through bounty-escrow,
 * whose settlement dependency is the record-intent stub.
 */

import { bountyConfig, bountyClientConfig } from './bounty-claim.config.js';
import * as store from './bounty-store.js';
import * as escrow from './bounty-escrow.js';
import * as watermark from './bounty-watermark.js';
import * as verifier from './bounty-verifier.js';
import settlement from './bounty-settlement.js';

/**
 * Identity verification is STUBBED in Run A — real OAuth is Run B.
 * TODO(run-b): replace with a real platform OAuth round-trip proving the
 * claimant controls the target handle. Until then every approval is recorded
 * as STUBBED_APPROVAL in the ledger so no stubbed claim can ever be mistaken
 * for a verified one after the fact.
 */
export class IdentityVerifier {
  async verify(_platform, _handle, _claimant) { throw new Error('not implemented'); }
}
export class StubIdentityVerifier extends IdentityVerifier {
  async verify(platform, handle, claimant) {
    if (!bountyConfig.identityStubAutoApprove) {
      return { approved: false, method: 'STUBBED_DENY' };
    }
    return { approved: true, method: 'STUBBED_APPROVAL', platform, handle, claimant };
  }
}

/**
 * Playback hooks handed to letters.js. These are the ONLY thing that opens a
 * watermark window: a code cannot exist unless the server itself started a
 * clip. Exported separately so they can be wired even in tests.
 */
export function makeClipHooks({ log = console } = {}) {
  const findOpenSession = (roomId) =>
    store.listAirSessions().find((s) => s.status === 'OPEN' && s.roomId === roomId) || null;

  return {
    onClipPlay(roomId, { clipId, durationS }) {
      if (!bountyConfig.enabled) return;
      const s = findOpenSession(roomId);
      if (!s) return; // room isn't running a bounty air session — nothing to do
      const r = watermark.startClipPlayback(s.id, { clipId, durationS });
      if (r && !r.code) {
        log.warn(`[bounty] clip ${clipId} is ${durationS}s — below the ${bountyConfig.minClipSeconds}s sampling floor, it will not be payable`);
      }
    },
    onClipEnd(roomId, { clipId }) {
      if (!bountyConfig.enabled) return;
      const s = findOpenSession(roomId);
      if (!s) return;
      watermark.endClipPlayback(s.id, { clipId });
    },
  };
}

export function attachBountyRoutes(app, { log = console, identityVerifier } = {}) {
  if (!bountyConfig.enabled) {
    log.log('[bounty] BOUNTY_CLAIM off — no routes mounted, no surfaces rendered');
    return { mounted: false };
  }
  const identity = identityVerifier || new StubIdentityVerifier();

  // Validate the escrow ledger chain BEFORE serving anything. Pools are
  // derived by folding this ledger, so starting on a corrupt one would serve
  // confidently-wrong balances. A torn final record self-heals (logged); an
  // interior gap or bad checksum throws and takes the boot with it.
  try {
    const { recovered } = store.verifyLedgerIntegrity();
    if (recovered) log.warn(`[bounty] ledger recovered ${recovered} torn record(s) at startup`);
  } catch (e) {
    log.error(`[bounty] REFUSING TO START: ${e.message}`);
    throw e;
  }

  // Same treatment for the EVIDENCE chain — the watermark codes a payout is
  // computed from. Corruption here does not lose bookkeeping, it makes a
  // verifier count fewer playbacks than aired and underpay, silently.
  try {
    const { recovered } = store.verifyEvidenceIntegrity();
    if (recovered) log.warn(`[bounty] evidence log recovered ${recovered} torn record(s) at startup`);
  } catch (e) {
    log.error(`[bounty] REFUSING TO START — evidence chain is corrupt: ${e.message}`);
    throw e;
  }

  log.warn('[bounty] BOUNTY_CLAIM ON — escrow is a LEDGER ONLY. Settlement is stubbed; no funds move.');

  // Protect reserved handles from being claimed as ordinary room handles.
  // Registered only while the flag is on (see rooms-store.setHandleGuard).
  import('./rooms-store.js').then(({ setHandleGuard }) => {
    setHandleGuard((h) => {
      const hit = store.listReservedHandles().find(
        (r) => r.handle === h && r.claimStatus !== 'RELEASED' && r.claimStatus !== 'VOID',
      );
      if (hit && !hit.claimedBy) {
        const err = new Error(`"${h}" is reserved for a creator bounty — claim it through the bounty flow`);
        err.code = 'handle_bounty_reserved';
        throw err;
      }
    });
  }).catch(() => { /* guard is best-effort; collision check still runs */ });

  const fail = (res, e) => {
    const code = e?.code === 'illegal_transition' ? 409 : e?.code === 'bounty_disabled' ? 404 : 400;
    return res.status(code).json({ error: e?.message || 'Bounty error', code: e?.code || null });
  };

  // ── Public: bounty board ─────────────────────────────────────────────────
  app.get('/api/bounty/config', (_req, res) => res.json(bountyClientConfig()));

  app.get('/api/bounty/pools', (_req, res) => {
    res.json({ pools: store.listPools(), currency: bountyConfig.currency });
  });

  app.get('/api/bounty/pool', (req, res) => {
    const key = store.handleKey(req.query.platform, req.query.handle);
    if (!key) return res.status(400).json({ error: 'platform and handle required' });
    res.json({ pool: store.getPool(key), reserved: store.getReservedHandleByKey(key) });
  });

  // ── Contribute (a recorded MegaChat against an unclaimed handle) ─────────
  app.post('/api/bounty/contribute', (req, res) => {
    try {
      const { platform, handle, contributor, amount, letterRef } = req.body || {};
      const c = escrow.contribute({ platform, handle, contributor, amount, letterRef });
      res.json({ ok: true, contribution: c, pool: store.getPool(c.handleKey) });
    } catch (e) { fail(res, e); }
  });

  // ── Claim flow ───────────────────────────────────────────────────────────
  app.post('/api/bounty/claim', async (req, res) => {
    try {
      const { platform, handle, claimant } = req.body || {};
      const key = store.handleKey(platform, handle);
      if (!key) return res.status(400).json({ error: 'platform and handle required' });
      const reserved = store.getReservedHandleByKey(key);
      if (!reserved) return res.status(404).json({ error: 'No bounty reserved for that handle' });

      if (reserved.claimStatus === 'ACCUMULATING') {
        escrow.transition({ handleKey: key, to: 'RESERVED', actor: claimant || 'claimant', reason: 'claim started' });
      }
      escrow.transition({ handleKey: key, to: 'CLAIM_PENDING', actor: claimant || 'claimant', reason: 'claim opened' });

      const claim = store.createClaim({ handleKey: key, claimant, ttlMs: bountyConfig.claimTtlMs });

      const idv = await identity.verify(platform, handle, claimant);
      store.updateClaim(claim.id, {
        verificationState: idv.approved ? 'VERIFIED' : 'DENIED',
        verificationMethod: idv.method,
      });
      store.appendLedger({
        handleKey: key, claimId: claim.id, type: 'IDENTITY_CHECK',
        actor: claimant || 'claimant', reason: idv.method,
        meta: { approved: idv.approved, stubbed: idv.method.startsWith('STUBBED') },
      });

      if (idv.approved) {
        escrow.transition({ handleKey: key, to: 'CLAIM_VERIFIED', actor: 'identity', reason: idv.method, claimId: claim.id });
        escrow.transition({ handleKey: key, to: 'AWAITING_AIRTIME', actor: 'system', reason: 'awaiting broadcast', claimId: claim.id });
        store.updateReservedHandle(key, { claimedBy: claimant || null });
      }
      res.json({ ok: true, claim: store.getClaim(claim.id), identity: idv, pool: store.getPool(key) });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/bounty/claim/:id', (req, res) => {
    const claim = store.getClaim(req.params.id);
    if (!claim) return res.status(404).json({ error: 'No such claim' });
    const sessions = store.listAirSessions(claim.id);
    const ledger = store.listLedger({ claimId: claim.id });
    const releases = ledger.filter((r) => r.type === 'RELEASE');
    const latest = releases[releases.length - 1];
    // Surface review state to the STREAMER. An ambiguous result that shows
    // nothing reads as a silent denial; "a person is looking at this" is the
    // difference between a support ticket and a trust incident.
    const reviews = sessions.flatMap((s) => store.listReviews({ airSessionId: s.id }));
    const openReview = reviews.find((r) => r.state === 'OPEN') || null;
    res.json({
      claim,
      pool: store.getPool(claim.handleKey),
      airSessions: sessions,
      verifiedClips: sessions.reduce((a, s) => a + (s.verifiedClips || 0), 0),
      verifiedClipSeconds: sessions.reduce((a, s) => a + (s.verifiedClipSeconds || 0), 0),
      verifiedMinutes: sessions.reduce((a, s) => a + (s.verifiedMinutes || 0), 0),
      underReview: !!openReview,
      reviewOpenedAt: openReview?.openedAt || null,
      reviews: reviews.map((r) => ({ id: r.id, state: r.state, openedAt: r.openedAt, resolvedAt: r.resolvedAt })),
      disputeWindowEndsAt: latest?.meta?.disputeWindowEndsAt || null,
      ledger,
    });
  });

  // ── Air sessions + watermark ─────────────────────────────────────────────
  app.post('/api/bounty/air-session', (req, res) => {
    try {
      const { claimId, roomId, platform } = req.body || {};
      const claim = store.getClaim(claimId);
      if (!claim) return res.status(404).json({ error: 'No such claim' });
      if (claim.verificationState !== 'VERIFIED') {
        return res.status(403).json({ error: 'Claim identity is not verified' });
      }
      const s = store.createAirSession({ claimId, roomId, platform });
      const first = watermark.issueCode(s.id);
      res.json({ ok: true, airSession: store.getAirSession(s.id), code: first });
    } catch (e) { fail(res, e); }
  });

  /** Overlay polls this for the code it must render. */
  app.get('/api/bounty/air-session/:id/code', (req, res) => {
    try {
      const rec = watermark.currentOrRotate(req.params.id);
      const s = store.getAirSession(req.params.id);
      if (!s) return res.status(404).json({ error: 'No such air session' });
      res.json({
        code: rec ? rec.code : null,
        expiresAt: rec ? rec.expiresAt : null,
        rotateMs: bountyConfig.codeRotateMs,
        badgeTooSmall: !!s.badgeTooSmall,
        status: s.status,
      });
    } catch (e) { fail(res, e); }
  });

  /** Overlay self-reports badge legibility. See the trust note in bounty-watermark.js. */
  app.post('/api/bounty/air-session/:id/badge', (req, res) => {
    try {
      const { tooSmall, detail } = req.body || {};
      const s = tooSmall
        ? watermark.reportBadgeTooSmall(req.params.id, detail)
        : watermark.clearBadgeViolation(req.params.id);
      res.json({ ok: true, badgeTooSmall: !!s.badgeTooSmall, violations: s.violations.length });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/bounty/air-session/:id/end', (req, res) => {
    try {
      const s = store.updateAirSession(req.params.id, { status: 'CLOSED', endedAt: Date.now() });
      res.json({ ok: true, airSession: s });
    } catch (e) { fail(res, e); }
  });

  // ── Verify + release ─────────────────────────────────────────────────────
  app.post('/api/bounty/air-session/:id/verify', async (req, res) => {
    try {
      const s = store.getAirSession(req.params.id);
      if (!s) return res.status(404).json({ error: 'No such air session' });
      const claim = store.getClaim(s.claimId);
      const key = claim.handleKey;

      const reserved = store.getReservedHandleByKey(key);
      if (escrow.canTransition(reserved.claimStatus, 'VERIFYING')) {
        escrow.transition({ handleKey: key, to: 'VERIFYING', actor: 'verifier', reason: 'verification started', claimId: claim.id, airSessionId: s.id });
      }

      const v = await verifier.verifyAirSession(s.id);

      // AMBIGUOUS evidence goes to a human instead of silently paying zero.
      // On mainnet, a streamer who did the work and got neither money nor a
      // person looking at their case is a support incident and a trust
      // incident at once.
      let review = null;
      if (v.result === 'AMBIGUOUS' && !store.hasOpenReview(s.id)) {
        review = store.createReview({
          airSessionId: s.id, claimId: claim.id, handleKey: key,
          verificationId: v.attempt.id, confidence: v.confidence,
          reason: `ambiguous: ${v.verifiedClips} clip(s) matched at confidence ${v.confidence}`,
        });
        store.appendLedger({
          handleKey: key, claimId: claim.id, airSessionId: s.id,
          type: 'REVIEW_OPENED', actor: 'verifier',
          reason: 'ambiguous verification routed to human review',
          meta: { reviewId: review.id, confidence: v.confidence },
        });
      }

      // Idempotency keyed on the session — re-verifying the same session can
      // never pay twice, however many times this route is hit. Blocks while a
      // review is open.
      const out = escrow.release({
        handleKey: key, claimId: claim.id, airSessionId: s.id,
        verifiedClips: v.verifiedClips, verifiedClipSeconds: v.verifiedClipSeconds,
        confidence: v.confidence,
        actor: 'verifier', idempotencyKey: `release:${s.id}`, settlement,
      });
      res.json({ ok: true, verification: v, release: out, review, pool: store.getPool(key) });
    } catch (e) { fail(res, e); }
  });

  // ── Refund path ──────────────────────────────────────────────────────────
  app.post('/api/bounty/refund-expired', (req, res) => {
    try {
      const key = store.handleKey(req.body?.platform, req.body?.handle);
      if (!key) return res.status(400).json({ error: 'platform and handle required' });
      const rows = escrow.refundExpired({ handleKey: key, actor: 'admin', settlement });
      res.json({ ok: true, refunded: rows.length, pool: store.getPool(key) });
    } catch (e) { fail(res, e); }
  });

  // ── Admin ────────────────────────────────────────────────────────────────
  app.get('/api/bounty/admin/sessions', (_req, res) => {
    const sessions = store.listAirSessions().map((s) => ({
      ...s,
      verifications: store.listVerifications(s.id),
      claim: store.getClaim(s.claimId),
    }));
    res.json({ sessions, settlementIntents: settlement.pending() });
  });

  app.post('/api/bounty/admin/override', (req, res) => {
    try {
      const { platform, handle, to, reason, actor } = req.body || {};
      const key = store.handleKey(platform, handle);
      if (!key) return res.status(400).json({ error: 'platform and handle required' });
      if (!reason || !String(reason).trim()) {
        return res.status(400).json({ error: 'A reason is required and is written to the ledger' });
      }
      const r = escrow.adminOverride({ handleKey: key, to, actor: actor || 'admin', reason });
      res.json({ ok: true, ...r, pool: store.getPool(key) });
    } catch (e) { fail(res, e); }
  });

  // ── Review queue (ambiguous verifications) ───────────────────────────────
  app.get('/api/bounty/admin/reviews', (_req, res) => {
    const now = Date.now();
    const reviews = store.listReviews().map((r) => ({
      ...r,
      ageMs: now - r.openedAt,
      // Past SLA and still open — surfaced loudly so it cannot rot silently.
      breachedSla: r.state === 'OPEN' && (now - r.openedAt) > bountyConfig.reviewSlaMs,
    }));
    res.json({
      reviews,
      slaMs: bountyConfig.reviewSlaMs,
      openCount: reviews.filter((r) => r.state === 'OPEN').length,
      breachedCount: reviews.filter((r) => r.breachedSla).length,
    });
  });

  app.post('/api/bounty/admin/reviews/:id/assign', (req, res) => {
    try {
      const r = store.updateReview(req.params.id, { assignee: req.body?.assignee || null });
      res.json({ ok: true, review: r });
    } catch (e) { fail(res, e); }
  });

  /** Resolve a review. A reason is REQUIRED and is written to the ledger. */
  app.post('/api/bounty/admin/reviews/:id/resolve', async (req, res) => {
    try {
      const { approve, reason, actor } = req.body || {};
      if (!reason || !String(reason).trim()) {
        return res.status(400).json({ error: 'A reason is required and is written to the ledger' });
      }
      const review = store.getReview(req.params.id);
      if (!review) return res.status(404).json({ error: 'No such review' });
      if (review.state !== 'OPEN') return res.status(409).json({ error: 'Review already resolved' });

      store.updateReview(review.id, {
        state: approve ? 'RESOLVED_APPROVE' : 'RESOLVED_REJECT',
        resolvedAt: Date.now(),
        resolvedBy: actor || 'admin',
        resolutionReason: String(reason).trim(),
      });
      store.appendLedger({
        handleKey: review.handleKey, claimId: review.claimId, airSessionId: review.airSessionId,
        type: 'REVIEW_RESOLVED', actor: actor || 'admin',
        reason: `${approve ? 'APPROVED' : 'REJECTED'}: ${String(reason).trim()}`,
        meta: { reviewId: review.id, approve: !!approve },
      });

      // Approving releases on the reviewer's judgement rather than the
      // confidence floor that could not decide.
      let out = null;
      if (approve) {
        const s = store.getAirSession(review.airSessionId);
        out = escrow.release({
          handleKey: review.handleKey, claimId: review.claimId, airSessionId: review.airSessionId,
          verifiedClips: s?.verifiedClips || 0, verifiedClipSeconds: s?.verifiedClipSeconds || 0,
          confidence: 1, // human-adjudicated
          actor: actor || 'admin', idempotencyKey: `release:${review.airSessionId}`, settlement,
        });
      }
      res.json({ ok: true, review: store.getReview(review.id), release: out });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/bounty/admin/ledger', (req, res) => {
    const key = req.query.platform && req.query.handle
      ? store.handleKey(req.query.platform, req.query.handle) : null;
    res.json({ ledger: store.listLedger(key ? { handleKey: key } : {}) });
  });

  log.log('[bounty] routes mounted (flagged ON)');
  return { mounted: true };
}
