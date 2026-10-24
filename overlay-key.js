/**
 * THE OVERLAY KEY (OPEN-ISSUES N14).
 *
 * The overlay (OBS browser source) identifies itself over the WebSocket with
 * `role: 'overlay'`, and anything can say that. For the display path that is
 * fine: tiles and MegaChats render to whoever subscribes. For a campaign
 * Holler it is not, because "played to the end on the overlay" moves a claim
 * to owed. So the overlay URL the room's manager is handed carries a key,
 * `&k=<key>`, the overlay sends it back in `subscribe_room`, and only a socket
 * that presented the right key for its room counts as the room's real
 * overlay for a campaign `aired` (letters.js `hasAuthedOverlay`).
 *
 * DERIVED, NOT STORED: HMAC-SHA256 over the room id with the same secret that
 * seals sign-in cookies (runtime-env.js sessionSecret; the variable chain is
 * copied rather than imported, because the production fallback differs — see
 * secret() below — and this file has no route side effects). No new store, nothing to
 * migrate, survives restarts and redeploys, and the same room always gets the
 * same URL, so a streamer's OBS scene never goes stale on its own. The label
 * keeps it from ever equalling a cookie signature over the same bytes.
 * Trade-off: no per-room rotation. Rotating means rotating the secret, which
 * also signs everyone out (DECISIONS, N14).
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { isProduction } from './runtime-env.js';

const KEY_LEN = 32; // base64url chars of the HMAC: 192 bits
const DEV_SECRET = 'megachat-dev-secret';
let warned = false;
/**
 * The secret, or null. The public dev fallback is in this file for anyone to
 * read, so a key derived from it is no key: in production (isProduction():
 * `--prod`, Railway's own variables, or NODE_ENV — it used to check NODE_ENV
 * alone, which Railway never sets and which read 'production' only because
 * Next sets it during prepare; OPEN-ISSUES K7) with neither variable set there
 * is NO overlay key — the manager gets the plain overlay URL and no socket
 * counts as the keyed overlay (a campaign Holler then never counts as aired).
 * Logged once, by NAME only.
 *
 * NOT auth.js's per-boot random fallback (runtime-env.js sessionSecret), on
 * purpose. A session cookie lost on restart costs one sign-in; an overlay key
 * that changes every boot would silently break every streamer's saved OBS
 * URL on every deploy, with nothing on screen saying why. No key, said out
 * loud, is the honest failure.
 */
const secret = () => {
  const s = process.env.AUTH_SECRET || process.env.MPP_SECRET_KEY;
  if (s) return s;
  if (isProduction()) {
    if (!warned) { warned = true; console.error('[overlay-key] AUTH_SECRET (or MPP_SECRET_KEY) is not set in production — overlay keys are DISABLED: no overlay counts a campaign Holler as aired until it is set'); }
    return null;
  }
  return DEV_SECRET;
};

/** The overlay key for a (normalized) room id, or null when no key can be derived. Hand it only to the room's manager. */
export function overlayKeyFor(roomId) {
  const s = secret();
  if (!s) return null;
  return createHmac('sha256', s)
    .update(`megachat-overlay-key:v1:${String(roomId)}`)
    .digest('base64url')
    .slice(0, KEY_LEN);
}

/** Constant-time: did this socket present the key for this room? */
export function overlayKeyMatches(roomId, key) {
  if (!roomId || typeof key !== 'string' || key.length !== KEY_LEN) return false;
  const k = overlayKeyFor(roomId);
  if (!k) return false;
  const want = Buffer.from(k);
  const got = Buffer.from(key);
  return got.length === want.length && timingSafeEqual(got, want);
}
