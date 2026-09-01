/**
 * PLATFORM AVATARS — a face for a streamer who has never signed up.
 *
 * The bounty leaderboard lists channels that have NOT claimed their pool and
 * whose credentials we will never have. We do not need them: both platform
 * clients here authenticate as OUR APP (client credentials), and both serve
 * public profile data for any channel. Twitch does it in one batched Helix
 * call; Kick takes two hops (see kick-api.js, where the shape is documented
 * against real responses rather than guessed).
 *
 * X and Rumble return null and always will — neither exposes a profile image
 * to an unauthenticated app for an arbitrary handle, and inventing one (a
 * scraped CDN path, a favicon) would be a guess rendered as fact next to
 * somebody's name.
 *
 * THREE RULES, in the order they matter:
 *
 * 1. NEVER THROW. An avatar is decoration on a page that is about money. A
 *    platform outage, an unconfigured client, a malformed handle — every one
 *    of them resolves `null` and the caller renders a monogram. Nothing in
 *    here may take the bounty page down.
 *
 * 2. NEVER STALL. A cold cache races a deadline; whatever has not landed by
 *    then is reported as null and KEEPS RESOLVING in the background, so the
 *    next render is warm. A slow third party costs one page a monogram, not
 *    a hanging request.
 *
 * 3. "COULD NOT ASK" ≠ "NO PICTURE". Both render as null, but they cache for
 *    very different lengths: a real miss is remembered for hours, an outage
 *    for a minute. Same distinction the live-status clients make, for the
 *    same reason — collapsing the two turns a 30-second blip into a
 *    leaderboard that is faceless until the TTL expires.
 */

import { getProfileImagesByLogin, twitchApiConfigured } from './twitch-api.js';
import { getProfilePictureBySlug, kickApiConfigured } from './kick-api.js';

/** Found. Profile images change rarely; hours is honest. */
const HIT_TTL_MS = 6 * 60 * 60 * 1000;
/** Asked, and there is genuinely no picture. Shorter: they may set one. */
const MISS_TTL_MS = 30 * 60 * 1000;
/** Could not ask. Just long enough to stop one render hammering a sick API. */
const ERROR_TTL_MS = 60 * 1000;

/** Bounded so a stream of junk handles cannot grow this without limit. */
const MAX_ENTRIES = 1000;
/** How long a single leaderboard render will wait on cold lookups. */
const DEFAULT_BUDGET_MS = 1500;
/** Kick has no batch endpoint, so cap the fan-out instead. */
const KICK_CONCURRENCY = 4;
/** Helix caps `login` at 100 per call. */
const TWITCH_BATCH = 100;

const SUPPORTED = new Set(['twitch', 'kick']);

/** key → { url: string|null, expiresAt: number }. Insertion-ordered, so the
 *  oldest entry is the first one iteration yields — that is the eviction. */
const cache = new Map();
/** key → Promise<string|null>, so ten pools naming one streamer make one call. */
const inflight = new Map();

// ── keys ────────────────────────────────────────────────────────────────────

/**
 * The cache key, and the key of the Map that resolveAvatars returns.
 * Deliberately the same `platform:handle` normalisation bounty-store uses for
 * handleKey — a caller may pass either — but computed here so this module
 * does not depend on the store.
 * @returns {string|null} null for anything that could not be a handle.
 */
export function avatarKey(platform, handle) {
  const p = String(platform || '').trim().toLowerCase();
  const h = String(handle || '').trim().replace(/^@/, '').toLowerCase();
  if (!p || !h) return null;
  if (!/^[a-z0-9_.-]{1,40}$/.test(h)) return null;
  return `${p}:${h}`;
}

// ── cache ───────────────────────────────────────────────────────────────────

function readCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) { cache.delete(key); return null; }
  // Re-insert so recency, not age, decides eviction.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function writeCache(key, url, ttlMs) {
  cache.delete(key);
  cache.set(key, { url: url || null, expiresAt: Date.now() + ttlMs });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Test/gate seam. Not used in production paths. */
export function _clearAvatarCache() {
  cache.clear();
  inflight.clear();
  if (twitchTimer) clearTimeout(twitchTimer);
  // Settle anything already queued: dropping the callbacks would leave a
  // caller awaiting a promise nothing will ever resolve.
  for (const { settle } of twitchQueue) settle(null);
  twitchQueue = [];
  twitchTimer = null;
}

/** Diagnostics only — sizes, never a credential. */
export function avatarCacheStats() {
  return { entries: cache.size, inflight: inflight.size, maxEntries: MAX_ENTRIES };
}

// ── twitch: micro-batched ───────────────────────────────────────────────────
// Everything queued before the next tick goes out as ONE Helix call. This is
// why a 40-row leaderboard is one request: resolveAvatars queues all forty
// synchronously, and the flush sees all forty.

let twitchQueue = []; // [{ login, settle }]
let twitchTimer = null;

function queueTwitch(login, log) {
  return new Promise((settle) => {
    twitchQueue.push({ login, settle });
    if (!twitchTimer) {
      // The .catch is not decoration: an unhandled rejection off a timer has
      // no caller to catch it and would take the server down over an avatar.
      twitchTimer = setTimeout(() => { flushTwitch(log).catch(() => {}); }, 0);
      // Never hold the process open for a decoration.
      if (typeof twitchTimer.unref === 'function') twitchTimer.unref();
    }
  });
}

