/**
 * SITE SETTINGS — the few product calls the site's owner makes from the hidden
 * /dev page, live, without a redeploy.
 *
 * The owner, 2026-09-25: "a hidden dev tab … for me and only me to set these
 * settings whenever". Each of these was a constant or a Railway variable. Now
 * a SAVED value (DATA_DIR/site-settings.json, written only by the /dev page)
 * wins over the env var, which wins over the default; clearing a saved value
 * falls back again. Every change is kept in a short history: who, when, from
 * what to what. A change is live only once it is on disk.
 *
 * WHO. The owner's MegaChat ACCOUNT, pinned in the file. Until one is pinned,
 * the first signed-in account whose linked TWITCH login is on SITE_ADMIN_TWITCH
 * (default: the owner's channel) is pinned — the same proof a room's owner
 * gives for their channel (server.js ownerProvesChannel); a handle is first-come
 * and proves nothing, and a same-named Kick or X login is somebody else. From
 * then on the login name is never consulted: a Twitch name can be given up and
 * registered by someone else, an account id cannot. (To move the page to
 * another account, delete `adminAccountIds` from the file on the volume.)
 * Everyone else — signed out, or signed in as anyone else — gets exactly what a
 * path that does not exist gets, from the page and the API alike.
 */
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'site-settings.json');
const HISTORY_MAX = 50;

const envNumber = (name) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : null);

/** Each setting: where it falls back to, and what a saved value may be. */
const DEFS = {
  // The live viewer count that gives a streamer the big featured card on the
  // board (server.js followTick; it stays until the count drops below 80%).
  bigStreamViewers: {
    fallback: () => (envNumber('BOARD_BIG_VIEWERS') != null
      ? { value: envNumber('BOARD_BIG_VIEWERS'), source: 'env' }
      : { value: 100, source: 'default' }),
    valid: (v) => Number.isInteger(v) && v >= 1 && v <= 1_000_000,
    rule: 'a whole number from 1 to 1,000,000',
  },
  // How long an aired MegaChat is kept for its broadcast's replay; 0 keeps
  // none (aired-clips.js). Never longer than the fan was told when sending.
  replayKeepDays: {
    fallback: () => (process.env.AIRED_CLIPS === '0'
      ? { value: 0, source: 'env' }
      : { value: 30, source: 'default' }),
    valid: (v) => Number.isInteger(v) && v >= 0 && v <= 90,
    rule: 'a whole number of days from 0 (off) to 90',
  },
  // Whether a broadcast where nobody took a seat and no MegaChat played still
  // gets a Recently aired card (airing-posters.js isListable).
  recentShowsQuiet: {
    fallback: () => ({ value: false, source: 'default' }),
    valid: (v) => typeof v === 'boolean',
    rule: 'true or false',
  },
};

const isSetting = (k) => Object.hasOwn(DEFS, k);
export const SETTING_NAMES = Object.keys(DEFS);

const EMPTY = () => ({ values: {}, updatedAt: null, updatedBy: null, history: [], adminAccountIds: [] });

let cache = null;
let readFailed = false; // the file exists but could not be read: never overwrite it

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const values = {};
    // A value this build no longer accepts is ignored, never obeyed.
    for (const [k, v] of Object.entries(raw.values || {})) if (isSetting(k) && DEFS[k].valid(v)) values[k] = v;
    cache = {
      values,
      updatedAt: raw.updatedAt || null,
      updatedBy: raw.updatedBy || null,
      history: Array.isArray(raw.history) ? raw.history.slice(-HISTORY_MAX) : [],
      adminAccountIds: Array.isArray(raw.adminAccountIds) ? raw.adminAccountIds.filter((x) => typeof x === 'string' && x) : [],
    };
    readFailed = false;
  } catch (e) {
    if (e?.code === 'ENOENT') {
      cache = EMPTY();
      readFailed = false;
    } else {
      // Unreadable is not "nothing saved": serve the defaults for now, read
      // it again next time, and refuse every write until it reads.
      if (!readFailed) console.warn(`[site-settings] could not read ${FILE}: ${e.message}`);
      readFailed = true;
      return EMPTY();
    }
  }
  return cache;
}

/** Write `next` to disk, THEN make it the live state. */
function commit(next) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw e;
  }
  cache = next;
}

const valueIn = (values, k) => (values[k] !== undefined ? values[k] : DEFS[k].fallback().value);

