/**
 * Streamer room config — JSON file persistence (no heavy infra).
 * Secrets stay in .env; per-room economics live here.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

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
    tickSeconds: Number(cfg.tickSeconds ?? defaults.tickSeconds),
    tickPrice: String(cfg.tickPrice ?? defaults.tickPrice),
    passkeyTickSeconds: Number(cfg.passkeyTickSeconds ?? defaults.passkeyTickSeconds),
    passkeyTickPrice: String(cfg.passkeyTickPrice ?? defaults.passkeyTickPrice),
    maxSession: String(cfg.maxSession ?? defaults.maxSession),
    maxSeats,
  };
}

export function createRoom(name, config = {}) {
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
