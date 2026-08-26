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
 * ACCOUNTS COME FROM THE RAW REST API, NOT THE SDK. @privy-io/server-auth
 * 1.32.5's LinkedAccountType union omits 'twitch_oauth' (and X/tiktok/etc are
 * newer than its schema), so its getUser() SILENTLY DROPS those accounts while
 * parsing — a Twitch login arrived looking like a nameless wallet, and the
 * handle fell to "user_<did>". Verified empirically: the raw endpoint returns
 * twitch_oauth+username, the SDK returns only the wallet. So we verify the
 * TOKEN with the SDK (that works) and read ACCOUNTS over REST (nothing gets
 * dropped). No SDK upgrade needed; REST is version-independent.
 *
 * Requires PRIVY_APP_SECRET (+ the app id). Absent → returns null and the
 * app runs exactly as it does today; nothing is faked.
 */
import { PrivyClient } from '@privy-io/server-auth';
import { setPlatformLogins } from './identity-store.js';
import { claimIdentity, getIdentity, suggestHandle, isHandleFree } from './identity-store.js';
import { sanitizeHandle } from './rooms-store.js';

const PRIVY_API_BASE = process.env.PRIVY_API_BASE || 'https://auth.privy.io';

/** The synthetic name given to a truly anonymous (wallet/passkey-only) user. */
export function syntheticName(did) {
  return 'user_' + String(did).replace(/[^a-z0-9]/gi, '').slice(-6);
}

/**
 * Pick a display name from RAW Privy linked_accounts (REST shape, snake_case).
 * Priority is what a streamer would put on screen: platform name first, the
 * generic floor last. Exported so the ladder is unit-testable without a live
 * Privy call. Returns null when there's no human name at all.
 */
export function displayNameFromRaw(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const f = (type) => list.find((a) => a && a.type === type);
  const twitch = f('twitch_oauth');
  if (twitch?.username) return { username: twitch.username, provider: 'twitch' };
  const x = f('twitter_oauth');
  if (x?.username) return { username: x.username, provider: 'x' };
  const tiktok = f('tiktok_oauth');
  if (tiktok?.username) return { username: tiktok.username, provider: 'tiktok' };
  const discord = f('discord_oauth');
  if (discord?.username) return { username: discord.username, provider: 'discord' };
  const google = f('google_oauth');
  if (google?.email) return { username: String(google.email).split('@')[0], provider: 'google' };
  const email = f('email');
  const emailAddr = email?.address || email?.email;
  if (emailAddr) return { username: String(emailAddr).split('@')[0], provider: 'email' };
  return null;
}

/**
 * What each platform's OWN OAuth says this person is called — as opposed to
 * displayNameFromRaw above, which picks ONE name for display. Ownership
 * checks must read this: a fan with Twitch and X linked displays as their
 * Twitch name, and that name proves nothing about their X handle.
 */
export function platformLoginsFromRaw(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const f = (type) => list.find((a) => a && a.type === type);
  const out = {};
  const twitch = f('twitch_oauth');
  if (twitch?.username) out.twitch = String(twitch.username);
  const x = f('twitter_oauth');
  if (x?.username) out.x = String(x.username);
  return out;
}

