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
 * A FILE THAT CANNOT BE READ IS LEFT ALONE. Written atomically through
 * json-store.js. An x-tokens.json that is torn, unparsable or the wrong shape
 * used to read as "no tokens", and the next X sign-in saved that over every
 * holder's row; now the store refuses writes (logged once, the file untouched)
 * and serves no holders until the file is repaired and the process restarts.
 *
 * NEVER LOGGED. No token, ciphertext or key value is written to a log line.
 */
import path from 'path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { createJsonStore, dataDir } from './json-store.js';

const storePath = () => path.join(dataDir(), 'x-tokens.json');

function key() {
  const raw = process.env.X_TOKEN_KEY || process.env.AUTH_SECRET || '';
  if (!raw) return null;
  return createHash('sha256').update(`x-token-store:v1:${raw}`).digest();
}
export const tokenStoreConfigured = () => !!key();

const tokenStore = createJsonStore({
  file: storePath,
  name: 'x-tokens',
  pretty: true,
  empty: () => ({ tokens: {} }),
  normalize: (doc) => {
    doc.tokens ||= {};
    // Refused like a parse error: an array here takes rows that JSON.stringify
    // then drops, and a string or number throws on every save.
    if (typeof doc.tokens !== 'object' || Array.isArray(doc.tokens)) throw new Error('tokens is not an object');
    return doc;
  },
});
const load = () => tokenStore.data();
/** The document, for a change: throws StoreRefused BEFORE anything is touched. */
function loadForWrite() {
  tokenStore.assertWritable();
  return tokenStore.data();
}
const save = () => tokenStore.save();

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

/** Store the token response from the X OAuth exchange for this account.
 *  Throws StoreRefused when x-tokens.json could not be read (auth.js logs it
 *  and links anyway). */
export function saveXToken(accountId, xUserId, token) {
  const k = key();
  if (!k || !accountId || !token?.access_token) return false;
  const store = loadForWrite();
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

/** Never throws: the disconnect it follows has already happened. */
export function dropXToken(accountId, { log = console } = {}) {
  if (tokenStore.refusal()) {
    // The row may still be in the unreadable file, and would be listed again
    // once it is repaired: name the account, so the repair drops it too.
    log.warn?.(`[x-tokens] could not drop ${accountId}'s token: the store refuses writes — remove that row when the file is repaired`);
    return;
  }
  const store = load();
  if (store.tokens[accountId]) { delete store.tokens[accountId]; save(); }
}

/**
 * Account ids holding a USABLE token, by X user id. Skipped: a row whose
 * refresh X refused (`dead`, until the holder signs in with X again, which
 * re-saves it) and a row the current key cannot open, which is every row
 * right after the key rotates. Neither can vouch for anyone, and listing them
 * made a campaign check walk them all, inside the campaign's X lock. An
 * unreadable row stays in the file, so restoring the old key restores it.
 */
export function holdersByXUserId() {
  const k = key();
  const out = new Map();
  if (!k) return out;
  for (const [accountId, row] of Object.entries(load().tokens)) {
    if (row.xUserId && !row.dead && open(row.sealed, k)) out.set(row.xUserId, accountId);
  }
  return out;
}

/**
 * A usable access token for this account, refreshing it when it has expired.
 * Returns null when there is none, it cannot be decrypted, X refused its
 * refresh before (`dead`), or the refresh fails — the caller treats that
 * holder as unavailable, never as an error.
 */
export async function getXAccessToken(accountId, { log = console } = {}) {
  const k = key();
  const row = load().tokens[accountId];
  if (!k || !row || row.dead) return null;
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
      // 400/401 is X refusing the grant itself (revoked, or a refresh token
      // already spent): retrying can never work, and every check used to POST
      // again, one holder at a time. Mark the row dead until the holder signs
      // in with X again. Anything else (5xx, 429) may pass, so the row stays.
      const refused = r.status === 400 || r.status === 401;
      if (refused) markDead(accountId, row, `refresh refused (http ${r.status})`);
      log.warn?.(`[x-tokens] refresh failed for ${accountId} (http ${r.status}) — holder unavailable ${refused ? 'until they sign in with X again' : 'for now'}`);
      return null;
    }
    // X rotates refresh tokens: the old one is dead the moment this returns.
    saveXToken(accountId, row.xUserId, { ...body, refresh_token: body.refresh_token || t.refreshToken });
    return body.access_token;
  } catch {
    return null; // a timeout or a network error says nothing about the grant: the row stays
  }
}

/** Only the row the refresh started from: a sign-in that re-saved it meanwhile is newer. */
function markDead(accountId, row, why) {
  const store = loadForWrite();
  if (store.tokens[accountId]?.sealed !== row.sealed) return;
  store.tokens[accountId] = { ...store.tokens[accountId], dead: { at: new Date().toISOString(), why } };
  save();
}

/** Test seam: forget the document (and any refusal) so the next read comes
 *  from disk, where DATA_DIR now points. */
export function _resetXTokensForTests() { tokenStore.reset(); refreshing.clear(); }
