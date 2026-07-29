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

import express from 'express';
import { bountyConfig, bountyClientConfig } from './bounty-claim.config.js';
import * as store from './bounty-store.js';
import * as escrow from './bounty-escrow.js';
import * as watermark from './bounty-watermark.js';
import * as verifier from './bounty-verifier.js';
import * as clips from './bounty-clips.js';
import { moderateMedia, moderationConfigured } from './moderation.js';
import * as evidence from './bounty-evidence.js';
import { twitchApiConfigured, getStreamByLogin } from './twitch-api.js';
import { kickApiConfigured, getChannelBySlug } from './kick-api.js';
import { readIdentityFromRequest } from './auth.js';
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
 * REAL Twitch ownership proof — activated by BOUNTY_IDENTITY_REAL=1.
 *
 * A claim is approved only when the REQUESTER'S SIGNED-IN IDENTITY is a
 * Twitch account whose login matches the claimed handle. That identity was
 * established by a real OAuth round trip (legacy /auth/twitch or Privy's
 * Twitch login), verified server-side and sealed into the tamper-evident
 * mc_identity cookie — so "I am this channel" is proven by Twitch itself,
 * not asserted in a request body.
 *
 * Kept behind its own flag rather than replacing the stub outright: the stub
 * remains the default so unattended test environments keep working, and
 * turning real verification on for production is one explicit env flip that
 * shows up in the boot log. Kick gets the same shape when its credentials
 * exist (OAuth 2.1 + PKCE, auth on id.kick.com, API on api.kick.com — noted
 * for the run that has keys).
 */
export class PlatformIdentityVerifier extends IdentityVerifier {
  static SUPPORTED = new Set(['twitch', 'kick']);
  async verify(platform, handle, _claimant, { req } = {}) {
    if (!PlatformIdentityVerifier.SUPPORTED.has(platform)) {
      return { approved: false, method: 'REAL_UNSUPPORTED_PLATFORM' };
    }
    const identity = req ? readIdentityFromRequest(req) : null;
    if (!identity) {
      return { approved: false, method: 'REAL_NOT_SIGNED_IN' };
    }
    // Cross-platform proof is no proof: a Twitch session says nothing about
    // who owns a Kick slug of the same name, and vice versa.
    if (identity.provider !== platform) {
      return { approved: false, method: `REAL_WRONG_PROVIDER:${identity.provider}` };
    }
    const owns = String(identity.username || identity.handle || '')
      .toLowerCase() === String(handle).toLowerCase();
    return owns
      ? {
        approved: true,
        method: platform === 'twitch' ? 'TWITCH_OAUTH_SESSION' : 'KICK_OAUTH_SESSION',
        platform, handle, login: identity.username,
      }
      : { approved: false, method: 'REAL_HANDLE_MISMATCH' };
  }
}
/** Back-compat name from the Twitch-only iteration. */
export const TwitchIdentityVerifier = PlatformIdentityVerifier;

/**
 * Playback hooks handed to letters.js. These are the ONLY thing that opens a
 * watermark window: a code cannot exist unless the server itself started a
 * clip. Exported separately so they can be wired even in tests.
 */
/**
 * Capture what the PLATFORM says about this channel at the instant a clip
 * plays: concurrent viewers, and when the broadcast began.
 *
 * Shared deliberately. This used to live inside the clip hook only, so the
 * admin/rehearsal playback route — the one the dress-rehearsal harness drives
 * during an actual broadcast — recorded nothing at all. The stream-context
 * gate would then have judged the one broadcast we most care about on missing
 * data.
 *
 * Fire-and-forget by contract: a platform round-trip must never sit inside the
 * playback path of a live stream.
 */
