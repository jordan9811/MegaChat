/**
 * Streamer room config — JSON file persistence (no heavy infra).
 * Secrets stay in .env; per-room economics live here.
 */
import path from 'path';
import { randomUUID } from 'crypto';
import { hashPassword, verifyPassword } from './room-auth.js';
// Config-only import: reading the sampling floor so the recording minimum is
// derived from it. Pulls in no bounty behaviour and is inert when the flag
// is off.
import { bountyConfig } from './bounty-claim.config.js';
import { createJsonStore, dataDir, readJsonFile, writeJsonAtomic } from './json-store.js';
import { envNum } from './env-num.js';

// DATA_DIR env points this at a persistent volume in production (Railway's
// container disk is EPHEMERAL — without it every deploy erases all rooms,
// handles and identities, which is why claims kept "coming back").
const storePath = () => path.join(dataDir(), 'rooms.json');

export const DEFAULT_ROOM_ID = 'default';

const bootMarkerPath = () => path.join(dataDir(), 'boot-marker.json');
/**
 * Persistence EVIDENCE, not persistence configuration.
 *
 * The previous check was `!!process.env.DATA_DIR`, which only proves someone
 * set a variable — it cannot tell an attached volume from a path pointing at
 * container-local disk that the next deploy erases. That distinction is the
 * whole question, and a storage design resting on the wrong answer is
 * worthless. So instead of asking the config, we leave a marker and see
 * whether it is still there next boot.
 *
 * Note the asymmetry: seeing a prior boot PROVES the directory survived a
 * restart. Not seeing one proves nothing — it is equally consistent with a
 * genuine first boot after this code shipped. So this reports `proven` or
 * `unproven`, and never claims a volume is absent.
 *
 * Written by `recordBoot()`, which the server calls once at boot — not at
 * import, which used to drop a marker into the repo's own data/ whenever a
 * gate imported this module before pointing DATA_DIR at its scratch dir.
 */
function readBootHistory() {
  const r = readJsonFile(bootMarkerPath());
  return r.state === 'ok' && Array.isArray(r.data?.boots) ? r.data.boots : [];
}

let bootEvidence = null; // { priorBoots, thisBoot }, once recordBoot has run

/** Leave this boot's marker. Idempotent within a process. */
export function recordBoot() {
  if (bootEvidence) return bootEvidence;
  const priorBoots = readBootHistory();
  const thisBoot = { id: randomUUID().slice(0, 8), at: new Date().toISOString() };
  try {
    writeJsonAtomic(bootMarkerPath(), { boots: [...priorBoots, thisBoot].slice(-20) }, { pretty: true });
  } catch {
    /* observability only — never worth failing a boot over */
  }
  bootEvidence = { priorBoots, thisBoot };
  return bootEvidence;
}

/** Where rooms/identities actually live, and whether that survives a deploy.
 *  Exposed on /api/health because "did the volume attach?" is otherwise
 *  invisible until data silently vanishes on the next push. */
export function dataDirInfo() {
  const { priorBoots, thisBoot } = bootEvidence || { priorBoots: readBootHistory(), thisBoot: null };
  const proven = priorBoots.length > 0;
  return {
    dir: dataDir(),
    // Kept as the same boolean field, but it now means PROVEN rather than
    // merely configured.
    persistent: proven,
    configured: !!process.env.DATA_DIR,
    evidence: {
      status: proven ? 'proven' : 'unproven',
      priorBoots: priorBoots.length,
      firstSeenAt: priorBoots[0]?.at || null,
      lastBootAt: priorBoots[priorBoots.length - 1]?.at || null,
      thisBootAt: thisBoot?.at || null,
      note: proven
        ? 'a marker written by an earlier boot was still here — this directory survives restarts'
        : 'no earlier boot marker found. This is expected on the first boot after this check shipped '
          + 'and does NOT mean the volume is missing; check again after the next deploy.',
    },
  };
}

