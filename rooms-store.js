/**
 * Streamer room config — JSON file persistence (no heavy infra).
 * Secrets stay in .env; per-room economics live here.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { hashPassword, verifyPassword } from './room-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'rooms.json');

export const DEFAULT_ROOM_ID = 'default';

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
    rewards: resolveRewards(cfg, defaults),
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
  const passwordHash = await hashPassword(password);
  return createRoom(name, config, passwordHash);
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

/** Test helper — reset in-memory cache. */
export function _resetCacheForTests() {
  cache = null;
}
