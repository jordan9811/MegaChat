import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
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
  dataDirInfo,
  migrateLegacyRoomPasswords,
  listRooms,
  letterPriceFor,
  getRoomByHandle,
  setRoomHandle,
  createRoomWithPassword,
  verifyRoomPassword,
  joinStreamGatesFor,
  pruneOrphanRooms,
  updateRoom,
} from './rooms-store.js';
import { attachDashboardRoutes } from './dashboard-routes.js';
import { createActivityManager } from './livekit-activity.js';
import { createWebhookTracker, verifyWebhookJwt, reconcile } from './livekit-webhooks.js';
import { createBreaker, breakerConfig } from './livekit-breaker.js';
import { lazyConfig, lazyClientConfig } from './livekit-lazy.config.js';
import { attachBountyRoutes, makeClipHooks } from './bounty-routes.js';
import { verifyRoomAccess } from './auth.js';
import {
  toAtomic,
  fromAtomic,
  readTokenBalance,
  readTokenAllowance,
  validatePaymentToken,
} from './token-utils.js';
import { createMppMeter, toWebRequest } from './meter-mpp.js';
import { createWalletClient, createPublicClient, http, erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// Load .env if present (Node >=20.6 native loader). Never throws if missing.
try {
  process.loadEnvFile();
} catch {
  // No .env file — fall back to process.env / defaults below.
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Tempo mainnet constants (eip155:4217) ───────────────────────────────────
// Env-driven; TEMPO_* vars live ALONGSIDE the legacy ARC_* vars (append-only
// .env policy) — this branch reads only the TEMPO_* ones. Values verified in
// TEMPO_NOTES.md. Real chain, real money: default prices stay at dust levels.
const CHAIN_ID = Number(process.env.TEMPO_CHAIN_ID || 4217);
const NETWORK = `eip155:${CHAIN_ID}`; // CAIP-2 identifier
const RPC_URL = process.env.TEMPO_RPC_URL || 'https://rpc.tempo.xyz';
// USDC.e (Stargate-bridged USDC, 6 decimals) — the meter currency.
const USDC_ADDRESS =
  process.env.TEMPO_USDC_ADDRESS || '0x20c000000000000000000000b9537d11c60e8b50';
const EXPLORER_URL = process.env.TEMPO_EXPLORER_URL || 'https://explore.tempo.xyz';

// Privy embedded wallets (browser wallet layer) — app id is public by design,
// secret stays server-side and is never sent to the client.
const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || process.env.PRIVY_APP_ID || null;

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
  let cfg = roomId ? resolveRoomConfig(roomId) : null;
  if (!cfg) {
    // Not a room id → try it as a HANDLE, so ?room=jordandotfun works
    // everywhere a hex id does. (Handles allow underscores, which the id
    // charset doesn't — the two lookups are genuinely different.)
    const byHandle = getRoomByHandle(raw);
    if (byHandle) return { roomId: byHandle.id, cfg: byHandle, atomics: roomAtomics(byHandle) };
  }
  if (!roomId) return { error: 'invalid_room_id' };
  if (!cfg) return { error: 'room_not_found', roomId };
  return { roomId, cfg, atomics: roomAtomics(cfg) };
}

// ─── Refund wallet (seller -> viewer) ────────────────────────────────────────
// Used ONLY to return the unused prepaid USDC when a viewer leaves. Plain ERC-20
// transfer via viem. NOTE: the Arc 1-gwei priority-fee floor was Arc-specific
// and is deliberately NOT ported — Tempo takes standard fee estimation and
// charges fees in the sender's stablecoin (TEMPO_NOTES.md).
const tempoViemChain = {
  id: CHAIN_ID,
  name: 'Tempo',
  network: NETWORK,
  nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 6 },
  rpcUrls: { default: { http: [RPC_URL] }, public: { http: [RPC_URL] } }
};

let sellerAccount = null;
let sellerWalletClient = null;
if (SELLER_PRIVATE_KEY && /^0x[0-9a-fA-F]{64}$/.test(SELLER_PRIVATE_KEY)) {
  try {
    sellerAccount = privateKeyToAccount(SELLER_PRIVATE_KEY);
    sellerWalletClient = createWalletClient({
      account: sellerAccount,
      chain: tempoViemChain,
      transport: http(RPC_URL)
    });
    console.log(`[refund] seller refund wallet ready: ${sellerAccount.address}`);
  } catch (err) {
    console.warn('[refund] failed to init seller wallet, refunds disabled:', err.message);
    sellerWalletClient = null;
  }
} else {
  console.warn('[refund] SELLER_PRIVATE_KEY not set — unused-balance refunds disabled.');
}

// ─── Phase 2: MPP session meter (TIP-1034 payment channels) ─────────────────
// The primary meter on Tempo. null when no seller key is configured — MPP
// joins then 503 and the legacy allowance path still works.
const mppMeter = createMppMeter({
  account: sellerAccount,
  rpcUrl: RPC_URL,
  chainId: CHAIN_ID,
  feeToken: USDC_ADDRESS,
});
if (mppMeter) console.log('[meter:mpp] TIP-1034 session meter ready');
else console.warn('[meter:mpp] disabled (no SELLER_PRIVATE_KEY) — falling back to allowance meter only');

// How long a live MPP seat may go without a PAID tick before it is kicked.
// Covers channel-open latency, tab hiccups, and slow voucher signatures.
const MPP_STALE_MS = Math.max(10_000, Number(process.env.MPP_STALE_MS || 20_000));

// Fee headroom reserved from the wallet balance when sizing a channel deposit
// (Tempo fees come out of the SAME stablecoin). Raw viem estimates the open
// tx at ~$0.003, but padded wallet estimators (Privy embedded) quote ~$0.022
// for a plain transfer — a $0.02 reserve made every small wallet's channel
// open unpayable (deposit + padded max fee > balance → wallet refuses → the
// viewer was auto-kicked seconds after going live). Wallets richer than
// cap + headroom never hit this, which is why the raw-key gates passed.
// Reserved from the viewer's balance for the channel open/close network fees
// (Tempo charges gas in the payment token). MEASURED on mainnet 2026-07-17:
// a real channel open cost 0.00018 USDC.e — 0.01 is a ~50x safety margin.
// The old 0.10 default locked out anyone holding less than a dime.
const MPP_FEE_HEADROOM = process.env.MPP_FEE_HEADROOM || '0.01';

// Refund the unused prepaid balance (settled - consumed = remainingAtomic) back
// to the viewer. Stream/MPP seats skip this — unspent funds never left the
// wallet (allowance) or return straight from channel escrow (MPP settle).
async function refundSeat(seat) {
  if (!seat || seat.refunded) return;
  if (seat.paymentMode === 'free_stream') {
    seat.refunded = true; // nothing was ever charged
    return;
  }
  if (seat.paymentMode === 'mpp_session') {
    seat.refunded = true;
    if (seat.channelId && mppMeter) {
      // Newest voucher settles on-chain; escrow refunds the viewer's remainder.
      mppMeter.settleChannel(seat.channelId, 'seat_ended').catch(() => {});
    } else if (seat.remainingAtomic > 0n) {
      console.log(
        `[refund] mpp seat ${seat.id}: no channel opened — nothing ever left the viewer wallet`
      );
    }
    return;
  }
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

function b64encodeJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}
function b64decodeJson(str) {
  return JSON.parse(Buffer.from(str, 'base64').toString('utf-8'));
}

