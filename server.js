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
import { getCredit, consumeCredit, creditViewer } from './reward-credits.js';
import {
  applyStreamTick,
  streamMeterPayload,
} from './passkey-meter.js';
import {
  resolveRoomConfig,
  normalizeRoomId,
  DEFAULT_ROOM_ID,
  migrateLegacyRoomPasswords,
  listRooms,
} from './rooms-store.js';
import { attachDashboardRoutes } from './dashboard-routes.js';
import {
  toAtomic,
  fromAtomic,
  readTokenBalance,
  readTokenAllowance,
  validatePaymentToken,
  estimateArcFeesWithFloor,
} from './token-utils.js';
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

function roomAtomics(roomCfg) {
  const gwDec = 6;
  const pkDec = roomCfg.paymentTokenDecimals;
  return {
    tickPriceAtomic: toAtomic(roomCfg.tickPrice, gwDec),
    gatewayMaxSessionAtomic: toAtomic(roomCfg.maxSession, gwDec),
    passkeyTickPriceAtomic: toAtomic(roomCfg.passkeyTickPrice, pkDec),
    maxSessionAtomic: toAtomic(roomCfg.maxSession, pkDec),
  };
}

function resolveRoomFromRequest(body, query) {
  const raw = (body && body.room != null) ? body.room : (query && query.room);
  const roomId = normalizeRoomId(raw);
  if (!roomId) return { error: 'invalid_room_id' };
  const cfg = resolveRoomConfig(roomId);
  if (!cfg) return { error: 'room_not_found', roomId };
  return { roomId, cfg, atomics: roomAtomics(cfg) };
}

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
// Arc rejects writes whose priority fee is under 1 gwei — see the Arc gas floor
// block in token-utils.js. EVERY seller-wallet write on Arc must spread
// arcFeesWithFloor() into its call — the refund transfer and the per-tick
// transferFrom both do.
const FEE_CACHE_MS = 30_000; // ticks fire every second — don't re-estimate each time

const arcFeeClient = createPublicClient({ chain: arcViemChain, transport: http(ARC_RPC_URL) });
let feeCache = { fees: null, at: 0 };

