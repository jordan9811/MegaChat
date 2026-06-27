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
import {
  applyStreamTick,
  streamMeterPayload,
} from './passkey-meter.js';
import { createWalletClient, createPublicClient, http, erc20Abi, decodeEventLog } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

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

// Circle Modular Wallets (passkey path) — loaded from env, never logged.
const CIRCLE_CLIENT_KEY = process.env.CIRCLE_CLIENT_KEY || null;
const CIRCLE_CLIENT_URL = process.env.CIRCLE_CLIENT_URL || null;
// Confirmed from Circle skill use-modular-wallets Transport URL Path Segments table.
const CIRCLE_MODULAR_CHAIN_PATH = process.env.CIRCLE_MODULAR_CHAIN_PATH || 'arcTestnet';

// Seller receives the seat payments. Default is a placeholder; set in .env.
const SELLER_WALLET_ADDRESS =
  process.env.SELLER_WALLET_ADDRESS ||
  '0x000000000000000000000000000000000000dEaD';
// Price per seat, in USDC dollars (legacy fixed price; kept for reference).
const SEAT_PRICE = process.env.SEAT_PRICE || '0.01';

// Seller private key — only used to REFUND the unused prepaid balance back to a
// viewer when they leave. This is a plain ERC-20 transfer, NOT part of the
// Gateway verify/settle payment path. Refunds are skipped if it isn't set.
const SELLER_PRIVATE_KEY = process.env.SELLER_PRIVATE_KEY || null;
// How long a paid seat may stay "pending" (paid but camera not approved) before
// we release it and refund the full prepaid amount.
const PENDING_CAMERA_TIMEOUT_MS = Number(process.env.PENDING_CAMERA_TIMEOUT_MS || 5 * 60 * 1000);

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

// Phase 2: passkey stream meter (true per-second on-chain pulls). MetaMask keeps TICK_* above.
const PASSKEY_TICK_SECONDS = Number(process.env.PASSKEY_TICK_SECONDS || 1);
const PASSKEY_TICK_PRICE = process.env.PASSKEY_TICK_PRICE || '0.001';
// Documented approach: B — session keys (A) not in SDK yet; streamed pulls via
// one upfront approve userOp + seller transferFrom each tick (silent after join).
const PASSKEY_METER_APPROACH = 'B';

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
const PASSKEY_TICK_PRICE_ATOMIC = usdcToAtomic(PASSKEY_TICK_PRICE);
const MAX_SESSION_ATOMIC = usdcToAtomic(MAX_SESSION);

// Circle Gateway facilitator client — verifies + settles the signed authorization.
const facilitator = new BatchFacilitatorClient({ url: FACILITATOR_URL });

// ─── Refund wallet (seller -> viewer) ────────────────────────────────────────
// Used ONLY to return the unused prepaid USDC when a viewer leaves. Plain ERC-20
// transfer via viem; independent of the Gateway payment path.
const arcViemChain = {
  id: ARC_CHAIN_ID,
  name: 'Arc Testnet',
  network: ARC_NETWORK,
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC_URL] }, public: { http: [ARC_RPC_URL] } }
};
let sellerAccount = null;
let sellerWalletClient = null;
if (SELLER_PRIVATE_KEY && /^0x[0-9a-fA-F]{64}$/.test(SELLER_PRIVATE_KEY)) {
  try {
    sellerAccount = privateKeyToAccount(SELLER_PRIVATE_KEY);
    sellerWalletClient = createWalletClient({
      account: sellerAccount,
      chain: arcViemChain,
      transport: http(ARC_RPC_URL)
    });
    console.log(`[refund] seller refund wallet ready: ${sellerAccount.address}`);
  } catch (err) {
    console.warn('[refund] failed to init seller wallet, refunds disabled:', err.message);
    sellerWalletClient = null;
  }
} else {
  console.warn('[refund] SELLER_PRIVATE_KEY not set — unused-balance refunds disabled.');
}

