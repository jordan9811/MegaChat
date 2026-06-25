import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static('public'));

// Active video seats
// Each seat has: { id, username, roomId, pushUrl, viewUrl, joinedAt, expiresAt }
const activeSeats = new Map();
const MAX_SEATS = 6;
const SEAT_DURATION = 10 * 60 * 1000; // 10 minutes

// Generate VDO.Ninja room
function generateVDORoom(username) {
  const roomId = randomUUID().slice(0, 8); // Short room ID
  
  return {
    roomId,
    pushUrl: `https://vdo.ninja/?push=${roomId}&label=${encodeURIComponent(username)}`,
    viewUrl: `https://vdo.ninja/?view=${roomId}&scene`
  };
}

// Broadcast to all connected clients
function broadcast(message) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(message));
    }
  });
}

// Add participant
function addParticipant(username) {
  if (activeSeats.size >= MAX_SEATS) {
    return { success: false, reason: 'no_seats_available' };
  }

  const seatId = randomUUID();
  const vdoRoom = generateVDORoom(username);
  const now = Date.now();
  
  const seat = {
    id: seatId,
    username,
    roomId: vdoRoom.roomId,
    pushUrl: vdoRoom.pushUrl,
    viewUrl: vdoRoom.viewUrl,
    joinedAt: now,
    expiresAt: now + SEAT_DURATION
  };

  activeSeats.set(seatId, seat);

  // Auto-remove after duration
  setTimeout(() => {
    removeParticipant(seatId, 'expired');
  }, SEAT_DURATION);

  // Broadcast to overlay
  broadcast({
    type: 'seat_added',
    seat: {
      id: seat.id,
      username: seat.username,
      viewUrl: seat.viewUrl,
      expiresAt: seat.expiresAt
    }
  });

  return { success: true, seat };
}

// Remove participant
function removeParticipant(seatId, reason = 'left') {
  const seat = activeSeats.get(seatId);
  if (!seat) return { success: false };

  activeSeats.delete(seatId);

  // Broadcast removal
  broadcast({
    type: 'seat_removed',
    seatId,
    reason
  });

  return { success: true };
}

// WebSocket connection
wss.on('connection', (ws) => {
  console.log('Client connected');

  // Send current state
  ws.send(JSON.stringify({
    type: 'initial_state',
    seats: Array.from(activeSeats.values()).map(s => ({
      id: s.id,
      username: s.username,
      viewUrl: s.viewUrl,
      expiresAt: s.expiresAt
    }))
  }));

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// Routes

// Main viewer page (where users pay and join)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// OBS overlay page (just video boxes)
app.get('/overlay', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'overlay.html'));
});

// Join seat (payment goes here later)
app.post('/api/join', (req, res) => {
  const { username } = req.body;
  
  if (!username) {
    return res.status(400).json({ error: 'Username required' });
  }

  const result = addParticipant(username);
  
  if (!result.success) {
    return res.status(409).json({ 
      error: 'No seats available',
      reason: result.reason 
    });
  }

  // Return the push URL for user to open their camera
  res.json({
    success: true,
    message: 'Seat assigned! Open this link to go live:',
    pushUrl: result.seat.pushUrl,
    seatId: result.seat.id,
    expiresIn: SEAT_DURATION / 1000
  });
});

// Leave seat
app.post('/api/leave/:seatId', (req, res) => {
  const { seatId } = req.params;
  const result = removeParticipant(seatId, 'left');
  
  if (!result.success) {
    return res.status(404).json({ error: 'Seat not found' });
  }

  res.json({ success: true });
});

// Get current seats
app.get('/api/seats', (req, res) => {
  res.json({
    seats: Array.from(activeSeats.values()).map(s => ({
      id: s.id,
      username: s.username,
      expiresAt: s.expiresAt
    })),
    available: MAX_SEATS - activeSeats.size,
    maxSeats: MAX_SEATS
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║  VIDEO STREAM SERVER RUNNING              ║
╠═══════════════════════════════════════════╣
║  Main:    http://localhost:${PORT}           ║
║  Overlay: http://localhost:${PORT}/overlay   ║
╠═══════════════════════════════════════════╣
║  Add overlay URL to OBS as Browser Source ║
╚═══════════════════════════════════════════╝
  `);
});