export function createPrivyIdentity({ log = console } = {}) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID || process.env.PRIVY_APP_ID || '';
  const appSecret = process.env.PRIVY_APP_SECRET || '';
  if (!appId || !appSecret) {
    log.warn('[privy-identity] not configured (need app id + PRIVY_APP_SECRET) — handles unavailable');
    return null;
  }
  const client = new PrivyClient(appId, appSecret);
  const authHeader = 'Basic ' + Buffer.from(`${appId}:${appSecret}`).toString('base64');

  // Credentials are validated at BOOT, loudly. `appSecret` being non-empty
  // proves nothing — a stale/mismatched secret still constructs a client, and
  // then every handle mint 401s at runtime while the UI just quietly shows no
  // username. That exact silence cost a full debugging round; never again.
  let credsValid = null; // null = still checking
  (async () => {
    try {
      await client.getUser('did:privy:credentialprobe000000');
      credsValid = true;
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
        credsValid = true;
        log.log('[privy-identity] ✓ credentials verified — handles enabled');
      }
    }
  })();

  /** Raw linked_accounts over REST — includes account types the SDK drops. */
  async function rawAccounts(did) {
    const r = await fetch(`${PRIVY_API_BASE}/api/v1/users/${encodeURIComponent(did)}`, {
      headers: { Authorization: authHeader, 'privy-app-id': appId },
    });
    if (!r.ok) throw new Error(`privy user fetch ${r.status}`);
    const body = await r.json();
    return body.linked_accounts || [];
  }

  /** Linked accounts, resilient: REST first (the SDK drops twitch/x), SDK second. */
  async function accountsResilient(did) {
    try {
      return await rawAccounts(did);
    } catch (err) {
      log.warn('[privy-identity] raw account fetch failed, trying SDK:', err.message);
      try {
        const u = await client.getUser(did);
        return u.linkedAccounts || [];
      } catch { return []; }
    }
  }

  /** Name for a DID: display ladder over the accounts, synthetic floor last. */
  async function nameFor(did, accounts = null) {
    const picked = displayNameFromRaw(accounts ?? await accountsResilient(did));
    return picked || { username: syntheticName(did), provider: 'wallet' };
  }

  return {
    configured: true,
    /** null = probing, true/false = known. Surfaced on /api/auth/providers. */
    credentialsValid: () => credsValid,
    displayNameFromRaw,
    /**
     * Display-safe linked-accounts list for the account panel — raw REST
     * (the SDK silently drops twitch/x), reduced to {type, name} pairs and
     * nothing else (no tokens, no ids).
     */
    async accountsFor(did) {
      const list = await rawAccounts(did);
      return list
        .map((a) => {
          if (!a || !a.type) return null;
          const type = String(a.type).replace(/_oauth$/, '');
          if (a.type === 'wallet') {
            const addr = String(a.address || '');
            return addr ? { type: 'wallet', name: `${addr.slice(0, 6)}…${addr.slice(-4)}` } : null;
          }
          const name = a.username || a.email || a.address || a.phoneNumber || null;
          return name ? { type, name: String(name) } : { type, name: null };
        })
        .filter(Boolean);
    },
    /**
     * Verify an access token and return the MegaChat identity for it, claiming
     * a handle on first sight. Throws on an invalid token — a forged token must
     * never mint a handle.
     */
    async identityFromToken(token) {
      const claims = await client.verifyAuthToken(token); // throws if forged/expired
      const did = claims.userId;
      const existing = getIdentity('privy', did);
      // ONE account fetch per sign-in serves both needs: the display name
      // ladder AND the per-platform logins that ownership checks read.
      // Refreshed every sign-in so linking X today counts tomorrow.
      const accounts = await accountsResilient(did);
      const logins = platformLoginsFromRaw(accounts);

      // REPAIR: an account that signed in before the REST fix (or before the
      // social finished linking) got the synthetic "user_<did>" placeholder.
      // That was never a name they chose — if a real platform name is now
      // available and free, upgrade to it. A genuinely-chosen handle is never
      // touched.
      if (existing) {
        setPlatformLogins('privy', did, logins);
        if (existing.handle === syntheticName(did)) {
          const picked = await nameFor(did, accounts);
          const real = sanitizeHandle(picked.username);
          if (real && real !== existing.handle && isHandleFree(real)) {
            const upgraded = claimIdentity({
              provider: 'privy', platformId: did, username: picked.username, handle: real,
            });
            log.log(`[privy-identity] upgraded placeholder → @${upgraded.handle} for ${did}`);
            return upgraded;
          }
        }
        return getIdentity('privy', did) || existing;
      }

      const { username, provider } = await nameFor(did, accounts);
      // The platform name itself first; a free variation only if it's taken.
      const wanted = sanitizeHandle(username) ? username : suggestHandle(username);
      let identity;
      try {
        identity = claimIdentity({ provider: 'privy', platformId: did, username, handle: wanted });
      } catch {
        identity = claimIdentity({
          provider: 'privy', platformId: did, username, handle: suggestHandle(username),
        });
      }
      setPlatformLogins('privy', did, logins);
      log.log(`[privy-identity] claimed @${identity.handle} for ${did} (via ${provider})`);
      return getIdentity('privy', did) || identity;
    },
  };
}