// LiveKit is now the default transport once its 3 env vars are present
// (same condition livekit.js gates on); 'vdo' is the only sticky explicit
// choice — a room that picked it stays on it even if LiveKit gets configured
// later. Anything else (explicit 'livekit' or never set) resolves to LiveKit
// when configured, degrading gracefully back to vdo if the keys vanish.
//
// READ AT CALL TIME, the runtime-env.js rule (audit harness-10). This was a
// constant computed at import, and server.js imports this module before it
// runs process.loadEnvFile(), so LiveKit keys that live only in .env (every
// local run) read as absent here while livekit.js, built after the load, was
// configured: local rooms defaulted to vdo, production (variables in the
// process env) to LiveKit, and no local run ever exercised production's
// default transport.
const livekitConfigured = () => !!(
  process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET
);
function resolveTransport(explicit) {
  if (explicit === 'vdo') return 'vdo';
  return livekitConfigured() ? 'livekit' : 'vdo';
}

/** Env-backed defaults when a room field is omitted. Numbers go through
 *  env-num.js: a malformed value (say MAX_SEATS='three') used to read as NaN
 *  and travel into every room's config. */
export function getEnvDefaults() {
  return {
    tickSeconds: envNum('TICK_SECONDS', 10),
    tickPrice: String(process.env.TICK_PRICE || '0.1'),
    passkeyTickSeconds: envNum('PASSKEY_TICK_SECONDS', 1),
    passkeyTickPrice: String(process.env.PASSKEY_TICK_PRICE || '0.001'),
    maxSession: String(process.env.MAX_SESSION || '2'),
    maxSeats: Math.min(3, Math.max(1, envNum('MAX_SEATS', 3))),
    // USDC.e on Tempo mainnet (TEMPO_NOTES.md). The legacy USDC_ADDRESS var
    // stays in .env for the Arc branches but is ignored here.
    paymentTokenAddress:
      process.env.TEMPO_USDC_ADDRESS || '0x20c000000000000000000000b9537d11c60e8b50',
    paymentTokenSymbol: 'USDC.e',
    paymentTokenDecimals: 6,
    rewards: {
      enabled: false,
      earnInterval: envNum('EARN_INTERVAL', 60),
      // Inside rewards.js's server bounds (REWARDS_MAX_EARN 0.01, REWARDS_MAX_CAP
      // 0.1): the old 0.1 / 5 defaults sat above them, so switching rewards on
      // for an existing room was refused as out of bounds.
      earnAmount: String(process.env.EARN_AMOUNT || '0.01'),
      earnCap: String(process.env.EARN_CAP || '0.1'),
      rewardType: 'usdc',
      rewardTokenAddress: null,
    },
  };
}

/** Per-feature reputation gates. minWatchSeconds is enforced today (via the
 * watch-time ledger); followers/subs are stored config until platform
 * verification ships — never silently enforced. */
/**
 * OVERLAY LAYOUT — where the tiles sit on the streamer's canvas.
 *
 * ON THE ROOM RECORD, not in a store of its own. The overlay already reads the
 * room on connect, so this costs no second read; it cannot be orphaned when a
 * room is deleted; it inherits whatever read-modify-write handling rooms-store
 * has; and a streamer editing mid-stream while the overlay reconnects is
 * exactly the race a separate file loses. A separate store would only earn its
 * keep on record size or write contention, and this is ~10 fields written by
 * one person occasionally.
 *
 * THE DEFAULTS ARE THE CURRENT HARDCODED GRID, to the pixel: #stage was
 * `top:20px right:20px`, tiles 320x180, 12px gap, stacking downward. An
 * existing room therefore renders identically until somebody edits it — the
 * migration is that there is no migration.
 *
 * `version` is an integer the overlay compares against what it last applied.
 * It is bumped on every change so a mid-stream edit is detectable without
 * diffing the object, and so the overlay can re-place tiles WITHOUT
 * reassigning seat indices: seat N stays seat N, only its canvas position
 * moves.
 */
