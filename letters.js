/**
 * Letter mode — recorded camera clips, paid flat, played ONCE on the overlay.
 *
 * Protocol (payment split from upload so the mpp voucher rides a small JSON
 * request, never the video bytes):
 *   1. POST /api/letter/submit   — MPP-PAID (one voucher at the room's flat
 *      letter price through the same TIP-1034 session machinery as ticks).
 *      Returns { letterId, uploadUrl }.
 *   2. PUT  /api/letter/upload/:id — raw webm/mp4 body (≤ LETTER_MAX_BYTES,
 *      within UPLOAD_GRACE_MS of payment) → queued (or pending approval).
 *   3. Scheduler: when the room has a free tile slot, broadcast letter_play →
 *      the overlay renders a <video> tile with the same stinger treatment →
 *      letter_end → media deleted shortly after. One-shot by design.
 *
 * TWO MODES, AND THE DIFFERENCE IS WHO DECIDES WHEN.
 *
 *   moderation: 'auto'     AI screens, the clip QUEUES, and the scheduler
 *                          airs it as soon as a tile frees. Hands-off.
 *   moderation: 'approve'  every clip waits for a human. Approving does NOT
 *                          air it — it moves the clip to READY, a held pile
 *                          the scheduler never touches. A mod airs each one
 *                          explicitly. This is the broadcast-producer model:
 *                          a pile of submissions and somebody choosing what
 *                          goes on screen and when.
 *
 * Approving used to mean "committed to air", because approve pushed straight
 * into the same FIFO the scheduler drains. That gave a reviewer a veto and no
 * timing, which is not what producing a show is.
 *
 * DURABLE. Letters used to live in memory only — a deploy mid-show dropped
 * every clip waiting for a decision, and each one was money somebody paid.
 * Metadata and video now live under DATA_DIR (letter-store.js) and are
 * restored on boot; a clip whose media did not survive is refunded rather
 * than resurrected empty.
 *
 * A HELD CLIP DOES NOT WAIT FOREVER. Anything left in review or ready past
 * LETTER_HOLD_TTL_MS is refunded, because a fan who paid and never aired is
 * owed their money, not an indefinite maybe.
 *
 * Moderation refunds (reject, upload expiry, hold expiry) leave through the
 * settlement door as recorded intents — never a transfer signed here.
 */
import express from 'express';
import { randomUUID } from 'crypto';
import {
  resolveRoomConfig,
  normalizeRoomId,
  letterPriceFor,
} from './rooms-store.js';
import { verifyRoomAccess } from './auth.js';
import { moderateMedia } from './moderation.js';
import { toWebRequest } from './meter-mpp.js';
import { toAtomic, fromAtomic } from './token-utils.js';
import { addMoment } from './airings-store.js';
import { createLetterStore } from './letter-store.js';

const LETTER_MAX_BYTES = 25 * 1024 * 1024; // per letter
const GLOBAL_MAX_BYTES = 120 * 1024 * 1024; // all rooms combined, now on disk
const QUEUE_MAX_PER_ROOM = 10;
const UPLOAD_GRACE_MS = 90_000; // paid → upload deadline
/**
 * How long a clip may sit waiting for a human — in review or approved-and-held
 * — before the payer is refunded. Six hours covers a long broadcast; past that
 * the fan is owed their money rather than an open-ended maybe.
 */
const HOLD_TTL_MS = Math.max(60_000, Number(process.env.LETTER_HOLD_TTL_MS) || 6 * 60 * 60_000);
/** Statuses that are waiting on a person rather than on a tile. */
const HELD = new Set(['pending_approval', 'ready']);
const MEDIA_TTL_MS = 60_000; // after playback, before the buffer is dropped
const STINGER_BUFFER_MS = 2600; // fly-in + fly-out allowance on playback

const FLY_IN_OK = new Set(['storm', 'proroll', 'callme', 'breaking', 'wildin']);
const FLY_OUT_OK = new Set(['crt', 'crumble', 'zapped', 'wildout']);