// Refund the unused prepaid balance (settled - consumed = remainingAtomic) back
// to the viewer. Passkey stream seats skip this — unspent USDC never left the wallet.
async function refundSeat(seat) {
  if (!seat || seat.refunded) return;
  if (seat.paymentMode === 'passkey_stream') {
    seat.refunded = true;
    if (seat.remainingAtomic > 0n) {
      console.log(
        `[refund] stream seat ${seat.id}: ${atomicToUsdc(seat.remainingAtomic)} USDC was never pulled — remains in viewer wallet`
      );
    }
    return;
  }
  const refundAtomic = seat.remainingAtomic;
  if (refundAtomic <= 0n) return; // nothing unused to return
  const to = seat.viewerAddress || seat.payer;
  if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to)) {
    console.warn(`[refund] seat ${seat.id}: no viewer address — cannot refund ${atomicToUsdc(refundAtomic)} USDC`);
    return;
  }
  seat.refunded = true; // guard against double refund

  if (!sellerWalletClient) {
    console.warn(`[refund] seat ${seat.id}: refunds disabled — would return ${atomicToUsdc(refundAtomic)} USDC to ${to}`);
    return;
  }

  const transfer = () => sellerWalletClient.writeContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to, refundAtomic]
  });

  try {
    const tx = await transfer();
    console.log(`[refund] seat ${seat.id}: returned ${atomicToUsdc(refundAtomic)} USDC to ${to} (tx ${tx})`);
  } catch (err) {
    console.warn(`[refund] seat ${seat.id}: refund failed, retrying once — ${err.message}`);
    try {
      const tx2 = await transfer();
      console.log(`[refund] seat ${seat.id}: refund retry ok, returned ${atomicToUsdc(refundAtomic)} USDC to ${to} (tx ${tx2})`);
    } catch (err2) {
      console.error(`[refund] seat ${seat.id}: refund retry FAILED — ${err2.message}`);
    }
  }
}

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
// On-chain USDC balance for passkey smart accounts (6-decimal ERC-20).
async function getOnChainUsdcBalance(address) {
  const client = createPublicClient({
    chain: arcViemChain,
    transport: http(ARC_RPC_URL)
  });
  const raw = await client.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address]
  });
  return {
    availableAtomic: BigInt(raw),
    pendingAtomic: 0n,
    available: atomicToUsdc(raw),
    pending: '0',
    hasRecord: raw > 0n
  };
}

// Verify passkey stream join: on-chain allowance (primary) + optional approve tx receipt.
async function verifyPasskeyStreamAllowance(payer, sessionAtomic, txHash) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(payer || '')) {
    return { ok: false, reason: 'invalid_payer' };
  }

  const readAllowance = async () => {
    const client = createPublicClient({
      chain: arcViemChain,
      transport: http(ARC_RPC_URL)
    });
    const raw = await client.readContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [payer, SELLER_WALLET_ADDRESS]
    });
    return BigInt(raw);
  };

  let allowance;
  try {
    allowance = await readAllowance();
  } catch (err) {
    return { ok: false, reason: 'allowance_read_failed', message: err.message };
  }

  // UserOp receipt can land before RPC allowance index catches up.
  if (allowance < sessionAtomic && txHash) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      allowance = await readAllowance();
    } catch { /* keep prior */ }
  }

  if (allowance < sessionAtomic) {
    console.warn(
      `[join:passkey] insufficient allowance ${atomicToUsdc(allowance)} USDC `
      + `(need ${atomicToUsdc(sessionAtomic)}) for ${payer}`
    );
    return { ok: false, reason: 'insufficient_allowance', allowance };
  }

  if (txHash && /^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    try {
      const client = createPublicClient({
        chain: arcViemChain,
        transport: http(ARC_RPC_URL)
      });
      const receipt = await client.getTransactionReceipt({ hash: txHash });
      if (!receipt || receipt.status !== 'success') {
        return { ok: false, reason: 'tx_not_success' };
      }
    } catch {
      // Allowance is authoritative once confirmed on-chain.
    }
  }

  console.log(
    `[join:passkey] verified allowance ${atomicToUsdc(allowance)} USDC `
    + `(session cap ${atomicToUsdc(sessionAtomic)}) for ${payer}`
  );
  return { ok: true, payer, allowance, amount: allowance, txHash: txHash || null };
}

// Legacy Phase 1 transfer verifier — not used by passkey stream join.
async function verifyModularUsdcPayment(txHash, expectedFrom, expectedAmountAtomic) {
  const client = createPublicClient({
    chain: arcViemChain,
    transport: http(ARC_RPC_URL)
  });
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  if (!receipt || receipt.status !== 'success') {
    return { ok: false, reason: 'tx_not_success' };
  }
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== USDC_ADDRESS.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: erc20Abi,
        data: log.data,
        topics: log.topics
      });
      if (decoded.eventName !== 'Transfer') continue;
      const from = decoded.args.from;
      const to = decoded.args.to;
      const value = BigInt(decoded.args.value);
      if (from.toLowerCase() !== expectedFrom.toLowerCase()) continue;
      if (to.toLowerCase() !== SELLER_WALLET_ADDRESS.toLowerCase()) continue;
      if (value < expectedAmountAtomic) continue;
      return { ok: true, payer: from, amount: value, txHash };
    } catch {
      continue;
    }
  }
  return { ok: false, reason: 'transfer_not_found' };
}

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
// Never cache the frontend during development — guarantees the browser always
// runs the latest index.html / overlay.html / rewards.js (no stale-bundle bugs).
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