const LAYOUT_ORIGINS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const LAYOUT_DIRECTIONS = ['down', 'up', 'right', 'left'];

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}

export function resolveLayout(raw) {
  const l = raw || {};
  const t = l.tile || {};
  const c = l.clip || {};
  return {
    version: clampInt(l.version, 1, 2_000_000_000, 1),
    origin: LAYOUT_ORIGINS.includes(l.origin) ? l.origin : 'top-right',
    direction: LAYOUT_DIRECTIONS.includes(l.direction) ? l.direction : 'down',
    margin: clampInt(l.margin, 0, 400, 20),
    tile: {
      // Floors are the legibility floor, not taste: the bounty badge is read
      // back off a downscaled broadcast frame, and a tile under ~160px wide
      // takes the badge below the verifier's pixel floor with it.
      w: clampInt(t.w, 160, 1920, 320),
      h: clampInt(t.h, 90, 1080, 180),
      gap: clampInt(t.gap, 0, 200, 12),
    },
    clip: {
      // `follow` keeps a MegaChat clip in the same stack as the seats, which
      // is what the overlay does today. Turning it off gives the clip its own
      // size and corner.
      follow: c.follow !== false,
      w: clampInt(c.w, 160, 1920, 320),
      h: clampInt(c.h, 90, 1080, 180),
      origin: LAYOUT_ORIGINS.includes(c.origin) ? c.origin : 'top-left',
      margin: clampInt(c.margin, 0, 400, 20),
    },
  };
}

/**
 * The tile ceiling, and the one place it is defined.
 *
 * server.js derives the seat cap from it (`effectiveMaxSeats`) and the layout
 * refusal below reserves space against it, so the two cannot drift: a layout
 * accepted for 3 tiles but rendered with 10 (a whitelisted guest raises the
 * cap mid-stream) is exactly the case that would bury the badge after the
 * streamer had already agreed to the layout.
 */
/** A layout that would bury the verification badge. Carries a streamer-facing
 *  reason, because a refusal with no reason is the same silent denial the
 *  review builder's own comment warns about. */
export class LayoutRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'LayoutRefused';
    this.code = 'layout_refused';
  }
}

export function maxEffectiveSeats() {
  return Math.max(1, envNum('MEGACHAT_MAX_SEATS', 10));
}

/** The canvas the overlay is designed against. Matches the editor's preview. */
const CANVAS_W = 1920;
const CANVAS_H = 1080;

/**
 * The box the bounty badge needs, INCLUDING its inset from the corner.
 *
 * Derived, not guessed. The badge is a row of: 3px border-left + 12px padding
 * + the "MEGACHAT" mark + an 8px gap + the dot-matrix canvas + 12px padding.
 * The canvas is drawMatrix(code, dot=4) on a 7-char code, i.e. 47x13 dots =
 * 188x52 css px (code-matrix.cjs matrixSize; bounty-watermark.js always emits
 * `NN-XXXX`), so the default badge is about 293x64. The `.too-small` and
 * `.legacy-code` states swap the canvas for text and are wider but far
 * shorter (~337x25). 360x80 covers every state with margin, and BADGE_INSET
 * matches the 16px the overlay pins it at.
 */
const BADGE_INSET = 16;
const BADGE_W = 360;
const BADGE_H = 80;

const rectsOverlap = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** A rect anchored `margin` in from the named corner of the canvas. */
function anchored(vert, horiz, w, h, margin) {
  return {
    x: horiz === 'left' ? margin : CANVAS_W - margin - w,
    y: vert === 'top' ? margin : CANVAS_H - margin - h,
    w,
    h,
  };
}

