/**
 * Streamer dashboard API — per-room password auth (hashed in rooms.json).
 */
import {
  resolveRoomConfig,
  createRoomWithPassword,
  updateRoom,
  setRoomActive,
  normalizeRoomId,
  verifyRoomPassword,
  setRoomPassword,
  sanitizeHandle,
  getRoomByHandle,
  setRoomHandle,
  setRoomOwner,
  roomsOwnedBy,
} from './rooms-store.js';
import { validatePaymentToken } from './token-utils.js';
import { isHandleTakenByIdentity } from './identity-store.js';
import { readIdentityFromRequest, roomOwnerKey, verifyRoomAccess } from './auth.js';

/**
 * Can this request use `handle` as a room link?
 *
 * Two registries own handles: OAuth identities (signing in RESERVES your name)
 * and rooms (a room actually USES it). The identity reservation exists so you
 * can claim your own name later — so "reserved by the person asking" is the
 * happy path, not a conflict. Previously this only asked *whether* an identity
 * held the name, never *whose*, which rejected everyone's own handle and made
 * signing in the one thing that broke your permanent link.
 *
 * `currentRoomId` lets an update re-save its own unchanged handle.
 */
function checkHandleAvailable(req, clean, currentRoomId = null) {
  const roomHolder = getRoomByHandle(clean);
  if (roomHolder && roomHolder.id !== currentRoomId) {
    const mine = readIdentityFromRequest(req)?.handle === clean;
    return {
      ok: false,
      status: 409,
      error: mine
        ? `@${clean} is already pointing at your other room (${roomHolder.id}). Free it there first, or pick another name.`
        : 'That handle is already taken',
    };
  }
  if (isHandleTakenByIdentity(clean) && readIdentityFromRequest(req)?.handle !== clean) {
    return { ok: false, status: 409, error: 'That handle is reserved by another account' };
  }
  return { ok: true };
}

/** Management routes only — never read body.password (create sends password in body). */
function getManagePassword(req) {
  const fromHeader = req.get('x-room-password');
  return typeof fromHeader === 'string' && fromHeader.length > 0 ? fromHeader : null;
}

