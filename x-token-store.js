/**
 * x-token-store.js — X OAuth 2.0 user tokens, encrypted at rest.
 *
 * WHY THIS EXISTS NOW. The identity layer deliberately stored no token: one
 * profile read inside the sign-in round trip was the whole use. Targeted
 * campaigns (campaign-engine.js) need one more thing a token can do and an
 * app token cannot: `connection_status` on a user lookup says whether the
 * TOKEN HOLDER follows the looked-up account. A reference set's members who
 * signed in to Holler with X can therefore vouch, at $0.01 a lookup, for the
 * people applying to a campaign. That requires holding their token, and a
 * refresh token (scope `offline.access`) because access tokens last 2 hours.
 *
 * WHAT IS STORED. `x-tokens.json` under DATA_DIR: per account id, the
 * AES-256-GCM ciphertext of {accessToken, refreshToken, expiresAt, scope},
 * plus the X user id in the clear (so a reference set can find its holders
 * without decrypting anything). Nothing else.
 *
 * THE KEY. `X_TOKEN_KEY` (any string; hashed to 32 bytes). Absent, it falls
 * back to `AUTH_SECRET`, the cookie-seal secret, so production works without
 * a new variable; rotating that secret makes every stored token unreadable,
 * which reads as "not stored" and costs a re-link, never a leak. With
 * neither set (a local dev box), nothing is stored at all.
 *
 * NEVER LOGGED. No token, ciphertext or key value is written to a log line.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = () => process.env.DATA_DIR || path.join(__dirname, 'data');
const storePath = () => path.join(dataDir(), 'x-tokens.json');

function key() {
  const raw = process.env.X_TOKEN_KEY || process.env.AUTH_SECRET || '';
  if (!raw) return null;
  return createHash('sha256').update(`x-token-store:v1:${raw}`).digest();
}
export const tokenStoreConfigured = () => !!key();

let cache = null;
function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(storePath(), 'utf8')); } catch { cache = { tokens: {} }; }
  cache.tokens ||= {};
  return cache;
}
function save() {
  const dir = dataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${storePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, storePath());
}

function seal(obj, k) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return `${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}
function open(sealed, k) {
  try {
    const [iv, tag, ct] = String(sealed).split('.');
    const d = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8'));
  } catch {
    return null; // wrong key (rotated secret) or a damaged row: treated as absent
  }
}

/** Store the token response from the X OAuth exchange for this account. */
export function saveXToken(accountId, xUserId, token) {
  const k = key();
  if (!k || !accountId || !token?.access_token) return false;
  const store = load();
  store.tokens[accountId] = {
    xUserId: String(xUserId || ''),
    savedAt: new Date().toISOString(),
    hasRefresh: !!token.refresh_token,
    sealed: seal({
      accessToken: token.access_token,
      refreshToken: token.refresh_token || null,
      expiresAt: Date.now() + (Number(token.expires_in) || 7200) * 1000,
      scope: token.scope || null,
    }, k),
  };
  save();
  return true;
}

export function dropXToken(accountId) {
  const store = load();
  if (store.tokens[accountId]) { delete store.tokens[accountId]; save(); }
}

/** Account ids holding a token, by X user id. No decryption. */
export function holdersByXUserId() {
  const out = new Map();
  for (const [accountId, row] of Object.entries(load().tokens)) if (row.xUserId) out.set(row.xUserId, accountId);
  return out;
}

/**
 * A usable access token for this account, refreshing it when it has expired.
 * Returns null when there is none, it cannot be decrypted, or the refresh
 * fails — the caller treats that holder as unavailable, never as an error.
 */
export async function getXAccessToken(accountId, { log = console } = {}) {
  const k = key();
  const row = load().tokens[accountId];
  if (!k || !row) return null;
  const t = open(row.sealed, k);
  if (!t) return null;
  if (t.expiresAt > Date.now() + 60_000) return t.accessToken;
  if (!t.refreshToken) return null;
  const clientId = process.env.X_CLIENT_ID || '';
  const clientSecret = process.env.X_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) return null;
  // ONE refresh per holder at a time. X rotates refresh tokens: a second
  // concurrent refresh would spend the same, now-dead refresh token, fail,
  // and (on X's side) can revoke the grant. Concurrent callers share it.
  if (refreshing.has(accountId)) return refreshing.get(accountId);
  const p = refreshOnce(accountId, row, t, clientId, clientSecret, log).finally(() => refreshing.delete(accountId));
  refreshing.set(accountId, p);
  return p;
}

const refreshing = new Map();
async function refreshOnce(accountId, row, t, clientId, clientSecret, log) {
  try {
    const base = process.env.X_TOKEN_BASE || 'https://api.twitter.com/2/oauth2';
    const r = await fetch(`${base}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refreshToken }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.access_token) {
      log.warn?.(`[x-tokens] refresh failed for ${accountId} (http ${r.status}) — holder unavailable until they sign in with X again`);
      return null;
    }
    // X rotates refresh tokens: the old one is dead the moment this returns.
    saveXToken(accountId, row.xUserId, { ...body, refresh_token: body.refresh_token || t.refreshToken });
    return body.access_token;
  } catch {
    return null;
  }
}

export function _resetXTokensForTests() { cache = null; refreshing.clear(); }
