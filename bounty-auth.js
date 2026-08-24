/**
 * BOUNTY ROUTE AUTHORIZATION — one enumerated policy, server-side.
 *
 * Every bounty route was open: approve, reject, and the whole /admin/* surface
 * answered to anyone who knew the path. Fine for a dark flag; unshippable the
 * moment BOUNTY_CLAIM goes public, because "approve this clip" and "override
 * this claim" move money.
 *
 * THE POLICY IS A TABLE, NOT SCATTERED CHECKS. Every route is listed here with
 * its tier, and `assertPolicyCoversRoutes` fails the gate if bounty-routes.js
 * registers a path this table does not name. A new route therefore cannot ship
 * without someone deciding what it is — the failure being designed against is a
 * state-changing route added later that quietly inherits nothing.
 *
 * TIERS
 *   PUBLIC     — readable by anyone. Directory, pool sizes, config.
 *   FAN        — a signed-in contributor. Pledging is tied to an account so
 *                moderation strikes cannot be shed by picking a new name.
 *   STREAMER   — the AUTHENTICATED CLAIMANT of that handle, and nobody else.
 *                Identity comes from the sealed mc_identity cookie and must
 *                match the platform+handle the route targets — the same proof
 *                the claim itself requires. A Twitch session cannot act on a
 *                Kick handle of the same name.
 *   CAPABILITY — no session, because the caller cannot have one: the OBS
 *                overlay polls from inside a browser source with no cookie.
 *                The unguessable UUID in its URL IS the credential. Stated
 *                explicitly so it reads as a decision, not an oversight.
 *   ADMIN      — a shared secret in BOUNTY_ADMIN_KEY. Obscurity was the
 *                previous control; this is at least a credential.
 */
import { readIdentityFromRequest } from './auth.js';
import * as store from './bounty-store.js';
import * as clips from './bounty-clips.js';

export const TIER = {
  PUBLIC: 'PUBLIC',
  FAN: 'FAN',
  STREAMER: 'STREAMER',
  CAPABILITY: 'CAPABILITY',
  ADMIN: 'ADMIN',
};

/**
 * How a STREAMER-tier route says which handle it is about. Routes differ: some
 * carry platform+handle directly, some carry an id that resolves to one.
 */
export const SUBJECT = {
  QUERY_HANDLE: 'QUERY_HANDLE',
  BODY_HANDLE: 'BODY_HANDLE',
  PARAM_CLAIM: 'PARAM_CLAIM',
  PARAM_AIR_SESSION: 'PARAM_AIR_SESSION',
  BODY_CLAIM: 'BODY_CLAIM',
  PARAM_CLIP: 'PARAM_CLIP',
};

