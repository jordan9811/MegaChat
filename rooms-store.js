/**
 * Streamer room config — JSON file persistence (no heavy infra).
 * Secrets stay in .env; per-room economics live here.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { hashPassword, verifyPassword } from './room-auth.js';
// Config-only import: reading the sampling floor so the recording minimum is
// derived from it. Pulls in no bounty behaviour and is inert when the flag
// is off.
import { bountyConfig } from './bounty-claim.config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR env points this at a persistent volume in production (Railway's
// container disk is EPHEMERAL — without it every deploy erases all rooms,
// handles and identities, which is why claims kept "coming back").
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'rooms.json');

export const DEFAULT_ROOM_ID = 'default';

/** Where rooms/identities actually live, and whether that survives a deploy.
 *  Exposed on /api/health because "did the volume attach?" is otherwise
 *  invisible until data silently vanishes on the next push. */
export function dataDirInfo() {
  return { dir: DATA_DIR, persistent: !!process.env.DATA_DIR };
}

// LiveKit is now the default transport once its 3 env vars are present
// (same condition livekit.js gates on); 'vdo' is the only sticky explicit
// choice — a room that picked it stays on it even if LiveKit gets configured
// later. Anything else (explicit 'livekit' or never set) resolves to LiveKit
// when configured, degrading gracefully back to vdo if the keys vanish.
const LIVEKIT_CONFIGURED = !!(
  process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET
);
function resolveTransport(explicit) {
  if (explicit === 'vdo') return 'vdo';
  return LIVEKIT_CONFIGURED ? 'livekit' : 'vdo';
}

/** Env-backed defaults when a room field is omitted. */
export function getEnvDefaults() {
  return {
    tickSeconds: Number(process.env.TICK_SECONDS || 10),
    tickPrice: String(process.env.TICK_PRICE || '0.1'),
    passkeyTickSeconds: Number(process.env.PASSKEY_TICK_SECONDS || 1),
    passkeyTickPrice: String(process.env.PASSKEY_TICK_PRICE || '0.001'),
    maxSession: String(process.env.MAX_SESSION || '2'),
    maxSeats: Math.min(3, Math.max(1, Number(process.env.MAX_SEATS || 3))),
    // USDC.e on Tempo mainnet (TEMPO_NOTES.md). The legacy USDC_ADDRESS var
    // stays in .env for the Arc branches but is ignored here.
    paymentTokenAddress:
      process.env.TEMPO_USDC_ADDRESS || '0x20c000000000000000000000b9537d11c60e8b50',
    paymentTokenSymbol: 'USDC.e',
    paymentTokenDecimals: 6,
    rewards: {
      enabled: false,
      earnInterval: Number(process.env.EARN_INTERVAL || 60),
      earnAmount: String(process.env.EARN_AMOUNT || '0.1'),
      earnCap: String(process.env.EARN_CAP || '5'),
      rewardType: 'usdc',
      rewardTokenAddress: null,
    },
  };
}

/** Per-feature reputation gates. minWatchSeconds is enforced today (via the
 * watch-time ledger); followers/subs are stored config until platform
 * verification ships — never silently enforced. */
function resolveGates(raw) {
  const g = raw || {};
  return {
    minWatchSeconds: Math.max(0, Math.min(86400, Number(g.minWatchSeconds ?? 0) || 0)),
    followersOnly: g.followersOnly === true,
    subsOnly: g.subsOnly === true,
  };
}

/** MegaChats — recorded clips paid at a flat price, played once on stream.
 *  Exported as a pure function so the duration bounds can be gated directly
 *  without standing up a room. */
export function resolveLetters(cfg) {
  const l = cfg.letters || {};
  /**
   * Floor DERIVED from the bounty verifier's sampling floor, not a second
   * hardcoded constant. A clip shorter than the floor cannot host a watermark
   * code long enough to be sampled out of a re-encoded broadcast, so it can
   * never be proven to have aired — and a clip that can never be proven is a
   * clip a fan paid for and nobody can be paid out. Raising the sampling floor
   * must therefore raise the recording minimum automatically; two independent
   * numbers would drift and silently reopen the hole.
   */
  const minSeconds = Math.max(
    1,
    Math.min(
      Number(l.minSeconds ?? bountyConfig.minClipSeconds) || bountyConfig.minClipSeconds,
      30,
    ),
  );
  const maxSeconds = Math.min(30, Math.max(minSeconds, Number(l.maxSeconds ?? 10) || 10));
  const price =
    typeof l.price === 'string' && parseFloat(l.price) > 0 ? String(l.price) : null;
  return {
    // MegaChats are the hero feature — ON unless the streamer turns them off.
    enabled: l.enabled !== false,
    minSeconds,
    maxSeconds,
    // null → derived at read time: maxSeconds worth of the live per-second rate
    price,
    moderation: l.moderation === 'approve' ? 'approve' : 'auto',
    // AI moderation (runs only when MODERATION_API_KEY is configured):
    // 'severe' flags only high-confidence violations; 'borderline' flags
    // anything the model marks at all.
    aiStrictness: l.aiStrictness === 'borderline' ? 'borderline' : 'severe',
    autoRefundOnReject: l.autoRefundOnReject !== false, // default ON
    gates: resolveGates(l.gates),
  };
}