/**
 * Where the seat stack actually lands, and where the badge goes because of it.
 *
 * `origin` picks the cross-axis side and `direction` picks the edge the stack
 * grows from — the semantics the layout editor's preview has always drawn and
 * that the overlay now matches (see applyStageAnchor in public/overlay.html).
 * The badge takes the diagonally opposite corner of wherever the stack ends up,
 * which is NOT simply the opposite of `origin`: origin top-left with direction
 * up puts the stack bottom-left, so the badge belongs top-right.
 */
export function layoutGeometry(layout, seats) {
  const l = resolveLayout(layout);
  const n = Math.max(1, Number(seats) || 1);
  const vert = l.direction === 'down' || l.direction === 'up';
  const stackVert = vert ? (l.direction === 'down' ? 'top' : 'bottom')
    : (l.origin.startsWith('top') ? 'top' : 'bottom');
  const stackHoriz = vert ? (l.origin.endsWith('left') ? 'left' : 'right')
    : (l.direction === 'right' ? 'left' : 'right');
  const span = n * ((vert ? l.tile.h : l.tile.w) + l.tile.gap) - l.tile.gap;
  const tiles = anchored(stackVert, stackHoriz,
    vert ? l.tile.w : span, vert ? span : l.tile.h, l.margin);
  const badgeVert = stackVert === 'top' ? 'bottom' : 'top';
  const badgeHoriz = stackHoriz === 'left' ? 'right' : 'left';
  const badge = anchored(badgeVert, badgeHoriz, BADGE_W, BADGE_H, BADGE_INSET);
  const clip = l.clip.follow ? null : anchored(
    l.clip.origin.startsWith('top') ? 'top' : 'bottom',
    l.clip.origin.endsWith('left') ? 'left' : 'right',
    l.clip.w, l.clip.h, l.clip.margin);
  return { layout: l, seats: n, vertical: vert, tiles, badge, clip, badgeCorner: `${badgeVert}-${badgeHoriz}` };
}

/**
 * Refuse a layout that would bury the badge. Returns a reason, or null.
 *
 * Checked at the CEILING, not at the room's configured seat count: a guest can
 * raise the cap mid-stream, and a layout that only collides at the tenth tile
 * would fail on the one broadcast the streamer cared about. An occluded badge
 * is a clip that genuinely aired reading as unverifiable, which is the failure
 * this project weighs heaviest — so this refuses the save rather than quietly
 * relocating the badge to a corner the streamer never chose.
 */
export function layoutCollision(layout, seats = maxEffectiveSeats()) {
  const g = layoutGeometry(layout, seats);
  if (rectsOverlap(g.tiles, g.badge)) {
    return `This layout covers the verification badge at ${g.seats} tiles. `
      + `The badge sits ${g.badgeCorner.replace('-', ' ')}; your tiles reach it. `
      + 'Use a smaller tile, a smaller gap, or the opposite corner.';
  }
  if (g.clip && rectsOverlap(g.clip, g.badge)) {
    return 'The MegaChat clip corner covers the verification badge. '
      + 'Move the clip, shrink it, or let it follow the seat stack.';
  }
  return null;
}

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
  const parsedPrice = typeof l.price === 'string' ? parseFloat(l.price) : NaN;
  const price = Number.isFinite(parsedPrice) && parsedPrice >= 0 ? String(parsedPrice) : null;
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
    admission: ['approve', 'manual'].includes(j.admission) ? j.admission : 'ai',
    liveSafety: ['remove', 'host'].includes(j.liveSafety) ? j.liveSafety : 'alert',
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
    // A USDC reward is paid as cash unless the room asks for seat credit
    // (rewards.js reads this; it used to be stripped here, so every USDC
    // room was cash whatever it stored — money H7).
    payout: r.payout === 'credit' ? 'credit' : 'cash',
  };
}

