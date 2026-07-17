/**
 * Privy-backed identity — ONE login for the whole app.
 *
 * Why this replaced MegaChat's own Twitch/X OAuth: Privy already speaks
 * Twitch, X, Google, email and passkey. Running a second OAuth stack beside
 * it meant a Twitch user signed in to US for a handle and then AGAIN to Privy
 * for a wallet — the double sign-in. Privy is now the only front door; this
 * module turns a verified Privy session into a MegaChat handle.
 *
 * IDENTITY KEY: the Privy DID, never the social account. One Privy user is
 * one human is one handle, no matter how many socials they link later —
 * linking X to a Twitch account must not mint a second name (see the handle
 * precedent in PASS_CHECKLIST). Linked socials only decide what we CALL you.
 *
 * Requires PRIVY_APP_SECRET (+ the app id). Absent → returns null and the
 * app runs exactly as it does today; nothing is faked.
 */
import { PrivyClient } from '@privy-io/server-auth';
import { claimIdentity, getIdentity, suggestHandle } from './identity-store.js';
import { sanitizeHandle } from './rooms-store.js';

export function createPrivyIdentity({ log = console } = {}) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID || process.env.PRIVY_APP_ID || '';
  const appSecret = process.env.PRIVY_APP_SECRET || '';
  if (!appId || !appSecret) {
    log.warn('[privy-identity] not configured (need app id + PRIVY_APP_SECRET) — handles unavailable');
    return null;
  }
  const client = new PrivyClient(appId, appSecret);

  // Credentials are validated at BOOT, loudly. `appSecret` being non-empty
  // proves nothing — a stale/mismatched secret still constructs a client, and
  // then every handle mint 401s at runtime while the UI just quietly shows no
  // username. That exact silence cost a full debugging round; never again.
  let credsValid = null; // null = still checking
  (async () => {
    try {
      await client.getUser('did:privy:credentialprobe000000');
      credsValid = true; // wouldn't normally resolve, but creds clearly work
    } catch (err) {
      const m = String(err?.message || err);
      if (/invalid app id or app secret|unauthor|401|403/i.test(m)) {
        credsValid = false;
        log.error(
          '[privy-identity] ✗ PRIVY_APP_SECRET is INVALID for this app id — '
          + 'sign-in will work but NO handles can be minted (users show as "Account", '
          + 'room links stay hex). Fix: Privy dashboard → Settings → Basics → App secret.'
        );
      } else {
        // "user not found" et al = credentials accepted.
        credsValid = true;
        log.log('[privy-identity] ✓ credentials verified — handles enabled');
      }
    }
  })();

  /**
   * What to call this person. Priority mirrors what a streamer would put on
   * screen: their platform name first, the generic account only as a floor.
   */
  function displayNameFrom(user) {
    const accounts = user.linkedAccounts || [];
    const find = (type) => accounts.find((a) => a.type === type);
    const twitch = find('twitch_oauth');
    if (twitch?.username) return { username: twitch.username, provider: 'twitch' };
    const x = find('twitter_oauth');
    if (x?.username) return { username: x.username, provider: 'x' };
    const google = find('google_oauth');
    if (google?.email) return { username: String(google.email).split('@')[0], provider: 'google' };
    const email = find('email');
    if (email?.address) return { username: String(email.address).split('@')[0], provider: 'email' };
    // Passkey/wallet-only accounts have no human name at all — give them a
    // stable one rather than showing hex anywhere.
    return { username: 'user_' + String(user.id).replace(/[^a-z0-9]/gi, '').slice(-6), provider: 'passkey' };
  }

  return {
    configured: true,
    /** null = probing, true/false = known. Surfaced on /api/auth/providers. */
    credentialsValid: () => credsValid,
    /**
     * Verify an access token and return the MegaChat identity for it,
     * claiming a handle on first sight. Throws on an invalid token — a
     * forged token must never mint a handle.
     */
    async identityFromToken(token) {
      const claims = await client.verifyAuthToken(token); // throws if forged/expired
      const did = claims.userId;
      // Already known → return as-is. Handles are permanent; re-linking a
      // social later never renames you.
      const existing = getIdentity('privy', did);
      if (existing) return existing;

      const user = await client.getUser(did);
      const { username, provider } = displayNameFrom(user);
      // First choice is the platform name itself; only if that's taken do we
      // fall back to a free variation (no picker, no extra click).
      const wanted = sanitizeHandle(username) ? username : suggestHandle(username);
      let identity;
      try {
        identity = claimIdentity({ provider: 'privy', platformId: did, username, handle: wanted });
      } catch {
        identity = claimIdentity({
          provider: 'privy', platformId: did, username, handle: suggestHandle(username),
        });
      }
      log.log(`[privy-identity] claimed @${identity.handle} for ${did} (via ${provider})`);
      return identity;
    },
  };
}
