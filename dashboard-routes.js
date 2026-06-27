/**
 * Streamer dashboard API — simple key auth from STREAMER_DASHBOARD_KEY in .env.
 */
import {
  listRooms,
  resolveRoomConfig,
  createRoom,
  updateRoom,
  setRoomActive,
  normalizeRoomId,
} from './rooms-store.js';
import { validatePaymentToken } from './token-utils.js';

export function attachDashboardRoutes(app, deps) {
  const {
    dashboardKey,
    activeSeats,
    removeParticipant,
    atomicToUsdc,
  } = deps;

  const authEnabled = !!(dashboardKey && dashboardKey.length > 0);

  function requireDashboardAuth(req, res, next) {
    if (!authEnabled) return next();
    const key = req.get('x-dashboard-key') || req.query.key;
    if (key !== dashboardKey) {
      return res.status(401).json({ error: 'Unauthorized', hint: 'Set X-Dashboard-Key header' });
    }
    next();
  }

  app.get('/dashboard', (req, res) => {
    res.sendFile(deps.dashboardHtmlPath);
  });

  app.get('/api/dashboard/auth-check', requireDashboardAuth, (req, res) => {
    res.json({ ok: true, authRequired: authEnabled });
  });

  app.get('/api/dashboard/rooms', requireDashboardAuth, (req, res) => {
    const rooms = listRooms().map((r) => ({
      ...r,
      joinUrl: `${deps.baseUrl}/?room=${r.id}`,
      overlayUrl: `${deps.baseUrl}/overlay?room=${r.id}`,
    }));
    res.json({ rooms, authRequired: authEnabled });
  });

  app.post('/api/dashboard/rooms', requireDashboardAuth, (req, res) => {
    const { name, config } = req.body || {};
    const room = createRoom(name, config);
    console.log(`[dashboard] created room ${room.id} (${room.name})`);
    res.status(201).json({
      room,
      joinUrl: `${deps.baseUrl}/?room=${room.id}`,
      overlayUrl: `${deps.baseUrl}/overlay?room=${room.id}`,
    });
  });

  app.get('/api/dashboard/rooms/:roomId', requireDashboardAuth, (req, res) => {
    const room = resolveRoomConfig(req.params.roomId);
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

  app.put('/api/dashboard/rooms/:roomId', requireDashboardAuth, async (req, res) => {
    const id = normalizeRoomId(req.params.roomId);
    if (!id) return res.status(400).json({ error: 'Invalid room id' });
    const body = req.body || {};
    if (body.config && body.config.paymentTokenAddress) {
      try {
        const meta = await validatePaymentToken(
          body.config.paymentTokenAddress,
          deps.rpcUrl,
          deps.chainId
        );
        body.config.paymentTokenSymbol = meta.symbol;
        body.config.paymentTokenDecimals = meta.decimals;
        console.log(`[dashboard] token ${meta.symbol} (${meta.decimals} dec) @ ${meta.address}`);
      } catch (err) {
        return res.status(400).json({ error: 'Invalid payment token', message: err.message });
      }
    }
    const room = updateRoom(id, body);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    console.log(`[dashboard] updated room ${room.id}`);
    res.json({ room });
  });

  app.post('/api/dashboard/rooms/:roomId/start', requireDashboardAuth, (req, res) => {
    const room = setRoomActive(req.params.roomId, true);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    console.log(`[dashboard] room ${room.id} started (accepting joins)`);
    res.json({ room });
  });

  app.post('/api/dashboard/rooms/:roomId/stop', requireDashboardAuth, (req, res) => {
    const room = setRoomActive(req.params.roomId, false);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    console.log(`[dashboard] room ${room.id} stopped (no new joins)`);
    res.json({ room });
  });

  app.post('/api/dashboard/rooms/:roomId/kick/:seatId', requireDashboardAuth, (req, res) => {
    const room = resolveRoomConfig(req.params.roomId);
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
