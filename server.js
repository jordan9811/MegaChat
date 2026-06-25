import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  BatchFacilitatorClient,
  GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS
} from '@circle-fin/x402-batching/server';
import { attachRewards } from './rewards.js';

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
// Price per seat, in USDC dollars (legacy fixed price; kept for reference).
const SEAT_PRICE = process.env.SEAT_PRICE || '0.01';

// ─── Pass B: pay-per-tick meter ──────────────────────────────────────────────
// The viewer signs ONE Gateway authorization for up to MAX_SESSION USDC at join.
// We settle that nanopayment once (batch-settled on Arc by Circle Gateway), then
// meter it down by TICK_PRICE every TICK_SECONDS. When the prepaid balance can no
// longer cover the next tick we auto-kick the seat ('out_of_funds'). This is the
// spec's PRE-PAID BLOCKS model: Gateway's EIP-3009 authorizations are single-use
// (one nonce, one fixed value), so a single signature cannot be partially drawn
// per tick — we prepay the session cap once and meter locally, no per-tick popups.
const TICK_SECONDS = Number(process.env.TICK_SECONDS || 10);
const TICK_PRICE = process.env.TICK_PRICE || '0.1';
const MAX_SESSION = process.env.MAX_SESSION || '2';

// USDC has 6 decimals. Convert a decimal USDC string to atomic units (BigInt).
function usdcToAtomic(amountStr) {
  const [whole, frac = ''] = String(amountStr).split('.');
  const fracPadded = (frac + '000000').slice(0, 6);
  return BigInt(whole || '0') * 1000000n + BigInt(fracPadded || '0');
}
// Format atomic USDC (BigInt) back to a trimmed decimal string.
function atomicToUsdc(atomic) {
  const v = BigInt(atomic);
  const whole = v / 1000000n;
  const frac = (v % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const TICK_PRICE_ATOMIC = usdcToAtomic(TICK_PRICE);
const MAX_SESSION_ATOMIC = usdcToAtomic(MAX_SESSION);

// Circle Gateway facilitator client — verifies + settles the signed authorization.
const facilitator = new BatchFacilitatorClient({ url: FACILITATOR_URL });

// Cache the Arc "supported kind" (USDC asset + Gateway Wallet verifyingContract).
let arcKindCache = null;
async function getArcKind() {
  if (arcKindCache) return arcKindCache;
  const res = await fetch(`${FACILITATOR_URL}/v1/x402/supported`);
  if (!res.ok) throw new Error(`Gateway /supported returned ${res.status}`);
  const data = await res.json();
  arcKindCache = (data.kinds || []).find(
    (k) => k.network === ARC_NETWORK && k.extra?.verifyingContract
  );
  if (!arcKindCache) throw new Error(`Arc (${ARC_NETWORK}) not advertised by Gateway`);
  return arcKindCache;
}

// Build x402 PaymentRequirements for a given atomic amount on Arc.
function buildRequirements(kind, amountAtomic) {
  const usdc = (kind.extra.assets || []).find((a) => a.symbol === 'USDC');
  if (!usdc) throw new Error('Gateway kind missing USDC asset');
  return {
    scheme: 'exact',
    network: ARC_NETWORK,
    asset: usdc.address,
    amount: amountAtomic.toString(),
    payTo: SELLER_WALLET_ADDRESS,
    maxTimeoutSeconds: GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS,
    extra: {
      name: 'GatewayWalletBatched',
      version: '1',
      verifyingContract: kind.extra.verifyingContract
    }
  };
}

function b64encodeJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}
function b64decodeJson(str) {
  return JSON.parse(Buffer.from(str, 'base64').toString('utf-8'));
}

// Circle Gateway domain id for Arc Testnet (GATEWAY_DOMAINS.arcTestnet).
const ARC_GATEWAY_DOMAIN = 26;

// Read a depositor's *available* Gateway balance the same way the facilitator /
// GatewayClient does: POST /v1/balances { token, sources:[{depositor, domain}] }.
// `balance` is the available (spendable) amount; `pendingBatch` is awaiting batch
// settlement. Amounts are decimal USDC strings (6 decimals) -> convert to atomic.
async function getGatewayBalance(address) {
  const res = await fetch(`${FACILITATOR_URL}/v1/balances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: 'USDC',
      sources: [{ depositor: address, domain: ARC_GATEWAY_DOMAIN }]
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `Gateway /balances returned ${res.status}`);
  }
  // No record yet (e.g. deposit not finalized) -> treat as zero available.
  const entry = (data.balances || []).find(
    (b) => (b.depositor || '').toLowerCase() === address.toLowerCase()
  ) || (data.balances || [])[0] || null;

  const availableStr = entry?.balance ?? '0';
  const pendingStr = entry?.pendingBatch ?? '0';
  return {
    availableAtomic: usdcToAtomic(availableStr),
    pendingAtomic: usdcToAtomic(pendingStr),
    available: atomicToUsdc(usdcToAtomic(availableStr)),
    pending: atomicToUsdc(usdcToAtomic(pendingStr)),
    hasRecord: !!entry
  };
}

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
    seatPrice: SEAT_PRICE,
    tickSeconds: TICK_SECONDS,
    tickPrice: TICK_PRICE,
    maxSession: MAX_SESSION
  });
});

// Read a wallet's available Circle Gateway balance (what it can spend to join).
// Returns the available + pending amounts and the spendable session amount
// (min(available, MAX_SESSION)) so the UI can preview "Remaining".
app.get('/api/balance/:address', async (req, res) => {
  const { address } = req.params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) {
    return res.status(400).json({ error: 'Invalid address' });
  }
  try {
    const bal = await getGatewayBalance(address);
    const spendableAtomic = bal.availableAtomic < MAX_SESSION_ATOMIC
      ? bal.availableAtomic
      : MAX_SESSION_ATOMIC;
    return res.json({
      address,
      available: bal.available,
      pending: bal.pending,
      hasRecord: bal.hasRecord,
      spendable: atomicToUsdc(spendableAtomic),
      maxSession: MAX_SESSION,
      canJoin: spendableAtomic >= TICK_PRICE_ATOMIC
    });
  } catch (err) {
    return res.status(502).json({ error: 'Balance lookup failed', message: err.message });
  }
});

// Active video seats
// Each seat has: { id, username, roomId, pushUrl, viewUrl, joinedAt, expiresAt,
//                  spentAtomic, remainingAtomic, payer, depositTx }
const activeSeats = new Map();
const MAX_SEATS = 6;
// Estimated max session length (ms) for the overlay countdown, derived from the
// prepaid cap. The real cutoff is the meter (remaining balance), not a fixed timer.
const SESSION_TICKS = TICK_PRICE_ATOMIC > 0n
  ? Number(MAX_SESSION_ATOMIC / TICK_PRICE_ATOMIC)
  : 0;
const ESTIMATED_SESSION_MS = SESSION_TICKS * TICK_SECONDS * 1000;

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

// Add participant (Pass B: metered, no fixed timer).
// `meta` carries the prepaid session balance signed by the viewer.
function addParticipant(username, meta = {}) {
  if (activeSeats.size >= MAX_SEATS) {
    return { success: false, reason: 'no_seats_available' };
  }

  const seatId = randomUUID();
  const vdoRoom = generateVDORoom(username);
  const now = Date.now();
  const remainingAtomic = meta.remainingAtomic ?? MAX_SESSION_ATOMIC;

  const seat = {
    id: seatId,
    username,
    roomId: vdoRoom.roomId,
    pushUrl: vdoRoom.pushUrl,
    viewUrl: vdoRoom.viewUrl,
    joinedAt: now,
    // Overlay countdown estimate; the meter (below) is the real cutoff.
    expiresAt: now + ESTIMATED_SESSION_MS,
    spentAtomic: 0n,
    remainingAtomic,
    payer: meta.payer || null,
    depositTx: meta.depositTx || null
  };

  activeSeats.set(seatId, seat);

  // NOTE: the fixed SEAT_DURATION setTimeout is intentionally removed in Pass B.
  // The shared meter interval (see startMeter) draws the seat down per tick.

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

// ─── Pass B meter ────────────────────────────────────────────────────────────
// Every TICK_SECONDS, draw TICK_PRICE from each active seat's prepaid balance.
// When the next draw would exceed the remaining balance, auto-kick the seat.
function tickMeter() {
  for (const seat of activeSeats.values()) {
    if (seat.remainingAtomic < TICK_PRICE_ATOMIC) {
      // Can't fund another tick — drop the seat.
      removeParticipant(seat.id, 'out_of_funds');
      continue;
    }

    seat.remainingAtomic -= TICK_PRICE_ATOMIC;
    seat.spentAtomic += TICK_PRICE_ATOMIC;

    const ticksLeft = TICK_PRICE_ATOMIC > 0n
      ? Number(seat.remainingAtomic / TICK_PRICE_ATOMIC)
      : 0;
    const secondsLeft = ticksLeft * TICK_SECONDS;

    broadcast({
      type: 'meter_update',
      seatId: seat.id,
      remaining: atomicToUsdc(seat.remainingAtomic),
      spent: atomicToUsdc(seat.spentAtomic),
      secondsLeft,
      minutesLeft: Math.floor(secondsLeft / 60)
    });

    // If this tick exhausted the balance, kick on the next pass.
    if (seat.remainingAtomic < TICK_PRICE_ATOMIC) {
      removeParticipant(seat.id, 'out_of_funds');
    }
  }
}

const meterInterval = setInterval(tickMeter, TICK_SECONDS * 1000);
// Don't keep the process alive solely for the meter.
if (typeof meterInterval.unref === 'function') meterInterval.unref();

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

// ─── Pass C: watch-to-earn (isolated; never breaks Pass A / B) ───────────────
try {
  attachRewards(wss, {
    earnInterval: Number(process.env.EARN_INTERVAL || 60),
    earnAmount: process.env.EARN_AMOUNT || '0.1',
    earnCap: process.env.EARN_CAP || '5',
    poolWallet: process.env.REWARD_POOL_WALLET_ADDRESS || null,
    poolPrivateKey: process.env.REWARD_POOL_PRIVATE_KEY || null,
    rpcUrl: ARC_RPC_URL
  });
} catch (err) {
  console.warn('[rewards] failed to attach, continuing without watch-to-earn:', err.message);
}

// Routes

// Main viewer page (where users pay and join)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// OBS overlay page (just video boxes)
app.get('/overlay', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'overlay.html'));
});

// Join seat — Circle Gateway payment on Arc Testnet (Pass B: prepaid session).
// 1) No payment header  -> 402 with Gateway requirements for the MAX_SESSION cap.
// 2) With Payment-Signature -> verify + settle the prepaid session, then start the
//    meter. The viewer signs ONE authorization (no per-tick popups); the meter
//    draws it down TICK_PRICE every TICK_SECONDS until 'out_of_funds'.
app.post('/api/join', async (req, res) => {
  try {
    const { username, address } = req.body;
    if (!username) {
      return res.status(400).json({ error: 'Username required' });
    }

    let kind;
    try {
      kind = await getArcKind();
    } catch (err) {
      return res.status(503).json({ error: 'Gateway unavailable', message: err.message });
    }

    const paymentHeader = req.headers['payment-signature'];

    // Step 1 — no payment yet: read the wallet's available Gateway balance and
    // emit a 402 for the spendable session amount = min(available, MAX_SESSION).
    // This is what fixes "insufficient_balance" for deposits below the cap: a
    // 1 USDC deposit is offered (and signable) as a 1 USDC session.
    if (!paymentHeader) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) {
        return res.status(400).json({ error: 'Wallet address required to price the session' });
      }

      let bal;
      try {
        bal = await getGatewayBalance(address);
      } catch (err) {
        return res.status(502).json({ error: 'Balance lookup failed', message: err.message });
      }

      const sessionAtomic = bal.availableAtomic < MAX_SESSION_ATOMIC
        ? bal.availableAtomic
        : MAX_SESSION_ATOMIC;

      if (sessionAtomic < TICK_PRICE_ATOMIC) {
        return res.status(402).json({
          error: 'Insufficient Gateway balance',
          reason: 'insufficient_balance',
          available: bal.available,
          pending: bal.pending,
          needAtLeast: TICK_PRICE,
          hint: bal.hasRecord
            ? 'Deposit more USDC into the Gateway to watch.'
            : 'No finalized Gateway balance yet — your deposit may still be finalizing.'
        });
      }

      const requirements = buildRequirements(kind, sessionAtomic);
      const paymentRequired = {
        x402Version: 2,
        resource: {
          url: '/api/join',
          description: `Co-stream seat — prepaid ${atomicToUsdc(sessionAtomic)} USDC, metered ${TICK_PRICE} USDC / ${TICK_SECONDS}s`,
          mimeType: 'application/json'
        },
        accepts: [requirements]
      };
      res.statusCode = 402;
      res.setHeader('PAYMENT-REQUIRED', b64encodeJson(paymentRequired));
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({}));
    }

    // Step 2 — verify + settle the signed authorization. The settled amount is
    // exactly what the viewer signed (their available balance, capped at the
    // session max), so the requirements we verify against must use that value.
    let paymentPayload;
    try {
      paymentPayload = b64decodeJson(paymentHeader);
    } catch {
      return res.status(400).json({ error: 'Malformed Payment-Signature header' });
    }

    let sessionAtomic;
    try {
      sessionAtomic = BigInt(paymentPayload?.payload?.authorization?.value ?? '0');
    } catch {
      sessionAtomic = 0n;
    }
    if (sessionAtomic <= 0n) {
      return res.status(400).json({ error: 'Signed authorization has no value' });
    }
    if (sessionAtomic > MAX_SESSION_ATOMIC) {
      return res.status(400).json({
        error: 'Authorization exceeds session cap',
        reason: 'over_cap',
        maxSession: MAX_SESSION
      });
    }

    const requirements = buildRequirements(kind, sessionAtomic);

    const verify = await facilitator.verify(paymentPayload, requirements);
    if (!verify.isValid) {
      return res.status(402).json({
        error: 'Payment verification failed',
        reason: verify.invalidReason
      });
    }

    // Settle the prepaid session once (Circle Gateway batch-settles on Arc).
    const settle = await facilitator.settle(paymentPayload, requirements);
    if (!settle.success) {
      return res.status(402).json({
        error: 'Payment settlement failed',
        reason: settle.errorReason
      });
    }

    const result = addParticipant(username, {
      remainingAtomic: sessionAtomic,
      payer: settle.payer || verify.payer || null,
      depositTx: settle.transaction || null
    });

    if (!result.success) {
      return res.status(409).json({
        error: 'No seats available',
        reason: result.reason
      });
    }

    const ticksLeft = TICK_PRICE_ATOMIC > 0n
      ? Number(result.seat.remainingAtomic / TICK_PRICE_ATOMIC)
      : 0;

    // Return the push URL for user to open their camera
    return res.json({
      success: true,
      message: 'Seat assigned! Open this link to go live:',
      pushUrl: result.seat.pushUrl,
      seatId: result.seat.id,
      remaining: atomicToUsdc(result.seat.remainingAtomic),
      tickPrice: TICK_PRICE,
      tickSeconds: TICK_SECONDS,
      maxSession: MAX_SESSION,
      secondsLeft: ticksLeft * TICK_SECONDS,
      payment: {
        payer: settle.payer || verify.payer || null,
        transaction: settle.transaction || null,
        network: ARC_NETWORK
      }
    });
  } catch (error) {
    console.error('join error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Payment processing error', message: error.message });
    }
  }
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
║  Meter:   ${TICK_PRICE} USDC / ${TICK_SECONDS}s  (cap ${MAX_SESSION} USDC)
║  Seller:  ${SELLER_WALLET_ADDRESS}
╚═══════════════════════════════════════════╝
  `);
});