/** THE TABLE. Keys are `METHOD /path` exactly as registered. */
export const ROUTE_POLICY = {
  // ── Public: the directory and its numbers ────────────────────────────────
  'GET /api/bounty/config': { tier: TIER.PUBLIC },
  'GET /api/bounty/pools': { tier: TIER.PUBLIC },
  'GET /api/bounty/pool': { tier: TIER.PUBLIC },
  'GET /api/bounty/pool-view': { tier: TIER.PUBLIC },
  'GET /api/bounty/program': { tier: TIER.PUBLIC },
  'GET /api/bounty/clips': { tier: TIER.PUBLIC },
  'GET /api/bounty/my': { tier: TIER.PUBLIC },
  // Carries its own identity proof (PlatformIdentityVerifier) inside the
  // handler — the whole point of the route is establishing who you are.
  'POST /api/bounty/claim': { tier: TIER.PUBLIC },

  // ── Fan: contributing ───────────────────────────────────────────────────
  'POST /api/bounty/pledge': { tier: TIER.FAN },
  'POST /api/bounty/contribute': { tier: TIER.FAN },
  // Bearer-by-id: the contributionId was minted by the pledge that created it
  // and is known only to that fan.
  'POST /api/bounty/clip/:contributionId': { tier: TIER.CAPABILITY },
  'POST /api/bounty/clip/:contributionId/frames': { tier: TIER.CAPABILITY },
  'GET /api/bounty/clip/:clipId/media': { tier: TIER.CAPABILITY },

  // ── Streamer: their inbox and their money ───────────────────────────────
  'GET /api/bounty/queue': { tier: TIER.STREAMER, subject: SUBJECT.QUERY_HANDLE },
  'POST /api/bounty/clip/:clipId/approve': { tier: TIER.STREAMER, subject: SUBJECT.PARAM_CLIP },
  'POST /api/bounty/clip/:clipId/reject': { tier: TIER.STREAMER, subject: SUBJECT.PARAM_CLIP },
  'GET /api/bounty/claim/:id': { tier: TIER.STREAMER, subject: SUBJECT.PARAM_CLAIM },
  'POST /api/bounty/air-session': { tier: TIER.STREAMER, subject: SUBJECT.BODY_CLAIM },
  'POST /api/bounty/air-session/:id/end': { tier: TIER.STREAMER, subject: SUBJECT.PARAM_AIR_SESSION },
  'POST /api/bounty/air-session/:id/verify': { tier: TIER.STREAMER, subject: SUBJECT.PARAM_AIR_SESSION },
  'POST /api/bounty/refund-expired': { tier: TIER.STREAMER, subject: SUBJECT.BODY_HANDLE },

  // ── Capability: the overlay, which cannot hold a session ────────────────
  'GET /api/bounty/air-session/:id/code': { tier: TIER.CAPABILITY },
  'POST /api/bounty/air-session/:id/badge': { tier: TIER.CAPABILITY },

  // ── Admin ───────────────────────────────────────────────────────────────
  'GET /api/bounty/admin/clip-storage': { tier: TIER.ADMIN },
  'POST /api/bounty/admin/playback': { tier: TIER.ADMIN },
  'POST /api/bounty/admin/playback/end': { tier: TIER.ADMIN },
  'POST /api/bounty/admin/sweep-pledges': { tier: TIER.ADMIN },
  'POST /api/bounty/admin/seed': { tier: TIER.ADMIN },
  'GET /api/bounty/admin/sessions': { tier: TIER.ADMIN },
  'POST /api/bounty/admin/override': { tier: TIER.ADMIN },
  'GET /api/bounty/admin/reviews': { tier: TIER.ADMIN },
  'POST /api/bounty/admin/reviews/:id/assign': { tier: TIER.ADMIN },
  'POST /api/bounty/admin/reviews/:id/resolve': { tier: TIER.ADMIN },
  'GET /api/bounty/admin/ledger': { tier: TIER.ADMIN },
};

export const adminKeyConfigured = () => !!process.env.BOUNTY_ADMIN_KEY;