function captureBroadcastObservation(s, { playbackId, clipId, log = console } = {}) {
  const look = s.platform === 'twitch' ? (twitchApiConfigured() ? getStreamByLogin : null)
    : s.platform === 'kick' ? (kickApiConfigured() ? getChannelBySlug : null)
      : null;
  if (!look) return; // no creds — "could not ask" is not evidence of anything
  const claim = store.getClaim(s.claimId);
  const handle = claim ? store.getReservedHandleByKey(claim.handleKey)?.handle : null;
  if (!handle) return;
  void look(handle, { log }).then((stream) => {
    if (!stream) return;
    evidence.recordViewerSample(s.id, {
      playbackId: playbackId || null, clipId: clipId || null,
      handle, platform: s.platform,
      live: stream.live, viewerCount: stream.viewerCount,
    });
    // THE BROADCAST START, TAKEN WHILE THE CHANNEL IS PROVABLY LIVE. This is
    // the only moment it can be had: verification is VOD-first and runs after
    // the stream is over, when the platform reports the channel offline and
    // the start time is simply gone. Asking at verify time returned null for
    // every honest session and routed all of them to NO_BROADCAST_START
    // review — broken in exactly the direction that punishes real streamers.
    //
    // Platform truth, not ours: the channel's start time, not when the air
    // session opened, which whoever is claiming controls.
    const cur = store.getAirSession(s.id) || s;
    const patch = {};
    if (stream.live && stream.startedAt) {
      const t = Date.parse(stream.startedAt);
      // Earliest observation wins — re-reading the same broadcast mid-session
      // must not walk the start time forward.
      if (Number.isFinite(t) && (!cur.broadcastStartedAt || t < cur.broadcastStartedAt)) {
        patch.broadcastStartedAt = t;
      }
    }
    if (stream.live) patch.lastLiveObservedAt = Date.now();
    if (Object.keys(patch).length) store.updateAirSession(s.id, patch);
  }).catch(() => { /* never let a platform hiccup touch the playback path */ });
}

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
      // Viewer count + broadcast start, captured together while the channel
      // is provably live. See captureBroadcastObservation.
      captureBroadcastObservation(s, { playbackId: r?.playbackId || null, clipId, log });
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
  // BOUNTY_IDENTITY_REAL=1 flips claims from the auto-approving stub to the
  // session-bound Twitch proof. Loud at boot either way — which verifier is
  // deciding who owns a handle must never be a surprise.
  const identity = identityVerifier
    || (process.env.BOUNTY_IDENTITY_REAL === '1' ? new PlatformIdentityVerifier() : new StubIdentityVerifier());
  log.log(`[bounty] identity verifier: ${identity.constructor.name}`);

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

  // And the CLIP INDEX, for the same reason as the other two: it is the record
  // of what a fan paid for and what a streamer is owed. It was the only one of
  // the three append-only chains not validated at boot, which meant corruption
  // would have surfaced lazily on the first upload instead of loudly here.
  {
    const t = clips.verifyClipIndexIntegrity();
    if (!t.ok) {
      log.error(`[bounty] REFUSING TO START — clip index is corrupt: ${t.error}`);
      throw new Error(`clip index corrupt: ${t.error}`);
    }
    const s = clips.stats();
    log.log(`[bounty] clip store: ${s.clips} clip(s), ${(s.bytes / 1e6).toFixed(1)}MB (${s.pctUsed}% of budget)`);
    // Orphaned media wastes volume; missing media is DATA LOSS and must be said
    // out loud rather than tidied away.
    const sweep = clips.sweepOrphans();
    if (sweep.deletedOrphanFiles.length) {
      log.warn(`[bounty] swept ${sweep.deletedOrphanFiles.length} orphaned clip file(s)`);
    }
    if (sweep.missingMedia.length) {
      log.error(
        `[bounty] ⚠ ${sweep.missingMedia.length} clip(s) have an index record but NO MEDIA on disk: `
        + `${sweep.missingMedia.join(', ')}. A fan paid for these and they cannot be played. `
        + `They are NOT being auto-purged — decide whether to refund them.`,
      );
    }
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
  //
  // Two steps on purpose, mirroring the letters flow: the contribution is
  // recorded first and the recording is uploaded against it second. The
  // reverse would store bytes for a contribution that might never exist.
  app.post('/api/bounty/contribute', (req, res) => {
    try {
      const { platform, handle, contributor, amount, letterRef } = req.body || {};
      const c = escrow.contribute({ platform, handle, contributor, amount, letterRef });
      res.json({
        ok: true,
        contribution: c,
        pool: store.getPool(c.handleKey),
        // Until this is uploaded the pool has money with nothing behind it.
        uploadUrl: `/api/bounty/clip/${encodeURIComponent(c.id)}`,
        uploadDeadline: Date.now() + bountyConfig.clipUploadGraceMs,
        clipLimits: {
          minSeconds: bountyConfig.minClipSeconds,
          maxBytes: bountyConfig.clipMaxBytes,
        },
      });
    } catch (e) { fail(res, e); }
  });

  // ── Upload the actual recording for a contribution ───────────────────────
  app.post('/api/bounty/clip/:contributionId',
    express.raw({ type: () => true, limit: bountyConfig.clipMaxBytes + 1024 }),
    (req, res) => {
      try {
        const contributionId = req.params.contributionId;
        const contribution = store.getContribution(contributionId);
        if (!contribution) return res.status(404).json({ error: 'No such contribution' });
        if (contribution.status !== 'HELD') {
          return res.status(409).json({ error: `Contribution is ${contribution.status}` });
        }
        const existing = clips.listClips(contribution.handleKey)
          .find((c) => c.contributionId === contributionId);
        if (existing) {
          // Idempotent: a retried upload must not store the clip twice and
          // must not burn a second slot against the handle cap.
          return res.json({ ok: true, clip: existing, deduped: true });
        }
        const out = clips.storeClip({
          handleKey: contribution.handleKey,
          contributionId,
          contributor: contribution.contributor,
          mime: req.get('content-type') || 'video/webm',
          durationS: Number(req.get('x-clip-duration') || req.query.durationS),
          data: req.body,
        });
        res.json({ ok: true, clip: out, moderation: moderationConfigured() ? 'queued' : 'not_configured' });

        // Moderation runs AT UPLOAD, never at playback: bounty clips air
        // later on someone's live broadcast, and nothing may hold a
        // classifier round-trip over a live stream. Post-ack so the fan's
        // upload latency never includes OpenAI's.
        if (moderationConfigured()) {
          const frames = pendingFrames.get(contributionId)?.frames || [];
          pendingFrames.delete(contributionId);
          setImmediate(async () => {
            try {
              const verdict = await moderateMedia({
                media: req.body, mime: req.get('content-type') || 'video/webm', frames, log,
                borderlineFloor: bountyConfig.moderationBorderlineFloor,
                violationFloor: bountyConfig.moderationViolationFloor,
              });
              if (verdict.grade) {
                clips.recordModeration(out.clipId, {
                  grade: verdict.grade, confidence: verdict.confidence,
                  topCategory: verdict.topCategory,
                });
                log.log(`[bounty] clip ${out.clipId} moderated: ${verdict.grade} (${verdict.confidence})`);
              } else {
                log.warn(`[bounty] clip ${out.clipId} moderation inconclusive (${verdict.error || 'no verdict'}) — queue shows it unmoderated`);
              }
            } catch (e) {
              log.warn(`[bounty] moderation failed for ${out.clipId}: ${e.message}`);
            }
          });
        }
      } catch (e) { fail(res, e); }
    });

  /** What a claiming streamer actually has waiting for them. */
  app.get('/api/bounty/clips', (req, res) => {
    const key = store.handleKey(req.query.platform, req.query.handle);
    if (!key) return res.status(400).json({ error: 'platform and handle required' });
    res.json({
      clips: clips.listClips(key).map(({ sha256, ...c }) => ({ ...c, sha256Short: sha256.slice(0, 12) })),
      storage: clips.stats(),
    });
  });

  /** Serve a stored clip. Refuses rather than serving bytes that changed. */
  app.get('/api/bounty/clip/:clipId/media', (req, res) => {
    const out = clips.readClip(req.params.clipId);
    if (!out.ok) {
      const code = out.error === 'not_found' ? 404 : 410;
      return res.status(code).json({
        error: out.error,
        hint: out.error === 'media_corrupt'
          ? 'This clip no longer matches the bytes we stored and will not be served. It is recorded as damaged, not silently replaced.'
          : 'This clip is no longer available.',
      });
    }
    res.setHeader('Content-Type', out.record.mime);
    res.setHeader('Content-Length', String(out.data.length));
    res.send(out.data);
  });

  app.get('/api/bounty/admin/clip-storage', (_req, res) => res.json(clips.stats()));

  // ── Pledges (the fan-facing program) ─────────────────────────────────────

  /**
   * One escrow, up to N target streamers, contributor-set expiry.
   * Payment note, disclosed here as everywhere: escrow is a ledger and
   * settlement is a stub — no real funds move in this build.
   */
  app.post('/api/bounty/pledge', (req, res) => {
    try {
      const { targets, contributor, amount, expiresInMs } = req.body || {};
      const out = escrow.pledge({ targets, contributor, amount, expiresInMs });
      res.json({
        ok: true,
        pledge: out.pledge,
        contribution: out.contribution,
        uploadUrl: `/api/bounty/clip/${encodeURIComponent(out.contribution.id)}`,
        uploadDeadline: Date.now() + bountyConfig.clipUploadGraceMs,
        clipLimits: { minSeconds: bountyConfig.minClipSeconds, maxBytes: bountyConfig.clipMaxBytes },
        // The rejection policy, machine-readable, so the client can show it
        // BEFORE payment rather than after a dispute.
        rejectionPolicy: {
          streamerDeclineRefund: 1,
          firstPolicyRejectionRefund: 1,
          repeatPolicyRejectionRefund: bountyConfig.rejectionRefundFraction,
          withheldShareGoesTo: 'streamer_pool',
          strikesRequire: 'human review or high-confidence classifier',
        },
      });
    } catch (e) { fail(res, e); }
  });

  /**
   * Client-sampled frames for moderation, posted BEFORE the media upload.
   * Held in memory only — they are classifier input, not evidence; the
   * verdict computed from them is what gets recorded. A restart between
   * frames and upload degrades to transcript-only moderation, same
   * fail-open posture as room MegaChats.
   */
  const pendingFrames = new Map(); // contributionId → { frames, at }
  app.post('/api/bounty/clip/:contributionId/frames', express.json({ limit: '6mb' }), (req, res) => {
    const frames = (req.body?.frames || []).filter((f) => /^data:image\//.test(String(f))).slice(0, 16);
    pendingFrames.set(req.params.contributionId, { frames, at: Date.now() });
    // Bound the map — entries are only useful for minutes.
    if (pendingFrames.size > 200) {
      const cutoff = Date.now() - 30 * 60_000;
      for (const [k, v] of pendingFrames) if (v.at < cutoff) pendingFrames.delete(k);
    }
    res.json({ ok: true, frames: frames.length });
  });

  /** Guaranteed-first pool display. Never a blended headline. */
  app.get('/api/bounty/pool-view', (req, res) => {
    const key = store.handleKey(req.query.platform, req.query.handle);
    if (!key) return res.status(400).json({ error: 'platform and handle required' });
    res.json({
      view: escrow.poolView(key),
      reserved: store.getReservedHandleByKey(key),
      clips: clips.listClips(key).length,
    });
  });

  /**
   * The program page feed. Platform-wide DISPLAYED total (what every pool
   * page adds up to, which multi-counts contested pledges) and REAL value
   * (one escrow per pledge) are both reported, labelled — per the design
   * requirement that rehypothecated money is never presented as bigger than
   * it is.
   */
  app.get('/api/bounty/program', (_req, res) => {
    const views = store.listReservedHandles().map((r) => ({
      ...escrow.poolView(r.key),
      seeded: !!r.seeded,
      claimed: !!r.claimedBy,
      // A pool with no fan money behind it is promotional by definition,
      // whoever created it.
      promotional: !!r.seeded || (store.listContributions(r.key).length === 0),
      clipsWaiting: clips.listClips(r.key).length,
    }))
      .sort((a, b) => (b.guaranteed + b.contestedTotal) - (a.guaranteed + a.contestedTotal));
    const realValue = views.reduce((a, v) => a + v.totalContributed, 0);
    const displayedTotal = views.reduce((a, v) => a + v.guaranteed + v.contestedTotal, 0);
    res.json({
      pools: views,
      currency: bountyConfig.currency,
      totals: {
        realValue: +realValue.toFixed(6),
        displayedTotal: +displayedTotal.toFixed(6),
        note: 'displayedTotal counts a contested pledge once per target; realValue counts each escrow once',
      },
    });
  });

  /**
   * Contributor status page: one row per contribution with its current state
   * and what happens next. `paid` is a defined rung that nothing reaches yet
   * — settlement is a stub — and the endpoint says so rather than faking it.
   */
  app.get('/api/bounty/my', (req, res) => {
    const contributor = String(req.query.contributor || '').trim();
    if (!contributor) return res.status(400).json({ error: 'contributor required' });
    const moderationOn = !!process.env.MODERATION_API_KEY;
    const mine = (store.listPledges({ contributor }) || []).map((p) => {
      const c = store.getContribution(p.contributionId);
      // Purged records included on purpose: "your clip was refunded" must
      // still name the clip it is talking about.
      const clip = c ? clips.clipForContribution(c.id) : null;
      const reserved = c ? store.getReservedHandleByKey(c.handleKey) : null;
      let state = 'pending_upload';
      let next = 'Upload your recording — the pledge refunds if none arrives.';
      if (c?.status === 'REFUNDED') {
        const reasonRow = store.listLedger({ handleKey: c.handleKey })
          .filter((r) => r.type === 'REFUND' && r.meta?.contributionId === c.id).pop();
        const why = reasonRow?.meta?.refundReason || 'refunded';
        state = why === 'PLEDGE_EXPIRED' || why === 'HANDLE_EXPIRED' ? 'expired_refunded'
          : why === 'STREAMER_DECLINED' ? 'declined_refunded'
            : why === 'POLICY_VIOLATION' ? 'rejected_policy' : 'refunded';
        next = state === 'rejected_policy'
          ? 'Refund issued per the rejection policy disclosed at record time.'
          : 'Refund recorded in the ledger. Nothing further happens.';
      } else if (clip) {
        if (clip.approval?.state === 'REJECTED') {
          state = clip.approval.reasonCode === 'POLICY_VIOLATION' ? 'rejected_policy' : 'declined_refunded';
          next = 'Refund is being recorded.';
        } else if (moderationOn && !clip.moderation && !reserved?.claimedBy) {
          // Pre-claim only. Once the streamer has claimed, the clip is in
          // THEIR queue whether or not the classifier ever answered (the
          // queue treats unmoderated as reviewable), so telling the fan
          // "automatic review is running" would be describing a state the
          // streamer is already past. Found by the UI verifier: a clip whose
          // moderation call failed read "in review" forever.
          state = 'pending_moderation';
          next = 'Automatic review runs shortly after upload.';
        } else if (!reserved?.claimedBy) {
          state = 'awaiting_claim';
          next = `Waiting for ${reserved?.handle || 'the streamer'} to claim. Refunds automatically if the pledge expires first.`;
        } else if (clip.approval?.state === 'APPROVED') {
          state = clip.playCount > 0 ? 'played' : 'approved';
          next = clip.playCount > 0
            ? 'Played on stream. Payout accounting runs against the pool (settlement not yet live).'
            : 'Approved — waits for the streamer to play it on air.';
        } else {
          state = 'claimed_pending_review';
          next = 'The streamer reviews every clip before it can air.';
        }
      }
      return {
        pledgeId: p.id, contributionId: c?.id || null, amount: p.amount,
        targets: p.targets, pledgeStatus: p.status, winner: p.winner,
        expiresAt: p.expiresAt, state, next,
        clip: clip ? {
          clipId: clip.clipId, durationS: clip.durationS,
          moderation: clip.moderation, approval: clip.approval, playCount: clip.playCount,
        } : null,
      };
    });
    res.json({
      contributions: mine.sort((a, b) => (b.expiresAt || 0) - (a.expiresAt || 0)),
      states: ['pending_upload', 'pending_moderation', 'awaiting_claim', 'claimed_pending_review',
        'approved', 'played', 'paid', 'expired_refunded', 'declined_refunded', 'rejected_policy', 'refunded'],
      note: '`paid` becomes reachable when real settlement lands; today releases are ledger entries only.',
    });
  });

  // ── Streamer approval queue ──────────────────────────────────────────────
  //
  // Every clip is reviewable before it can play on air. Default, not
  // optional. Sorted so the safe pile clears fast: clean high-confidence
  // first, violations last and loudly flagged.

  const gradeRank = { clean: 0, borderline: 1, violation: 2 };
  app.get('/api/bounty/queue', (req, res) => {
    const key = store.handleKey(req.query.platform, req.query.handle);
    if (!key) return res.status(400).json({ error: 'platform and handle required' });
    const queue = clips.listClips(key)
      .filter((c) => !c.approval)
      .map((c) => ({
        clipId: c.clipId, durationS: c.durationS, bytes: c.bytes,
        storedAt: c.storedAt, contributor: c.contributor,
        moderation: c.moderation,
        mediaUrl: `/api/bounty/clip/${c.clipId}/media`,
      }))
      .sort((a, b) => {
        const ga = gradeRank[a.moderation?.grade] ?? 1; // unmoderated sorts with borderline
        const gb = gradeRank[b.moderation?.grade] ?? 1;
        if (ga !== gb) return ga - gb;
        // Within a grade, higher confidence first — most certain verdicts up top.
        return (b.moderation?.confidence ?? 0) - (a.moderation?.confidence ?? 0);
      });
    res.json({ queue, count: queue.length });
  });

  app.post('/api/bounty/clip/:clipId/approve', (req, res) => {
    try {
      const clip = clips.approveClip(req.params.clipId, { by: String(req.body?.by || 'streamer') });
      if (!clip) return res.status(404).json({ error: 'No such clip' });
      res.json({ ok: true, clip });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/bounty/clip/:clipId/reject', (req, res) => {
    try {
      const { by, reasonCode, reason, confidence } = req.body || {};
      const out = escrow.refundRejectedClip({
        clipId: req.params.clipId, by: String(by || 'streamer'),
        reasonCode, reason,
        confidence: Number.isFinite(+confidence) ? +confidence : null,
        // A queue rejection IS human review by definition.
        humanReviewed: true,
        settlement,
      });
      res.json({ ok: true, ...out });
    } catch (e) { fail(res, e); }
  });

  /**
   * Operator/rehearsal playback trigger: open and close watermark windows
   * over HTTP without driving the whole letters queue. This is how the
   * corpus generator and the dress rehearsal issue REAL codes through the
   * real store — the same startClipPlayback the letters hook calls.
   */
  app.post('/api/bounty/admin/playback', (req, res) => {
    try {
      const { airSessionId, clipId, durationS } = req.body || {};
      const sess = store.getAirSession(airSessionId);
      if (!sess) return res.status(404).json({ error: 'No such air session' });
      const out = watermark.startClipPlayback(airSessionId, {
        clipId: String(clipId || 'rehearsal'), durationS: Number(durationS) || 10,
      });
      // Same platform observation the live room path takes. The dress
      // rehearsal drives THIS route during a real broadcast, so leaving it out
      // meant the one session that matters most carried no broadcast start.
      captureBroadcastObservation(sess, { playbackId: out?.playbackId || null, clipId, log });
      res.json({ ok: true, playbackId: out?.playbackId || null, code: out?.code || null, reason: out?.reason || null });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/bounty/admin/playback/end', (req, res) => {
    try {
      const { airSessionId, clipId, playbackId } = req.body || {};
      watermark.endClipPlayback(airSessionId, { clipId, playbackId });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  /** Deterministic sweeper trigger (the interval below is the ambient one). */
  app.post('/api/bounty/admin/sweep-pledges', (_req, res) => {
    try {
      res.json({ ok: true, swept: escrow.sweepExpiredPledges({ settlement }) });
    } catch (e) { fail(res, e); }
  });

  /** Hand-picked program entries. Labelled promotional on every surface. */
  app.post('/api/bounty/admin/seed', (req, res) => {
    try {
      const { platform, handle } = req.body || {};
      const key = store.handleKey(platform, handle);
      if (!key) return res.status(400).json({ error: 'platform and handle required' });
      if (!store.getReservedHandleByKey(key)) {
        store.reserveHandle({ platform, handle, ttlMs: bountyConfig.reservationTtlMs });
      }
      store.updateReservedHandle(key, { seeded: true });
      res.json({ ok: true, reserved: store.getReservedHandleByKey(key) });
    } catch (e) { fail(res, e); }
  });

  const pledgeSweeper = setInterval(() => {
    try {
      const swept = escrow.sweepExpiredPledges({ settlement });
      if (swept.length) log.log(`[bounty] pledge sweeper refunded ${swept.length} expired pledge(s)`);
    } catch (e) { log.warn(`[bounty] pledge sweep failed: ${e.message}`); }
  }, bountyConfig.pledgeSweepMs);
  if (pledgeSweeper.unref) pledgeSweeper.unref();

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
      // Re-entering CLAIM_PENDING is legal-by-skip: with real identity
      // verification a DENIED attempt used to leave the handle wedged here,
      // and every later claim — including the actual channel owner's — 409'd.
      // An impostor must never be able to lock a streamer out by failing.
      if (store.getReservedHandleByKey(key).claimStatus !== 'CLAIM_PENDING') {
        escrow.transition({ handleKey: key, to: 'CLAIM_PENDING', actor: claimant || 'claimant', reason: 'claim opened' });
      }

      const claim = store.createClaim({ handleKey: key, claimant, ttlMs: bountyConfig.claimTtlMs });

      const idv = await identity.verify(platform, handle, claimant, { req });
      store.updateClaim(claim.id, {
        verificationState: idv.approved ? 'VERIFIED' : 'DENIED',
        verificationMethod: idv.method,
      });
      store.appendLedger({
        handleKey: key, claimId: claim.id, type: 'IDENTITY_CHECK',
        actor: claimant || 'claimant', reason: idv.method,
        meta: { approved: idv.approved, stubbed: idv.method.startsWith('STUBBED') },
      });

      // A denied claim RELEASES the handle back to RESERVED so the next
      // attempt (most importantly the real owner's) is not blocked by this
      // one's failure.
      if (!idv.approved) {
        escrow.transition({
          handleKey: key, to: 'RESERVED', actor: 'identity',
          reason: `claim denied: ${idv.method}`, claimId: claim.id,
        });
      }

      let wonPledges = [];
      if (idv.approved) {
        escrow.transition({ handleKey: key, to: 'CLAIM_VERIFIED', actor: 'identity', reason: idv.method, claimId: claim.id });
        escrow.transition({ handleKey: key, to: 'AWAITING_AIRTIME', actor: 'system', reason: 'awaiting broadcast', claimId: claim.id });
        store.updateReservedHandle(key, { claimedBy: claimant || null });
        // Contested pledges resolve at the moment of a VERIFIED claim, and
        // nowhere else. claimPledges is synchronous by contract, so two
        // claims racing through the awaits above cannot split a pledge —
        // whichever continuation lands here first takes every shared pledge
        // whole. Keep it directly after the transitions, with no await in
        // between.
        wonPledges = escrow.claimPledges(key, { actor: claimant || 'claimant' });
      }
      res.json({
        ok: true, claim: store.getClaim(claim.id), identity: idv,
        pool: store.getPool(key), poolView: escrow.poolView(key), wonPledges,
      });
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
      // NO CODE IS ISSUED HERE, and that is the whole point of the
      // playback-bound redesign: a code exists only while a clip is actually
      // playing, because a code that exists at session-open would prove the
      // overlay was parked, not that anything aired.
      //
      // This line used to call watermark.issueCode(), which that redesign
      // deleted. Nothing caught it because every gate creates air sessions
      // through store.createAirSession() directly rather than through this
      // route — so the route threw on its first real use and the mechanic was
      // dead the moment a streamer tried to go live.
      res.json({ ok: true, airSession: store.getAirSession(s.id), code: null });
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

  app.post('/api/bounty/air-session/:id/end', async (req, res) => {
    try {
      const prev = store.getAirSession(req.params.id);
      // OBSERVE WHETHER THE BROADCAST IS STILL RUNNING, once, here. This is the
      // last moment the answer exists: the tail check ("did the stream continue
      // past the last counted playback?") cannot be answered at verify time,
      // hours later, when every channel looks offline.
      //
      // Still live  → broadcastEndedAt stays null and the tail check passes.
      //               A streamer who closes the overlay and keeps streaming is
      //               the normal case and must never be flagged for it.
      // Offline now → we know the stream ended somewhere between the last live
      //               observation and now. We record NOW, the generous end of
      //               that interval, because the cost of a wrong tail flag
      //               falls on someone who did the work.
      const patch = { status: 'CLOSED', endedAt: Date.now() };
      if (prev) {
        const look = prev.platform === 'twitch' ? (twitchApiConfigured() ? getStreamByLogin : null)
          : prev.platform === 'kick' ? (kickApiConfigured() ? getChannelBySlug : null)
            : null;
        const claim = look ? store.getClaim(prev.claimId) : null;
        const handle = claim ? store.getReservedHandleByKey(claim.handleKey)?.handle : null;
        if (handle) {
          // Never let a platform hiccup block a streamer from closing out.
          const stream = await look(handle, { log }).catch(() => null);
          if (stream && stream.live === false) patch.broadcastEndedAt = Date.now();
          else if (stream && stream.live) patch.lastLiveObservedAt = Date.now();
        }
      }
      const s = store.updateAirSession(req.params.id, patch);
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

      // mode:'real' selects the REAL pipeline: platform frame source
      // (VOD-first; live for a during-broadcast spot check) + the
      // deterministic matrix decoder. Default stays fixture-driven so every
      // gate runs with zero network and zero spend.
      let sourceOpts = {};
      if (req.body?.mode === 'real') {
        const { frameSourceFor } = await import('./frame-sources.js');
        const { OcrFrameChecker } = await import('./ocr-frame-checker.js');
        sourceOpts = {
          frameSource: frameSourceFor(s.platform, {
            log, mode: req.body.sourceMode || 'vod',
            vodUrl: req.body.vodUrl || null,
            frames: req.body.frames || [],
          }),
          codeChecker: new OcrFrameChecker({ log }),
        };
        if (req.body.vodStartMs && sourceOpts.frameSource) {
          sourceOpts.frameSource.vodStartMs = Number(req.body.vodStartMs);
        }
      }
      const v = await verifier.verifyAirSession(s.id, sourceOpts);

      // ── STREAM CONTEXT: a gate, not a dial ──────────────────────────────
      // Did these playbacks happen inside a real broadcast? Warmup + tail,
      // pass/fail per playback, failures to HUMAN REVIEW. Broadcast start
      // comes from PLATFORM truth (the viewer samples captured at playback
      // carry it) — never from when our own air session opened, which a
      // farmer controls.
      let context = null;
      if (v.verifiedClips > 0) {
        const { evaluateStreamContext, describeContext } = await import('./bounty-stream-context.js');
        // READ THE OBSERVATION, DO NOT RE-ASK. Both values were captured while
        // the channel was live (start at clip playback, end at session close).
        // Asking Helix here instead returns "offline, no start time" for every
        // session verified from a VOD — i.e. the normal path — which silently
        // sent honest streamers to review. Re-read the record: it is fresh
        // enough to matter and old enough to exist.
        const fresh = store.getAirSession(s.id) || s;
        context = evaluateStreamContext({
          broadcastStartedAt: fresh.broadcastStartedAt || null,
          broadcastEndedAt: fresh.broadcastEndedAt || null,
          playbacks: (v.clipVerdicts || []).filter((c) => c.verified).map((c) => ({
            clipId: c.clipId, playbackId: c.playbackId,
            startedAt: (s.playbackWindows || []).find((w) => w.playbackId === c.playbackId)?.startedAt || 0,
          })),
        });
        context.summary = describeContext(context);
      }

      // AMBIGUOUS evidence goes to a human instead of silently paying zero.
      // On mainnet, a streamer who did the work and got neither money nor a
      // person looking at their case is a support incident and a trust
      // incident at once.
      let review = null;
      const contextNeedsReview = !!context?.needsReview;
      const qualityNeedsReview = (v.belowQualityFloorClips || 0) > 0;
      if ((v.result === 'AMBIGUOUS' || v.result === 'SOURCE_UNAVAILABLE'
        || contextNeedsReview || qualityNeedsReview) && !store.hasOpenReview(s.id)) {
        review = store.createReview({
          airSessionId: s.id, claimId: claim.id, handleKey: key,
          verificationId: v.attempt?.id || null, confidence: v.confidence,
          reason: contextNeedsReview
            // The SPECIFIC condition, so a reviewer acts in seconds.
            ? `stream context: ${context.summary}`
            : qualityNeedsReview
              ? `stream quality below the verifier floor on ${v.belowQualityFloorClips} clip(s) — `
                + 'reads landed but marginal; do not let the shortfall look like normal partial verification'
              : v.result === 'SOURCE_UNAVAILABLE'
            // "We could not look" — a human decides whether to retry later or
            // verify manually. Never a FAIL, never silently zero.
            ? `source unavailable: ${v.sourceState}${v.sourceDetail ? ` — ${v.sourceDetail}` : ''}`
            : `ambiguous: ${v.verifiedClips} clip(s) matched at confidence ${v.confidence}`,
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
      res.json({
        ok: true, verification: v, release: out, review,
        // Payout is UNCHANGED by context — verified playbacks release against
        // the pledge, unweighted. Context decides whether a human looks, not
        // how much anyone is paid.
        streamContext: context,
        pool: store.getPool(key),
      });
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