export function attachDashboardRoutes(app, deps) {
  const {
    activeSeats,
    removeParticipant,
    setSeatPinned,
    atomicToUsdc,
  } = deps;

  // Owner-by-identity (signed-in cookie) OR the room password (shared mods).
  async function requireRoomAccess(req, res, next) {
    const id = normalizeRoomId(req.params.roomId);
    if (!id) return res.status(400).json({ error: 'Invalid room id' });
    const access = await verifyRoomAccess(req, id);
    if (!access.ok) {
      return res.status(401).json({
        error: 'Unauthorized',
        hint: 'Sign in as the room owner, or provide the room password.',
      });
    }
    req.roomId = id;
    next();
  }

  async function validateConfigTokens(config) {
    if (config.paymentTokenAddress) {
      const meta = await validatePaymentToken(
        config.paymentTokenAddress,
        deps.rpcUrl,
        deps.chainId
      );
      config.paymentTokenSymbol = meta.symbol;
      config.paymentTokenDecimals = meta.decimals;
    }
    // Streamer payout wallet: empty/null clears it (platform wallet receives);
    // anything else must be a well-formed address.
    if (config.payoutAddress != null && config.payoutAddress !== '') {
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(config.payoutAddress))) {
        throw new Error('Invalid payout wallet address');
      }
    } else if ('payoutAddress' in config) {
      config.payoutAddress = null;
    }
    if (config.rewards?.rewardType === 'token' && config.rewards.rewardTokenAddress) {
      const meta = await validatePaymentToken(
        config.rewards.rewardTokenAddress,
        deps.rpcUrl,
        deps.chainId
      );
      config.rewards.rewardTokenSymbol = meta.symbol;
      config.rewards.rewardTokenDecimals = meta.decimals;
    }
  }

  /** Public create. Signed-in → the room is OWNED (no password needed);
   *  password is optional and only sets the mod-share key. Signed out → a
   *  password is required so the room still has an admin path. */
  async function handleCreateRoom(req, res) {
    const { name, config, password, handle } = req.body || {};
    console.log('[dashboard:create] create room request received');
    const identity = readIdentityFromRequest(req);
    const hasPassword = typeof password === 'string' && password.length > 0;
    if (hasPassword && password.length < 4) {
      return res.status(400).json({ error: 'Room password must be at least 4 characters' });
    }
    if (!identity && !hasPassword) {
      return res.status(400).json({
        error: 'Sign in to own this room, or set a room password to manage it.',
      });
    }
    // Handle claim is validated BEFORE the room exists so a conflict never
    // leaves a half-created room behind.
    if (handle != null && handle !== '') {
      const clean = sanitizeHandle(handle);
      if (!clean) {
        return res.status(400).json({ error: 'Invalid handle: 3-20 chars, letters/numbers/underscore' });
      }
      const avail = checkHandleAvailable(req, clean);
      if (!avail.ok) return res.status(avail.status).json({ error: avail.error });
    }
    let mergedConfig = config || {};
    try {
      await validateConfigTokens(mergedConfig);
    } catch (err) {
      return res.status(400).json({
        error: err.message.includes('reward') ? 'Invalid reward token' : 'Invalid payment token',
        message: err.message,
      });
    }
    let room;
    try {
      room = await createRoomWithPassword(name, mergedConfig, hasPassword ? password : null);
      if (identity) setRoomOwner(room.id, roomOwnerKey(identity));
      if (handle != null && handle !== '') {
        setRoomHandle(room.id, handle);
        room = resolveRoomConfig(room.id);
      }
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    console.log(`[dashboard:create] room ${room.id} (${room.name}) created — ${identity ? 'owned by ' + roomOwnerKey(identity) : 'password-only'}`);
    res.status(201).json({
      room,
      owned: !!identity,
      hasPassword,
      joinUrl: `${deps.baseUrl}/?room=${room.id}`,
      overlayUrl: `${deps.baseUrl}/overlay?room=${room.id}`,
    });
  }

  // NOTE: /dashboard is served by the Next.js frontend (streamer dashboard).
  // The legacy static dashboard remains reachable at /dashboard.html.

  app.post('/api/dashboard/unlock', async (req, res) => {
    const { roomId: rawId, password } = req.body || {};
    const roomId = normalizeRoomId(rawId);
    if (!roomId) return res.status(400).json({ error: 'Invalid room id' });
    if (!password || typeof password !== 'string') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const room = resolveRoomConfig(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const ok = await verifyRoomPassword(roomId, password);
    if (!ok) return res.status(401).json({ error: 'Unauthorized' });
    res.json({
      ok: true,
      room,
      joinUrl: `${deps.baseUrl}/?room=${room.id}`,
      overlayUrl: `${deps.baseUrl}/overlay?room=${room.id}`,
    });
  });

  // Public create — register BEFORE any /rooms/:roomId management routes.
  app.post('/api/dashboard/create', handleCreateRoom);
  app.post('/api/dashboard/rooms', handleCreateRoom);

  // "Your rooms" — everything the signed-in identity owns, with live counts.
  // Signed out → empty (no password/identity, nothing to show). This is what
  // lets a streamer get back to a room without re-creating it.
  app.get('/api/dashboard/my-rooms', (req, res) => {
    const key = roomOwnerKey(readIdentityFromRequest(req));
    if (!key) return res.json({ rooms: [] });
    const rooms = roomsOwnedBy(key).map((r) => {
      let live = 0;
      let waiting = 0;
      for (const s of activeSeats.values()) {
        if (s.streamRoomId !== r.id) continue;
        if (s.live) live++; else waiting++;
      }
      return { ...r, live, waiting };
    });
    res.json({ rooms });
  });

  app.get('/api/dashboard/rooms/:roomId', requireRoomAccess, (req, res) => {
    const room = resolveRoomConfig(req.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const seats = [];
    const now = Date.now();
    for (const seat of activeSeats.values()) {
      if (seat.streamRoomId !== room.id) continue;
      const connected = !!(seat.ownerWs && seat.ownerWs.readyState === 1);
      // 'unstable' = control WS currently down, or blipped in the last 2 min —
      // the streamer sees who's riding a flaky connection. LiveKit seats
      // refine this with the SFU's own quality signal (good/poor).
      const recentBlip = seat.lastDisconnectAt && now - seat.lastDisconnectAt < 120000;
      let quality = seat.live ? (connected && !recentBlip ? 'good' : 'unstable') : null;
      if (quality === 'good' && seat.lkQuality) {
        if (seat.lkQuality === 'poor') quality = 'poor';
        else if (seat.lkQuality === 'lost') quality = 'unstable';
      }
      seats.push({
        id: seat.id,
        username: seat.username,
        live: !!seat.live,
        pinned: !!seat.pinned,
        paymentMode: seat.paymentMode,
        remaining: atomicToUsdc(seat.remainingAtomic),
        spent: atomicToUsdc(seat.spentAtomic),
        viewerAddress: seat.viewerAddress,
        joinedAt: seat.joinedAt,
        liveAt: seat.liveAt,
        connected,
        quality,
      });
    }

    res.json({
      room,
      seats,
      joinUrl: `${deps.baseUrl}/?room=${room.id}`,
      overlayUrl: `${deps.baseUrl}/overlay?room=${room.id}`,
    });
  });

  app.put('/api/dashboard/rooms/:roomId', requireRoomAccess, async (req, res) => {
    const body = req.body || {};
    if (body.config) {
      try {
        await validateConfigTokens(body.config);
      } catch (err) {
        return res.status(400).json({ error: 'Invalid token', message: err.message });
      }
    }
    if (body.newPassword && typeof body.newPassword === 'string') {
      if (body.newPassword.length < 4) {
        return res.status(400).json({ error: 'New password must be at least 4 characters' });
      }
      await setRoomPassword(req.roomId, body.newPassword);
    }
    if (body.handle !== undefined) {
      const clean = body.handle === '' || body.handle === null ? null : sanitizeHandle(body.handle);
      if (clean) {
        const avail = checkHandleAvailable(req, clean, req.roomId);
        if (!avail.ok) return res.status(avail.status).json({ error: avail.error });
      }
      try {
        setRoomHandle(req.roomId, body.handle);
      } catch (err) {
        return res.status(err.code === 'handle_taken' ? 409 : 400).json({ error: err.message });
      }
    }
    const room = updateRoom(req.roomId, body);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    console.log(`[dashboard] updated room ${room.id}`);
    res.json({ room });
  });

  app.post('/api/dashboard/rooms/:roomId/start', requireRoomAccess, (req, res) => {
    const room = setRoomActive(req.roomId, true);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    console.log(`[dashboard] room ${room.id} started (accepting joins)`);
    res.json({ room });
  });

  app.post('/api/dashboard/rooms/:roomId/stop', requireRoomAccess, (req, res) => {
    const room = setRoomActive(req.roomId, false);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    console.log(`[dashboard] room ${room.id} stopped (no new joins)`);
    res.json({ room });
  });

  app.post('/api/dashboard/rooms/:roomId/kick/:seatId', requireRoomAccess, (req, res) => {
    const room = resolveRoomConfig(req.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const seat = activeSeats.get(req.params.seatId);
    if (!seat || seat.streamRoomId !== room.id) {
      return res.status(404).json({ error: 'Seat not found in this room' });
    }
    removeParticipant(seat.id, 'kicked');
    console.log(`[dashboard] kicked seat ${seat.id} from room ${room.id}`);
    res.json({ success: true, seatId: seat.id });
  });

  // Pin/unpin a live seat as free co-host (meter paused while pinned).
  // Same password gate as kick.
  app.post('/api/dashboard/rooms/:roomId/pin/:seatId', requireRoomAccess, (req, res) => {
    const room = resolveRoomConfig(req.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const seat = activeSeats.get(req.params.seatId);
    if (!seat || seat.streamRoomId !== room.id) {
      return res.status(404).json({ error: 'Seat not found in this room' });
    }
    const pinned = req.body?.pinned !== false; // default: pin
    setSeatPinned(seat.id, pinned);
    res.json({ success: true, seatId: seat.id, pinned: !!seat.pinned });
  });
}