/** Join Stream (live seats) — independently togglable, gates inherit from
 * MegaChats by default (billing/shipping-address pattern). */
function resolveJoinStream(cfg) {
  const j = cfg.joinStream || {};
  return {
    enabled: j.enabled !== false, // default ON — existing rooms unchanged
    gatesSameAsMegaChat: j.gatesSameAsMegaChat !== false,
    gates: resolveGates(j.gates),
  };
}

/** The gates that actually apply to Join Stream in this room. */
export function joinStreamGatesFor(cfg) {
  return cfg.joinStream.gatesSameAsMegaChat ? cfg.letters.gates : cfg.joinStream.gates;
}

/** Effective flat price for a letter in this room (token units, string). */
export function letterPriceFor(cfg) {
  if (cfg.letters?.price) return cfg.letters.price;
  const perSecond = parseFloat(cfg.passkeyTickPrice || '0.001') /
    Math.max(1, Number(cfg.passkeyTickSeconds || 1));
  const p = perSecond * (cfg.letters?.maxSeconds ?? 10);
  // FREE rooms (per-second rate 0, no explicit letter price): MegaChats are
  // free too — the old dust floor here would force a pointless payment.
  if (p <= 0) return '0';
  return String(Math.max(0.000001, Math.round(p * 1e6) / 1e6));
}

function resolveRewards(cfg, defaults) {
  const r = cfg.rewards || {};
  const d = defaults.rewards;
  return {
    enabled: r.enabled === true,
    earnInterval: Number(r.earnInterval ?? d.earnInterval),
    earnAmount: String(r.earnAmount ?? d.earnAmount),
    earnCap: String(r.earnCap ?? d.earnCap),
    rewardType: String(r.rewardType ?? d.rewardType),
    rewardTokenAddress: r.rewardTokenAddress ?? d.rewardTokenAddress,
    rewardTokenSymbol: r.rewardTokenSymbol ?? null,
    rewardTokenDecimals: r.rewardTokenDecimals ?? null,
  };
}

let cache = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadStore() {
  if (cache) return cache;
  ensureDataDir();
  if (!fs.existsSync(STORE_PATH)) {
    cache = { rooms: {} };
    ensureDefaultRoom(cache);
    saveStore(cache);
    return cache;
  }
  try {
    cache = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (!cache.rooms) cache.rooms = {};
  } catch {
    cache = { rooms: {} };
  }
  ensureDefaultRoom(cache);
  return cache;
}

/** Assign hashed default password to legacy rooms missing passwordHash. */
export async function migrateLegacyRoomPasswords() {
  const store = loadStore();
  const defaultPwd = process.env.ROOM_DEFAULT_PASSWORD || 'changeme';
  let count = 0;
  for (const rec of Object.values(store.rooms)) {
    // Owner-only rooms legitimately have no password — never force one on them.
    if (rec.ownerKey) continue;
    if (!rec.passwordHash) {
      rec.passwordHash = await hashPassword(defaultPwd);
      count++;
    }
  }
  if (count > 0) {
    saveStore(store);
    console.log(
      `[rooms] migrated ${count} legacy room(s) without password — `
      + 'use ROOM_DEFAULT_PASSWORD from .env, then set a new password in dashboard'
    );
  }
}

export async function verifyRoomPassword(roomId, password) {
  const rec = getRoomRecord(roomId);
  if (!rec?.passwordHash) return false;
  return verifyPassword(password, rec.passwordHash);
}

export async function setRoomPassword(roomId, newPassword) {
  const id = normalizeRoomId(roomId);
  if (!id) return null;
  const store = loadStore();
  const rec = store.rooms[id];
  if (!rec) return null;
  rec.passwordHash = await hashPassword(newPassword);
  saveStore(store);
  return true;
}

function saveStore(store) {
  ensureDataDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  cache = store;
}