function flushTwitch(log) {
  const batch = twitchQueue;
  twitchQueue = [];
  twitchTimer = null;
  const chunks = [];
  for (let i = 0; i < batch.length; i += TWITCH_BATCH) chunks.push(batch.slice(i, i + TWITCH_BATCH));
  // Chunks in parallel, not one after another: a board with more than 100
  // pools should cost one round trip, not one per hundred.
  return Promise.all(chunks.map(async (chunk) => {
    let rows = null;
    try {
      rows = await getProfileImagesByLogin(chunk.map((c) => c.login), { log });
    } catch (e) {
      // getProfileImagesByLogin already null-objects, but a module whose whole
      // promise is "never throws" must not depend on someone else's promise.
      log.warn(`[platform-avatars] twitch batch failed: ${e?.message || e}`);
      rows = null;
    }
    for (const { login, settle } of chunk) {
      const key = `twitch:${login}`;
      if (!rows) { writeCache(key, null, ERROR_TTL_MS); settle(null); continue; }
      const url = rows.get(login) || null;
      writeCache(key, url, url ? HIT_TTL_MS : MISS_TTL_MS);
      settle(url);
    }
  }));
}

// ── kick: capped fan-out ────────────────────────────────────────────────────

let kickActive = 0;
const kickWaiting = [];

function kickSlot() {
  if (kickActive < KICK_CONCURRENCY) { kickActive += 1; return Promise.resolve(); }
  return new Promise((go) => kickWaiting.push(go));
}

function releaseKickSlot() {
  const next = kickWaiting.shift();
  if (next) next();
  else kickActive = Math.max(0, kickActive - 1);
}

async function lookupKick(slug, key, log) {
  await kickSlot();
  try {
    const res = await getProfilePictureBySlug(slug, { log });
    if (!res) { writeCache(key, null, ERROR_TTL_MS); return null; }   // could not ask
    writeCache(key, res.url, res.url ? HIT_TTL_MS : MISS_TTL_MS);
    return res.url;
  } finally {
    releaseKickSlot();
  }
}

// ── lookup ──────────────────────────────────────────────────────────────────

function lookup(platform, handle, key, log) {
  const already = inflight.get(key);
  if (already) return already;
  const p = (async () => {
    try {
      if (platform === 'twitch') {
        if (!twitchApiConfigured()) { writeCache(key, null, ERROR_TTL_MS); return null; }
        return await queueTwitch(handle, log);
      }
      if (platform === 'kick') {
        if (!kickApiConfigured()) { writeCache(key, null, ERROR_TTL_MS); return null; }
        return await lookupKick(handle, key, log);
      }
      return null;
    } catch (e) {
      log.warn(`[platform-avatars] ${key} failed: ${e?.message || e}`);
      writeCache(key, null, ERROR_TTL_MS);
      return null;
    }
  })()
    // Deliberately NOT a `finally` inside the async body: a path that returns
    // without ever awaiting (an unconfigured client) would run it before the
    // set below and strand a resolved promise in the map forever. `.finally`
    // is always a microtask, so the set has happened.
    .finally(() => { inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * One streamer's public profile image.
 * @returns {Promise<string|null>} null means "render the monogram" — no
 *   picture, no such channel, unsupported platform, or the platform was
 *   unreachable. The caller does not need to tell those apart; this module
 *   does, for caching.
 */
export async function resolveAvatar(platform, handle, { log = console } = {}) {
  try {
    const key = avatarKey(platform, handle);
    if (!key) return null;
    const hit = readCache(key);
    if (hit) return hit.url;
    const [p, h] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (!SUPPORTED.has(p)) return null; // X, Rumble, anything else: no public image API
    return await lookup(p, h, key, log);
  } catch (e) {
    // Rule 1. Whatever just happened, it is not worth a 500 on the bounty page.
    try { log.warn(`[platform-avatars] resolveAvatar(${platform}/${handle}) failed: ${e?.message || e}`); } catch {}
    return null;
  }
}

/**
 * A whole leaderboard at once — concurrently, and bounded by a deadline.
 *
 * Cached rows cost nothing. Uncached Twitch rows collapse into one Helix
 * call. Uncached Kick rows fan out up to KICK_CONCURRENCY at a time. Anything
 * still outstanding when the budget expires comes back null AND KEEPS GOING:
 * its result lands in the cache for the next render. That is the difference
 * between a cold cache costing one page its faces and a cold cache costing
 * one page its response time.
 *
 * @param {Array<{platform: string, handle: string}>} entries
 * @returns {Promise<Map<string, string|null>>} keyed by avatarKey().
 */
export async function resolveAvatars(entries, { budgetMs = DEFAULT_BUDGET_MS, log = console } = {}) {
  const out = new Map();
  try {
    const pending = [];
    for (const e of entries || []) {
      const key = avatarKey(e?.platform, e?.handle);
      if (!key || out.has(key)) continue;
      const hit = readCache(key);
      if (hit) { out.set(key, hit.url); continue; }
      // Default to the fallback, then upgrade if the lookup lands in time.
      out.set(key, null);
      const p = key.slice(0, key.indexOf(':'));
      if (!SUPPORTED.has(p)) continue;
      pending.push(
        lookup(p, key.slice(key.indexOf(':') + 1), key, log)
          .then((url) => { out.set(key, url); })
          .catch(() => {}), // rule 1: a rejection here must not reject the batch
      );
    }
    if (pending.length) await raceDeadline(Promise.allSettled(pending), budgetMs);
  } catch (e) {
    try { log.warn(`[platform-avatars] batch failed: ${e?.message || e}`); } catch {}
  }
  // A COPY: lookups that miss the deadline keep running and would otherwise
  // mutate a map the caller has already serialised.
  return new Map(out);
}

function raceDeadline(promise, ms) {
  return new Promise((done) => {
    const t = setTimeout(done, ms);
    if (typeof t.unref === 'function') t.unref();
    promise.then(() => { clearTimeout(t); done(); }, () => { clearTimeout(t); done(); });
  });
}
