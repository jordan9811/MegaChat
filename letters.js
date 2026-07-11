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
 *      letter_end → media deleted shortly after. One-shot by design: letters
 *      live in memory only, never on disk.
 *
 * Moderation: rooms set letters.moderation = 'approve' → letters wait in a
 * password-gated queue; reject (or upload expiry) refunds the payer with a
 * plain TIP-20 transfer from the PLATFORM wallet (payout-wallet rooms: the
 * platform absorbs the refund — documented in MEGA_CHECKLIST).
 */
import express from 'express';
import { randomUUID } from 'crypto';
import { erc20Abi } from 'viem';
import {
  resolveRoomConfig,
  normalizeRoomId,
  verifyRoomPassword,
  letterPriceFor,
} from './rooms-store.js';
import { toWebRequest } from './meter-mpp.js';
import { toAtomic, fromAtomic } from './token-utils.js';

const LETTER_MAX_BYTES = 25 * 1024 * 1024; // per letter
const GLOBAL_MAX_BYTES = 120 * 1024 * 1024; // all rooms combined
const QUEUE_MAX_PER_ROOM = 10;
const UPLOAD_GRACE_MS = 90_000; // paid → upload deadline
const MEDIA_TTL_MS = 60_000; // after playback, before the buffer is dropped
const STINGER_BUFFER_MS = 2600; // fly-in + fly-out allowance on playback

const FLY_IN_OK = new Set(['storm', 'proroll', 'callme', 'breaking', 'wildin']);
const FLY_OUT_OK = new Set(['crt', 'crumble', 'zapped', 'wildout']);