// On-chain TIP-20/ERC-20 balance on Tempo (viewer wallets, seller, pool).
async function getOnChainTokenBalance(tokenAddress, address, decimals = 6) {
  const raw = await readTokenBalance(tokenAddress, address, RPC_URL, CHAIN_ID);
  return {
    availableAtomic: raw,
    pendingAtomic: 0n,
    available: fromAtomic(raw, decimals),
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
    tokenAddress, payer, SELLER_WALLET_ADDRESS, RPC_URL, CHAIN_ID
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
        chain: tempoViemChain,
        transport: http(RPC_URL)
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

// ─── Legacy /r/<handle> links → bare /<handle> ──────────────────────────────
// The /r/ prefix is retired (it read like a subreddit). Anything already
// pasted in a chat or a bio keeps working via a permanent redirect; the live
// handle routes are registered last, next to the Next.js mount.
app.get('/r/:handle', (req, res) =>
  res.redirect(301, `/${encodeURIComponent(req.params.handle)}`));
app.get('/r/:handle/overlay', (req, res) =>
  res.redirect(301, `/${encodeURIComponent(req.params.handle)}/overlay`));

// Expose the Arc / Gateway config the frontend needs to build payments.
// Boot/infra truth in one place: is data durable across deploys, and did the
// seeded rooms come back? Cheap to curl, saves guessing from the outside.
app.get('/api/health', (req, res) => {
  const data = dataDirInfo();
  res.json({
    ok: true,
    // false here means the NEXT deploy wipes every room, handle and identity.
    persistentData: data.persistent,
    dataDir: data.dir,
    livekitConfigured: !!livekit,
    rooms: listRooms().length,
  });
});

app.get('/api/config', (req, res) => {
  const resolved = resolveRoomFromRequest(null, req.query);
  if (resolved.error === 'invalid_room_id') {
    return res.status(400).json({ error: 'Invalid room id' });
  }
  if (resolved.error === 'room_not_found') {
    return res.status(404).json({ error: 'Room not found', roomId: resolved.roomId });
  }
  const { roomId, cfg } = resolved;
  res.json({
    roomId,
    roomName: cfg.name,
    roomActive: cfg.active,
    // Lazy connect: tells the overlay whether to hold a LiveKit connection
    // while idle (it should not) and how to run its signal channel.
    lazyConnect: lazyClientConfig(cfg.lazyConnectScope),
    chainId: CHAIN_ID,
    chainIdHex: '0x' + CHAIN_ID.toString(16),
    chainName: 'Tempo',
    network: NETWORK,
    rpcUrl: RPC_URL,
    usdcAddress: USDC_ADDRESS,
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
    twitchChannel: cfg.twitchChannel || null,
    rewardsEnabled: !!cfg.rewards?.enabled,
    letters: cfg.letters?.enabled
      ? {
          enabled: true,
          // The recorder needs the floor to refuse a short take BEFORE a
          // wallet prompt, not after the server rejects it.
          minSeconds: cfg.letters.minSeconds,
          maxSeconds: cfg.letters.maxSeconds,
          price: letterPriceFor(cfg),
          moderation: cfg.letters.moderation,
          minWatchSeconds: cfg.letters.gates.minWatchSeconds,
        }
      : { enabled: false },
    joinStream: {
      enabled: cfg.joinStream.enabled,
      minWatchSeconds: joinStreamGatesFor(cfg).minWatchSeconds,
    },
    handle: cfg.handle,
    isDemo: !!cfg.isDemo,
    transport: cfg.transport,
    stingerSounds: cfg.stingerSounds,
    livekitConfigured: !!livekit,
    ...(cfg.transport === 'livekit' && livekit ? { livekitUrl: livekit.url } : {}),
    rewards: cfg.rewards,
    // MPP session meter (TIP-1034 channels) — primary on Tempo.
    meterMode: mppMeter ? 'mpp_session' : 'allowance',
    // Legacy key kept null so the old Arc pages degrade cleanly if opened.
    modularWallets: null,
    privy: PRIVY_APP_ID ? { appId: PRIVY_APP_ID } : null
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
  // Tempo: every wallet mode (Privy embedded, MetaMask) reads the same
  // on-chain TIP-20 balance — the Circle Gateway ledger no longer exists.
  const minTick = atomics.passkeyTickPriceAtomic;
  try {
    const bal = await getOnChainTokenBalance(
      cfg.paymentTokenAddress, address, cfg.paymentTokenDecimals
    );
    // Preview must match what /api/join/mpp will actually grant: the fee
    // headroom is reserved from the same stablecoin balance.
    const headroomAtomic = toAtomic(MPP_FEE_HEADROOM, cfg.paymentTokenDecimals);
    const spendCapAtomic = bal.availableAtomic > headroomAtomic
      ? bal.availableAtomic - headroomAtomic
      : 0n;
    const spendableAtomic = spendCapAtomic < atomics.maxSessionAtomic
      ? spendCapAtomic
      : atomics.maxSessionAtomic;
    return res.json({
      address,
      roomId: cfg.id,
      available: bal.available,
      pending: bal.pending,
      hasRecord: bal.hasRecord,
      spendable: fromAtomic(spendableAtomic, cfg.paymentTokenDecimals),
      maxSession: cfg.maxSession,
      canJoin: spendableAtomic >= minTick && cfg.active,
      roomActive: cfg.active,
      source: 'onchain'
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

/** Is at least one overlay (OBS browser source) rendering this room? */
function hasOverlay(streamRoomId) {
  const target = streamRoomId || DEFAULT_ROOM_ID;
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    if (client.__role !== 'overlay') continue;
    if ((client.__streamRoomId || DEFAULT_ROOM_ID) === target) return true;
  }
  return false;
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

/**
 * Lazy connect — owns "should the overlay be holding a LiveKit connection".
 * See LIVEKIT-AUDIT.md: the overlay used to connect on page load and never
 * hang up, which is what drained the free tier with no guests on camera.
 */
const lkActivity = createActivityManager({ broadcastToRoom, hasOverlay });

/**
 * Webhook-derived session truth + the burn breaker that reads it.
 * Deliberately NOT fed by lkActivity's self-reported ledger: a breaker fed by
 * the same self-report that hid the last leak would fail in exactly the case
 * it exists for.
 */
const lkWebhooks = createWebhookTracker({
  onSession: (rec) => {
    console.log(`[lk-webhook] session ${rec.kind} ${rec.identity} in ${rec.room} — ${(rec.durationMs / 60_000).toFixed(2)}min${rec.outOfOrder ? ' (out-of-order delivery, reconciled)' : ''}`);
  },
});
const lkBreaker = createBreaker({ getUsage: () => lkWebhooks.stats() });
{
  const t = setInterval(() => lkBreaker.evaluate(), 60_000);
  if (t.unref) t.unref();
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
    payoutAddress: roomCfg.payoutAddress || null,
    lastMeterAt: 0,
    _tickInFlight: false,
    flyIn: sanitizeStinger(meta.flyIn, FLY_IN_STINGERS),
    flyOut: sanitizeStinger(meta.flyOut, FLY_OUT_STINGERS),
    // Control-plane WS health: reconnect grace + flakiness signal for the
    // dashboard. Never touches metering — the seat stays live (and billing)
    // through a blip, exactly like the video itself.
    disconnects: 0,
    lastDisconnectAt: 0,
    _graceTimer: null,
  };

  activeSeats.set(seatId, seat);

  // Lazy connect: a granted seat is a hard commitment — make sure the overlay
  // is (or is becoming) connected. Usually a no-op because the join sheet
  // already prewarmed us well before payment cleared.
  lkActivity.seatOccupied(seat.streamRoomId, seatId);

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
  // MPP: the staleness clock starts now; the first paid tick (which also
  // opens the channel) must land within MPP_STALE_MS.
  seat.lastPaidAt = Date.now();
  if (ws) { ws.__seatId = seatId; seat.ownerWs = ws; }

  const tickPrice = seat.paymentMode === 'gateway'
    ? seat.gatewayTickPriceAtomic
    : seat.passkeyTickPriceAtomic;
  const tickSec = seat.paymentMode === 'gateway'
    ? seat.gatewayTickSeconds
    : seat.passkeyTickSeconds;
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
  if (seat._graceTimer) { clearTimeout(seat._graceTimer); seat._graceTimer = null; }
  // Lazy connect: last seat out starts the grace timer (not an instant hangup —
  // back-to-back joiners must never see a connect/disconnect flap).
  lkActivity.seatVacated(seat.streamRoomId, seatId);
  // LiveKit rooms: the SFU drops the participant NOW (kick/leave enforcement
  // server-side, not just client goodwill). vdo rooms: no-op.
  {
    const roomCfg = resolveRoomConfig(seat.streamRoomId);
    if (roomCfg?.transport === 'livekit' && livekit) {
      void livekit.kickParticipant(seat.streamRoomId, `seat:${seatId}`);
    }
  }

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
        args: [seat.viewerAddress, seat.payoutAddress || SELLER_WALLET_ADDRESS, tickPrice]
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
    // Free-room seats: no billing, and no payment-staleness kick — their
    // liveness is the WS/LiveKit connection (grace timers), not vouchers.
    if (seat.paymentMode === 'free_stream') continue;
    if (seat.paymentMode === 'mpp_session') {
      // MPP seats are billed by CLIENT-driven signed vouchers hitting
      // /api/meter/tick — the server side only enforces liveness: a live
      // seat whose paid ticks stop arriving gets kicked (and its channel
      // settled with the newest voucher via refundSeat).
      // LiveKit rooms: the transport auto-reconnects and the client pauses
      // ticks (zero charges) during the blip, so those seats get a
      // configurable grace window before the stale-kick (default 15s + tick
      // margin, env LIVEKIT_SEAT_GRACE_S). Meter never charges dead air —
      // vouchers simply don't exist while offline.
      const roomCfg = resolveRoomConfig(seat.streamRoomId);
      const staleMs = roomCfg?.transport === 'livekit'
        ? Math.max(MPP_STALE_MS, (Number(process.env.LIVEKIT_SEAT_GRACE_S || 15) + 5) * 1000)
        : MPP_STALE_MS;
      if (now - (seat.lastPaidAt || seat.liveAt || 0) > staleMs) {
        console.log(`[meter:mpp] seat ${seat.id}: paid ticks stalled — removing`);
        removeParticipant(seat.id, 'payment_stalled');
      }
      continue;
    }
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

// Seat-owner sockets get a reconnect grace window before the seat is freed:
// flaky networks blip the control WS while the WebRTC video keeps flowing.
// Deliberate exits stay instant — the join page fires an explicit leave
// beacon on pagehide, and kick / POST /api/leave still remove immediately.
const SEAT_RECONNECT_GRACE_MS = Math.max(
  5000,
  parseInt(process.env.SEAT_RECONNECT_GRACE_MS || '30000', 10) || 30000
);

// WebSocket connection
wss.on('connection', (ws, req) => {
  console.log('Client connected');
  ws.__streamRoomId = DEFAULT_ROOM_ID;
  ws.isAlive = true;
  // (Overlay detection is role-based only: a Referer-sniff fallback for
  // stale pages was tried and DISPROVEN — Chromium sends no Referer on WS
  // handshakes. Stale pages heal via no-cache + reload-on-disconnect.)
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'subscribe_room' && typeof msg.room === 'string') {
      const roomId = normalizeRoomId(msg.room);
      if (roomId && resolveRoomConfig(roomId)) {
        ws.__streamRoomId = roomId;
        // The overlay (OBS browser source) identifies itself — MegaChats only
        // PLAY while one is connected, so paid clips can't burn into a room
        // where nothing renders them.
        if (msg.role === 'overlay') ws.__role = 'overlay';
        sendInitialState(ws);
      }
      return;
    }

    if (msg.type === 'register_seat' && typeof msg.seatId === 'string') {
      const seat = activeSeats.get(msg.seatId);
      if (seat) {
        ws.__seatId = msg.seatId;
        seat.ownerWs = ws;
        if (seat._graceTimer) {
          clearTimeout(seat._graceTimer);
          seat._graceTimer = null;
          console.log(`[seat] ${seat.id}: owner reconnected within grace — seat kept`);
        }
      } else {
        // Seat died while this client was offline — tell it to tear down.
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'seat_removed', seatId: msg.seatId, reason: 'not_found' }));
        }
      }
    } else if (msg.type === 'camera_ready' && typeof msg.seatId === 'string') {
      activateSeatLive(msg.seatId, ws);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    // Overlay browser source went away (OBS closed, scene removed, reload).
    // Close its ledger record so "connected minutes" never over-counts, and
    // only when no OTHER overlay is still rendering this room.
    if (ws.__role === 'overlay') {
      const rid = ws.__streamRoomId || DEFAULT_ROOM_ID;
      setImmediate(() => { if (!hasOverlay(rid)) lkActivity.overlayGone(rid); });
    }
    const seatId = ws.__seatId;
    if (!seatId) return;
    const seat = activeSeats.get(seatId);
    // A newer socket may have already re-bound this seat (reconnect landed
    // before the old socket's close event) — then this close means nothing.
    if (!seat || seat.ownerWs !== ws) return;
    seat.ownerWs = null;
    seat.disconnects = (seat.disconnects || 0) + 1;
    seat.lastDisconnectAt = Date.now();
    if (seat._graceTimer) clearTimeout(seat._graceTimer);
    seat._graceTimer = setTimeout(() => {
      seat._graceTimer = null;
      if (activeSeats.has(seatId) && !seat.ownerWs) {
        console.log(`[seat] ${seatId}: reconnect grace expired — removing + refunding`);
        removeParticipant(seatId, 'disconnected');
      }
    }, SEAT_RECONNECT_GRACE_MS);
    console.log(
      `[seat] ${seatId}: owner disconnected — ${Math.round(SEAT_RECONNECT_GRACE_MS / 1000)}s reconnect grace`
    );
  });
});

// Detect half-dead sockets (NAT timeouts, sleeping devices): an unanswered
// ping terminates the socket, which routes seat owners into the grace flow
// above instead of leaving a zombie binding.
const wsHeartbeat = setInterval(() => {
  wss.clients.forEach((client) => {
    if (client.isAlive === false) return client.terminate();
    client.isAlive = false;
    try { client.ping(); } catch { /* socket already closing */ }
  });
}, 15000);
if (typeof wsHeartbeat.unref === 'function') wsHeartbeat.unref();

// ─── Pass C: watch-to-earn (isolated; never breaks Pass A / B) ───────────────
let rewardsSvc = null;
try {
  rewardsSvc = attachRewards(wss, {
    getRoomConfig: resolveRoomConfig,
    poolPrivateKey: process.env.REWARD_POOL_PRIVATE_KEY || null,
    rpcUrl: RPC_URL,
    usdcAddress: USDC_ADDRESS,
  });
} catch (err) {
  console.warn('[rewards] failed to attach, continuing without watch-to-earn:', err.message);
}

// ─── Per-feature reputation gates ────────────────────────────────────────────
// minWatchSeconds enforces off the live watch-time ledger (rewards module).
// followersOnly/subsOnly are stored config until platform verification ships —
// configuration is honest about that in the dashboard, and we never silently
// enforce what we cannot verify.
function checkFeatureGates(cfg, gates, address) {
  if (gates.minWatchSeconds > 0) {
    const watched = rewardsSvc ? rewardsSvc.getWatchSeconds(cfg.id, address) : 0;
    if (watched < gates.minWatchSeconds) {
      return {
        blocked: true,
        status: 403,
        body: {
          error: 'Not enough watch time yet',
          reason: 'min_watch_time',
          watchedSeconds: watched,
          requiredSeconds: gates.minWatchSeconds,
          hint: `This unlocks after ${gates.minWatchSeconds}s of watching — you're at ${watched}s. Keep this page open (and your wallet connected) to build it up.`,
        },
      };
    }
  }
  return { blocked: false };
}

// ─── LiveKit transport (default once configured; vdo is the backup) ────────
import { createLivekitService } from './livekit.js';
const livekit = createLivekitService();
if (livekit) console.log('[livekit] transport available at', livekit.url, '— now the default');

// Token minting — publisher tokens require the seat the join flow granted.
// ─── LiveKit webhooks: the authoritative session source ─────────────────────
// Raw body required — the signature commits to the exact bytes.
app.post('/api/livekit/webhook', express.raw({ type: '*/*', limit: '256kb' }), (req, res) => {
  if (!livekit) return res.status(503).json({ error: 'LiveKit not configured' });
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
  try {
    verifyWebhookJwt(req.headers.authorization, raw, {
      apiKey: process.env.LIVEKIT_API_KEY,
      apiSecret: process.env.LIVEKIT_API_SECRET,
    });
  } catch (e) {
    // Unsigned or tampered deliveries are rejected outright — an
    // unauthenticated writer to the authoritative session ledger would be
    // worse than having no ledger at all.
    console.warn(`[lk-webhook] REJECTED delivery: ${e.message}`);
    return res.status(401).json({ error: 'invalid webhook signature', detail: e.message });
  }
  let event;
  try { event = JSON.parse(raw.toString('utf8')); }
  catch { return res.status(400).json({ error: 'unparseable webhook body' }); }

  // ACKNOWLEDGE FIRST, process after. LiveKit retries on a slow or failed
  // delivery, and a retried participant_left that we then dedupe is harmless —
  // but a delivery we never ack can be dropped, which would leave a session
  // looking permanently open in the exact ledger the breaker meters. That
  // turns the leak detector into a false-alarm generator, so the ack must
  // never wait on our processing.
  res.json({ ok: true, accepted: true });
  setImmediate(() => {
    try {
      const out = lkWebhooks.handle(event);
      lkBreaker.evaluate();
      if (out.deduped) console.log(`[lk-webhook] duplicate ${event.event} ignored (idempotent)`);
    } catch (e) {
      console.error(`[lk-webhook] post-ack processing failed for ${event?.event}: ${e.message}`);
    }
  });
});

/** Webhook-derived usage + breaker state (operator surface). */
app.get('/api/livekit/burn', (_req, res) => {
  const webhookStats = lkWebhooks.stats();
  res.json({
    breaker: lkBreaker.snapshot(),
    webhook: webhookStats,
    // Clamp the ledger to the webhook's observation window. The ledger is
    // persisted on /data and the webhook tracker is not, so without this the
    // reconciliation reports a divergence after every deploy that is purely
    // an artifact of the two having different memories.
    reconciliation: reconcile({
      webhookStats,
      ledgerStats: lkActivity.ledgerStats(webhookStats.observingSince),
    }),
  });
});

/**
 * Purge sessions that were never ours — LiveKit dashboard test fires, or any
 * foreign participant in the project. A dashboard test left a 150-minute
 * phantom that consumed 37.5% of the daily burn budget before anyone looked;
 * an operator needs a way to clear that without restarting the service.
 */
app.post('/api/livekit/burn/purge-foreign', (req, res) => {
  const removed = lkWebhooks.purgeForeign();
  if (removed.length) {
    console.warn(`[lk-webhook] purged ${removed.length} non-MegaChat session(s): ` +
      removed.map((r) => `${r.identity}@${r.room} (${r.openMinutes}min, ${r.reason})`).join('; '));
  }
  lkBreaker.evaluate();
  res.json({ ok: true, purged: removed.length, removed, burn: lkBreaker.snapshot() });
});

/** Operator override — requires who and why, both logged. */
app.post('/api/livekit/burn/override', (req, res) => {
  try {
    const { by, reason, ttlMs } = req.body || {};
    const o = lkBreaker.setOverride({ by, reason, ttlMs });
    res.json({ ok: true, override: { by: o.by, reason: o.reason, expiresAt: o.until } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/livekit/burn/override', (req, res) => {
  lkBreaker.clearOverride(req.body?.by || 'operator');
  res.json({ ok: true });
});

// ─── Lazy connect: activity signal surface ──────────────────────────────────
// The overlay does not hold a LiveKit connection while idle; it obeys these.

/** Join sheet opened — earliest credible intent. Wakes the overlay so the
 *  handshake completes INSIDE the payment flow (which is slower), making
 *  lazy connect invisible to the audience. */
app.post('/api/livekit/prewarm', (req, res) => {
  const resolved = resolveRoomFromRequest(req.body, req.query);
  if (resolved.error) return res.status(404).json({ error: resolved.error });
  const token = lkActivity.prewarm(resolved.roomId);
  res.json({ ok: true, prewarm: token, health: lkActivity.overlayHealth(resolved.roomId) });
});

/**
 * Guest is still moving through the join flow — restarts the abandon clock.
 * Without this, a slow-but-real join (someone reading a wallet dialog) would
 * be clipped at the abandon cap mid-payment, which is worse than the burn the
 * cap prevents. sendBeacon-friendly: accepts text/plain bodies too.
 */
app.post('/api/livekit/prewarm/progress', express.text({ type: '*/*' }), (req, res) => {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const resolved = resolveRoomFromRequest(body, req.query);
  if (resolved.error) return res.status(404).json({ error: resolved.error });
  const ok = lkActivity.prewarmProgress(resolved.roomId, body?.prewarm, body?.stage);
  res.json({ ok, stage: body?.stage || null });
});

/** Guest closed the sheet without buying — release the hold (grace still applies). */
app.post('/api/livekit/prewarm/cancel', express.text({ type: '*/*' }), (req, res) => {
  if (typeof req.body === 'string') { try { req.body = JSON.parse(req.body); } catch { req.body = {}; } }
  const resolved = resolveRoomFromRequest(req.body, req.query);
  if (resolved.error) return res.status(404).json({ error: resolved.error });
  lkActivity.cancelPrewarm(resolved.roomId, req.body?.prewarm);
  res.json({ ok: true });
});

/** Overlay heartbeat + polling fallback in one call: proves the browser source
 *  is alive AND returns the state it should be in if its WS signal died. */
app.post('/api/livekit/overlay/beat', (req, res) => {
  const resolved = resolveRoomFromRequest(req.body, req.query);
  if (resolved.error) return res.status(404).json({ error: resolved.error });
  lkActivity.beat(resolved.roomId, req.body?.lkState, req.body?.identity);
  res.json({ ok: true, desired: lkActivity.desired(resolved.roomId) });
});

/** Overlay health for the booth dashboard + the paid-join guard. */
app.get('/api/livekit/overlay/health', (req, res) => {
  const resolved = resolveRoomFromRequest(req.query, req.query);
  if (resolved.error) return res.status(404).json({ error: resolved.error });
  res.json(lkActivity.overlayHealth(resolved.roomId));
});

/** Session ledger — how the next leak gets caught on day one. */
app.get('/api/livekit/sessions', (req, res) => {
  res.json({ ...lkActivity.ledgerStats(), lazyConnect: lazyConfig.enabled });
});

app.post('/api/livekit/token', async (req, res) => {
  try {
    const { role, seatId } = req.body || {};
    const resolved = resolveRoomFromRequest(req.body, req.query);
    if (resolved.error) {
      return res.status(resolved.error === 'room_not_found' ? 404 : 400).json({ error: resolved.error });
    }
    const { roomId, cfg } = resolved;
    if (cfg.transport !== 'livekit') {
      return res.status(400).json({ error: 'Room does not use the LiveKit transport' });
    }
    if (!livekit) {
      return res.status(503).json({ error: 'LiveKit is not configured on this server' });
    }
    // Burn breaker. A token IS a new connection, so this is the chokepoint.
    // Existing sessions already hold their tokens and are untouched — we never
    // cut a live guest off air to save minutes.
    {
      const gate = lkBreaker.checkAllowed();
      if (!gate.allowed) {
        console.error(`[lk-breaker] refused a ${role} token for room ${roomId} — budget reached`);
        return res.status(503).json({
          error: gate.reason,
          code: 'burn_budget_reached',
          state: gate.state,
        });
      }
    }
    if (role === 'publisher') {
      const seat = activeSeats.get(String(seatId || ''));
      if (!seat || seat.streamRoomId !== roomId) {
        return res.status(403).json({ error: 'No authorized seat — join first' });
      }
      const token = await livekit.publisherToken(roomId, seat);
      return res.json({ token, url: livekit.url, room: livekit.lkRoomName(roomId), identity: `seat:${seat.id}` });
    }
    if (role === 'overlay') {
      // Per-source instance id keeps a reload evicting only ITSELF, while two
      // genuinely different overlays (second OBS source, a tab opened to check
      // it) coexist instead of kicking each other off — which showed up as a
      // black broadcast with tiles still rendering.
      const inst = String(req.body?.instance || '').replace(/[^a-z0-9]/gi, '').slice(0, 12);
      // STABLE identity, deliberately. The old random `viewer:<rand>` meant
      // LiveKit could not dedupe: every OBS reload connected as a brand-new
      // participant while the stale one lingered until the reaper took it, so
      // reload churn STACKED billed participants (26 in one session — see
      // LIVEKIT-AUDIT.md). A fixed identity makes a rejoin evict its own
      // predecessor instantly, so reconnects are idempotent and self-healing.
      const identity = inst ? `overlay:${roomId}:${inst}` : `overlay:${roomId}`;
      const token = await livekit.subscriberToken(roomId, identity);
      return res.json({ token, url: livekit.url, room: livekit.lkRoomName(roomId), identity });
    }
    if (role === 'subscriber') {
      const identity = `viewer:${Math.random().toString(36).slice(2, 10)}`;
      const token = await livekit.subscriberToken(roomId, identity);
      return res.json({ token, url: livekit.url, room: livekit.lkRoomName(roomId), identity });
    }
    if (role === 'host') {
      // The streamer's own camera — dashboard-grade auth: owner identity OR
      // the room password (same rule as every management route).
      const access = await verifyRoomAccess(req, roomId);
      if (!access.ok) return res.status(401).json({ error: 'Sign in as the room owner, or provide the room password.' });
      const token = await livekit.hostToken(roomId);
      return res.json({ token, url: livekit.url, room: livekit.lkRoomName(roomId), identity: `host:${roomId}` });
    }
    return res.status(400).json({ error: 'Unknown role' });
  } catch (err) {
    console.warn('[livekit] token error:', err.message);
    return res.status(500).json({ error: 'Token minting failed' });
  }
});

// LiveKit connection quality, reported by the joiner (possession of the
// seat id — same trust level as camera_ready). Cosmetic signal only.
app.post('/api/seat/quality', (req, res) => {
  const { seatId, quality } = req.body || {};
  const seat = activeSeats.get(String(seatId || ''));
  if (!seat) return res.status(404).json({ error: 'Seat not found' });
  const q = String(quality || '').toLowerCase();
  if (!['excellent', 'good', 'poor', 'lost', 'unknown'].includes(q)) {
    return res.status(400).json({ error: 'Bad quality value' });
  }
  seat.lkQuality = q;
  seat.lkQualityAt = Date.now();
  res.json({ ok: true });
});

// ─── OAuth identity (Twitch / X — identity only, env-gated) ─────────────────
app.set('trust proxy', 1); // Railway terminates TLS; req.protocol must be https
try {
  const { attachAuth } = await import('./auth.js');
  attachAuth(app);
} catch (err) {
  console.warn('[auth] failed to attach, continuing without OAuth identity:', err.message);
}

// ─── Letter mode (isolated; reuses the MPP payment rails read-only) ─────────
try {
  const { attachLetters } = await import('./letters.js');
  attachLetters(app, {
    mppMeter,
    broadcastToRoom,
    hasOverlay,
    activeSeats,
    sellerAddress: SELLER_WALLET_ADDRESS,
    getWatchSeconds: (roomId, wallet) =>
      (rewardsSvc ? rewardsSvc.getWatchSeconds(roomId, wallet) : 0),
    // Creator bounty: the watermark that proves a clip aired is minted from
    // THIS server-side playback event, so proof-of-playback and proof-of-air
    // are one artifact instead of two that can disagree. No-ops when the
    // BOUNTY_CLAIM flag is off.
    ...makeClipHooks(),
  });
} catch (err) {
  console.warn('[letters] failed to attach, continuing without letter mode:', err.message);
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

// OBS overlay page (just video boxes). no-cache: without it browsers
// heuristically cache this HTML and OBS browser sources keep running
// PRE-DEPLOY code indefinitely — the page reloads itself whenever its WS
// drops (every deploy), and this makes that reload actually fetch the
// current build instead of the cached one.
app.get('/overlay', (req, res) => {
  res.set('Cache-Control', 'no-cache');
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
        network: NETWORK,
        mode,
        source: 'earned_balance',
      }
    : {
        payer: verified.payer,
        transaction: verified.txHash,
        allowance: fromAtomic(verified.allowance, dec),
        tokenSymbol: sym,
        network: NETWORK,
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
    if (!cfg.joinStream.enabled) {
      return res.status(403).json({
        error: 'Join Stream is disabled in this room',
        reason: 'feature_disabled',
        hint: cfg.letters.enabled ? 'This room takes MegaChats only — send one instead.' : undefined,
      });
    }
    {
      const gate = checkFeatureGates(cfg, joinStreamGatesFor(cfg), address);
      if (gate.blocked) return res.status(gate.status).json(gate.body);
    }

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
          cfg.paymentTokenAddress, address, RPC_URL, CHAIN_ID
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

// ─── Phase 2: MPP session join + metered tick ───────────────────────────────

// MPP session join — no upfront transfer, no approve. The escrow channel
// opens on the first paid tick after the camera goes live.
app.post('/api/join/mpp', async (req, res) => {
  try {
    if (!mppMeter) {
      return res.status(503).json({
        error: 'MPP meter unavailable on this server',
        hint: 'SELLER_PRIVATE_KEY missing'
      });
    }
    const { username, address } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });
    const hasAddress = /^0x[0-9a-fA-F]{40}$/.test(address || '');
    const resolved = resolveRoomFromRequest(req.body, req.query);
    if (resolved.error === 'invalid_room_id') {
      return res.status(400).json({ error: 'Invalid room id' });
    }
    if (resolved.error === 'room_not_found') {
      return res.status(404).json({ error: 'Room not found', roomId: resolved.roomId });
    }
    const { roomId, cfg, atomics } = resolved;
    if (!cfg.joinStream.enabled) {
      return res.status(403).json({
        error: 'Join Stream is disabled in this room',
        reason: 'feature_disabled',
        hint: cfg.letters.enabled ? 'This room takes MegaChats only — send one instead.' : undefined,
      });
    }
    {
      const gate = checkFeatureGates(cfg, joinStreamGatesFor(cfg), address);
      if (gate.blocked) return res.status(gate.status).json(gate.body);
    }

    if (!cfg.active) {
      return res.status(403).json({ error: 'Room is not accepting joins', reason: 'room_stopped', roomId });
    }

    // FREE rooms (tick price 0): no wallet, no balance, no channel — the seat
    // is simply granted. Liveness comes from the control WS / LiveKit
    // connection, not payment vouchers (tickAllMeters skips free seats).
    if (atomics.passkeyTickPriceAtomic === 0n) {
      const freeResult = addParticipant(username, {
        remainingAtomic: 0n,
        payer: hasAddress ? address : null,
        viewerAddress: hasAddress ? address : null,
        paymentMode: 'free_stream',
        sessionCapAtomic: 0n,
        streamRoomId: roomId,
        flyIn: req.body.flyIn,
        flyOut: req.body.flyOut,
      });
      if (!freeResult.success) {
        const status = freeResult.reason === 'room_stopped' ? 403 : 409;
        return res.status(status).json({
          error: freeResult.reason === 'room_stopped' ? 'Room is not accepting joins' : 'No seats available',
          reason: freeResult.reason,
          roomId
        });
      }
      schedulePendingCameraTimeout(freeResult.seat.id);
      const freeSeat = freeResult.seat;
      console.log(`[join:free] room ${roomId} seat ${freeSeat.id} for ${username} (free room)`);
      return res.json({
        success: true,
        free: true,
        message: 'Seat assigned! Allow camera access to go live:',
        pushUrl: freeSeat.pushUrl,
        seatId: freeSeat.id,
        remaining: '0',
        sessionCap: '0',
        tickPrice: '0',
        tickSeconds: cfg.passkeyTickSeconds,
        maxSession: '0',
        secondsLeft: 0,
        paymentMode: 'free_stream',
        paymentTokenSymbol: cfg.paymentTokenSymbol,
        paymentTokenAddress: cfg.paymentTokenAddress,
        paymentTokenDecimals: cfg.paymentTokenDecimals,
        payment: { payer: hasAddress ? address : null, mode: 'free_stream', network: NETWORK },
      });
    }

    // Paid rooms DO need a wallet — the check moved below the free branch so
    // free rooms never demand one.
    if (!hasAddress) {
      return res.status(400).json({ error: 'Wallet address required' });
    }

    let rawBal;
    try {
      rawBal = await readTokenBalance(cfg.paymentTokenAddress, address, RPC_URL, CHAIN_ID);
    } catch (err) {
      return res.status(502).json({ error: 'Balance lookup failed', message: err.message });
    }
    // Tempo fees come out of the SAME stablecoin balance that funds the
    // channel deposit. Depositing the full balance makes the open tx itself
    // unpayable (learned on mainnet: InsufficientBalance at exactly the cap).
    // Reserve headroom for the open + close fees (see MPP_FEE_HEADROOM above —
    // padded wallet estimators need far more room than the raw ~$0.0006 cost).
    const feeHeadroom = toAtomic(MPP_FEE_HEADROOM, cfg.paymentTokenDecimals);
    const spendable = rawBal > feeHeadroom ? rawBal - feeHeadroom : 0n;
    const sessionAtomic = spendable < atomics.maxSessionAtomic ? spendable : atomics.maxSessionAtomic;
    if (sessionAtomic < atomics.passkeyTickPriceAtomic) {
      // Be EXACT: total needed = one tick + the fee reserve; tell them the
      // precise top-up instead of a stale hardcoded number.
      const neededAtomic = atomics.passkeyTickPriceAtomic + feeHeadroom;
      const topUpAtomic = neededAtomic > rawBal ? neededAtomic - rawBal : 0n;
      return res.status(402).json({
        error: `Insufficient ${cfg.paymentTokenSymbol} balance`,
        reason: 'insufficient_balance',
        available: fromAtomic(rawBal, cfg.paymentTokenDecimals),
        needAtLeast: fromAtomic(neededAtomic, cfg.paymentTokenDecimals),
        tokenSymbol: cfg.paymentTokenSymbol,
        hint: `Top up at least ${fromAtomic(topUpAtomic, cfg.paymentTokenDecimals)} ${cfg.paymentTokenSymbol} — ${MPP_FEE_HEADROOM} is reserved for network fees.`,
        path: 'mpp',
        roomId
      });
    }

    const result = addParticipant(username, {
      remainingAtomic: sessionAtomic,
      payer: address,
      viewerAddress: address,
      paymentMode: 'mpp_session',
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
    const seat = result.seat;
    const ticksLeft = atomics.passkeyTickPriceAtomic > 0n
      ? Number(sessionAtomic / atomics.passkeyTickPriceAtomic)
      : 0;
    console.log(
      `[join:mpp] room ${roomId} seat ${seat.id} for ${username} (${address}) `
      + `cap ${fromAtomic(sessionAtomic, cfg.paymentTokenDecimals)} ${cfg.paymentTokenSymbol}`
    );
    return res.json({
      success: true,
      message: 'Seat assigned! Allow camera access to go live:',
      pushUrl: seat.pushUrl,
      seatId: seat.id,
      roomId,
      remaining: fromAtomic(sessionAtomic, cfg.paymentTokenDecimals),
      sessionCap: fromAtomic(sessionAtomic, cfg.paymentTokenDecimals),
      tickPrice: cfg.passkeyTickPrice,
      tickSeconds: cfg.passkeyTickSeconds,
      maxSession: cfg.maxSession,
      secondsLeft: ticksLeft * cfg.passkeyTickSeconds,
      paymentMode: 'mpp_session',
      paymentTokenSymbol: cfg.paymentTokenSymbol,
      paymentTokenAddress: cfg.paymentTokenAddress,
      paymentTokenDecimals: cfg.paymentTokenDecimals,
      tickUrl: `/api/meter/tick?seat=${seat.id}&room=${encodeURIComponent(roomId)}`,
      payment: { payer: address, mode: 'mpp_session', network: NETWORK },
    });
  } catch (error) {
    console.error('[join:mpp] error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'MPP join failed', message: error.message });
    }
  }
});

// Metered tick. Every request is a 402 challenge (first contact), a channel
// OPEN credential (one on-chain deposit tx by the viewer), a signed off-chain
// VOUCHER (every subsequent tick — zero gas), or a CLOSE action. The mppx
// session method verifies each one; we only translate receipts into seat
// meter state and WS broadcasts.
app.all('/api/meter/tick', async (req, res) => {
  try {
    if (!mppMeter) return res.status(503).json({ error: 'MPP meter unavailable' });
    const resolved = resolveRoomFromRequest(req.body, req.query);
    if (resolved.error) {
      return res.status(resolved.error === 'room_not_found' ? 404 : 400).json({
        error: resolved.error,
        roomId: resolved.roomId
      });
    }
    const { cfg, atomics } = resolved;
    const seatId = String(req.query.seat || '');
    const seat = activeSeats.get(seatId) || null;

    // Pinned co-host = free seat: acknowledge the tick WITHOUT charging so
    // the client loop keeps running and billing resumes seamlessly on unpin.
    if (seat && seat.pinned) {
      seat.lastPaidAt = Date.now();
      return res.json({
        ok: true,
        pinned: true,
        seatId: seat.id,
        remaining: fromAtomic(seat.remainingAtomic, cfg.paymentTokenDecimals),
        spent: fromAtomic(seat.spentAtomic, cfg.paymentTokenDecimals),
      });
    }

    const result = await mppMeter.handleTick(toWebRequest(req), {
      amount: cfg.passkeyTickPrice,
      currency: cfg.paymentTokenAddress,
      decimals: cfg.paymentTokenDecimals,
      unitType: 'tick',
      // Session settlements pay the streamer's payout wallet directly.
      recipient: cfg.payoutAddress || SELLER_WALLET_ADDRESS,
      suggestedDeposit: seat
        ? fromAtomic(seat.sessionCapAtomic, cfg.paymentTokenDecimals)
        : cfg.maxSession,
    });

    if (result.status === 402) return result.respond(res);

    const receipt = result.receipt;
    if (seat && receipt) {
      if (receipt.channelId) seat.channelId = receipt.channelId;
      // SessionReceipt.spent is RAW atomic units (confirmed on mainnet:
      // '8000' for 8 ticks of 0.001 with 6 decimals) — never re-scale it.
      let spentAtomic = 0n;
      try { spentAtomic = BigInt(receipt.spent ?? '0'); } catch { spentAtomic = seat.spentAtomic; }
      seat.spentAtomic = spentAtomic;
      seat.remainingAtomic = seat.sessionCapAtomic > spentAtomic
        ? seat.sessionCapAtomic - spentAtomic
        : 0n;
      seat.lastPaidAt = Date.now();

      const tickPrice = atomics.passkeyTickPriceAtomic;
      const ticksLeft = tickPrice > 0n ? Number(seat.remainingAtomic / tickPrice) : 0;
      const secondsLeft = ticksLeft * cfg.passkeyTickSeconds;
      broadcastMeterUpdate(seat, {
        seatId: seat.id,
        remaining: fromAtomic(seat.remainingAtomic, cfg.paymentTokenDecimals),
        spent: fromAtomic(seat.spentAtomic, cfg.paymentTokenDecimals),
        secondsLeft,
        minutesLeft: Math.floor(secondsLeft / 60),
        mode: 'mpp_session',
        tokenSymbol: cfg.paymentTokenSymbol,
      });
      if (seat.remainingAtomic < tickPrice) {
        removeParticipant(seat.id, 'out_of_funds');
      }
      return result.respond(res, {
        ok: true,
        seatId: seat.id,
        remaining: fromAtomic(seat.remainingAtomic, cfg.paymentTokenDecimals),
        spent: fromAtomic(seat.spentAtomic, cfg.paymentTokenDecimals),
        secondsLeft,
      });
    }

    // Seat already gone (voucher/close landing after a kick) — acknowledge so
    // the client can finish its close handshake; settlement is server-owned.
    return result.respond(res, { ok: true, seat: 'gone' });
  } catch (error) {
    console.error('[meter:mpp] tick error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Tick failed', message: error.message });
    }
  }
});

// Legacy Circle Gateway join (Arc) — retired on Tempo. MetaMask viewers go
// through the same unified meter as embedded wallets from Phase 2 onward.
app.post('/api/join', (req, res) => {
  res.status(501).json({
    error: 'The Gateway prepaid join was retired in the Tempo migration.',
    hint: 'Use the join page flow (unified meter) — POST /api/join/passkey.',
    redirect: '/api/join/passkey',
    path: 'gateway'
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

// ─── Twitch preview liveness ────────────────────────────────────────────────
// The browse-card thumbnail uses Twitch's free preview image, but Twitch
// serves it via a 302: a LIVE channel redirects to a real frame, while an
// offline/nonexistent one redirects to a generic gray ttv-static/404_preview
// placeholder (HTTP 200 — so a client onError never fires). Only the redirect
// TARGET distinguishes them, and reading it needs a server-side request.
// Cached per channel with stale-while-revalidate so client polling can't
// hammer Twitch: at most one probe per channel per TTL, never blocking the
// browse response.
const twitchLiveCache = new Map(); // login -> { live, at }
const TWITCH_LIVE_TTL_MS = 90_000;
const twitchRefreshing = new Set();

async function refreshTwitchLive(login) {
  if (twitchRefreshing.has(login)) return;
  twitchRefreshing.add(login);
  let live = false;
  try {
    const url = `https://static-cdn.jtvnw.net/previews-ttv/live_user_${encodeURIComponent(login)}-440x248.jpg`;
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(4000) });
    const loc = r.headers.get('location') || '';
    if (loc) live = !/404_preview|ttv-static/i.test(loc); // offline placeholder → not live
    else if (r.status === 200) live = true; // served directly (rare)
  } catch { /* network/timeout → treat as offline */ }
  twitchLiveCache.set(login, { live, at: Date.now() });
  twitchRefreshing.delete(login);
}

function twitchLiveCached(channel) {
  const login = String(channel || '').trim().replace(/^@/, '').toLowerCase();
  if (!login) return false;
  const hit = twitchLiveCache.get(login);
  if (!hit || Date.now() - hit.at > TWITCH_LIVE_TTL_MS) {
    void refreshTwitchLive(login); // fire-and-forget; first browse shows fallback, next poll upgrades
  }
  return hit ? hit.live : false;
}

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
      // The pretty link. Cards must send viewers to /<handle> when one
      // exists — a claimed room advertising its hex id defeats the feature.
      handle: cfg.handle || null,
      live,
      waiting,
      maxSeats: cfg.maxSeats,
      passkeyTickPrice: cfg.passkeyTickPrice,
      passkeyTickSeconds: cfg.passkeyTickSeconds,
      paymentTokenSymbol: cfg.paymentTokenSymbol,
      rewardsEnabled: !!cfg.rewards?.enabled,
      // Browse-card preview: Twitch publishes a free auto-updating thumbnail
      // for any live channel — no infra, and it's the streamer's already-
      // public broadcast, so no viewer-privacy concern. twitchLive gates the
      // client from rendering Twitch's gray offline placeholder.
      twitchChannel: cfg.twitchChannel || null,
      twitchLive: cfg.twitchChannel ? twitchLiveCached(cfg.twitchChannel) : false,
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

// Creator bounty (Run A). Mounts NOTHING when BOUNTY_CLAIM is off, so an
// unflagged deploy is byte-identical to before. Escrow is a ledger only —
// settlement is a record-intent stub, no funds move. See HANDOFF-BOUNTY.md.
attachBountyRoutes(app);

attachDashboardRoutes(app, {
  baseUrl: BASE_URL,
  rpcUrl: RPC_URL,
  chainId: CHAIN_ID,
  activeSeats,
  removeParticipant,
  setSeatPinned,
  atomicToUsdc,
});

await migrateLegacyRoomPasswords();

// ─── Boot cleanup: dump orphan rooms ────────────────────────────────────────
// Now that the volume persists data, junk test rooms would otherwise pile up
// forever. Prune everything that isn't the default, isn't the seeded demo, and
// isn't OWNED by a signed-in identity — so a fresh deploy stays tidy while
// owned rooms and the demo always survive. Opt out with KEEP_ORPHAN_ROOMS=true.
if (process.env.KEEP_ORPHAN_ROOMS !== 'true') {
  try {
    const removed = pruneOrphanRooms({ protectHandles: ['demo'] });
    if (removed.length) console.log(`[rooms] pruned ${removed.length} orphan room(s): ${removed.join(', ')}`);
  } catch (err) {
    console.warn('[rooms] orphan prune failed:', err.message);
  }
}

// ─── Always-on demo room at /demo ────────────────────────────────────────────
// A living showcase: dust live pricing, tiny point drops, letters on. RE-SPUN
// every boot — the canonical config is re-applied so a deploy always leaves a
// clean, current demo (LiveKit transport by default, MegaChats + drops on).
const DEMO_CONFIG = {
  isDemo: true,
  passkeyTickPrice: '0.001',
  passkeyTickSeconds: 1,
  maxSession: '0.03',
  maxSeats: 3,
  letters: { enabled: true, maxSeconds: 10, price: null, moderation: 'auto' },
  rewards: {
    enabled: true,
    earnInterval: 30,
    earnAmount: '1',
    earnCap: '50',
    rewardType: 'points',
    rewardTokenAddress: null,
  },
};
try {
  const existing = getRoomByHandle('demo');
  if (existing) {
    // Reset the demo back to its canonical config on every deploy.
    updateRoom(existing.id, { name: 'MegaChat Demo — try everything for pennies', config: DEMO_CONFIG });
    console.log(`[demo] refreshed demo room ${existing.id} at /demo`);
  } else {
    const demoPassword = process.env.DEMO_ROOM_PASSWORD
      || Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url');
    const room = await createRoomWithPassword(
      'MegaChat Demo — try everything for pennies', DEMO_CONFIG, demoPassword,
    );
    setRoomHandle(room.id, 'demo');
    console.log(
      `[demo] seeded demo room ${room.id} at /demo`
      + (process.env.DEMO_ROOM_PASSWORD ? '' : ` (password: ${demoPassword} — set DEMO_ROOM_PASSWORD to pin it)`)
    );
  }
} catch (err) {
  console.warn('[demo] demo room seed failed:', err.message);
}

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

// Browsers implicitly request /favicon.ico; the app icon lives at /icon.svg
// (Next metadata). Redirect instead of 404ing every page load.
app.get('/favicon.ico', (_req, res) => res.redirect(301, '/icon.svg'));

// ─── Permanent room links: /<handle> and /<handle>/overlay ──────────────────
// Registered HERE, dead last, on purpose: every real Express route (/overlay,
// /api/*, /auth/*) is already claimed above, so a handle can never shadow one.
// An unclaimed name calls next() and falls through to Next — its own pages
// (/join, /dashboard, /roadmap) and its 404 both still render normally.
// RESERVED_HANDLES (rooms-store.js) is the second net: those names can't be
// claimed in the first place. Handles are [a-z0-9_]{3,20}, so anything with a
// dot or dash (/how-it-works, /icon.svg) can't collide by construction.
const handleRoom = (req) => getRoomByHandle(req.params.handle);
app.get('/:handle', (req, res, next) => {
  const room = handleRoom(req);
  if (!room) return next();
  // Serve the join page IN PLACE — no redirect, so the address bar keeps
  // megachat.fun/<handle> instead of decaying to /join?room=<hex>. The
  // client resolves the room from the pathname (and /api/config accepts
  // handles), so the pretty URL is the real URL.
  req.url = '/join';
  nextHandle(req, res);
});
app.get('/:handle/overlay', (req, res, next) => {
  const room = handleRoom(req);
  if (!room) return next();
  res.redirect(302, `/overlay?room=${room.id}`);
});

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
║  MEGACHAT — UNIFIED APP (TEMPO MAINNET)    ║
╠═══════════════════════════════════════════╣
║  App:     http://localhost:${PORT}  [next ${nextDev ? 'dev' : 'prod'}]
║  Join:    http://localhost:${PORT}/join?room=<id>
║  Overlay: http://localhost:${PORT}/overlay   ║
╠═══════════════════════════════════════════╣
║  Chain:   ${NETWORK} (Tempo)
║  Meter (legacy prepaid): ${TICK_PRICE} USDC / ${TICK_SECONDS}s
║  Meter (stream):   ${PASSKEY_TICK_PRICE} USDC / ${PASSKEY_TICK_SECONDS}s  [approach ${PASSKEY_METER_APPROACH}]
║  Session cap:      ${MAX_SESSION} USDC
║  Seller:  ${SELLER_WALLET_ADDRESS}
╚═══════════════════════════════════════════╝
  `);
});