/** Length-independent compare so the key cannot be probed byte by byte. */
function secretEquals(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

/** Which platform:handle is this STREAMER route acting on? */
function resolveSubjectKey(req, subject) {
  switch (subject) {
    case SUBJECT.QUERY_HANDLE:
      return store.handleKey(req.query?.platform, req.query?.handle);
    case SUBJECT.BODY_HANDLE:
      return store.handleKey(req.body?.platform, req.body?.handle);
    case SUBJECT.PARAM_CLAIM:
      return store.getClaim(req.params?.id)?.handleKey || null;
    case SUBJECT.BODY_CLAIM:
      return store.getClaim(req.body?.claimId)?.handleKey || null;
    case SUBJECT.PARAM_AIR_SESSION: {
      const s = store.getAirSession(req.params?.id);
      return s ? (store.getClaim(s.claimId)?.handleKey || null) : null;
    }
    case SUBJECT.PARAM_CLIP:
      // The clip record carries the handle it was recorded FOR, which is the
      // streamer entitled to approve or reject it.
      return clips.getClip(req.params?.clipId)?.handleKey || null;
    default:
      return null;
  }
}

/**
 * Does this request's signed-in identity own `handleKey`? The same proof the
 * claim requires: provider must match the platform and the OAuth login must
 * equal the handle. Never client-asserted.
 */
export function identityOwnsHandle(req, handleKey) {
  if (!handleKey) return false;
  const identity = readIdentityFromRequest(req);
  if (!identity) return false;
  const [platform, handle] = handleKey.split(':');
  if (identity.provider !== platform) return false;
  const login = String(identity.username || identity.handle || '').toLowerCase();
  return !!login && login === handle;
}

/**
 * Express middleware for one policy entry. Applied AT REGISTRATION in
 * bounty-routes.js, so authorization runs before the handler and cannot be
 * skipped by a handler that forgot to check.
 */
export function authorize(policy, { log = console } = {}) {
  return (req, res, next) => {
    switch (policy.tier) {
      case TIER.PUBLIC:
      case TIER.CAPABILITY:
        return next();

      case TIER.FAN: {
        const identity = readIdentityFromRequest(req);
        if (!identity) {
          return res.status(401).json({
            error: 'Sign in to continue',
            reason: 'auth_required',
            hint: 'Pledging is tied to an account so moderation strikes cannot be shed by changing a name.',
          });
        }
        req.bountyIdentity = identity;
        return next();
      }

      case TIER.STREAMER: {
        // AUTHENTICATE BEFORE RESOLVING. Resolving first meant an anonymous
        // caller got 400-not-found vs 401-unauthorized depending on whether
        // the id existed — a free existence oracle over every claim, clip and
        // air session. Nobody without a session learns anything.
        if (!readIdentityFromRequest(req)) {
          return res.status(401).json({
            error: 'Sign in as the streamer for this handle', reason: 'auth_required',
          });
        }
        const key = resolveSubjectKey(req, policy.subject);
        if (!key) {
          // Cannot tell whose it is → refuse rather than default-allow.
          return res.status(404).json({ error: 'Not found' });
        }
        if (!identityOwnsHandle(req, key)) {
          return res.status(403).json({ error: 'This is not your handle', reason: 'wrong_handle' });
        }
        req.bountyHandleKey = key;
        return next();
      }

      case TIER.ADMIN: {
        if (!adminKeyConfigured()) {
          // Refuse rather than fall open. An unset key must never mean allow.
          log.warn?.('[bounty-auth] BOUNTY_ADMIN_KEY is not set — admin routes refuse');
          return res.status(503).json({ error: 'Admin access is not configured' });
        }
        const presented = req.get('x-bounty-admin-key') || req.body?.adminKey;
        if (!secretEquals(presented, process.env.BOUNTY_ADMIN_KEY)) {
          return res.status(401).json({ error: 'Unauthorized', reason: 'bad_admin_key' });
        }
        return next();
      }

      default:
        return res.status(500).json({ error: `Unknown auth tier ${policy.tier}` });
    }
  };
}

/** Look up a policy, or throw — an unlisted route is a programming error. */
export function policyFor(method, path) {
  const k = `${method.toUpperCase()} ${path}`;
  const p = ROUTE_POLICY[k];
  if (!p) {
    throw new Error(`[bounty-auth] no policy for ${k} — add it to ROUTE_POLICY in bounty-auth.js`);
  }
  return p;
}

/**
 * Gate helper. Every registered route must appear in the table, and every
 * table entry must match a real route. Either direction drifting is a bug: an
 * unlisted route is an unprotected one, and a stale entry describes something
 * imaginary.
 */
export function assertPolicyCoversRoutes(registered) {
  const listed = new Set(Object.keys(ROUTE_POLICY));
  const actual = new Set(registered);
  const unlisted = [...actual].filter((r) => !listed.has(r));
  const stale = [...listed].filter((r) => !actual.has(r));
  return { ok: unlisted.length === 0 && stale.length === 0, unlisted, stale };
}