// Written through on every change, atomically (json-store.js). A rooms.json
// that cannot be read is never treated as empty: the store refuses writes and
// the file stays as it is (DECISIONS D3) — the old loader served `{}`, and the
// boot path (the password migration, then the demo seed) saved that over the
// real rooms before anyone could look.
const rooms = createJsonStore({
  file: storePath,
  name: 'rooms',
  pretty: true,
  writeIfMissing: true,
  empty: () => ({ rooms: {} }),
  normalize: (doc) => {
    if (!doc.rooms || typeof doc.rooms !== 'object') doc.rooms = {};
    ensureDefaultRoom(doc);
    return doc;
  },
});

const loadStore = () => rooms.data();

/**
 * Why rooms.json is refused, or null. A sweep that deletes what belongs to
 * rooms that no longer exist (airings, kept clips, posters) must check this
 * first: a refused store serves only the default room, and "every other room
 * is gone" is exactly the wrong conclusion to act on.
 */
export function roomsRefusal() {
  return rooms.refusal();
}

/**
 * Give the DEFAULT room a password from ROOM_DEFAULT_PASSWORD when it has none.
 *
 * Scoped to the default room, and to an explicitly set variable (stores-13,
 * stores-15). It used to hash EVERY owner-less room, falling back to the
 * public string 'changeme': every password-less room on the box then shared
 * one guessable password, and the boot pruner — which runs after this — could
 * no longer tell a room nobody can manage from one somebody can (DECISIONS D1).
 * Unset, the default room stays password-less: listed and joinable, managed by
 * nobody until the variable is set. Rotating the variable never re-hashes a
 * room that already has a password; only the dashboard changes one.
 */
export async function migrateLegacyRoomPasswords() {
  const refusal = rooms.refusal();
  if (refusal) {
    console.warn(`[rooms] default-room password migration skipped: ${refusal.file} is refused (${refusal.why})`);
    return;
  }
  const rec = loadStore().rooms[DEFAULT_ROOM_ID];
  if (!rec || rec.passwordHash || rec.ownerKey) return;
  const pwd = process.env.ROOM_DEFAULT_PASSWORD;
  if (!pwd) {
    console.log('[rooms] the default room has no password and ROOM_DEFAULT_PASSWORD is unset — nobody can manage it from the dashboard');
    return;
  }
  const hash = await hashPassword(pwd);
  const now = loadStore().rooms[DEFAULT_ROOM_ID];
  if (!now || now.passwordHash) return; // someone set one during the hash
  now.passwordHash = hash;
  saveStore();
  console.log('[rooms] the default room now takes ROOM_DEFAULT_PASSWORD — set its own password in the dashboard');
}

export async function verifyRoomPassword(roomId, password) {
  const rec = getRoomRecord(roomId);
  if (!rec?.passwordHash) return false;
  return verifyPassword(password, rec.passwordHash);
}

export async function setRoomPassword(roomId, newPassword) {
  const id = normalizeRoomId(roomId);
  if (!id) return null;
  if (!loadStore().rooms[id]) return null;
  const hash = await hashPassword(newPassword);
  rooms.assertWritable();
  const rec = loadStore().rooms[id];
  if (!rec) return null;
  rec.passwordHash = hash;
  saveStore();
  return true;
}