// Browsers require text/javascript for ES modules (.js / .mjs). Express's default
// MIME lookup can mislabel .mjs on some platforms, which breaks dynamic import().
function staticJsHeaders(res, filePath) {
  if (filePath.endsWith('.mjs') || filePath.endsWith('.js')) {
    res.setHeader('Content-Type', 'text/javascript; charset=UTF-8');
  }
}

app.use(express.static('public', {
  etag: false,
  lastModified: false,
  setHeaders: staticJsHeaders,
}));

// Expose the Arc / Gateway config the frontend needs to build payments.
app.get('/api/config', (req, res) => {
  const modularWallets = (CIRCLE_CLIENT_KEY && CIRCLE_CLIENT_URL)
    ? {
        clientKey: CIRCLE_CLIENT_KEY,
        clientUrl: CIRCLE_CLIENT_URL,
        chainPath: CIRCLE_MODULAR_CHAIN_PATH
      }
    : null;
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
    maxSession: MAX_SESSION,
    passkeyTickSeconds: PASSKEY_TICK_SECONDS,
    passkeyTickPrice: PASSKEY_TICK_PRICE,
    passkeyMeterApproach: PASSKEY_METER_APPROACH,
    modularWallets
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
  const passkeyMode = req.get('x-wallet-mode') === 'passkey'
    || req.query.mode === 'passkey';
  try {
    const bal = passkeyMode
      ? await getOnChainUsdcBalance(address)
      : await getGatewayBalance(address);
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
      canJoin: spendableAtomic >= TICK_PRICE_ATOMIC,
      source: passkeyMode ? 'onchain' : 'gateway'
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
    // 'live' gates everything: a tile is only shown, and the meter only ticks,
    // once the joiner signals camera_ready (see activateSeatLive).
    live: false,
    liveAt: null,
    expiresAt: 0, // set when the camera goes live
    spentAtomic: 0n,
    remainingAtomic,
    payer: meta.payer || null,
    viewerAddress: meta.viewerAddress || meta.payer || null,
    depositTx: meta.depositTx || null,
    refunded: false,
    ownerWs: null,
    // 'gateway' = MetaMask prepaid block; 'passkey_stream' = approve + per-tick pull
    paymentMode: meta.paymentMode || 'gateway',
    sessionCapAtomic: meta.sessionCapAtomic ?? remainingAtomic,
    _tickInFlight: false,
  };

  activeSeats.set(seatId, seat);

  // NOTE: we do NOT broadcast seat_added here. The overlay tile must only appear
  // after the camera is actually live (camera_ready), not on payment/join.

  return { success: true, seat };
}

// Promote a paid+pending seat to live once the joiner's camera is publishing.
// This is what starts the meter and shows the tile on the overlay.
function activateSeatLive(seatId, ws) {
  const seat = activeSeats.get(seatId);
  if (!seat || seat.live) return false;

  seat.live = true;
  seat.liveAt = Date.now();
  if (ws) { ws.__seatId = seatId; seat.ownerWs = ws; }

  const tickPrice = seat.paymentMode === 'passkey_stream'
    ? PASSKEY_TICK_PRICE_ATOMIC
    : TICK_PRICE_ATOMIC;
  const tickSec = seat.paymentMode === 'passkey_stream'
    ? PASSKEY_TICK_SECONDS
    : TICK_SECONDS;
  const ticksLeft = tickPrice > 0n
    ? Number(seat.remainingAtomic / tickPrice)
    : 0;
  // Overlay countdown estimate; the meter is the real cutoff. Starts NOW (live).
  seat.expiresAt = Date.now() + ticksLeft * tickSec * 1000;

  broadcast({
    type: 'seat_added',
    seat: {
      id: seat.id,
      username: seat.username,
      viewUrl: seat.viewUrl,
      expiresAt: seat.expiresAt
    }
  });
  const modeLabel = seat.paymentMode === 'passkey_stream' ? 'stream meter' : 'prepaid meter';
  console.log(`[seat] ${seat.id}: camera live — ${modeLabel} started (${atomicToUsdc(seat.remainingAtomic)} USDC cap)`);
  return true;
}

// Remove participant. Frees the seat immediately and (if any prepaid balance is
// unused) refunds it back to the viewer — without blocking the removal.
function removeParticipant(seatId, reason = 'left') {
  const seat = activeSeats.get(seatId);
  if (!seat) return { success: false };

  activeSeats.delete(seatId);

  // Broadcast removal (tile disappears instantly for everyone).
  broadcast({
    type: 'seat_removed',
    seatId,
    reason
  });

  // Refund the unused prepaid USDC (fire-and-forget; never blocks removal).
  refundSeat(seat).catch((e) => console.error('[refund] unexpected error:', e));

  return { success: true };
}

// ─── Pass B meter (MetaMask/Gateway prepaid block) ─────────────────────────
function tickPrepaidSeat(seat) {
  if (seat.remainingAtomic < TICK_PRICE_ATOMIC) {
    removeParticipant(seat.id, 'out_of_funds');
    return;
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
    minutesLeft: Math.floor(secondsLeft / 60),
    mode: 'gateway'
  });

  if (seat.remainingAtomic < TICK_PRICE_ATOMIC) {
    removeParticipant(seat.id, 'out_of_funds');
  }
}

