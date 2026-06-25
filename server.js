import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server';

// Load .env if present (Node >=20.6 native loader). Never throws if missing.
try {
  process.loadEnvFile();
} catch {
  // No .env file — fall back to process.env / defaults below.
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Arc Testnet constants (eip155:5042002) ──────────────────────────────────
// These are the literal Arc Testnet values. We NEVER fall back to Base Sepolia.
const ARC_CHAIN_ID = Number(process.env.ARC_CHAIN_ID || 5042002);
const ARC_NETWORK = `eip155:${ARC_CHAIN_ID}`; // CAIP-2 identifier used by Gateway
const ARC_RPC_URL = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';
const USDC_ADDRESS =
  process.env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000';
const GATEWAY_WALLET_ADDRESS =
  process.env.GATEWAY_WALLET_ADDRESS ||
  '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
const FACILITATOR_URL =
  process.env.FACILITATOR_URL || 'https://gateway-api-testnet.circle.com';
const EXPLORER_URL = process.env.EXPLORER_URL || 'https://testnet.arcscan.app';

// Seller receives the seat payments. Default is a placeholder; set in .env.
const SELLER_WALLET_ADDRESS =
  process.env.SELLER_WALLET_ADDRESS ||
  '0x000000000000000000000000000000000000dEaD';
// Price per seat, in USDC dollars (parsed by the Gateway middleware).
const SEAT_PRICE = process.env.SEAT_PRICE || '0.01';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static('public'));

// Expose the Arc / Gateway config the frontend needs to build payments.
app.get('/api/config', (req, res) => {
  res.json({
    chainId: ARC_CHAIN_ID,
    chainIdHex: '0x' + ARC_CHAIN_ID.toString(16),
    network: ARC_NETWORK,
    rpcUrl: ARC_RPC_URL,
    usdcAddress: USDC_ADDRESS,
    gatewayWalletAddress: GATEWAY_WALLET_ADDRESS,
    facilitatorUrl: FACILITATOR_URL,
    explorerUrl: EXPLORER_URL,
    sellerAddress: SELLER_WALLET_ADDRESS,
    seatPrice: SEAT_PRICE
  });
});

// ─── Circle Gateway payment gate (replaces the x402.org facilitator) ─────────
// Buyers pay USDC out of their Circle Gateway balance on Arc Testnet. The
// middleware emits a 402 with Gateway payment requirements, verifies the
// EIP-3009 authorization, and settles via the Circle Gateway facilitator.
const gateway = createGatewayMiddleware({
  sellerAddress: SELLER_WALLET_ADDRESS,
  facilitatorUrl: FACILITATOR_URL,
  networks: [ARC_NETWORK]
});

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

// Join seat — gated by Circle Gateway payment on Arc Testnet.
// gateway.require() emits the 402 + Gateway requirements, verifies the signed
// EIP-3009 authorization, and settles before our handler ever runs.
app.post('/api/join', gateway.require(SEAT_PRICE), (req, res) => {
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
    expiresIn: SEAT_DURATION / 1000,
    payment: req.payment || null
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

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║  VIDEO STREAM SERVER RUNNING (ARC TESTNET) ║
╠═══════════════════════════════════════════╣
║  Main:    http://localhost:${PORT}           ║
║  Overlay: http://localhost:${PORT}/overlay   ║
╠═══════════════════════════════════════════╣
║  Chain:   ${ARC_NETWORK}
║  Pay:     ${SEAT_PRICE} USDC via Circle Gateway
║  Seller:  ${SELLER_WALLET_ADDRESS}
╚═══════════════════════════════════════════╝
  `);
});
