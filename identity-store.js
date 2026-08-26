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
// Same persistent-volume override as rooms-store — identities being wiped on
// every deploy is what made OAuth re-show the claim screen "every time".
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
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
    // saved room defaults ride the identity — re-claiming a handle must not
    // wipe them
    ...(existing?.roomDefaults ? { roomDefaults: existing.roomDefaults } : {}),
    // Platform logins survive re-claims for the same reason defaults do.
    ...(existing?.platformLogins ? { platformLogins: existing.platformLogins } : {}),
  };
  store.identities[k] = identity;
  store.handles[wanted] = k;
  save();
  return identity;
}

/**
 * Per-identity room defaults — the create form starts from these instead of
 * blank. Display/prefill data only; every room still validates its own
 * config on create. `null` clears.
 */
export function setIdentityDefaults(provider, platformId, defaults) {
  const store = load();
  const identity = store.identities[key(provider, platformId)];
  if (!identity) return null;
  if (defaults === null) delete identity.roomDefaults;
  else identity.roomDefaults = defaults;
  save();
  return identity;
}

/**
 * Per-platform OAuth logins for identities whose provider is an AGGREGATOR
 * (Privy). identity.username is the DISPLAY ladder's pick — for someone with
 * Twitch and X linked it is their Twitch name, so it can never serve as X
 * ownership proof. This map holds what each platform's own OAuth said:
 * { twitch: 'name', x: 'name' }. Written on every sign-in, so linking a new
 * platform takes effect the next time the streamer signs in.
 */
export function setPlatformLogins(provider, platformId, logins) {
  const store = load();
  const identity = store.identities[key(provider, platformId)];
  if (!identity) return null;
  const clean = {};
  for (const [k, v] of Object.entries(logins || {})) {
    if (typeof v === 'string' && v.trim()) clean[String(k).toLowerCase()] = v.trim().slice(0, 60);
  }
  if (Object.keys(clean).length) identity.platformLogins = clean;
  else delete identity.platformLogins;
  save();
  return identity;
}

/** Test helper. */
export function _resetIdentitiesForTests() {
  cache = null;
}