// ─── Phase 2 passkey stream meter: on-chain transferFrom each tick ─────────
async function tickPasskeyStreamSeat(seat) {
  if (seat._tickInFlight) return;
  if (seat.remainingAtomic < PASSKEY_TICK_PRICE_ATOMIC) {
    removeParticipant(seat.id, 'out_of_funds');
    return;
  }

  seat._tickInFlight = true;
  try {
    if (sellerWalletClient) {
      const tx = await sellerWalletClient.writeContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'transferFrom',
        args: [seat.viewerAddress, SELLER_WALLET_ADDRESS, PASSKEY_TICK_PRICE_ATOMIC]
      });
      console.log(
        `[meter:passkey] seat ${seat.id}: pulled ${atomicToUsdc(PASSKEY_TICK_PRICE_ATOMIC)} USDC (tx ${tx})`
      );
    } else {
      console.log(
        `[meter:passkey] seat ${seat.id}: DRY pull ${atomicToUsdc(PASSKEY_TICK_PRICE_ATOMIC)} USDC (no SELLER_PRIVATE_KEY)`
      );
    }

    if (!applyStreamTick(seat, PASSKEY_TICK_PRICE_ATOMIC)) {
      removeParticipant(seat.id, 'out_of_funds');
      return;
    }

    const payload = streamMeterPayload(seat, PASSKEY_TICK_PRICE_ATOMIC, PASSKEY_TICK_SECONDS);
    payload.remaining = atomicToUsdc(seat.remainingAtomic);
    payload.spent = atomicToUsdc(seat.spentAtomic);
    broadcast({ type: 'meter_update', ...payload });

    if (seat.remainingAtomic < PASSKEY_TICK_PRICE_ATOMIC) {
      removeParticipant(seat.id, 'out_of_funds');
    }
  } catch (err) {
    console.warn(`[meter:passkey] seat ${seat.id}: pull failed — ${err.message}`);
    removeParticipant(seat.id, 'out_of_funds');
  } finally {
    seat._tickInFlight = false;
  }
}

function tickMeterGateway() {
  for (const seat of activeSeats.values()) {
    if (!seat.live) continue;
    if (seat.paymentMode === 'passkey_stream') continue;
    tickPrepaidSeat(seat);
  }
}

function tickMeterPasskey() {
  for (const seat of activeSeats.values()) {
    if (!seat.live) continue;
    if (seat.paymentMode !== 'passkey_stream') continue;
    tickPasskeyStreamSeat(seat).catch((e) =>
      console.error(`[meter:passkey] seat ${seat.id} unexpected:`, e)
    );
  }
}

const gatewayMeterInterval = setInterval(tickMeterGateway, TICK_SECONDS * 1000);
const passkeyMeterInterval = setInterval(tickMeterPasskey, PASSKEY_TICK_SECONDS * 1000);
if (typeof gatewayMeterInterval.unref === 'function') gatewayMeterInterval.unref();
if (typeof passkeyMeterInterval.unref === 'function') passkeyMeterInterval.unref();

