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
} from './rooms-store.js';
import { validatePaymentToken } from './token-utils.js';

function getRoomPassword(req) {
  const fromHeader = req.get('x-room-password');
  if (fromHeader) return fromHeader;
  if (req.body && typeof req.body.password === 'string') return req.body.password;
  return null;
}

export function attachDashboardRoutes(app, deps) {
  const {
    activeSeats,
    removeParticipant,
    atomicToUsdc,
  } = deps;

  async function requireRoomPassword(req, res, next) {
    const id = normalizeRoomId(req.params.roomId);
    if (!id) return res.status(400).json({ error: 'Invalid room id' });
    const password = getRoomPassword(req);
    if (!password) {
      return res.status(401).json({ error: 'Unauthorized', hint: 'Room password required' });
    }
    const ok = await verifyRoomPassword(id, password);
    if (!ok) {
      return res.status(401).json({ error: 'Unauthorized' });
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

  app.get('/dashboard', (req, res) => {
    res.sendFile(deps.dashboardHtmlPath);
  });

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

  app.post('/api/dashboard/rooms', async (req, res) => {
    const { name, config, password } = req.body || {};
    if (!password || typeof password !== 'string' || password.length < 4) {
      return res.status(400).json({ error: 'Room password required (min 4 characters)' });
    }
    let mergedConfig = config || {};
    try {
      await validateConfigTokens(mergedConfig);
    } catch (err) {
      return res.status(400).json({ error: err.message.includes('reward') ? 'Invalid reward token' : 'Invalid payment token', message: err.message });
    }
    let room;
    try {
      room = await createRoomWithPassword(name, mergedConfig, password);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    console.log(`[dashboard] created room ${room.id} (${room.name})`);
    res.status(201).json({
      room,
      joinUrl: `${deps.baseUrl}/?room=${room.id}`,
      overlayUrl: `${deps.baseUrl}/overlay?room=${room.id}`,
    });
  });

  app.get('/api/dashboard/rooms/:roomId', requireRoomPassword, (req, res) => {
    const room = resolveRoomConfig(req.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const seats = [];
    for (const seat of activeSeats.values()) {
      if (seat.streamRoomId !== room.id) continue;
      seats.push({
        id: seat.id,
        username: seat.username,
        live: !!seat.live,
        paymentMode: seat.paymentMode,
        remaining: atomicToUsdc(seat.remainingAtomic),
        spent: atomicToUsdc(seat.spentAtomic),
        viewerAddress: seat.viewerAddress,
        joinedAt: seat.joinedAt,
        liveAt: seat.liveAt,
      });
    }

    res.json({
      room,
      seats,
      joinUrl: `${deps.baseUrl}/?room=${room.id}`,
      overlayUrl: `${deps.baseUrl}/overlay?room=${room.id}`,
    });
  });

  app.put('/api/dashboard/rooms/:roomId', requireRoomPassword, async (req, res) => {
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
    const room = updateRoom(req.roomId, body);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    console.log(`[dashboard] updated room ${room.id}`);
    res.json({ room });
  });

  app.post('/api/dashboard/rooms/:roomId/start', requireRoomPassword, (req, res) => {
    const room = setRoomActive(req.roomId, true);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    console.log(`[dashboard] room ${room.id} started (accepting joins)`);
    res.json({ room });
  });

  app.post('/api/dashboard/rooms/:roomId/stop', requireRoomPassword, (req, res) => {
    const room = setRoomActive(req.roomId, false);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    console.log(`[dashboard] room ${room.id} stopped (no new joins)`);
    res.json({ room });
  });

  app.post('/api/dashboard/rooms/:roomId/kick/:seatId', requireRoomPassword, (req, res) => {
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
}