function ensureDefaultRoom(store) {
  if (store.rooms[DEFAULT_ROOM_ID]) return;
  const d = getEnvDefaults();
  store.rooms[DEFAULT_ROOM_ID] = {
    id: DEFAULT_ROOM_ID,
    name: 'Default Room',
    active: true,
    createdAt: new Date().toISOString(),
    config: { ...d },
  };
}

// ─── Persistent handles (/<handle> permanent room links) ────────────────────
// Handles live at the ROOT (megachat.xyz/yourname), so this list is what keeps
// one from shadowing a real page. Anything containing a dot or dash is already
// unclaimable (sanitizeHandle allows only [a-z0-9_]), which covers
// /how-it-works and every static asset. What's left to reserve: current
// single-word routes, plus words a future page might plausibly want — a name
// claimed today would otherwise win over a page added tomorrow.
const RESERVED_HANDLES = new Set([
  // current routes
  'api', 'join', 'dashboard', 'overlay', 'r', 'auth', 'roadmap', 'index',
  'admin', 'www', 'assets', 'static', 'login', 'how-it-works', 'next',
  '_next', 'public', 'favicon', 'icon', 'robots', 'sitemap',
  // plausible future routes — cheap to reserve now, painful to reclaim later
  'about', 'blog', 'browse', 'careers', 'channel', 'contact', 'docs',
  'explore', 'faq', 'help', 'home', 'jobs', 'legal', 'live', 'logout',
  'me', 'press', 'pricing', 'privacy', 'room', 'rooms', 'settings',
  'signin', 'signup', 'status', 'support', 'terms', 'user', 'users',
  'watch', 'embed', 'search', 'new', 'create', 'billing', 'account',
]);

/** 3-20 chars, a-z 0-9 _ ; lowercased. Null if unset/invalid/reserved. */
export function sanitizeHandle(raw) {
  if (raw == null) return null;
  const h = String(raw).trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(h)) return null;
  if (RESERVED_HANDLES.has(h)) return null;
  return h;
}

export function getRoomByHandle(handle) {
  const h = sanitizeHandle(handle);
  if (!h) return null;
  const store = loadStore();
  for (const rec of Object.values(store.rooms)) {
    if (rec.handle === h) return resolveRoomConfig(rec.id);
  }
  return null;
}

/**
 * Optional external veto on handle claims, registered at boot. Exists so the
 * creator-bounty feature can protect a handle it has reserved for a specific
 * streamer without this module importing the bounty store (which would be a
 * cycle: bounty-store → rooms-store → bounty-store). Null unless something
 * registers, so the default path is byte-identical to before.
 */
let handleGuard = null;
export function setHandleGuard(fn) { handleGuard = typeof fn === 'function' ? fn : null; }

/** Claim (or change) a room's handle. Returns the handle, or throws on conflict. */
export function setRoomHandle(roomId, rawHandle) {
  const id = normalizeRoomId(roomId);
  const store = loadStore();
  const rec = id ? store.rooms[id] : null;
  if (!rec) throw new Error('Room not found');
  if (rawHandle == null || rawHandle === '') {
    delete rec.handle;
    saveStore(store);
    return null;
  }
  const h = sanitizeHandle(rawHandle);
  if (!h) throw new Error('Invalid handle: 3-20 chars, letters/numbers/underscore');
  for (const other of Object.values(store.rooms)) {
    if (other.id !== rec.id && other.handle === h) {
      const err = new Error('Handle already taken');
      err.code = 'handle_taken';
      throw err;
    }
  }
  // Bounty reservations get a veto: without this, a pool accumulated against
  // a streamer's name could be orphaned by anyone grabbing that handle first.
  // Throws (never silently rejects) so the caller surfaces a real reason.
  if (handleGuard) handleGuard(h, rec.id);
  rec.handle = h;
  saveStore(store);
  return h;
}

/** Twitch login names: 3-25 chars, alphanumeric + underscore. Null if unset/bad. */
export function sanitizeTwitchChannel(raw) {
  if (raw == null) return null;
  const name = String(raw).trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_]{3,25}$/.test(name) ? name : null;
}

export function normalizeRoomId(raw) {
  if (raw == null || raw === '') return DEFAULT_ROOM_ID;
  const id = String(raw).trim().toLowerCase();
  if (!/^[a-z0-9-]{1,32}$/.test(id)) return null;
  return id;
}

export function listRooms() {
  const store = loadStore();
  return Object.values(store.rooms).map((r) => ({
    id: r.id,
    name: r.name,
    active: r.active !== false,
    createdAt: r.createdAt,
    config: resolveRoomConfig(r.id),
  }));
}