// WebSocket connection
wss.on('connection', (ws) => {
  console.log('Client connected');

  // Send current state — only LIVE seats render on the overlay.
  ws.send(JSON.stringify({
    type: 'initial_state',
    seats: Array.from(activeSeats.values()).filter(s => s.live).map(s => ({
      id: s.id,
      username: s.username,
      viewUrl: s.viewUrl,
      expiresAt: s.expiresAt
    }))
  }));

  // Seat lifecycle messages from a joiner's page.
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'register_seat' && typeof msg.seatId === 'string') {
      // Bind this socket to the seat so a tab close instantly frees + refunds it,
      // even if the camera never went live.
      const seat = activeSeats.get(msg.seatId);
      if (seat) { ws.__seatId = msg.seatId; seat.ownerWs = ws; }
    } else if (msg.type === 'camera_ready' && typeof msg.seatId === 'string') {
      // Camera approved + publishing -> show the tile and start the meter.
      activateSeatLive(msg.seatId, ws);
    }
    // rewards_* messages are handled by the rewards.js connection listener.
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    // If this socket owned a seat, remove it the moment the viewer drops —
    // stops the meter and refunds the unused balance immediately.
    if (ws.__seatId && activeSeats.has(ws.__seatId)) {
      console.log(`[seat] ${ws.__seatId}: owner disconnected — removing + refunding`);
      removeParticipant(ws.__seatId, 'disconnected');
    }
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

function schedulePendingCameraTimeout(seatId) {
  setTimeout(() => {
    const s = activeSeats.get(seatId);
    if (s && !s.live) {
      console.log(`[seat] ${seatId}: camera not approved in time — releasing + refunding`);
      removeParticipant(seatId, 'camera_timeout');
    }
  }, PENDING_CAMERA_TIMEOUT_MS);
}

function passkeyJoinSuccessResponse(seat, verified) {
  const ticksLeft = PASSKEY_TICK_PRICE_ATOMIC > 0n
    ? Number(seat.remainingAtomic / PASSKEY_TICK_PRICE_ATOMIC)
    : 0;
  return {
    success: true,
    message: 'Seat assigned! Open this link to go live:',
    pushUrl: seat.pushUrl,
    seatId: seat.id,
    remaining: atomicToUsdc(seat.remainingAtomic),
    tickPrice: PASSKEY_TICK_PRICE,
    tickSeconds: PASSKEY_TICK_SECONDS,
    maxSession: MAX_SESSION,
    secondsLeft: ticksLeft * PASSKEY_TICK_SECONDS,
    paymentMode: 'passkey_stream',
    payment: {
      payer: verified.payer,
      transaction: verified.txHash,
      allowance: atomicToUsdc(verified.allowance),
      network: ARC_NETWORK,
      mode: 'passkey_stream',
      approach: PASSKEY_METER_APPROACH,
    }
  };
}

// Passkey/modular smart account join — NO Gateway x402 middleware or transfer lookup.
app.post('/api/join/passkey', async (req, res) => {
  try {
    const { username, address } = req.body;
    if (!username) {
      return res.status(400).json({ error: 'Username required' });
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) {
      return res.status(400).json({ error: 'Smart account address required' });
    }

    const modularPaymentHeader = req.headers['x-modular-payment'];

    // Step 1 — session terms (on-chain balance only; no Gateway 402).
    if (!modularPaymentHeader) {
      let bal;
      try {
        bal = await getOnChainUsdcBalance(address);
      } catch (err) {
        return res.status(502).json({ error: 'Balance lookup failed', message: err.message });
      }

      const sessionAtomic = bal.availableAtomic < MAX_SESSION_ATOMIC
        ? bal.availableAtomic
        : MAX_SESSION_ATOMIC;

      if (sessionAtomic < PASSKEY_TICK_PRICE_ATOMIC) {
        return res.status(402).json({
          error: 'Insufficient USDC balance',
          reason: 'insufficient_balance',
          available: bal.available,
          needAtLeast: PASSKEY_TICK_PRICE,
          hint: 'Fund your smart account from faucet.circle.com (Arc Testnet).',
          path: 'passkey'
        });
      }

      console.log(
        `[join:passkey] session terms for ${address}: `
        + `cap ${atomicToUsdc(sessionAtomic)} USDC, `
        + `${PASSKEY_TICK_PRICE} USDC / ${PASSKEY_TICK_SECONDS}s stream meter`
      );

      return res.json({
        needsApprove: true,
        sessionAmount: atomicToUsdc(sessionAtomic),
        sessionAmountAtomic: sessionAtomic.toString(),
        payTo: SELLER_WALLET_ADDRESS,
        tickPrice: PASSKEY_TICK_PRICE,
        tickSeconds: PASSKEY_TICK_SECONDS,
        maxSession: MAX_SESSION,
        meterApproach: PASSKEY_METER_APPROACH,
        path: 'passkey'
      });
    }

    // Step 2 — approve confirmed client-side; verify allowance and admit.
    let modPay;
    try {
      modPay = b64decodeJson(modularPaymentHeader);
    } catch {
      return res.status(400).json({ error: 'Malformed X-Modular-Payment header' });
    }

    const txHash = modPay.txHash;
    const payer = modPay.payer || address;
    let sessionAtomic;
    try {
      sessionAtomic = BigInt(modPay.amount || '0');
    } catch {
      sessionAtomic = 0n;
    }

    if (sessionAtomic <= 0n) {
      return res.status(400).json({ error: 'Modular payment has no session cap' });
    }
    if (sessionAtomic > MAX_SESSION_ATOMIC) {
      return res.status(400).json({
        error: 'Session cap exceeds max',
        reason: 'over_cap',
        maxSession: MAX_SESSION
      });
    }

    const verified = await verifyPasskeyStreamAllowance(payer, sessionAtomic, txHash);
    if (!verified.ok) {
      return res.status(402).json({
        error: 'Passkey allowance verification failed',
        reason: verified.reason,
        path: 'passkey'
      });
    }

    const result = addParticipant(username, {
      remainingAtomic: sessionAtomic,
      payer: verified.payer,
      viewerAddress: payer,
      depositTx: verified.txHash,
      paymentMode: 'passkey_stream',
      sessionCapAtomic: sessionAtomic,
    });

    if (!result.success) {
      return res.status(409).json({
        error: 'No seats available',
        reason: result.reason
      });
    }

    schedulePendingCameraTimeout(result.seat.id);
    console.log(`[join:passkey] admitted seat ${result.seat.id} for ${username} (${payer})`);
    return res.json(passkeyJoinSuccessResponse(result.seat, verified));
  } catch (error) {
    console.error('[join:passkey] error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Passkey join failed', message: error.message });
    }
  }
});