function saveStore() {
  rooms.save();
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
  // the landing/app split: /app is the room board and /legacy the previous
  // front end. Both are plain lowercase, so neither the dash-or-dot rule nor
  // anything else stops a handle from shadowing them — /:handle is matched
  // BEFORE the Next fallthrough, so claiming one would make the page
  // unreachable. 'bounty' had the same gap, and so did 'dev' — the site
  // owner's settings page, a Next page behind the same fallthrough.
  'app', 'legacy', 'bounty', 'dev',
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

/**
 * The handle `rawHandle` would give room `rec`: null to clear it, or the
 * sanitized name. Throws, changing nothing, when the name is invalid, another
 * room holds it, or a bounty reservation vetoes it.
 */
function checkedHandle(store, rec, rawHandle) {
  if (rawHandle == null || rawHandle === '') return null;
  const h = sanitizeHandle(rawHandle);
  if (!h) throw Object.assign(new Error('Invalid handle: 3-20 chars, letters/numbers/underscore'), { code: 'invalid_handle' });
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
  return h;
}

function assignHandle(rec, h) {
  if (h) rec.handle = h;
  else delete rec.handle;
}

/** Claim (or change) a room's handle. Returns the handle, or throws on conflict. */
export function setRoomHandle(roomId, rawHandle) {
  const id = normalizeRoomId(roomId);
  const store = loadStore();
  const rec = id ? store.rooms[id] : null;
  if (!rec) throw new Error('Room not found');
  rooms.assertWritable();
  const h = checkedHandle(store, rec, rawHandle);
  assignHandle(rec, h);
  saveStore();
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
    layout: resolveLayout(cfg.layout),
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

/**
 * A room name, at most 64 CHARACTERS. Cut by code point, not UTF-16 unit:
 * `.slice(0, 64)` split an emoji in a Twitch title and stored a lone
 * surrogate (stores-10). server.js compares a stream title through this too,
 * so the follow loop and the store agree on what "unchanged" means.
 */
export function clampRoomName(s) {
  return Array.from(String(s)).slice(0, 64).join('');
}

export function createRoom(name, config = {}, passwordHash = null) {
  const store = loadStore();
  rooms.assertWritable();
  let id;
  do {
    id = randomUUID().replace(/-/g, '').slice(0, 8);
  } while (store.rooms[id]);

  const defaults = getEnvDefaults();
  const rec = {
    id,
    name: clampRoomName(name || 'My Stream'),
    active: true,
    createdAt: new Date().toISOString(),
    passwordHash,
    config: {
      ...defaults,
      ...config,
      maxSeats: Math.min(3, Math.max(1, Number(config.maxSeats ?? defaults.maxSeats))),
    },
  };
  // The other write path. Guarding only updateRoom would let a room be born
  // with a layout that buries the badge — account defaults carry `layout`
  // into the create payload, so this is reachable without touching the editor.
  if (config.layout) {
    const why = layoutCollision(rec.config.layout);
    if (why) throw new LayoutRefused(why);
  }
  store.rooms[id] = rec;
  saveStore();
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
// ownerKey is the ACCOUNT id (`acct_…`) — stable across every platform login
// linked to that person, and set by `roomOwnerKey` in auth.js. Lets the
// owner manage without a password, and powers the dashboard "your rooms" list.
export function setRoomOwner(roomId, ownerKey) {
  const id = normalizeRoomId(roomId);
  const store = loadStore();
  const rec = id ? store.rooms[id] : null;
  if (!rec || !ownerKey) return null;
  rooms.assertWritable();
  rec.ownerKey = String(ownerKey);
  saveStore();
  return rec.ownerKey;
}

/**
 * Who owns this room, or null if nobody does.
 *
 * `isRoomOwnedBy` answers false for BOTH "someone else owns it" and "nobody
 * owns it", which is the wrong shape for a caller that has to refuse the
 * first and allow the second — binding a bounty air session to a room
 * (E37) is exactly that caller.
 */
export function roomOwnerOf(roomId) {
  const rec = getRoomRecord(roomId);
  return rec?.ownerKey || null;
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

/**
 * What `patch` makes of `rec`, computed without touching it. Throws
 * LayoutRefused when the merged layout would bury the badge.
 */
function patchedFields(rec, patch) {
  const next = {};
  if (patch.name != null) next.name = clampRoomName(patch.name);
  if (patch.active != null) next.active = !!patch.active;
  if (patch.config) {
    const merged = { ...(rec.config || {}), ...patch.config };
    if (merged.maxSeats != null) {
      merged.maxSeats = Math.min(3, Math.max(1, Number(merged.maxSeats)));
    }
    // REFUSE BEFORE WRITING, not at read time. resolveLayout clamps on read,
    // so a layout that buries the badge would otherwise be stored verbatim and
    // simply read back clamped — accepted, persisted, and wrong on the
    // broadcast. This is the single choke point every layout write funnels
    // through, so the HTTP route cannot be bypassed by calling the API direct.
    if (patch.config.layout) {
      const why = layoutCollision(merged.layout);
      if (why) throw new LayoutRefused(why);
    }
    next.config = merged;
  }
  return next;
}

/**
 * Apply `patch` (name, active, config) to a room. All or nothing: the record
 * is changed only after every check has passed. It used to assign the name
 * and `active` first and refuse the layout after, so a refused save left them
 * in the served cache and the next unrelated write persisted them (stores-7).
 */
export function updateRoom(roomId, patch) {
  const id = normalizeRoomId(roomId);
  if (!id) return null;
  const store = loadStore();
  const rec = store.rooms[id];
  if (!rec) return null;
  rooms.assertWritable();
  Object.assign(rec, patchedFields(rec, patch));
  saveStore();
  return resolveRoomConfig(id);
}

/**
 * The dashboard's save: a new password, a handle and a patch, validated
 * together and written once. Nothing is applied unless all of it is: a
 * refused layout no longer leaves the new handle and password saved behind a
 * 400 (stores-7). `password` undefined/empty keeps the current one; `handle`
 * undefined keeps it, '' or null clears it. Returns the resolved room, or
 * null when it does not exist; throws LayoutRefused, `handle_taken`,
 * `invalid_handle`, or StoreRefused, having changed nothing.
 */
export async function applyRoomUpdate(roomId, { password, handle, patch = {} } = {}) {
  const id = normalizeRoomId(roomId);
  if (!id || !loadStore().rooms[id]) return null;
  // The one await happens BEFORE the checks, so nothing can change between a
  // check passing and the write that relies on it.
  const passwordHash = password ? await hashPassword(password) : null;
  const store = loadStore();
  const rec = store.rooms[id];
  if (!rec) return null;
  rooms.assertWritable();
  const fields = patchedFields(rec, patch);
  const h = handle === undefined ? undefined : checkedHandle(store, rec, handle);
  Object.assign(rec, fields);
  if (passwordHash) rec.passwordHash = passwordHash;
  if (h !== undefined) assignHandle(rec, h);
  saveStore();
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
  rooms.assertWritable();
  delete store.rooms[id];
  saveStore();
  return true;
}

/** How many rooms exist, without resolving any of them (stores-11). */
export function roomCount() {
  return Object.keys(loadStore().rooms).length;
}

/**
 * A room nobody can manage: no owner AND no password (DECISIONS D1). The
 * default room and protected handles (the demo) are never orphans.
 *
 * A password-only room is NOT an orphan. The create page offers signed-out
 * streamers exactly that room, and the pruner used to delete it on the next
 * deploy (stores-1). Its password is its admin path, so it stays.
 */
export function isOrphanRoom(rec, { protectHandles = [] } = {}) {
  if (!rec || rec.id === DEFAULT_ROOM_ID) return false;
  if (rec.handle && protectHandles.includes(rec.handle)) return false;
  return !rec.ownerKey && !rec.passwordHash;
}

/**
 * Remove every orphan room (isOrphanRoom). Restores the useful part of the old
 * ephemeral behaviour — junk test rooms that nobody could ever manage do not
 * pile up on the volume — while owned rooms, password rooms and the seeded demo
 * always survive. Returns the ids removed.
 */
export function pruneOrphanRooms({ protectHandles = [] } = {}) {
  const store = loadStore();
  const doomed = Object.values(store.rooms).filter((rec) => isOrphanRoom(rec, { protectHandles })).map((rec) => rec.id);
  if (!doomed.length) return [];
  rooms.assertWritable();
  for (const id of doomed) delete store.rooms[id];
  saveStore();
  return doomed;
}

/** Test helper — reset in-memory cache. */
export function _resetCacheForTests() {
  rooms.reset();
}