async function arcFeesWithFloor() {
  if (feeCache.fees && Date.now() - feeCache.at < FEE_CACHE_MS) return feeCache.fees;
  const fees = await estimateArcFeesWithFloor(arcFeeClient);
  feeCache = { fees, at: Date.now() };
  return fees;
}

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
  if (
    seat.paymentMode === 'passkey_stream'
    || seat.paymentMode === 'credit_stream'
    || seat.paymentMode === 'points_stream'
  ) {
    seat.refunded = true;
    if (seat.remainingAtomic > 0n) {
      if (seat.paymentMode === 'passkey_stream') {
        console.log(
          `[refund] stream seat ${seat.id}: ${atomicToUsdc(seat.remainingAtomic)} USDC was never pulled — remains in viewer wallet`
        );
      } else {
        const dec = seat.paymentTokenDecimals ?? 6;
        const sym = seat.paymentTokenSymbol || 'CREDIT';
        creditViewer(seat.streamRoomId, seat.viewerAddress, seat.remainingAtomic, {
          type: seat.paymentMode === 'points_stream' ? 'points' : 'usdc',
          symbol: sym,
          decimals: dec,
        });
        console.log(
          `[refund] credit seat ${seat.id}: returned ${fromAtomic(seat.remainingAtomic, dec)} ${sym} to earned balance`
        );
      }
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

  const transfer = async () => sellerWalletClient.writeContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to, refundAtomic],
    ...(await arcFeesWithFloor())
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
async function verifyPasskeyStreamAllowance(payer, sessionAtomic, txHash, tokenAddress) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(payer || '')) {
    return { ok: false, reason: 'invalid_payer' };
  }

  const readAllowance = async () => readTokenAllowance(
    tokenAddress, payer, SELLER_WALLET_ADDRESS, ARC_RPC_URL, ARC_CHAIN_ID
  );

  let allowance;
  try {
    allowance = await readAllowance();
  } catch (err) {
    return { ok: false, reason: 'allowance_read_failed', message: err.message };
  }

  if (allowance < sessionAtomic && txHash) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      allowance = await readAllowance();
    } catch { /* keep prior */ }
  }

  if (allowance < sessionAtomic) {
    console.warn(
      `[join:passkey] insufficient allowance for token ${tokenAddress}: `
      + `${allowance} < ${sessionAtomic} for ${payer}`
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
    } catch { /* allowance is authoritative */ }
  }

  console.log(
    `[join:passkey] verified allowance ${allowance} (atomic) on ${tokenAddress} for ${payer}`
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
// noServer + manual upgrade routing so the Next.js dev/HMR websocket
// (/_next/*) can coexist on the same port. App clients connect to the root
// path (ws://host/) exactly as before — connection/message logic unchanged.
const wss = new WebSocketServer({ noServer: true });

app.use(express.json());
// Passkeys + localStorage require localhost (Circle Console domain). Redirect
// 127.0.0.1 so Chrome bookmarks don't land on a separate broken origin.
app.use((req, res, next) => {
  if (req.hostname === '127.0.0.1') {
    const port = Number(process.env.PORT || 3000);
    return res.redirect(301, `http://localhost:${port}${req.originalUrl}`);
  }
  next();
});
// Never cache the frontend during development — guarantees the browser always
// runs the latest index.html / overlay.html / rewards.js (no stale-bundle bugs).
// Next.js assets (/_next/*) manage their own caching (immutable hashed chunks).
app.use((req, res, next) => {
  if (!req.path.startsWith('/_next/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
  next();
});

// Browsers require text/javascript for ES modules (.js / .mjs). Express's default
// MIME lookup can mislabel .mjs on some platforms, which breaks dynamic import().
function staticJsHeaders(res, filePath) {
  if (filePath.endsWith('.mjs') || filePath.endsWith('.js')) {
    res.setHeader('Content-Type', 'text/javascript; charset=UTF-8');
  }
}

// index: false — the app root (/) is owned by the Next.js frontend below; the
// legacy viewer page stays reachable at /index.html as a fallback.
app.use(express.static('public', {
  index: false,
  etag: false,
  lastModified: false,
  setHeaders: staticJsHeaders,
}));

// Expose the Arc / Gateway config the frontend needs to build payments.
app.get('/api/config', (req, res) => {
  const resolved = resolveRoomFromRequest(null, req.query);
  if (resolved.error === 'invalid_room_id') {
    return res.status(400).json({ error: 'Invalid room id' });
  }
  if (resolved.error === 'room_not_found') {
    return res.status(404).json({ error: 'Room not found', roomId: resolved.roomId });
  }
  const { roomId, cfg } = resolved;
  const modularWallets = (CIRCLE_CLIENT_KEY && CIRCLE_CLIENT_URL)
    ? {
        clientKey: CIRCLE_CLIENT_KEY,
        clientUrl: CIRCLE_CLIENT_URL,
        chainPath: CIRCLE_MODULAR_CHAIN_PATH
      }
    : null;
  res.json({
    roomId,
    roomName: cfg.name,
    roomActive: cfg.active,
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
    tickSeconds: cfg.tickSeconds,
    tickPrice: cfg.tickPrice,
    maxSession: cfg.maxSession,
    maxSeats: cfg.maxSeats,
    passkeyTickSeconds: cfg.passkeyTickSeconds,
    passkeyTickPrice: cfg.passkeyTickPrice,
    passkeyMeterApproach: PASSKEY_METER_APPROACH,
    paymentTokenAddress: cfg.paymentTokenAddress,
    paymentTokenSymbol: cfg.paymentTokenSymbol,
    paymentTokenDecimals: cfg.paymentTokenDecimals,
    gatewayTokenSymbol: 'USDC',
    gatewayNote: 'MetaMask/Gateway path always uses USDC on Arc',
    rewards: cfg.rewards,
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
  const resolved = resolveRoomFromRequest(null, req.query);
  if (resolved.error) {
    return res.status(resolved.error === 'room_not_found' ? 404 : 400).json({
      error: resolved.error === 'room_not_found' ? 'Room not found' : 'Invalid room id',
      roomId: resolved.roomId
    });
  }
  const { cfg, atomics } = resolved;
  const passkeyMode = req.get('x-wallet-mode') === 'passkey'
    || req.query.mode === 'passkey';
  const minTick = passkeyMode ? atomics.passkeyTickPriceAtomic : atomics.tickPriceAtomic;
  try {
    const bal = passkeyMode
      ? await getOnChainUsdcBalance(address)
      : await getGatewayBalance(address);
    const spendableAtomic = bal.availableAtomic < atomics.maxSessionAtomic
      ? bal.availableAtomic
      : atomics.maxSessionAtomic;
    return res.json({
      address,
      roomId: cfg.id,
      available: bal.available,
      pending: bal.pending,
      hasRecord: bal.hasRecord,
      spendable: atomicToUsdc(spendableAtomic),
      maxSession: cfg.maxSession,
      canJoin: spendableAtomic >= minTick && cfg.active,
      roomActive: cfg.active,
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

// Generate VDO.Ninja room
function generateVDORoom(username) {
  const roomId = randomUUID().slice(0, 8); // Short stream id (not dashboard room)

  return {
    roomId,
    pushUrl: `https://vdo.ninja/?push=${roomId}&label=${encodeURIComponent(username)}`,
    viewUrl: `https://vdo.ninja/?view=${roomId}&scene`
  };
}

function broadcastToRoom(streamRoomId, message) {
  const target = streamRoomId || DEFAULT_ROOM_ID;
  wss.clients.forEach((client) => {
    if (client.readyState !== 1) return;
    const sub = client.__streamRoomId || DEFAULT_ROOM_ID;
    if (sub !== target) return;
    client.send(JSON.stringify(message));
  });
}

function broadcastMeterUpdate(seat, payload) {
  const msg = { type: 'meter_update', ...payload };
  if (seat.ownerWs && seat.ownerWs.readyState === 1) {
    seat.ownerWs.send(JSON.stringify(msg));
  }
  broadcastToRoom(seat.streamRoomId, msg);
}

function sendInitialState(ws) {
  const roomId = ws.__streamRoomId || DEFAULT_ROOM_ID;
  ws.send(JSON.stringify({
    type: 'initial_state',
    room: roomId,
    seats: Array.from(activeSeats.values()).filter((s) => s.live && s.streamRoomId === roomId).map((s) => ({
      id: s.id,
      username: s.username,
      viewUrl: s.viewUrl,
      expiresAt: s.expiresAt,
      flyIn: s.flyIn,
      flyOut: s.flyOut,
      pinned: !!s.pinned
    }))
  }));
}

// Legacy alias — prefer broadcastToRoom for seat events.
function broadcast(message) {
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(JSON.stringify(message));
  });
}

// Overlay stinger choices travel with the seat (cosmetic only — the overlay
// picks the entrance/exit animation from these). Unknown values become null,
// which the overlay renders with its default animations.
const FLY_IN_STINGERS = new Set(['storm', 'proroll', 'callme', 'breaking', 'wildin']);
const FLY_OUT_STINGERS = new Set(['crt', 'crumble', 'zapped', 'wildout']);
const sanitizeStinger = (v, allowed) =>
  (typeof v === 'string' && allowed.has(v)) ? v : null;

// Add participant (Pass B: metered, no fixed timer).
// `meta` carries the prepaid session balance signed by the viewer.
function addParticipant(username, meta = {}) {
  const streamRoomId = meta.streamRoomId || DEFAULT_ROOM_ID;
  const roomCfg = resolveRoomConfig(streamRoomId);
  if (!roomCfg) {
    return { success: false, reason: 'room_not_found' };
  }
  if (!roomCfg.active) {
    return { success: false, reason: 'room_stopped' };
  }

  // Pinned co-host seats ride for free ON TOP of the paid seats — they don't
  // consume a slot, so a full room + pinned guest still admits maxSeats payers.
  const roomSeatCount = [...activeSeats.values()]
    .filter((s) => s.streamRoomId === streamRoomId && !s.pinned).length;
  if (roomSeatCount >= roomCfg.maxSeats) {
    return { success: false, reason: 'no_seats_available' };
  }

  const atomics = roomAtomics(roomCfg);
  const seatId = randomUUID();
  const vdoRoom = generateVDORoom(username);
  const now = Date.now();
  const remainingAtomic = meta.remainingAtomic ?? atomics.maxSessionAtomic;

  const seat = {
    id: seatId,
    username,
    streamRoomId,
    roomId: vdoRoom.roomId,
    pushUrl: vdoRoom.pushUrl,
    viewUrl: vdoRoom.viewUrl,
    joinedAt: now,
    live: false,
    liveAt: null,
    expiresAt: 0,
    spentAtomic: 0n,
    remainingAtomic,
    payer: meta.payer || null,
    viewerAddress: meta.viewerAddress || meta.payer || null,
    depositTx: meta.depositTx || null,
    refunded: false,
    ownerWs: null,
    paymentMode: meta.paymentMode || 'gateway',
    sessionCapAtomic: meta.sessionCapAtomic ?? remainingAtomic,
    gatewayTickSeconds: roomCfg.tickSeconds,
    gatewayTickPriceAtomic: atomics.tickPriceAtomic,
    passkeyTickSeconds: roomCfg.passkeyTickSeconds,
    passkeyTickPriceAtomic: atomics.passkeyTickPriceAtomic,
    maxSessionAtomic: atomics.maxSessionAtomic,
    paymentTokenAddress: roomCfg.paymentTokenAddress,
    paymentTokenSymbol: meta.paymentTokenSymbol ?? roomCfg.paymentTokenSymbol,
    paymentTokenDecimals: meta.paymentTokenDecimals ?? roomCfg.paymentTokenDecimals,
    lastMeterAt: 0,
    _tickInFlight: false,
    flyIn: sanitizeStinger(meta.flyIn, FLY_IN_STINGERS),
    flyOut: sanitizeStinger(meta.flyOut, FLY_OUT_STINGERS),
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
    ? seat.passkeyTickPriceAtomic
    : seat.gatewayTickPriceAtomic;
  const tickSec = seat.paymentMode === 'passkey_stream'
    ? seat.passkeyTickSeconds
    : seat.gatewayTickSeconds;
  const ticksLeft = tickPrice > 0n
    ? Number(seat.remainingAtomic / tickPrice)
    : 0;
  seat.expiresAt = Date.now() + ticksLeft * tickSec * 1000;

  broadcastToRoom(seat.streamRoomId, {
    type: 'seat_added',
    seat: {
      id: seat.id,
      username: seat.username,
      viewUrl: seat.viewUrl,
      expiresAt: seat.expiresAt,
      flyIn: seat.flyIn,
      flyOut: seat.flyOut
    }
  });
  const modeLabel = seat.paymentMode === 'passkey_stream' ? 'stream meter' : 'prepaid meter';
  console.log(
    `[seat] ${seat.id} (room ${seat.streamRoomId}): camera live — ${modeLabel} `
    + `(${atomicToUsdc(seat.remainingAtomic)} USDC cap)`
  );
  return true;
}

// Pin/unpin a seat as co-host (dashboard action, room-password gated).
// Pinned = free seat: the meter loop skips it entirely (no pulls, no local
// deduction), it doesn't count toward maxSeats for new joins, and the overlay
// shows a CO-HOST badge. Unpin resumes normal metering from now (no catch-up
// charge for the pinned time).
function setSeatPinned(seatId, pinned) {
  const seat = activeSeats.get(seatId);
  if (!seat) return null;
  seat.pinned = !!pinned;
  if (!seat.pinned) seat.lastMeterAt = Date.now(); // no instant tick on unpin
  broadcastToRoom(seat.streamRoomId, {
    type: 'seat_pinned',
    seatId: seat.id,
    pinned: seat.pinned,
  });
  console.log(`[seat] ${seat.id}: ${seat.pinned ? 'PINNED (co-host, meter paused)' : 'unpinned (meter resumed)'}`);
  return seat;
}

// Remove participant. Frees the seat immediately and (if any prepaid balance is
// unused) refunds it back to the viewer — without blocking the removal.
function removeParticipant(seatId, reason = 'left') {
  const seat = activeSeats.get(seatId);
  if (!seat) return { success: false };

  activeSeats.delete(seatId);

  broadcastToRoom(seat.streamRoomId, {
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
  const tickPrice = seat.gatewayTickPriceAtomic ?? TICK_PRICE_ATOMIC;
  const tickSec = seat.gatewayTickSeconds ?? TICK_SECONDS;
  if (seat.remainingAtomic < tickPrice) {
    removeParticipant(seat.id, 'out_of_funds');
    return;
  }

  seat.remainingAtomic -= tickPrice;
  seat.spentAtomic += tickPrice;

  const ticksLeft = tickPrice > 0n ? Number(seat.remainingAtomic / tickPrice) : 0;
  const secondsLeft = ticksLeft * tickSec;

  broadcastMeterUpdate(seat, {
    seatId: seat.id,
    remaining: atomicToUsdc(seat.remainingAtomic),
    spent: atomicToUsdc(seat.spentAtomic),
    secondsLeft,
    minutesLeft: Math.floor(secondsLeft / 60),
    mode: 'gateway'
  });

  if (seat.remainingAtomic < tickPrice) {
    removeParticipant(seat.id, 'out_of_funds');
  }
}

// ─── Phase 2 passkey stream meter: on-chain transferFrom each tick ─────────
async function tickPasskeyStreamSeat(seat) {
  if (seat._tickInFlight) return;
  const tickPrice = seat.passkeyTickPriceAtomic ?? PASSKEY_TICK_PRICE_ATOMIC;
  const tickSec = seat.passkeyTickSeconds ?? PASSKEY_TICK_SECONDS;
  const tokenAddress = seat.paymentTokenAddress || USDC_ADDRESS;
  const tokenDec = seat.paymentTokenDecimals ?? 6;
  const tokenSym = seat.paymentTokenSymbol || 'USDC';
  const localCredit = seat.paymentMode === 'credit_stream' || seat.paymentMode === 'points_stream';
  if (seat.remainingAtomic < tickPrice) {
    removeParticipant(seat.id, 'out_of_funds');
    return;
  }

  seat._tickInFlight = true;
  try {
    if (localCredit) {
      console.log(
        `[meter:credit] seat ${seat.id}: tick ${fromAtomic(tickPrice, tokenDec)} ${tokenSym}`
      );
    } else if (sellerWalletClient) {
      const tx = await sellerWalletClient.writeContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'transferFrom',
        args: [seat.viewerAddress, SELLER_WALLET_ADDRESS, tickPrice],
        ...(await arcFeesWithFloor())
      });
      console.log(
        `[meter:passkey] seat ${seat.id}: pulled ${fromAtomic(tickPrice, tokenDec)} ${tokenSym} (tx ${tx})`
      );
    } else {
      console.log(
        `[meter:passkey] seat ${seat.id}: DRY pull ${fromAtomic(tickPrice, tokenDec)} ${tokenSym}`
      );
    }

    if (!applyStreamTick(seat, tickPrice)) {
      removeParticipant(seat.id, 'out_of_funds');
      return;
    }

    const payload = streamMeterPayload(seat, tickPrice, tickSec, tokenDec);
    payload.remaining = fromAtomic(seat.remainingAtomic, tokenDec);
    payload.spent = fromAtomic(seat.spentAtomic, tokenDec);
    payload.tokenSymbol = tokenSym;
    broadcastMeterUpdate(seat, payload);

    if (seat.remainingAtomic < tickPrice) {
      removeParticipant(seat.id, 'out_of_funds');
    }
  } catch (err) {
    console.warn(`[meter:passkey] seat ${seat.id}: pull failed — ${err.message}`);
    removeParticipant(seat.id, 'out_of_funds');
  } finally {
    seat._tickInFlight = false;
  }
}

function tickAllMeters() {
  const now = Date.now();
  for (const seat of activeSeats.values()) {
    if (!seat.live) continue;
    if (seat.pinned) continue; // co-host seat: meter fully paused, zero charges
    if (
      seat.paymentMode === 'passkey_stream'
      || seat.paymentMode === 'credit_stream'
      || seat.paymentMode === 'points_stream'
    ) {
      const interval = (seat.passkeyTickSeconds ?? PASSKEY_TICK_SECONDS) * 1000;
      if (now - (seat.lastMeterAt || 0) < interval) continue;
      tickPasskeyStreamSeat(seat)
        .then(() => { seat.lastMeterAt = now; })
        .catch((e) => console.error(`[meter:passkey] seat ${seat.id} unexpected:`, e));
    } else {
      const interval = (seat.gatewayTickSeconds ?? TICK_SECONDS) * 1000;
      if (now - (seat.lastMeterAt || 0) < interval) continue;
      tickPrepaidSeat(seat);
      seat.lastMeterAt = now;
    }
  }
}

const meterInterval = setInterval(tickAllMeters, 1000);
if (typeof meterInterval.unref === 'function') meterInterval.unref();

// WebSocket connection
wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.__streamRoomId = DEFAULT_ROOM_ID;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'subscribe_room' && typeof msg.room === 'string') {
      const roomId = normalizeRoomId(msg.room);
      if (roomId && resolveRoomConfig(roomId)) {
        ws.__streamRoomId = roomId;
        sendInitialState(ws);
      }
      return;
    }

    if (msg.type === 'register_seat' && typeof msg.seatId === 'string') {
      const seat = activeSeats.get(msg.seatId);
      if (seat) { ws.__seatId = msg.seatId; seat.ownerWs = ws; }
    } else if (msg.type === 'camera_ready' && typeof msg.seatId === 'string') {
      activateSeatLive(msg.seatId, ws);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    if (ws.__seatId && activeSeats.has(ws.__seatId)) {
      console.log(`[seat] ${ws.__seatId}: owner disconnected — removing + refunding`);
      removeParticipant(ws.__seatId, 'disconnected');
    }
  });
});

// ─── Pass C: watch-to-earn (isolated; never breaks Pass A / B) ───────────────
try {
  attachRewards(wss, {
    getRoomConfig: resolveRoomConfig,
    poolPrivateKey: process.env.REWARD_POOL_PRIVATE_KEY || null,
    rpcUrl: ARC_RPC_URL,
  });
} catch (err) {
  console.warn('[rewards] failed to attach, continuing without watch-to-earn:', err.message);
}

// Routes

// Root is served by the Next.js frontend (fallthrough handler below). Old
// viewer links of the form /?room=<id> redirect to the new join page; the
// legacy Express viewer page itself remains available at /index.html?room=<id>.
app.get('/', (req, res, next) => {
  if (req.query.room) {
    return res.redirect(`/join?room=${encodeURIComponent(String(req.query.room))}`);
  }
  next();
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

function passkeyJoinSuccessResponse(seat, verified, roomCfg) {
  const tickPrice = roomCfg.passkeyTickPrice;
  const tickSec = roomCfg.passkeyTickSeconds;
  const dec = seat.paymentTokenDecimals ?? roomCfg.paymentTokenDecimals;
  const sym = seat.paymentTokenSymbol ?? roomCfg.paymentTokenSymbol;
  const priceAtomic = seat.passkeyTickPriceAtomic;
  const ticksLeft = priceAtomic > 0n ? Number(seat.remainingAtomic / priceAtomic) : 0;
  const mode = seat.paymentMode || 'passkey_stream';
  const payment = (mode === 'credit_stream' || mode === 'points_stream')
    ? {
        payer: verified.payer,
        transaction: null,
        allowance: fromAtomic(verified.allowance, dec),
        tokenSymbol: sym,
        network: ARC_NETWORK,
        mode,
        source: 'earned_balance',
      }
    : {
        payer: verified.payer,
        transaction: verified.txHash,
        allowance: fromAtomic(verified.allowance, dec),
        tokenSymbol: sym,
        network: ARC_NETWORK,
        mode: 'passkey_stream',
        approach: PASSKEY_METER_APPROACH,
      };
  return {
    success: true,
    message: 'Seat assigned! Open this link to go live:',
    pushUrl: seat.pushUrl,
    seatId: seat.id,
    roomId: roomCfg.id,
    remaining: fromAtomic(seat.remainingAtomic, dec),
    tickPrice,
    tickSeconds: tickSec,
    maxSession: roomCfg.maxSession,
    secondsLeft: ticksLeft * tickSec,
    paymentMode: mode,
    paymentTokenSymbol: sym,
    payment,
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

    const resolved = resolveRoomFromRequest(req.body, req.query);
    if (resolved.error === 'invalid_room_id') {
      return res.status(400).json({ error: 'Invalid room id' });
    }
    if (resolved.error === 'room_not_found') {
      return res.status(404).json({ error: 'Room not found', roomId: resolved.roomId });
    }
    const { roomId, cfg, atomics } = resolved;
    const rw = cfg.rewards;
    const modularPaymentHeader = req.headers['x-modular-payment'];
    const useRewardCredit = req.body.useRewardCredit === true;

    if (useRewardCredit && !modularPaymentHeader) {
      if (!cfg.active) {
        return res.status(403).json({ error: 'Room is not accepting joins', reason: 'room_stopped', roomId });
      }
      if (!rw?.enabled) {
        return res.status(400).json({ error: 'Rewards not enabled for this room', roomId });
      }

      const credit = getCredit(roomId, address);
      let sessionAtomic;
      let paymentMode = 'credit_stream';
      let tokenDec = cfg.paymentTokenDecimals;
      let tokenSym = cfg.paymentTokenSymbol;

      if (rw.rewardType === 'points') {
        const tickAtomic = toAtomic(cfg.passkeyTickPrice, 0);
        const maxAtomic = toAtomic(cfg.maxSession, 0);
        sessionAtomic = credit.atomic < maxAtomic ? credit.atomic : maxAtomic;
        if (sessionAtomic < tickAtomic) {
          return res.status(402).json({
            error: 'Not enough earned points to join',
            reason: 'insufficient_rewards',
            available: fromAtomic(credit.atomic, 0),
            needAtLeast: cfg.passkeyTickPrice,
            tokenSymbol: 'PTS',
            path: 'passkey',
            roomId,
          });
        }
        paymentMode = 'points_stream';
        tokenDec = 0;
        tokenSym = 'PTS';
      } else {
        sessionAtomic = credit.atomic < atomics.maxSessionAtomic
          ? credit.atomic
          : atomics.maxSessionAtomic;
        if (sessionAtomic < atomics.passkeyTickPriceAtomic) {
          return res.status(402).json({
            error: 'Not enough earned balance to join',
            reason: 'insufficient_rewards',
            available: fromAtomic(credit.atomic, cfg.paymentTokenDecimals),
            needAtLeast: cfg.passkeyTickPrice,
            tokenSymbol: cfg.paymentTokenSymbol,
            path: 'passkey',
            roomId,
          });
        }
      }

      const used = consumeCredit(roomId, address, sessionAtomic);
      if (used < sessionAtomic) {
        return res.status(402).json({
          error: 'Earned balance changed — try again',
          reason: 'insufficient_rewards',
          roomId,
        });
      }

      const result = addParticipant(username, {
        remainingAtomic: sessionAtomic,
        payer: address,
        viewerAddress: address,
        paymentMode,
        sessionCapAtomic: sessionAtomic,
        streamRoomId: roomId,
        paymentTokenDecimals: tokenDec,
        paymentTokenSymbol: tokenSym,
        flyIn: req.body.flyIn,
        flyOut: req.body.flyOut,
      });

      if (!result.success) {
        creditViewer(roomId, address, used, {
          type: rw.rewardType === 'points' ? 'points' : rw.rewardType,
          symbol: tokenSym,
          decimals: tokenDec,
        });
        const status = result.reason === 'room_stopped' ? 403 : 409;
        return res.status(status).json({
          error: result.reason === 'room_stopped' ? 'Room is not accepting joins' : 'No seats available',
          reason: result.reason,
          roomId,
        });
      }

      schedulePendingCameraTimeout(result.seat.id);
      console.log(`[join:passkey] room ${roomId} credit join seat ${result.seat.id} for ${username} (${address})`);
      return res.json(passkeyJoinSuccessResponse(result.seat, {
        payer: address,
        txHash: null,
        allowance: sessionAtomic,
      }, cfg));
    }

    if (!modularPaymentHeader) {
      if (!cfg.active) {
        return res.status(403).json({
          error: 'Room is not accepting joins',
          reason: 'room_stopped',
          roomId
        });
      }

      let rawBal;
      try {
        rawBal = await readTokenBalance(
          cfg.paymentTokenAddress, address, ARC_RPC_URL, ARC_CHAIN_ID
        );
      } catch (err) {
        return res.status(502).json({ error: 'Balance lookup failed', message: err.message });
      }

      const credit = getCredit(roomId, address);
      const sym = cfg.paymentTokenSymbol;

      if (rw?.enabled && rw.rewardType === 'points' && credit.atomic >= toAtomic(cfg.passkeyTickPrice, 0)) {
        const maxPts = toAtomic(cfg.maxSession, 0);
        const sessionPts = credit.atomic < maxPts ? credit.atomic : maxPts;
        return res.json({
          needsApprove: false,
          useRewardCredit: true,
          rewardType: 'points',
          roomId,
          sessionAmount: fromAtomic(sessionPts, 0),
          sessionAmountAtomic: sessionPts.toString(),
          tickPrice: cfg.passkeyTickPrice,
          tickSeconds: cfg.passkeyTickSeconds,
          maxSession: cfg.maxSession,
          paymentTokenSymbol: 'PTS',
          paymentTokenDecimals: 0,
          path: 'passkey',
          hint: 'Join with earned points — no wallet approve needed.',
        });
      }

      let totalAvailable = rawBal;
      if (rw?.enabled && credit.atomic > 0n && rw.rewardType !== 'points') {
        totalAvailable = rawBal + credit.atomic;
      }

      const sessionAtomic = totalAvailable < atomics.maxSessionAtomic
        ? totalAvailable
        : atomics.maxSessionAtomic;

      if (sessionAtomic < atomics.passkeyTickPriceAtomic) {
        return res.status(402).json({
          error: `Insufficient ${sym} balance`,
          reason: 'insufficient_balance',
          available: fromAtomic(rawBal, cfg.paymentTokenDecimals),
          rewardBalance: rw?.enabled ? fromAtomic(credit.atomic, cfg.paymentTokenDecimals) : undefined,
          needAtLeast: cfg.passkeyTickPrice,
          tokenSymbol: sym,
          hint: 'Fund your smart account on Arc Testnet.',
          path: 'passkey',
          roomId
        });
      }

      if (
        rw?.enabled
        && rw.rewardType !== 'points'
        && rawBal < atomics.passkeyTickPriceAtomic
        && credit.atomic >= atomics.passkeyTickPriceAtomic
      ) {
        const creditSession = credit.atomic < atomics.maxSessionAtomic
          ? credit.atomic
          : atomics.maxSessionAtomic;
        return res.json({
          needsApprove: false,
          useRewardCredit: true,
          rewardType: rw.rewardType,
          roomId,
          sessionAmount: fromAtomic(creditSession, cfg.paymentTokenDecimals),
          sessionAmountAtomic: creditSession.toString(),
          tickPrice: cfg.passkeyTickPrice,
          tickSeconds: cfg.passkeyTickSeconds,
          maxSession: cfg.maxSession,
          paymentTokenAddress: cfg.paymentTokenAddress,
          paymentTokenSymbol: sym,
          paymentTokenDecimals: cfg.paymentTokenDecimals,
          path: 'passkey',
          hint: 'Join with earned balance — no wallet approve needed.',
        });
      }

      const onChainSession = rawBal < atomics.maxSessionAtomic
        ? rawBal
        : atomics.maxSessionAtomic;

      console.log(
        `[join:passkey] room ${roomId} session terms for ${address}: `
        + `cap ${fromAtomic(onChainSession, cfg.paymentTokenDecimals)} ${sym}, `
        + `${cfg.passkeyTickPrice} ${sym} / ${cfg.passkeyTickSeconds}s stream meter`
      );

      return res.json({
        needsApprove: true,
        roomId,
        sessionAmount: fromAtomic(onChainSession, cfg.paymentTokenDecimals),
        sessionAmountAtomic: onChainSession.toString(),
        payTo: SELLER_WALLET_ADDRESS,
        paymentTokenAddress: cfg.paymentTokenAddress,
        paymentTokenSymbol: sym,
        paymentTokenDecimals: cfg.paymentTokenDecimals,
        tickPrice: cfg.passkeyTickPrice,
        tickSeconds: cfg.passkeyTickSeconds,
        maxSession: cfg.maxSession,
        meterApproach: PASSKEY_METER_APPROACH,
        path: 'passkey'
      });
    }

    if (!cfg.active) {
      return res.status(403).json({ error: 'Room is not accepting joins', reason: 'room_stopped', roomId });
    }

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
    if (sessionAtomic > atomics.maxSessionAtomic) {
      return res.status(400).json({
        error: 'Session cap exceeds max',
        reason: 'over_cap',
        maxSession: cfg.maxSession
      });
    }

    const verified = await verifyPasskeyStreamAllowance(
      payer, sessionAtomic, txHash, cfg.paymentTokenAddress
    );
    if (!verified.ok) {
      return res.status(402).json({
        error: 'Passkey allowance verification failed',
        reason: verified.reason,
        path: 'passkey',
        roomId
      });
    }

    const result = addParticipant(username, {
      remainingAtomic: sessionAtomic,
      payer: verified.payer,
      viewerAddress: payer,
      depositTx: verified.txHash,
      paymentMode: 'passkey_stream',
      sessionCapAtomic: sessionAtomic,
      streamRoomId: roomId,
      flyIn: req.body.flyIn,
      flyOut: req.body.flyOut,
    });

    if (!result.success) {
      const status = result.reason === 'room_stopped' ? 403 : 409;
      return res.status(status).json({
        error: result.reason === 'room_stopped' ? 'Room is not accepting joins' : 'No seats available',
        reason: result.reason,
        roomId
      });
    }

    schedulePendingCameraTimeout(result.seat.id);
    console.log(`[join:passkey] room ${roomId} admitted seat ${result.seat.id} for ${username} (${payer})`);
    return res.json(passkeyJoinSuccessResponse(result.seat, verified, cfg));
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

    const resolved = resolveRoomFromRequest(req.body, req.query);
    if (resolved.error === 'invalid_room_id') {
      return res.status(400).json({ error: 'Invalid room id' });
    }
    if (resolved.error === 'room_not_found') {
      return res.status(404).json({ error: 'Room not found', roomId: resolved.roomId });
    }
    const { roomId, cfg, atomics } = resolved;

    const paymentHeader = req.headers['payment-signature'];

    let kind;
    try {
      kind = await getArcKind();
    } catch (err) {
      return res.status(503).json({ error: 'Gateway unavailable', message: err.message });
    }

    if (!paymentHeader) {
      if (!cfg.active) {
        return res.status(403).json({
          error: 'Room is not accepting joins',
          reason: 'room_stopped',
          roomId
        });
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) {
        return res.status(400).json({ error: 'Wallet address required to price the session' });
      }

      let bal;
      try {
        bal = await getGatewayBalance(address);
      } catch (err) {
        return res.status(502).json({ error: 'Balance lookup failed', message: err.message });
      }

      const sessionAtomic = bal.availableAtomic < atomics.gatewayMaxSessionAtomic
        ? bal.availableAtomic
        : atomics.gatewayMaxSessionAtomic;

      if (sessionAtomic < atomics.tickPriceAtomic) {
        return res.status(402).json({
          error: 'Insufficient Gateway balance',
          reason: 'insufficient_balance',
          available: bal.available,
          pending: bal.pending,
          needAtLeast: cfg.tickPrice,
          hint: bal.hasRecord
            ? 'Deposit more USDC into the Gateway to watch.'
            : 'No finalized Gateway balance yet — your deposit may still be finalizing.',
          path: 'gateway',
          roomId
        });
      }

      const requirements = buildRequirements(kind, sessionAtomic);
      const paymentRequired = {
        x402Version: 2,
        resource: {
          url: '/api/join',
          description: `Co-stream seat — prepaid ${atomicToUsdc(sessionAtomic)} USDC, metered ${cfg.tickPrice} USDC / ${cfg.tickSeconds}s`,
          mimeType: 'application/json'
        },
        accepts: [requirements]
      };
      res.statusCode = 402;
      res.setHeader('PAYMENT-REQUIRED', b64encodeJson(paymentRequired));
      res.setHeader('Content-Type', 'application/json');
      console.log(`[join:gateway] room ${roomId} 402 session terms for ${address}: ${atomicToUsdc(sessionAtomic)} USDC cap`);
      return res.end(JSON.stringify({
        sessionAmount: atomicToUsdc(sessionAtomic),
        sessionAmountAtomic: sessionAtomic.toString(),
        payTo: SELLER_WALLET_ADDRESS,
        roomId,
        walletMode: 'metamask',
        tickPrice: cfg.tickPrice,
        tickSeconds: cfg.tickSeconds,
        maxSession: cfg.maxSession,
        meterApproach: 'gateway_prepaid',
        path: 'gateway'
      }));
    }

    if (!cfg.active) {
      return res.status(403).json({ error: 'Room is not accepting joins', reason: 'room_stopped', roomId });
    }

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
    if (sessionAtomic > atomics.maxSessionAtomic) {
      return res.status(400).json({
        error: 'Authorization exceeds session cap',
        reason: 'over_cap',
        maxSession: cfg.maxSession
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
      depositTx: settle.transaction || null,
      streamRoomId: roomId,
      flyIn: req.body.flyIn,
      flyOut: req.body.flyOut,
    });

    if (!result.success) {
      const status = result.reason === 'room_stopped' ? 403 : 409;
      return res.status(status).json({
        error: result.reason === 'room_stopped' ? 'Room is not accepting joins' : 'No seats available',
        reason: result.reason,
        roomId
      });
    }

    schedulePendingCameraTimeout(result.seat.id);
    console.log(`[join:gateway] room ${roomId} admitted seat ${result.seat.id} for ${username}`);

    const tickPrice = result.seat.gatewayTickPriceAtomic;
    const tickSec = result.seat.gatewayTickSeconds;
    const ticksLeft = tickPrice > 0n ? Number(result.seat.remainingAtomic / tickPrice) : 0;

    return res.json({
      success: true,
      message: 'Seat assigned! Open this link to go live:',
      pushUrl: result.seat.pushUrl,
      seatId: result.seat.id,
      roomId,
      remaining: atomicToUsdc(result.seat.remainingAtomic),
      tickPrice: cfg.tickPrice,
      tickSeconds: cfg.tickSeconds,
      maxSession: cfg.maxSession,
      secondsLeft: ticksLeft * tickSec,
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
  const resolved = resolveRoomFromRequest(null, req.query);
  const roomId = resolved.error ? DEFAULT_ROOM_ID : resolved.roomId;
  const seats = Array.from(activeSeats.values())
    .filter((s) => s.streamRoomId === roomId)
    .map((s) => ({
      id: s.id,
      username: s.username,
      expiresAt: s.expiresAt,
      live: s.live
    }));
  const maxSeats = resolved.error ? 3 : resolved.cfg.maxSeats;
  res.json({
    roomId,
    seats,
    available: maxSeats - seats.length,
    maxSeats
  });
});

// Public browse directory — active rooms that haven't opted out (unlisted).
// Reuses rooms-store + the live seat map; no duplicated state. Sorted hottest
// first: live on-camera count, then queued viewers (paid, camera pending).
app.get('/api/rooms/public', (req, res) => {
  const rooms = [];
  for (const r of listRooms()) {
    if (!r.active) continue;
    const cfg = r.config;
    if (!cfg || cfg.unlisted) continue;
    let live = 0;
    let waiting = 0;
    for (const s of activeSeats.values()) {
      if (s.streamRoomId !== r.id) continue;
      if (s.live) live++; else waiting++;
    }
    rooms.push({
      id: r.id,
      name: cfg.name,
      live,
      waiting,
      maxSeats: cfg.maxSeats,
      passkeyTickPrice: cfg.passkeyTickPrice,
      passkeyTickSeconds: cfg.passkeyTickSeconds,
      paymentTokenSymbol: cfg.paymentTokenSymbol,
      rewardsEnabled: !!cfg.rewards?.enabled,
      createdAt: r.createdAt,
    });
  }
  rooms.sort((a, b) => (b.live - a.live)
    || (b.waiting - a.waiting)
    || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  res.json({ rooms });
});

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

attachDashboardRoutes(app, {
  baseUrl: BASE_URL,
  rpcUrl: ARC_RPC_URL,
  chainId: ARC_CHAIN_ID,
  activeSeats,
  removeParticipant,
  setSeatPinned,
  atomicToUsdc,
});

await migrateLegacyRoomPasswords();

// ─── Next.js frontend (single-process mount) ────────────────────────────────
// The Next app in web/ (dashboard, /join page, /_next assets) runs INSIDE this
// process as the fallthrough handler: every request Express doesn't claim
// (APIs, /overlay, public/ static) is handed to Next. Why this direction and
// not Next API routes: the meter interval, seat Map, WebSocket server, and
// Gateway facilitator are long-lived singletons that must not be re-created
// per route — mounting Next here keeps all payment/meter/WS logic untouched.
const NEXT_DIR = path.join(__dirname, 'web');
const nextDev = !process.argv.includes('--prod')
  && process.env.NODE_ENV !== 'production';

const { createRequire } = await import('module');
const requireFromWeb = createRequire(path.join(NEXT_DIR, 'package.json'));
let createNextApp;
try {
  createNextApp = requireFromWeb('next');
} catch (err) {
  console.error(
    '[next] Could not load the frontend. Run "npm install" once at the project '
    + `root (it also installs web/ dependencies). Underlying error: ${err.message}`
  );
  process.exit(1);
}

const nextApp = createNextApp({ dev: nextDev, dir: NEXT_DIR });
const nextHandle = nextApp.getRequestHandler();
await nextApp.prepare();
const nextUpgrade = nextApp.getUpgradeHandler();

// Everything not matched above (Next pages + /_next assets) goes to Next.
app.use((req, res) => nextHandle(req, res));

// Upgrade routing: app clients open ws://host/ (root path — unchanged);
// /_next/* upgrades belong to the Next dev/HMR websocket.
// CAUTION: Next dev lazily attaches its OWN 'upgrade' listener to this server
// on the first proxied request (via req.socket.server) and destroys sockets
// it doesn't recognize — that would kill every app WebSocket. Trap upgrade
// listeners added after ours and give them /_next traffic only.
let nextLazyUpgrade = null;
server.on('upgrade', (req, socket, head) => {
  const pathname = (req.url || '/').split('?')[0];
  if (pathname.startsWith('/_next')) {
    (nextLazyUpgrade || nextUpgrade)(req, socket, head);
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});
for (const method of ['on', 'addListener', 'prependListener']) {
  const original = server[method].bind(server);
  server[method] = (event, listener) => {
    if (event === 'upgrade') {
      nextLazyUpgrade = listener;
      return server;
    }
    return original(event, listener);
  };
}

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║  MEGACHAT — UNIFIED APP (ARC TESTNET)      ║
╠═══════════════════════════════════════════╣
║  App:     http://localhost:${PORT}  [next ${nextDev ? 'dev' : 'prod'}]
║  Join:    http://localhost:${PORT}/join?room=<id>
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