export function getRoomRecord(roomId) {
  const id = normalizeRoomId(roomId);
  if (!id) return null;
  const store = loadStore();
  return store.rooms[id] || null;
}

/** Effective room config (defaults merged). Returns null if room missing. */
export function resolveRoomConfig(roomId) {
  const id = normalizeRoomId(roomId);
  if (!id) return null;
  const rec = getRoomRecord(id);
  if (!rec) return null;
  const defaults = getEnvDefaults();
  const cfg = rec.config || {};
  const handle = rec.handle || null;
  const maxSeats = Math.min(3, Math.max(1, Number(cfg.maxSeats ?? defaults.maxSeats)));
  return {
    id: rec.id,
    name: rec.name || rec.id,
    active: rec.active !== false,
    // Rooms are public/listed by default; unlisted rooms still work by
    // direct link but are hidden from the browse directory.
    unlisted: cfg.unlisted === true,
    tickSeconds: Number(cfg.tickSeconds ?? defaults.tickSeconds),
    tickPrice: String(cfg.tickPrice ?? defaults.tickPrice),
    passkeyTickSeconds: Number(cfg.passkeyTickSeconds ?? defaults.passkeyTickSeconds),
    passkeyTickPrice: String(cfg.passkeyTickPrice ?? defaults.passkeyTickPrice),
    maxSession: String(cfg.maxSession ?? defaults.maxSession),
    maxSeats,
    ...resolvePaymentToken(cfg, defaults),
    // Streamer payout wallet — session settlements pay here directly.
    // null → the platform seller wallet (env) receives.
    payoutAddress: /^0x[0-9a-fA-F]{40}$/.test(String(cfg.payoutAddress || ''))
      ? String(cfg.payoutAddress)
      : null,
    // Twitch login of the room's target stream — the join page embeds it as
    // the delayed "spectate" surface. null → no embed. (Additive field;
    // rooms.json is branch-shared, Arc branches simply ignore it.)
    twitchChannel: sanitizeTwitchChannel(cfg.twitchChannel),
    letters: resolveLetters(cfg),
    joinStream: resolveJoinStream(cfg),
    rewards: resolveRewards(cfg, defaults),
    // Permanent identity: /<handle> resolves here forever; old id links
    // keep working untouched.
    handle,
    isDemo: cfg.isDemo === true,
    // Camera transport: LiveKit is the default once LIVEKIT_* env is present;
    // vdo.ninja is the sticky backup for rooms that explicitly chose it.
    transport: resolveTransport(cfg.transport),
    // Overlay stinger SFX (synthesized in-browser, master toggle, default on).
    stingerSounds: cfg.stingerSounds !== false,
    // Use the owner's LINKED Twitch account automatically (embed on the join
    // page + browse thumbnail). Default ON — if you've connected Twitch, the
    // obvious intent is to use it, so it should not be something you go
    // hunting for in Advanced. Set false to opt out and keep the field blank.
    twitchAuto: cfg.twitchAuto !== false,
    // Lazy connect scope (see LIVEKIT-AUDIT.md + livekit-lazy.config.js):
    //   'seat'      — DEFAULT. Overlay connects only while a seat is being
    //                 bought or held. Cheapest by far; idle costs nothing.
    //   'broadcast' — Overlay stays connected for the whole broadcast. ~6x
    //                 better than the old always-on bug but a 4h/day streamer
    //                 still burns ~7,200 min/month, so it does NOT get under
    //                 the free tier on its own. For a streamer who wants zero
    //                 chance of pop-in and will pay for it.
    lazyConnectScope: cfg.lazyConnectScope === 'broadcast' ? 'broadcast' : 'seat',
  };
}

// data/rooms.json is SHARED with the Arc branches (gitignored, one working
// dir), so persisted rooms may still carry Arc Testnet token addresses. Remap
// them to the Tempo default AT READ TIME — never rewrite the file in place,
// or the Arc fallback branches would inherit Tempo addresses.
const LEGACY_ARC_TOKENS = new Set([
  '0x3600000000000000000000000000000000000000', // Arc Testnet USDC
]);

function resolvePaymentToken(cfg, defaults) {
  const raw = String(cfg.paymentTokenAddress ?? '').toLowerCase();
  if (!raw || LEGACY_ARC_TOKENS.has(raw)) {
    return {
      paymentTokenAddress: defaults.paymentTokenAddress,
      paymentTokenSymbol: defaults.paymentTokenSymbol,
      paymentTokenDecimals: defaults.paymentTokenDecimals,
    };
  }
  return {
    paymentTokenAddress: String(cfg.paymentTokenAddress),
    paymentTokenSymbol: String(cfg.paymentTokenSymbol ?? defaults.paymentTokenSymbol),
    paymentTokenDecimals: Number(cfg.paymentTokenDecimals ?? defaults.paymentTokenDecimals),
  };
}