/** The value in force: saved, else env, else default. */
export function getSetting(name) {
  if (!isSetting(name)) throw new Error(`unknown site setting ${name}`);
  return valueIn(load().values, name);
}

/** Everything the /dev page shows: each value, where it came from, what it
 *  falls back to, and the recent changes. */
export function siteSettingsView() {
  const s = load();
  const settings = {};
  for (const [name, def] of Object.entries(DEFS)) {
    const fb = def.fallback();
    const saved = s.values[name];
    settings[name] = {
      value: saved !== undefined ? saved : fb.value,
      source: saved !== undefined ? 'saved' : fb.source,
      fallback: fb.value,
      fallbackSource: fb.source,
      rule: def.rule,
    };
  }
  return { settings, updatedAt: s.updatedAt, updatedBy: s.updatedBy, history: [...s.history].reverse() };
}

/**
 * Apply a patch: `{ name: value }` saves, `{ name: null }` clears the saved
 * value (back to env/default). All or nothing — one bad value changes nothing,
 * and nothing is live until it is on disk.
 * @returns {{ ok: true, changed: object } | { ok: false, errors: string[], status?: number }}
 */
export function updateSiteSettings(patch, { by = null, now = Date.now() } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, errors: ['Send an object of settings'] };
  const errors = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!isSetting(k)) errors.push(`${k} is not a setting`);
    else if (v !== null && !DEFS[k].valid(v)) errors.push(`${k} must be ${DEFS[k].rule}`);
  }
  if (errors.length) return { ok: false, errors };
  const s = load();
  if (readFailed) return { ok: false, status: 500, errors: ['The saved settings could not be read, so nothing was changed'] };
  const next = { ...s, values: { ...s.values }, history: [...s.history] };
  const changed = {};
  for (const [k, v] of Object.entries(patch)) {
    const before = valueIn(next.values, k);
    const wasSaved = next.values[k] !== undefined;
    if (v === null) delete next.values[k];
    else next.values[k] = v;
    const after = valueIn(next.values, k);
    if (before !== after || (v === null && wasSaved)) changed[k] = { from: before, to: after, ...(v === null ? { cleared: true } : {}) };
  }
  if (Object.keys(changed).length) {
    next.updatedAt = now;
    next.updatedBy = by;
    next.history.push({ at: now, by, changed });
    next.history = next.history.slice(-HISTORY_MAX);
  }
  try {
    commit(next);
  } catch (e) {
    return { ok: false, status: 500, errors: [`Not saved: ${e.message}`] };
  }
  return { ok: true, changed };
}

const norm = (n) => String(n || '').trim().replace(/^@/, '').toLowerCase();

/** The Twitch logins that may claim /dev before an account is pinned
 *  (SITE_ADMIN_TWITCH, comma-separated). */
function adminLogins() {
  const raw = process.env.SITE_ADMIN_TWITCH ?? 'jordandotfun';
  return new Set(String(raw).split(',').map(norm).filter(Boolean));
}

/** Its linked TWITCH login is on the list — a Kick or X login spelled the
 *  same is somebody else. */
function hasAdminTwitchLogin(identity) {
  const allowed = adminLogins();
  if (!allowed.size) return false;
  const logins = [
    ...(identity.links || []).filter((l) => l.provider === 'twitch').map((l) => l.username),
    identity.platformLogins?.twitch,
  ].map(norm).filter(Boolean);
  return logins.some((l) => allowed.has(l));
}

/**
 * Is this identity (auth.js readIdentityFromRequest) the site's owner? The
 * pinned account, once there is one; before that, the first account with an
 * admin Twitch login — which is then pinned (see the header).
 */
export function isSiteAdmin(identity) {
  const accountId = identity?.accountId;
  if (!accountId) return false;
  const s = load();
  if (readFailed) return false; // fail closed
  if (s.adminAccountIds.length) return s.adminAccountIds.includes(accountId);
  if (!hasAdminTwitchLogin(identity)) return false;
  try {
    commit({ ...s, adminAccountIds: [accountId] });
    console.log(`[site-settings] /dev pinned to account ${accountId}`);
  } catch (e) {
    console.warn(`[site-settings] could not pin the owner's account: ${e.message}`);
    return false;
  }
  return true;
}

export function _resetSiteSettingsForTests() {
  cache = null;
  readFailed = false;
}