export function attachLetters(app, deps) {
  const {
    mppMeter,
    broadcastToRoom,
    // No overlay connected = nothing renders letter_play — hold the queue
    // instead of burning clips into the void. Default true keeps standalone/
    // test wiring (and any host without the hook) on the old behavior.
    hasOverlay = () => true,
    activeSeats,
    sellerAddress,
    /**
     * THE SETTLEMENT DOOR. A MegaChat refund used to be a transfer this file
     * signed itself with the meter's wallet client. Money now leaves only
     * through settlement.js, against a recorded intent, so a refund here is
     * an intent the door executes on its next flush. No signer wired means
     * the intent waits, visibly, rather than the refund silently not
     * happening.
     */
    settlement = null,
    getWatchSeconds = () => 0,
    /**
     * Creator-bounty playback hooks. The watermark code that proves a clip
     * aired is bound to THIS event, server-side — there is no separate
     * client-reported "a clip played" signal that could disagree with it.
     * Default no-ops keep standalone/test wiring unchanged.
     */
    onClipPlay = () => {},
    onClipEnd = () => {},
    log = console,
  } = deps;

  /** roomId → { queue: Letter[], playing: Letter|null } */
  const rooms = new Map();
  /** letterId → Letter (any status). `media` is a MARKER; the bytes are on disk. */
  const byId = new Map();
  const store = createLetterStore({ maxBytes: GLOBAL_MAX_BYTES, log });
  let globalBytes = 0;

  /** Write the metadata of everything worth remembering. Cheap; small file. */
  const persist = () => {
    try { store.saveMeta([...byId.values()]); }
    catch (e) { log.warn?.(`[letters] could not persist: ${e.message}`); }
  };

  const roomState = (roomId) => {
    if (!rooms.has(roomId)) rooms.set(roomId, { queue: [], playing: null });
    return rooms.get(roomId);
  };

  const liveSeatCount = (roomId) => {
    let n = 0;
    for (const seat of activeSeats.values()) {
      if (seat.streamRoomId === roomId && seat.live) n++;
    }
    return n;
  };

  function dropMedia(letter) {
    if (letter.media) {
      globalBytes -= letter.bytes || store.mediaSize(letter.id);
      if (globalBytes < 0) globalBytes = 0;
      store.deleteMedia(letter.id);
      letter.media = false;
      letter.bytes = 0;
    }
  }

  function removeLetter(letter) {
    dropMedia(letter);
    byId.delete(letter.id);
    const state = roomState(letter.roomId);
    state.queue = state.queue.filter((l) => l.id !== letter.id);
    if (state.playing?.id === letter.id) state.playing = null;
    persist();
  }

  // ─── AI moderation (recorded clips ONLY — never the live path) ────────────
  // Configured via MODERATION_API_KEY (+ MODERATION_API_BASE for tests/self-
  // hosted gateways). Absent → everything queues exactly as before; a verdict
  // is NEVER faked. Pipeline: whisper transcript + omni-moderation over the
  // transcript and the client-sampled frames. Fail-open on any error/timeout
  // (seconds of latency budget, not minutes).
  const moderationConfigured = () => !!process.env.MODERATION_API_KEY;

  /**
   * DELEGATES to the shared pipeline in moderation.js (extracted so bounty
   * clips run the SAME transcript+frames review instead of a second, slightly
   * different one). This wrapper only maps the graded result back onto the
   * pass/flag semantics this queue has always had:
   *  - fail-open on error or no inputs (a verdict is never faked)
   *  - 'borderline' strictness flags on ANY category flag
   *  - 'severe' strictness flags on worst score ≥ 0.7 — the same number the
   *    shared module's 'violation' floor defaults to
   */
  async function moderateLetter(letter, cfg) {
    const out = await moderateMedia({
      media: letter.media, mime: letter.mime, frames: letter.frames || [], log,
    });
    if (!out.configured || out.error || out.grade === null) {
      return { verdict: 'pass', reason: null };
    }
    const flagged = cfg.letters.aiStrictness === 'borderline'
      ? out.flagged
      : out.topScore >= 0.7;
    if (!flagged) return { verdict: 'pass', reason: null };
    const pct = Math.round((out.topScore || 0) * 100);
    return {
      verdict: 'flag',
      reason: `${out.topCategory || 'flagged'} (${pct}%)`
        + (out.transcript ? ` — “${out.transcript.slice(0, 90)}”` : ''),
    };
  }

  /** Route a fully-uploaded letter to its resting state (+ broadcast). */
  function settleIntoQueue(letter, cfg, flaggedReason) {
    if (flaggedReason) {
      letter.status = 'pending_approval';
      letter.flaggedReason = flaggedReason;
    } else {
      letter.status = cfg.letters.moderation === 'approve' ? 'pending_approval' : 'queued';
    }
    if (HELD.has(letter.status)) letter.heldSince = Date.now();
    if (letter.status === 'queued') roomState(letter.roomId).queue.push(letter);
    persist();
    broadcastToRoom(letter.roomId, {
      type: 'letter_queued',
      letterId: letter.id,
      status: letter.status,
      username: letter.username,
      flagged: !!flaggedReason,
      // lets the sender's toast stay honest when nothing can render it yet
      overlayLive: hasOverlay(letter.roomId),
    });
  }

  /** Refund the flat price to the payer from the PLATFORM wallet. */
  async function refundLetter(letter, reason) {
    // Free letters: nothing was paid, nothing to send (payer may even be null).
    if (!(parseFloat(letter.price) > 0) || !letter.payer) {
      removeLetter(letter);
      return;
    }
    letter.status = 'refunding';
    try {
      const cfg = resolveRoomConfig(letter.roomId);
      if (!settlement) throw new Error('no settlement door wired');
      const r = settlement.refund({
        to: letter.payer,
        amountAtomic: toAtomic(letter.price, cfg.paymentTokenDecimals).toString(),
        token: { address: cfg.paymentTokenAddress, decimals: cfg.paymentTokenDecimals, symbol: cfg.paymentTokenSymbol },
        ref: `letter:${letter.id}:refund`,
        meta: { reason, roomId: letter.roomId },
      });
      log.log(`[letters] refund of ${letter.price} to ${letter.payer} (${reason}) ${r.deduped ? 'already recorded' : 'recorded'} as intent ${r.row.ref} — ${settlement.hasSigner('platform') ? 'pays on the next settlement flush' : 'PENDING until PLATFORM_SETTLEMENT_KEY is set'}`);
    } catch (err) {
      log.warn(`[letters] refund could not be recorded for ${letter.id} (${reason}): ${err.shortMessage || err.message}`);
    }
    removeLetter(letter);
  }

  // ── 1. Paid submit (JSON; the mpp voucher rides this request) ─────────────
  app.post('/api/letter/submit', async (req, res) => {
    try {
      if (!mppMeter) return res.status(503).json({ error: 'Payments unavailable on this server' });
      const roomId = normalizeRoomId((req.body && req.body.room) || req.query.room);
      const cfg = roomId ? resolveRoomConfig(roomId) : null;
      if (!cfg) return res.status(404).json({ error: 'Room not found' });
      if (!cfg.letters.enabled) return res.status(403).json({ error: 'MegaChats are not enabled in this room' });
      if (!cfg.active) return res.status(403).json({ error: 'Room is not accepting joins right now' });

      const { username, address, durationS, mime, flyIn, flyOut } = req.body || {};
      if (!username || typeof username !== 'string') {
        return res.status(400).json({ error: 'Username required' });
      }
      // Free letters (price 0) need no wallet — there is nothing to charge or
      // refund. Paid ones still require the payer address.
      const hasAddress = /^0x[0-9a-fA-F]{40}$/.test(address || '');
      if (!hasAddress && parseFloat(letterPriceFor(cfg)) > 0) {
        return res.status(400).json({ error: 'Wallet address required' });
      }
      const dur = Number(durationS);
      if (!Number.isFinite(dur) || dur <= 0 || dur > cfg.letters.maxSeconds + 1) {
        return res.status(400).json({ error: `MegaChats are capped at ${cfg.letters.maxSeconds}s in this room` });
      }
      // Below the sampling floor a clip can never be PROVEN to have aired, so
      // it must never be sold. This sits above the payment handshake on
      // purpose: rejecting after a charge would mean issuing a refund for
      // something we should not have accepted in the first place.
      if (dur < cfg.letters.minSeconds) {
        return res.status(400).json({
          error: `MegaChats need to be at least ${cfg.letters.minSeconds} seconds`,
          reason: 'below_min_duration',
          minSeconds: cfg.letters.minSeconds,
          durationS: dur,
          hint: `Shorter clips can't be reliably verified on stream, so we don't charge for them. Record at least ${cfg.letters.minSeconds}s.`,
        });
      }
      if (!/^video\/(webm|mp4)/.test(String(mime || ''))) {
        return res.status(400).json({ error: 'Unsupported recording format' });
      }
      // Per-feature reputation gate (MegaChats' own gates — Join Stream may
      // inherit these, never the other way around).
      if (cfg.letters.gates.minWatchSeconds > 0) {
        const watched = getWatchSeconds(cfg.id, address);
        if (watched < cfg.letters.gates.minWatchSeconds) {
          return res.status(403).json({
            error: 'Not enough watch time yet',
            reason: 'min_watch_time',
            watchedSeconds: watched,
            requiredSeconds: cfg.letters.gates.minWatchSeconds,
            hint: `MegaChats unlock after ${cfg.letters.gates.minWatchSeconds}s of watching — you're at ${watched}s.`,
          });
        }
      }

      const state = roomState(cfg.id);
      const pending = state.queue.length + (state.playing ? 1 : 0);
      if (pending >= QUEUE_MAX_PER_ROOM) {
        return res.status(429).json({ error: 'MegaChat queue is full — try again in a minute' });
      }

      const price = letterPriceFor(cfg);
      // Free rooms: price 0 → skip the payment handshake entirely. There is
      // nothing to charge and nothing to refund on reject/expiry.
      let result = null;
      if (parseFloat(price) > 0) {
        result = await mppMeter.handleTick(toWebRequest(req), {
          amount: price,
          currency: cfg.paymentTokenAddress,
          decimals: cfg.paymentTokenDecimals,
          unitType: 'letter',
          recipient: cfg.payoutAddress || sellerAddress,
          suggestedDeposit: price,
        });
        if (result.status === 402) return result.respond(res);
      }

      const letter = {
        id: randomUUID(),
        roomId: cfg.id,
        username: String(username).slice(0, 20),
        payer: hasAddress ? address : null,
        price,
        durationS: Math.ceil(dur),
        mime: String(mime),
        flyIn: FLY_IN_OK.has(flyIn) ? flyIn : null,
        flyOut: FLY_OUT_OK.has(flyOut) ? flyOut : null,
        status: 'awaiting_upload',
        media: null,
        paidAt: Date.now(),
      };
      byId.set(letter.id, letter);
      log.log(`[letters] ${letter.id} ${parseFloat(price) > 0 ? `paid ${price} by ${address}` : 'free'} in room ${cfg.id}`);
      const body = {
        success: true,
        letterId: letter.id,
        uploadUrl: `/api/letter/upload/${letter.id}`,
        price,
        moderation: cfg.letters.moderation,
      };
      return result ? result.respond(res, body) : res.json(body);
    } catch (err) {
      log.warn('[letters] submit error:', err.message);
      return res.status(500).json({ error: 'MegaChat submit failed', message: err.message });
    }
  });

  // ── 2. One-shot media upload ───────────────────────────────────────────────
  app.put(
    '/api/letter/upload/:id',
    express.raw({ type: () => true, limit: LETTER_MAX_BYTES }),
    (req, res) => {
      const letter = byId.get(req.params.id);
      if (!letter || letter.status !== 'awaiting_upload') {
        return res.status(404).json({ error: 'Unknown or already-uploaded MegaChat' });
      }
      if (Date.now() - letter.paidAt > UPLOAD_GRACE_MS) {
        void refundLetter(letter, 'upload_expired');
        return res.status(410).json({ error: 'Upload window expired — payment refunded' });
      }
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length < 1024) {
        return res.status(400).json({ error: 'Empty or invalid recording' });
      }
      if (globalBytes + body.length > GLOBAL_MAX_BYTES) {
        void refundLetter(letter, 'server_full');
        return res.status(507).json({ error: 'MegaChat storage full — payment refunded' });
      }
      try {
        store.writeMedia(letter.id, body);
      } catch (e) {
        log.warn(`[letters] could not store media for ${letter.id}: ${e.message}`);
        void refundLetter(letter, 'storage_failed');
        return res.status(507).json({ error: 'MegaChat storage unavailable — payment refunded' });
      }
      letter.media = true;
      letter.bytes = body.length;
      globalBytes += body.length;
      letter.uploadedAt = Date.now();
      const cfg = resolveRoomConfig(letter.roomId);
      if (moderationConfigured()) {
        // AI review before the queue — recorded clips only, never live.
        letter.status = 'reviewing';
        log.log(`[letters] ${letter.id} uploaded ${(body.length / 1024).toFixed(0)}KB → reviewing (AI)`);
        res.json({ success: true, status: 'reviewing', overlayLive: hasOverlay(letter.roomId) });
        const t0 = Date.now();
        void moderateLetter(letter, cfg).then(({ verdict, reason }) => {
          if (letter.status !== 'reviewing') return; // expired/removed meanwhile
          log.log(`[letters] ${letter.id} verdict=${verdict} in ${Date.now() - t0}ms${reason ? ' — ' + reason : ''}`);
          settleIntoQueue(letter, cfg, verdict === 'flag' ? reason : null);
        });
        return;
      }
      log.log(`[letters] ${letter.id} uploaded ${(body.length / 1024).toFixed(0)}KB (no moderation key)`);
      settleIntoQueue(letter, cfg, null);
      res.json({ success: true, status: letter.status, overlayLive: hasOverlay(letter.roomId) });
    }
  );

  // Client-sampled frames for the AI review — arrive BEFORE the upload so the
  // pipeline has them when it starts. Unpaid: bound to a paid letter id.
  app.post('/api/letter/frames/:id', express.json({ limit: '3mb' }), (req, res) => {
    const letter = byId.get(req.params.id);
    if (!letter || letter.status !== 'awaiting_upload') {
      return res.status(404).json({ error: 'Unknown MegaChat' });
    }
    const frames = Array.isArray(req.body?.frames) ? req.body.frames : [];
    letter.frames = frames
      .filter((f) => typeof f === 'string' && f.startsWith('data:image/') && f.length < 300_000)
      .slice(0, 5);
    res.json({ ok: true, frames: letter.frames.length });
  });

  // ── 3. Media for the overlay (and the approve-queue preview) ─────────────
  app.get('/api/letter/media/:id', (req, res) => {
    const letter = byId.get(req.params.id);
    if (!letter || !letter.media) return res.status(404).json({ error: 'Gone' });
    const bytes = store.readMedia(letter.id);
    if (!bytes) return res.status(404).json({ error: 'Gone' });
    res.setHeader('Content-Type', letter.mime);
    res.setHeader('Cache-Control', 'no-store');
    res.send(bytes);
  });

  // ── Moderation auth: owner identity OR room password (dashboard scheme) ──
  async function requirePassword(req, res) {
    const roomId = normalizeRoomId(req.params.roomId);
    if (!roomId) { res.status(400).json({ error: 'Invalid room id' }); return null; }
    const access = await verifyRoomAccess(req, roomId);
    if (!access.ok) {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    }
    return roomId;
  }

  app.get('/api/dashboard/rooms/:roomId/letters', async (req, res) => {
    const roomId = await requirePassword(req, res);
    if (!roomId) return;
    const list = [...byId.values()]
      .filter((l) => l.roomId === roomId && ['reviewing', 'pending_approval', 'ready', 'queued', 'playing'].includes(l.status))
      .map((l) => ({
        id: l.id, username: l.username, durationS: l.durationS, price: l.price,
        status: l.status, uploadedAt: l.uploadedAt || null,
        flaggedReason: l.flaggedReason || null,
        mediaUrl: l.media ? `/api/letter/media/${l.id}` : null,
        // A held clip is waiting on a person, and it is not waiting forever:
        // the dashboard shows how long is left before the payer is refunded.
        heldSince: l.heldSince || null,
        expiresAt: HELD.has(l.status) && l.heldSince ? l.heldSince + HOLD_TTL_MS : null,
      }));
    // overlayLive tells the dashboard WHY queued clips are holding — the
    // #1 confusion was a clip "just sitting there" with no explanation.
    res.json({ letters: list, overlayLive: hasOverlay(roomId) });
  });

  // AIR IT. The producer's one button: put this clip on screen now.
  //
  // Accepts a READY clip (approved and held, in approve mode) as well as a
  // QUEUED one (auto mode, jumping the scheduler's FIFO). Overlay detection is
  // deliberately bypassed — a mod can see their own OBS and detection cannot —
  // but the slot rules still apply, because airing into a full tile stack
  // burns a one-shot invisibly.
  app.post('/api/dashboard/rooms/:roomId/letters/:id/play', async (req, res) => {
    const roomId = await requirePassword(req, res);
    if (!roomId) return;
    const letter = byId.get(req.params.id);
    if (!letter || letter.roomId !== roomId || !['queued', 'ready'].includes(letter.status) || !letter.media) {
      return res.status(404).json({ error: 'MegaChat not found, or not ready to air' });
    }
    const state = roomState(roomId);
    if (state.playing) return res.status(409).json({ error: 'Another MegaChat is already playing' });
    const cfg = resolveRoomConfig(roomId);
    if (liveSeatCount(roomId) >= cfg.maxSeats) {
      return res.status(409).json({ error: 'All camera tiles are busy — try when a slot frees up' });
    }
    state.queue = state.queue.filter((l) => l.id !== letter.id);
    playLetter(roomId, state, letter, 'aired by a mod');
    res.json({ success: true });
  });

  /**
   * Approve. In APPROVE mode this does NOT air the clip: it moves to `ready`,
   * a held pile the scheduler never drains, and a mod airs it when the show
   * wants it. In auto mode approval is only ever reached by an AI-flagged
   * clip, and letting the scheduler have it is the behaviour that room asked
   * for — so there it still queues.
   */
  app.post('/api/dashboard/rooms/:roomId/letters/:id/approve', async (req, res) => {
    const roomId = await requirePassword(req, res);
    if (!roomId) return;
    const letter = byId.get(req.params.id);
    if (!letter || letter.roomId !== roomId || letter.status !== 'pending_approval') {
      return res.status(404).json({ error: 'MegaChat not found or not pending' });
    }
    const cfg = resolveRoomConfig(roomId);
    const producer = cfg?.letters?.moderation === 'approve';
    letter.approvedAt = Date.now();
    if (producer) {
      letter.status = 'ready';
      letter.heldSince = Date.now();
      log.log(`[letters] ${letter.id} approved → ready (held until a mod airs it)`);
    } else {
      letter.status = 'queued';
      letter.heldSince = null;
      roomState(roomId).queue.push(letter);
      log.log(`[letters] ${letter.id} approved → queued`);
    }
    persist();
    broadcastToRoom(roomId, { type: 'letter_queued', letterId: letter.id, status: letter.status, username: letter.username, flagged: false, overlayLive: hasOverlay(roomId) });
    res.json({ success: true, status: letter.status });
  });

  app.post('/api/dashboard/rooms/:roomId/letters/:id/reject', async (req, res) => {
    const roomId = await requirePassword(req, res);
    if (!roomId) return;
    const letter = byId.get(req.params.id);
    if (!letter || letter.roomId !== roomId || !['pending_approval', 'ready', 'queued'].includes(letter.status)) {
      return res.status(404).json({ error: 'MegaChat not found or not rejectable' });
    }
    const cfg = resolveRoomConfig(roomId);
    if (cfg.letters.autoRefundOnReject) {
      log.log(`[letters] ${letter.id} rejected — refunding`);
      void refundLetter(letter, 'rejected');
      return res.json({ success: true, refunded: true });
    }
    log.log(`[letters] ${letter.id} rejected — kept (room refund policy off)`);
    removeLetter(letter);
    res.json({ success: true, refunded: false });
  });

  // ── Scheduler: play when a tile slot is free; expire stale uploads ────────
  const tick = setInterval(() => {
    const now = Date.now();
    for (const letter of byId.values()) {
      if (letter.status === 'awaiting_upload' && now - letter.paidAt > UPLOAD_GRACE_MS) {
        void refundLetter(letter, 'upload_expired');
      }
      // Waiting on a person, and nobody came. The fan is owed their money
      // rather than an indefinite maybe — see HOLD_TTL_MS.
      if (HELD.has(letter.status) && letter.heldSince && now - letter.heldSince > HOLD_TTL_MS) {
        log.log(`[letters] ${letter.id} expired after ${Math.round((now - letter.heldSince) / 60_000)} min ${letter.status === 'ready' ? 'ready to air' : 'in review'} — refunding`);
        void refundLetter(letter, letter.status === 'ready' ? 'never_aired' : 'review_expired');
      }
    }
    for (const [roomId, state] of rooms.entries()) {
      if (state.playing || state.queue.length === 0) continue;
      const cfg = resolveRoomConfig(roomId);
      if (!cfg) continue;
      if (liveSeatCount(roomId) >= cfg.maxSeats) continue; // queued while seats busy
      // A MegaChat is one-shot: play it only while an overlay is actually
      // rendering the room. Otherwise it "plays" to nobody, the sender is
      // told it aired, and the media is deleted — a paid clip burnt.
      if (!hasOverlay(roomId)) continue;
      const letter = state.queue.shift();
      if (!letter || !letter.media) continue;
      playLetter(roomId, state, letter);
    }
  }, 2000);
  if (typeof tick.unref === 'function') tick.unref();

  /** One-shot play: broadcast the tile, schedule the end + cleanup. */
  function playLetter(roomId, state, letter, why = '') {
    state.playing = letter;
    letter.status = 'playing';
    letter.airedAt = Date.now();
    letter.heldSince = null;
    persist();
    // The most interesting second in a broadcast: somebody paid to be on the
    // stream and here they are. A "recently aired" card opens its replay
    // here rather than at zero. No-op when the room is not on air.
    try {
      addMoment(roomId, { kind: 'megachat', label: letter.username || null });
    } catch (e) {
      log.warn?.(`[airings] megachat moment failed: ${e.message}`);
    }
    log.log(`[letters] ${letter.id} playing in room ${roomId} (${letter.durationS}s)${why ? ' — ' + why : ''}`);
    broadcastToRoom(roomId, {
      type: 'letter_play',
      letter: {
        id: letter.id,
        username: letter.username,
        mediaUrl: `/api/letter/media/${letter.id}`,
        durationS: letter.durationS,
        flyIn: letter.flyIn,
        flyOut: letter.flyOut,
      },
    });
    // Bounty: open the clip's watermark window at the true playback start.
    try { onClipPlay(roomId, { clipId: letter.id, durationS: letter.durationS }); }
    catch (e) { log.warn(`[letters] bounty onClipPlay failed: ${e.message}`); }

    setTimeout(() => {
      letter.status = 'done';
      state.playing = null;
      broadcastToRoom(roomId, { type: 'letter_end', letterId: letter.id });
      try { onClipEnd(roomId, { clipId: letter.id }); }
      catch (e) { log.warn(`[letters] bounty onClipEnd failed: ${e.message}`); }
      setTimeout(() => removeLetter(letter), MEDIA_TTL_MS);
    }, letter.durationS * 1000 + STINGER_BUFFER_MS);
  }

  /**
   * PASS C PART 3a — a stored pledged clip goes on air THROUGH THIS QUEUE.
   *
   * The bank replays a buried clip by handing its bytes here as a synthetic,
   * already-paid letter whose id IS the clip id. The scheduler then does what
   * it does for every letter: waits for a free tile and a live overlay,
   * broadcasts letter_play, and fires onClipPlay — which opens the watermark
   * window with a FRESH per-playback nonce, because that is the only door a
   * window opens through. No second play path, no second proof path.
   *
   * price 0 and payer null: the fan paid at pledge time through the escrow;
   * refundLetter must never see this as money to return.
   */
  function enqueueStoredClip(roomId, { clipId, media, mime, durationS, username = null }) {
    if (!roomId || !clipId || !Buffer.isBuffer(media) || media.length < 1024) return { ok: false, reason: 'no media' };
    if (byId.has(clipId)) return { ok: false, reason: 'already queued' };
    const state = roomState(roomId);
    if (state.queue.length >= QUEUE_MAX_PER_ROOM) return { ok: false, reason: 'queue full' };
    if (globalBytes + media.length > GLOBAL_MAX_BYTES) return { ok: false, reason: 'server full' };
    try {
      store.writeMedia(clipId, media);
    } catch (e) {
      log.warn(`[letters] could not store bounty replay ${clipId}: ${e.message}`);
      return { ok: false, reason: 'storage failed' };
    }
    const letter = {
      id: clipId, roomId, username: username ? String(username).slice(0, 20) : null,
      payer: null, price: '0', durationS: Math.ceil(Number(durationS) || 0), mime: String(mime || 'video/webm'),
      flyIn: null, flyOut: null, status: 'queued', media: true, bytes: media.length,
      paidAt: Date.now(), uploadedAt: Date.now(),
      bounty: true,
    };
    byId.set(letter.id, letter);
    globalBytes += media.length;
    state.queue.push(letter);
    persist();
    log.log(`[letters] bounty replay ${clipId} queued in room ${roomId} (${letter.durationS}s, position ${state.queue.length})`);
    return { ok: true, position: state.queue.length };
  }

  /**
   * What the last process left behind. Runs once, at attach.
   *
   * The rules, and why each is the safe direction:
   *   · media gone          → refund. A playable clip with nothing to play is
   *                           worse than money returned.
   *   · mid-AI-review       → send to a HUMAN, flagged as interrupted. Never
   *                           auto-queue something no review finished.
   *   · mid-air             → back to its resting state. The fan paid for it
   *                           to air and it did not finish; a mod decides.
   *   · queued / ready /    → restored exactly, queue order preserved.
   *     pending_approval
   *
   * A restored held clip keeps its ORIGINAL heldSince, so a deploy does not
   * quietly restart somebody's refund clock.
   */
  function restoreFromDisk() {
    let loaded;
    try { loaded = store.load(); } catch (e) { log.warn(`[letters] restore failed: ${e.message}`); return; }
    const byRoomQueued = new Map();
    for (const row of loaded.restored) {
      const letter = { ...row, media: row.status !== 'awaiting_upload', bytes: store.mediaSize(row.id), frames: undefined };
      if (letter.status === 'reviewing') {
        letter.status = 'pending_approval';
        letter.flaggedReason = letter.flaggedReason || 'AI review was interrupted by a restart — decide by watching it';
        letter.heldSince = letter.heldSince || Date.now();
      } else if (letter.status === 'playing') {
        const cfg = resolveRoomConfig(letter.roomId);
        letter.status = cfg?.letters?.moderation === 'approve' ? 'ready' : 'queued';
        letter.heldSince = letter.status === 'ready' ? (letter.heldSince || Date.now()) : null;
        letter.airedAt = null;
      }
      byId.set(letter.id, letter);
      globalBytes += letter.bytes || 0;
      if (letter.status === 'queued') {
        if (!byRoomQueued.has(letter.roomId)) byRoomQueued.set(letter.roomId, []);
        byRoomQueued.get(letter.roomId).push(letter);
      }
    }
    for (const [roomId, list] of byRoomQueued) {
      list.sort((a, b) => (a.uploadedAt || a.paidAt || 0) - (b.uploadedAt || b.paidAt || 0));
      roomState(roomId).queue = list;
    }
    // Media that did not survive: the payer gets their money back. The door is
    // idempotent on the ref, so a repeated boot cannot refund twice.
    for (const row of loaded.orphaned) {
      const letter = { ...row, media: false, bytes: 0 };
      byId.set(letter.id, letter);
      log.warn(`[letters] ${letter.id} lost its media across a restart — refunding`);
      void refundLetter(letter, 'media_lost');
    }
    if (byId.size) {
      const held = [...byId.values()].filter((l) => HELD.has(l.status)).length;
      log.log(`[letters] restored ${byId.size} MegaChat(s) — ${held} waiting on a person, ${Math.round(globalBytes / 1024)}KB on disk`);
    }
    persist();
  }
  restoreFromDisk();

  log.log(`[letters] letter mode attached (durable; hold TTL ${Math.round(HOLD_TTL_MS / 60_000)} min)`);
  return { _byId: byId, enqueueStoredClip, _store: store }; // _byId exposed for tests
}
