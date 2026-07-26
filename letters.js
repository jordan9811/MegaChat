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
  letterPriceFor,
} from './rooms-store.js';
import { verifyRoomAccess } from './auth.js';
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
    // No overlay connected = nothing renders letter_play — hold the queue
    // instead of burning clips into the void. Default true keeps standalone/
    // test wiring (and any host without the hook) on the old behavior.
    hasOverlay = () => true,
    activeSeats,
    sellerAddress,
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

  // ─── AI moderation (recorded clips ONLY — never the live path) ────────────
  // Configured via MODERATION_API_KEY (+ MODERATION_API_BASE for tests/self-
  // hosted gateways). Absent → everything queues exactly as before; a verdict
  // is NEVER faked. Pipeline: whisper transcript + omni-moderation over the
  // transcript and the client-sampled frames. Fail-open on any error/timeout
  // (seconds of latency budget, not minutes).
  const moderationConfigured = () => !!process.env.MODERATION_API_KEY;

  async function moderateLetter(letter, cfg) {
    const key = process.env.MODERATION_API_KEY;
    const base = (process.env.MODERATION_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');
    let transcript = '';
    try {
      const fd = new FormData();
      fd.append('file', new Blob([letter.media], { type: letter.mime }), 'megachat.webm');
      fd.append('model', 'whisper-1');
      const tr = await fetch(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: fd,
        signal: AbortSignal.timeout(15000),
      });
      if (tr.ok) transcript = String((await tr.json()).text || '');
      else log.warn(`[letters] transcription ${tr.status} — continuing frames-only`);
    } catch (err) {
      log.warn('[letters] transcription failed (fail-open):', err.message);
    }

    // omni-moderation accepts AT MOST ONE image per request (400
    // too_many_images above that) — the mock API in the P2 gate accepted
    // many, which hid this: with ≥2 sampled frames every real review
    // 400'd and failed open, i.e. moderation never actually ran. Split:
    // transcript + first frame ride together, every further frame gets its
    // own request (the endpoint is free), and the verdict is the WORST
    // result across all of them.
    const frames = letter.frames || [];
    const requests = [];
    const first = [];
    if (transcript) first.push({ type: 'text', text: transcript });
    if (frames[0]) first.push({ type: 'image_url', image_url: { url: frames[0] } });
    if (first.length) requests.push(first);
    for (const f of frames.slice(1)) {
      requests.push([{ type: 'image_url', image_url: { url: f } }]);
    }
    if (requests.length === 0) return { verdict: 'pass', reason: null };

    try {
      const results = await Promise.all(requests.map(async (input) => {
        const mr = await fetch(`${base}/moderations`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'omni-moderation-latest', input }),
          signal: AbortSignal.timeout(15000),
        });
        if (!mr.ok) {
          // surface the API's own reason — a bare status code made real
          // misconfigurations (bad payload, wrong key scope)
          // indistinguishable from transient blips
          const body = await mr.text().catch(() => '');
          throw new Error(`moderation ${mr.status}: ${body.replace(/\s+/g, ' ').slice(0, 300)}`);
        }
        const data = await mr.json();
        return (data.results && data.results[0]) || null;
      }));

      let anyFlagged = false;
      const scores = {};
      for (const r of results) {
        if (!r) continue;
        if (r.flagged) anyFlagged = true;
        for (const [k, v] of Object.entries(r.category_scores || {})) {
          if (!(k in scores) || v > scores[k]) scores[k] = v;
        }
      }
      const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0] || null;
      const flagged = cfg.letters.aiStrictness === 'borderline'
        ? anyFlagged
        : !!(top && top[1] >= 0.7);
      if (!flagged) return { verdict: 'pass', reason: null };
      const pct = top ? Math.round(top[1] * 100) : 0;
      return {
        verdict: 'flag',
        reason: `${top ? top[0] : 'flagged'} (${pct}%)`
          + (transcript ? ` — “${transcript.slice(0, 90)}”` : ''),
      };
    } catch (err) {
      log.warn('[letters] moderation failed (fail-open):', err.message);
      return { verdict: 'pass', reason: null };
    }
  }

  /** Route a fully-uploaded letter to its resting state (+ broadcast). */
  function settleIntoQueue(letter, cfg, flaggedReason) {
    if (flaggedReason) {
      letter.status = 'pending_approval';
      letter.flaggedReason = flaggedReason;
    } else {
      letter.status = cfg.letters.moderation === 'approve' ? 'pending_approval' : 'queued';
    }
    if (letter.status === 'queued') roomState(letter.roomId).queue.push(letter);
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
      letter.media = body;
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
    res.setHeader('Content-Type', letter.mime);
    res.setHeader('Cache-Control', 'no-store');
    res.send(letter.media);
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
      .filter((l) => l.roomId === roomId && ['reviewing', 'pending_approval', 'queued', 'playing'].includes(l.status))
      .map((l) => ({
        id: l.id, username: l.username, durationS: l.durationS, price: l.price,
        status: l.status, uploadedAt: l.uploadedAt || null,
        flaggedReason: l.flaggedReason || null,
        mediaUrl: l.media ? `/api/letter/media/${l.id}` : null,
      }));
    // overlayLive tells the dashboard WHY queued clips are holding — the
    // #1 confusion was a clip "just sitting there" with no explanation.
    res.json({ letters: list, overlayLive: hasOverlay(roomId) });
  });

  // Streamer override: play a queued clip NOW, overlay-detection be damned
  // (they can see their own OBS; detection can't). Slot rules still apply —
  // playing into a full tile stack would burn the one-shot invisibly.
  app.post('/api/dashboard/rooms/:roomId/letters/:id/play', async (req, res) => {
    const roomId = await requirePassword(req, res);
    if (!roomId) return;
    const letter = byId.get(req.params.id);
    if (!letter || letter.roomId !== roomId || letter.status !== 'queued' || !letter.media) {
      return res.status(404).json({ error: 'MegaChat not found or not queued' });
    }
    const state = roomState(roomId);
    if (state.playing) return res.status(409).json({ error: 'Another MegaChat is already playing' });
    const cfg = resolveRoomConfig(roomId);
    if (liveSeatCount(roomId) >= cfg.maxSeats) {
      return res.status(409).json({ error: 'All camera tiles are busy — try when a slot frees up' });
    }
    state.queue = state.queue.filter((l) => l.id !== letter.id);
    playLetter(roomId, state, letter, 'forced by streamer');
    res.json({ success: true });
  });

  app.post('/api/dashboard/rooms/:roomId/letters/:id/approve', async (req, res) => {
    const roomId = await requirePassword(req, res);
    if (!roomId) return;
    const letter = byId.get(req.params.id);
    if (!letter || letter.roomId !== roomId || letter.status !== 'pending_approval') {
      return res.status(404).json({ error: 'MegaChat not found or not pending' });
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

  log.log('[letters] letter mode attached (one-shot, in-memory)');
  return { _byId: byId }; // exposed for tests
}