// MetaMask / Circle Gateway join — prepaid session via x402 (unchanged).
app.post('/api/join', async (req, res) => {
  try {
    const { username, address } = req.body;
    if (!username) {
      return res.status(400).json({ error: 'Username required' });
    }

    if (req.get('x-wallet-mode') === 'passkey' || req.headers['x-modular-payment']) {
      return res.status(400).json({
        error: 'Passkey wallets must use POST /api/join/passkey',
        redirect: '/api/join/passkey',
        path: 'gateway'
      });
    }

    const paymentHeader = req.headers['payment-signature'];

    let kind;
    try {
      kind = await getArcKind();
    } catch (err) {
      return res.status(503).json({ error: 'Gateway unavailable', message: err.message });
    }

    // Step 1 — no payment yet: read balance and emit 402 for the spendable session.
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
            : 'No finalized Gateway balance yet — your deposit may still be finalizing.',
          path: 'gateway'
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
      console.log(`[join:gateway] 402 session terms for ${address}: ${atomicToUsdc(sessionAtomic)} USDC cap`);
      return res.end(JSON.stringify({
        sessionAmount: atomicToUsdc(sessionAtomic),
        sessionAmountAtomic: sessionAtomic.toString(),
        payTo: SELLER_WALLET_ADDRESS,
        walletMode: 'metamask',
        tickPrice: TICK_PRICE,
        tickSeconds: TICK_SECONDS,
        meterApproach: 'gateway_prepaid',
        path: 'gateway'
      }));
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
      viewerAddress: (address && /^0x[0-9a-fA-F]{40}$/.test(address))
        ? address
        : (settle.payer || verify.payer || null),
      depositTx: settle.transaction || null
    });

    if (!result.success) {
      return res.status(409).json({
        error: 'No seats available',
        reason: result.reason
      });
    }

    const pendingSeatId = result.seat.id;
    schedulePendingCameraTimeout(pendingSeatId);
    console.log(`[join:gateway] admitted seat ${result.seat.id} for ${username}`);

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
║  Meter (MetaMask): ${TICK_PRICE} USDC / ${TICK_SECONDS}s
║  Meter (Passkey):  ${PASSKEY_TICK_PRICE} USDC / ${PASSKEY_TICK_SECONDS}s  [approach ${PASSKEY_METER_APPROACH}]
║  Session cap:      ${MAX_SESSION} USDC
║  Seller:  ${SELLER_WALLET_ADDRESS}
╚═══════════════════════════════════════════╝
  `);
});