export function createRoom(name, config = {}, passwordHash = null) {
  const store = loadStore();
  let id;
  do {
    id = randomUUID().replace(/-/g, '').slice(0, 8);
  } while (store.rooms[id]);

  const defaults = getEnvDefaults();
  const rec = {
    id,
    name: String(name || 'My Stream').slice(0, 64),
    active: true,
    createdAt: new Date().toISOString(),
    passwordHash,
    config: {
      ...defaults,
      ...config,
      maxSeats: Math.min(3, Math.max(1, Number(config.maxSeats ?? defaults.maxSeats))),
    },
  };
  store.rooms[id] = rec;
  saveStore(store);
  return resolveRoomConfig(id);
}

export async function createRoomWithPassword(name, config, password) {
  // Password is now OPTIONAL: a signed-in owner needs none (ownership is the
  // auth); a password, when set, is the mod-share key. No password → null hash,
  // which verifyPassword never matches, so the room is owner-only.
  const passwordHash = password ? await hashPassword(password) : null;
  return createRoom(name, config, passwordHash);
}

// ─── Room ownership (by signed-in identity) ─────────────────────────────────
// ownerKey is `${provider}:${platformId}` — stable per Privy account. Lets the
// owner manage without a password, and powers the dashboard "your rooms" list.
export function setRoomOwner(roomId, ownerKey) {
  const id = normalizeRoomId(roomId);
  const store = loadStore();
  const rec = id ? store.rooms[id] : null;
  if (!rec || !ownerKey) return null;
  rec.ownerKey = String(ownerKey);
  saveStore(store);
  return rec.ownerKey;
}

export function isRoomOwnedBy(roomId, ownerKey) {
  if (!ownerKey) return false;
  const rec = getRoomRecord(roomId);
  return !!rec && rec.ownerKey === String(ownerKey);
}

/** Lean cards for the dashboard "your rooms" list, newest first. */
export function roomsOwnedBy(ownerKey) {
  if (!ownerKey) return [];
  const store = loadStore();
  return Object.values(store.rooms)
    .filter((r) => r.ownerKey === String(ownerKey))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .map((r) => ({
      id: r.id,
      name: r.name || r.id,
      handle: r.handle || null,
      active: r.active !== false,
      createdAt: r.createdAt || null,
      hasPassword: !!r.passwordHash,
    }));
}

export function updateRoom(roomId, patch) {
  const id = normalizeRoomId(roomId);
  if (!id) return null;
  const store = loadStore();
  const rec = store.rooms[id];
  if (!rec) return null;

  if (patch.name != null) rec.name = String(patch.name).slice(0, 64);
  if (patch.active != null) rec.active = !!patch.active;
  if (patch.config) {
    rec.config = { ...(rec.config || {}), ...patch.config };
    if (rec.config.maxSeats != null) {
      rec.config.maxSeats = Math.min(3, Math.max(1, Number(rec.config.maxSeats)));
    }
  }
  saveStore(store);
  return resolveRoomConfig(id);
}

export function setRoomActive(roomId, active) {
  return updateRoom(roomId, { active: !!active });
}

export function deleteRoom(roomId) {
  const id = normalizeRoomId(roomId);
  if (!id || id === DEFAULT_ROOM_ID) return false; // never delete the default
  const store = loadStore();
  if (!store.rooms[id]) return false;
  delete store.rooms[id];
  saveStore(store);
  return true;
}

/**
 * Remove orphan rooms: everything that is NOT the default, NOT a protected
 * handle (the demo), and has NO ownerKey. Restores the useful part of the old
 * ephemeral behavior (junk test rooms don't pile up) now that the volume makes
 * data durable — while OWNED rooms and the seeded demo always survive. Returns
 * the ids removed.
 */
export function pruneOrphanRooms({ protectHandles = [] } = {}) {
  const store = loadStore();
  const protect = new Set(protectHandles);
  const removed = [];
  for (const rec of Object.values(store.rooms)) {
    if (rec.id === DEFAULT_ROOM_ID) continue;
    if (rec.handle && protect.has(rec.handle)) continue;
    if (rec.ownerKey) continue; // someone owns it — keep
    removed.push(rec.id);
    delete store.rooms[rec.id];
  }
  if (removed.length) saveStore(store);
  return removed;
}

/** Test helper — reset in-memory cache. */
export function _resetCacheForTests() {
  cache = null;
}
