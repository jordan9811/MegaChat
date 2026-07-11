/**
 * OAuth identities — platform account ↔ MegaChat handle. JSON persistence,
 * same zero-infra pattern as rooms-store. IDENTITY ONLY: no watch-time
 * verification, no platform drops (roadmap).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sanitizeHandle, getRoomByHandle } from './rooms-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'identities.json');

let cache = null;

function load() {
  if (cache) return cache;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    cache = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    cache = { identities: {}, handles: {} };
  }
  if (!cache.identities) cache.identities = {};
  if (!cache.handles) cache.handles = {};
  return cache;
}

function save() {
  fs.writeFileSync(STORE_PATH, JSON.stringify(cache, null, 2));
}

const key = (provider, platformId) => `${provider}:${platformId}`;

export function getIdentity(provider, platformId) {
  const store = load();
  return store.identities[key(provider, platformId)] || null;
}

export function isHandleTakenByIdentity(handle) {
  const store = load();
  return !!store.handles[handle];
}

/** Free across BOTH registries (identities + room handles). */
export function isHandleFree(handle) {
  const h = sanitizeHandle(handle);
  if (!h) return false;
  return !isHandleTakenByIdentity(h) && !getRoomByHandle(h);
}

/** First free variant of the platform username: name, name2 … name_99. */
export function suggestHandle(platformUsername) {
  const base = sanitizeHandle(platformUsername) ||
    sanitizeHandle('user_' + String(platformUsername).replace(/[^a-z0-9]/gi, '').slice(0, 10)) ||
    'user_' + Math.random().toString(36).slice(2, 8);
  if (isHandleFree(base)) return base;
  for (let i = 2; i < 100; i++) {
    const alt = sanitizeHandle(`${base.slice(0, 17)}_${i}`);
    if (alt && isHandleFree(alt)) return alt;
  }
  return sanitizeHandle(base.slice(0, 12) + '_' + Math.random().toString(36).slice(2, 6));
}

/**
 * Bind an identity to a handle. Existing identity keeps its handle unless a
 * new (free) one is chosen. Throws { code: 'handle_taken' } on conflicts.
 */
export function claimIdentity({ provider, platformId, username, handle }) {
  const store = load();
  const k = key(provider, platformId);
  const existing = store.identities[k];
  const wanted = sanitizeHandle(handle);
  if (!wanted) {
    const err = new Error('Invalid handle: 3-20 chars, letters/numbers/underscore');
    err.code = 'invalid_handle';
    throw err;
  }
  if (existing && existing.handle === wanted) return existing;
  if (!isHandleFree(wanted)) {
    const err = new Error('Handle already taken');
    err.code = 'handle_taken';
    throw err;
  }
  if (existing) delete store.handles[existing.handle];
  const identity = {
    provider,
    platformId: String(platformId),
    username: String(username).slice(0, 40),
    handle: wanted,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
  store.identities[k] = identity;
  store.handles[wanted] = k;
  save();
  return identity;
}

/** Test helper. */
export function _resetIdentitiesForTests() {
  cache = null;
}