export function attachLetters(app, deps) {
  const {
    mppMeter,
    broadcastToRoom,
    activeSeats,
    sellerAddress,
    log = console,
  } = deps;

  /** roomId → { queue: Letter[], playing: Letter|null } */
  const rooms = new Map();
  /** letterId → Letter (any status) */
  const byId = new Map();
  let globalBytes = 0;

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
      globalBytes -= letter.media.length;
      letter.media = null;
    }
  }

  function removeLetter(letter) {
    dropMedia(letter);
    byId.delete(letter.id);
    const state = roomState(letter.roomId);
    state.queue = state.queue.filter((l) => l.id !== letter.id);
    if (state.playing?.id === letter.id) state.playing = null;
  }

  /** Refund the flat price to the payer from the PLATFORM wallet. */
  async function refundLetter(letter, reason) {
    letter.status = 'refunding';
    try {
      const cfg = resolveRoomConfig(letter.roomId);
      const hash = await mppMeter.walletClient.writeContract({
        address: cfg.paymentTokenAddress,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [letter.payer, toAtomic(letter.price, cfg.paymentTokenDecimals)],
      });
      log.log(`[letters] refunded ${letter.price} to ${letter.payer} (${reason}) tx ${hash}`);
    } catch (err) {
      log.warn(`[letters] refund failed for ${letter.id} (${reason}): ${err.shortMessage || err.message}`);
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
      if (!cfg.letters.enabled) return res.status(403).json({ error: 'Letters are not enabled in this room' });
      if (!cfg.active) return res.status(403).json({ error: 'Room is not accepting joins right now' });

      const { username, address, durationS, mime, flyIn, flyOut } = req.body || {};
      if (!username || typeof username !== 'string') {
        return res.status(400).json({ error: 'Username required' });
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) {
        return res.status(400).json({ error: 'Wallet address required' });
      }
      const dur = Number(durationS);
      if (!Number.isFinite(dur) || dur <= 0 || dur > cfg.letters.maxSeconds + 1) {
        return res.status(400).json({ error: `Letters are capped at ${cfg.letters.maxSeconds}s in this room` });
      }
      if (!/^video\/(webm|mp4)/.test(String(mime || ''))) {
        return res.status(400).json({ error: 'Unsupported recording format' });
      }
      const state = roomState(cfg.id);
      const pending = state.queue.length + (state.playing ? 1 : 0);
      if (pending >= QUEUE_MAX_PER_ROOM) {
        return res.status(429).json({ error: 'Letter queue is full — try again in a minute' });
      }

      const price = letterPriceFor(cfg);
      const result = await mppMeter.handleTick(toWebRequest(req), {
        amount: price,
        currency: cfg.paymentTokenAddress,
        decimals: cfg.paymentTokenDecimals,
        unitType: 'letter',
        recipient: cfg.payoutAddress || sellerAddress,
        suggestedDeposit: price,
      });
      if (result.status === 402) return result.respond(res);

      const letter = {
        id: randomUUID(),
        roomId: cfg.id,
        username: String(username).slice(0, 20),
        payer: address,
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
      log.log(`[letters] ${letter.id} paid ${price} by ${address} in room ${cfg.id}`);
      return result.respond(res, {
        success: true,
        letterId: letter.id,
        uploadUrl: `/api/letter/upload/${letter.id}`,
        price,
        moderation: cfg.letters.moderation,
      });
    } catch (err) {
      log.warn('[letters] submit error:', err.message);
      return res.status(500).json({ error: 'Letter submit failed', message: err.message });
    }
  });

  // ── 2. One-shot media upload ───────────────────────────────────────────────
  app.put(
    '/api/letter/upload/:id',
    express.raw({ type: () => true, limit: LETTER_MAX_BYTES }),
    (req, res) => {
      const letter = byId.get(req.params.id);
      if (!letter || letter.status !== 'awaiting_upload') {
        return res.status(404).json({ error: 'Unknown or already-uploaded letter' });
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
        return res.status(507).json({ error: 'Letter storage full — payment refunded' });
      }
      letter.media = body;
      globalBytes += body.length;
      letter.uploadedAt = Date.now();
      const cfg = resolveRoomConfig(letter.roomId);
      letter.status = cfg.letters.moderation === 'approve' ? 'pending_approval' : 'queued';
      if (letter.status === 'queued') roomState(letter.roomId).queue.push(letter);
      log.log(`[letters] ${letter.id} uploaded ${(body.length / 1024).toFixed(0)}KB → ${letter.status}`);
      broadcastToRoom(letter.roomId, {
        type: 'letter_queued',
        letterId: letter.id,
        status: letter.status,
        username: letter.username,
      });
      res.json({ success: true, status: letter.status });
    }
  );

  // ── 3. Media for the overlay (and the approve-queue preview) ─────────────
  app.get('/api/letter/media/:id', (req, res) => {
    const letter = byId.get(req.params.id);
    if (!letter || !letter.media) return res.status(404).json({ error: 'Gone' });
    res.setHeader('Content-Type', letter.mime);
    res.setHeader('Cache-Control', 'no-store');
    res.send(letter.media);
  });

  // ── Moderation (password-gated, same header scheme as the dashboard) ─────
  async function requirePassword(req, res) {
    const roomId = normalizeRoomId(req.params.roomId);
    if (!roomId) { res.status(400).json({ error: 'Invalid room id' }); return null; }
    const password = req.get('x-room-password');
    if (!password || !(await verifyRoomPassword(roomId, password))) {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    }
    return roomId;
  }

  app.get('/api/dashboard/rooms/:roomId/letters', async (req, res) => {
    const roomId = await requirePassword(req, res);
    if (!roomId) return;
    const list = [...byId.values()]
      .filter((l) => l.roomId === roomId && ['pending_approval', 'queued', 'playing'].includes(l.status))
      .map((l) => ({
        id: l.id, username: l.username, durationS: l.durationS, price: l.price,
        status: l.status, uploadedAt: l.uploadedAt || null,
        mediaUrl: l.media ? `/api/letter/media/${l.id}` : null,
      }));
    res.json({ letters: list });
  });

  app.post('/api/dashboard/rooms/:roomId/letters/:id/approve', async (req, res) => {
    const roomId = await requirePassword(req, res);
    if (!roomId) return;
    const letter = byId.get(req.params.id);
    if (!letter || letter.roomId !== roomId || letter.status !== 'pending_approval') {
      return res.status(404).json({ error: 'Letter not found or not pending' });
    }
    letter.status = 'queued';
    roomState(roomId).queue.push(letter);
    log.log(`[letters] ${letter.id} approved`);
    res.json({ success: true });
  });

  app.post('/api/dashboard/rooms/:roomId/letters/:id/reject', async (req, res) => {
    const roomId = await requirePassword(req, res);
    if (!roomId) return;
    const letter = byId.get(req.params.id);
    if (!letter || letter.roomId !== roomId || !['pending_approval', 'queued'].includes(letter.status)) {
      return res.status(404).json({ error: 'Letter not found or not rejectable' });
    }
    log.log(`[letters] ${letter.id} rejected — refunding`);
    void refundLetter(letter, 'rejected');
    res.json({ success: true, refunded: true });
  });

  // ── Scheduler: play when a tile slot is free; expire stale uploads ────────
  const tick = setInterval(() => {
    const now = Date.now();
    for (const letter of byId.values()) {
      if (letter.status === 'awaiting_upload' && now - letter.paidAt > UPLOAD_GRACE_MS) {
        void refundLetter(letter, 'upload_expired');
      }
    }
    for (const [roomId, state] of rooms.entries()) {
      if (state.playing || state.queue.length === 0) continue;
      const cfg = resolveRoomConfig(roomId);
      if (!cfg) continue;
      if (liveSeatCount(roomId) >= cfg.maxSeats) continue; // queued while seats busy
      const letter = state.queue.shift();
      if (!letter || !letter.media) continue;
      state.playing = letter;
      letter.status = 'playing';
      log.log(`[letters] ${letter.id} playing in room ${roomId} (${letter.durationS}s)`);
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
      setTimeout(() => {
        letter.status = 'done';
        state.playing = null;
        broadcastToRoom(roomId, { type: 'letter_end', letterId: letter.id });
        setTimeout(() => removeLetter(letter), MEDIA_TTL_MS);
      }, letter.durationS * 1000 + STINGER_BUFFER_MS);
    }
  }, 2000);
  if (typeof tick.unref === 'function') tick.unref();

  log.log('[letters] letter mode attached (one-shot, in-memory)');
  return { _byId: byId }; // exposed for tests
}
