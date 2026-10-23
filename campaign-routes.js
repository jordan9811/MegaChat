/**
 * campaign-routes.js — HTTP for targeted reward campaigns (campaign-engine.js).
 *
 * THE POLICY IS A TABLE, like bounty-auth.js: every route is registered from
 * CAMPAIGN_ROUTES with its tier, so a route cannot exist without someone
 * deciding who may call it, and _gate-campaigns.mjs walks the table and calls
 * every non-public route with no credentials.
 *
 *   PUBLIC  anyone — the offer page's data. GET /api/campaigns/:key is public
 *           for a SLUG and creator-only for a campaign ID (cmp_…; a slug can
 *           never contain "_", so the two cannot collide).
 *   FAN     a signed-in account (the sealed mc_identity cookie). Anyone may
 *           create a campaign; the engine checks that a campaign or a
 *           reference set is the caller's own before acting on it.
 *   ADMIN   moderation only (hide, force-close, see everything): the site
 *           owner's account (site-settings.js isSiteAdmin) OR the bounty
 *           admin key (BOUNTY_ADMIN_KEY, bounty-auth.js) — the existing admin
 *           credentials, reused. There is no unauthenticated admin path.
 *
 * Paths and envelopes are the contract web/lib/campaigns-api.ts calls.
 *
 * X DEVELOPER POLICY: nothing served here asks anyone to act on X; campaign
 * copy is refused when it does (campaign-eligibility.js copyViolation).
 */
import { readIdentityFromRequest } from './auth.js';
import { isSiteAdmin } from './site-settings.js';
import { adminKeyMatches, adminKeyConfigured } from './bounty-auth.js';
import { getAccount, setAccountPayoutWallet } from './accounts.js';
import { appBearerConfigured } from './attestation/x-api.js';
import { tokenStoreConfigured } from './x-token-store.js';
import { fundingEnabled, PAID_OFF_MSG } from './campaign-engine.js';
import { RULE_MENU } from './campaign-eligibility.js';

export const TIER = { PUBLIC: 'PUBLIC', FAN: 'FAN', ADMIN: 'ADMIN' };
const isCampaignId = (k) => /^cmp_[a-z0-9]+$/.test(String(k || ''));
const httpErr = (status, code, message) => Object.assign(new Error(message), { status, code });

function who(req) {
  const identity = readIdentityFromRequest(req);
  return { accountId: identity?.accountId || null, isAdmin: isSiteAdmin(identity) || adminKeyMatches(req), identity };
}

/** X estimates per caller per minute (sliding window, in memory). */
export const ESTIMATE_PER_MIN = 10;
const estimateHits = new Map();
export function estimateAllowed(key, at = Date.now()) {
  const recent = (estimateHits.get(key) || []).filter((t) => at - t < 60_000);
  if (recent.length >= ESTIMATE_PER_MIN) { estimateHits.set(key, recent); return false; }
  recent.push(at); estimateHits.set(key, recent);
  if (estimateHits.size > 5000) for (const [k, v] of estimateHits) if (!v.some((t) => at - t < 60_000)) estimateHits.delete(k);
  return true;
}

/**
 * Eligibility checks per signed-in account per minute (sliding window, in
 * memory): CHECK_PER_MIN on any one campaign, CHECK_PER_MIN_ALL across all of
 * them. A check can cost the platform an X profile read; with no limit one
 * account could loop it (round-3 money finding 3). Per campaign so a person
 * checking several offers in a row is not refused.
 */
export const CHECK_PER_MIN = 6;
export const CHECK_PER_MIN_ALL = 30;
const checkHits = new Map();
export function checkAllowed(accountKey, slug, at = Date.now()) {
  const hit = (key, limit) => {
    const recent = (checkHits.get(key) || []).filter((t) => at - t < 60_000);
    if (recent.length >= limit) { checkHits.set(key, recent); return false; }
    recent.push(at); checkHits.set(key, recent);
    return true;
  };
  const ok = hit(`${accountKey}\u0000${String(slug || '').toLowerCase()}`, CHECK_PER_MIN) && hit(accountKey, CHECK_PER_MIN_ALL);
  if (checkHits.size > 5000) for (const [k, v] of checkHits) if (!v.some((t) => at - t < 60_000)) checkHits.delete(k);
  return ok;
}

const send = (res, e) => {
  const status = e.status || 500;
  if (status >= 500 && status !== 502 && status !== 503) console.warn('[campaigns]', e.message);
  res.status(status).json({
    error: status >= 500 && !e.code ? 'Campaign request failed' : e.message, reason: e.code || null,
    ...(e.estimate ? { estimate: e.estimate } : {}),
  });
};

/** THE TABLE. Handlers receive (engine, req, who) and return JSON or throw. */
export const CAMPAIGN_ROUTES = [
  // ── a creator's own campaigns (any signed-in account) ───────────────────
  ['GET', '/api/campaigns/mine', TIER.FAN, (e, req, w) => ({ campaigns: e.listManaged({ ...w, all: req.query.all === '1' }) })],
  ['GET', '/api/campaign-config', TIER.FAN, (e, req, w) => ({
    isAdmin: w.isAdmin, fundingEnabled: fundingEnabled(), xBearer: appBearerConfigured(), xTokenStore: tokenStoreConfigured(),
    adminKey: adminKeyConfigured(), ruleMenu: RULE_MENU,
  })],
  ['POST', '/api/campaigns', TIER.FAN, async (e, req, w) => e.manageView(await e.createCampaign(req.body || {}, w))],
  ['PATCH', '/api/campaigns/:id', TIER.FAN, async (e, req, w) => e.manageView(await e.updateCampaign(req.params.id, req.body || {}, w))],
  /**
   * Fund: {ok, campaign} once the budget is pulled, or {needsApproval} when
   * the wallet has not approved enough to the spender (or no wallet was
   * named). Body: {wallet, approveTx?, signature?, typedData?}: after the
   * approve mines, the wallet signs `needsApproval.sign` (EIP-712, with its
   * own address and a deadline ≤ 10 min) and the client sends both.
   * `spender` is the address the wallet approves (the campaign spender);
   * `holder` is the platform wallet the budget is pulled into, which pays
   * rewards and the refund.
   */
  ['POST', '/api/campaigns/:id/fund', TIER.FAN, async (e, req, w) => {
    const c = e.getManaged(req.params.id, w);
    // Refuse BEFORE asking for an approve: nobody should pay gas for an
    // approval this server would then refuse to use.
    if (!fundingEnabled()) throw httpErr(503, 'funding_off', PAID_OFF_MSG);
    if (!e.fundTerms(c.id, w).pullSigner) throw httpErr(503, 'no_pull_signer', 'This server cannot take a campaign budget right now. Nothing was charged.');
    const terms = e.fundTerms(c.id, w);
    const needsApproval = (extra = {}) => ({ needsApproval: { token: { address: c.token.address, symbol: c.token.symbol, decimals: c.token.decimals }, spender: terms.spender, holder: terms.holder, amountAtomic: c.budget.atomic, sign: terms.sign, ...extra } });
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(req.body?.wallet || ''))) return needsApproval({ walletRequired: true });
    // No approve transaction yet: ask for one, whatever the allowance. The
    // approval is the wallet's proof that it is the caller's.
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(req.body?.approveTx || ''))) return needsApproval({ approveRequired: true });
    try {
      return { ok: true, campaign: e.manageView(await e.fund(c.id, { wallet: req.body.wallet, approveTx: req.body?.approveTx || null, signature: req.body?.signature || null, typedData: req.body?.typedData || null }, w)) };
    } catch (err) {
      if (err.code === 'insufficient_allowance') return needsApproval({ allowance: err.allowance || '0' });
      throw err;
    }
  }],
  ['POST', '/api/campaigns/:id/open', TIER.FAN, (e, req, w) => ({ ok: true, campaign: e.manageView(e.open(req.params.id, w)) })],
  ['POST', '/api/campaigns/:id/close', TIER.FAN, (e, req, w) => ({ ok: true, campaign: e.manageView(e.close(req.params.id, { ...w, reason: 'closed by creator' })) })],
  ['GET', '/api/campaigns/:id/claims', TIER.FAN, (e, req, w) => ({ claims: e.claimsFor(req.params.id, w) })],

  // ── reference sets ──────────────────────────────────────────────────────
  ['GET', '/api/reference-sets/mine', TIER.FAN, (e, req, w) => ({ sets: e.listSets(w) })],
  ['POST', '/api/reference-sets/estimate', TIER.FAN, async (e, req, w) => {
    const b = req.body || {};
    // An X estimate costs a lookup. Rate-limited per caller, and past the
    // campaign's free allowance it is held and charged to the named funded
    // campaign (engine.estimateForCampaign).
    if (b.source !== 'manual' && !estimateAllowed(w.accountId || (w.isAdmin ? 'admin' : 'anon'))) {
      throw httpErr(429, 'rate_limited', `At most ${ESTIMATE_PER_MIN} X estimates a minute. Wait a moment and try again.`);
    }
    const est = await e.estimateForCampaign({ source: b.source, sourceRef: b.sourceRef, campaignId: b.campaignId || null }, w);
    return { estimatedUsd: est.costUsd, count: est.count, ...est };
  }],
  ['POST', '/api/reference-sets', TIER.FAN, async (e, req, w) => e.buildSet({ ...(req.body || {}), confirm: req.body?.confirm ?? req.body?.confirmCostUsd != null }, w)],
  ['GET', '/api/reference-sets/:id', TIER.FAN, (e, req, w) => ({ set: e.getSetView(req.params.id, w) })],
  ['POST', '/api/reference-sets/:id/refresh', TIER.FAN, async (e, req, w) => e.refreshSet(req.params.id, { ...(req.body || {}), confirm: req.body?.confirm ?? req.body?.confirmCostUsd != null }, w)],

  // ── tokens: a creator's custom reward token, read on chain ──────────────
  ['GET', '/api/tokens/:address', TIER.FAN, (e, req) => e.tokenInfo(String(req.params.address))],

  // ── payout wallet: where a claimant is paid ─────────────────────────────
  ['POST', '/api/account/payout-wallet', TIER.FAN, (e, req, w) => {
    const a = setAccountPayoutWallet(w.accountId, req.body?.address ?? null);
    e.sync(); // an owed claim waiting for a wallet gets its intent now
    return { ok: true, payoutWallet: a.payoutWallet || null };
  }],

  // ── admin: moderation and abuse controls only ───────────────────────────
  ['GET', '/api/campaigns/admin/all', TIER.ADMIN, (e) => ({ campaigns: e.listManaged({ isAdmin: true, all: true }) })],
  ['POST', '/api/campaigns/admin/c/:id/hide', TIER.ADMIN, (e, req) => ({ campaign: e.manageView(e.setHidden(req.params.id, req.body?.hidden !== false)) })],
  // A campaign stuck in funding_pending (OPEN-ISSUES N12): resolved by the
  // sweep's own rule, now — back to draft only with no transaction, after
  // 30 min, and the whole budget still allowed; never marked funded on a guess.
  ['POST', '/api/campaigns/admin/c/:id/resolve-funding', TIER.ADMIN, async (e, req) => {
    const out = await e.resolveStuckFunding(req.params.id, { isAdmin: true });
    return { status: out.status, needsPerson: out.needsPerson, campaign: out.campaign ? e.manageView(out.campaign) : null };
  }],
  ['POST', '/api/campaigns/admin/c/:id/close', TIER.ADMIN, (e, req) => ({ campaign: e.manageView(e.close(req.params.id, { isAdmin: true, reason: String(req.body?.reason || 'closed by an admin').slice(0, 200) })) })],

  // ── public: the offer page (by slug) ────────────────────────────────────
  ['GET', '/api/campaigns/:key', TIER.PUBLIC, (e, req, w) => {
    if (isCampaignId(req.params.key)) {
      if (!w.accountId && !w.isAdmin) throw httpErr(401, 'auth_required', 'Sign in to continue');
      return { campaign: e.manageView(e.getManaged(req.params.key, w)) };
    }
    const v = e.publicView(req.params.key);
    if (!v) throw httpErr(404, 'not_found', 'No such campaign.');
    return { campaign: v };
  }],
  ['GET', '/api/campaigns/:slug/my-claim', TIER.PUBLIC, (e, req, w) => {
    const acct = w.accountId ? getAccount(w.accountId) : null;
    const x = acct?.links?.find((l) => l.provider === 'x') || null;
    return {
      signedIn: !!acct, xLinked: !!x, xUsername: x?.username || null,
      payoutWallet: acct?.payoutWallet || null,
      xSignIn: !!(process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET),
      claim: acct ? e.myClaim(req.params.slug, acct.id) : null,
    };
  }],
  ['POST', '/api/campaigns/:slug/check', TIER.FAN, async (e, req, w) => {
    if (!checkAllowed(w.accountId || 'admin', req.params.slug)) throw httpErr(429, 'rate_limited', 'Too many checks in a minute. Wait a moment and try again.');
    const r = await e.check(req.params.slug, { accountId: w.accountId });
    return { eligible: r.result.eligible, checks: r.result.checks, claim: e.claimView(r.claim) };
  }],
];

function guard(tier) {
  return (req, res, next) => {
    const w = who(req);
    if (tier === TIER.FAN && !w.accountId && !w.isAdmin) {
      return res.status(401).json({ error: 'Sign in to continue', reason: 'auth_required' });
    }
    if (tier === TIER.ADMIN && !w.isAdmin) {
      return res.status(w.accountId ? 403 : 401).json({ error: 'Admin only', reason: w.accountId ? 'not_admin' : 'auth_required' });
    }
    req.campaignWho = w;
    next();
  };
}

export function attachCampaignRoutes(app, engine) {
  // Registered in table order: literal paths (mine, admin/…) come before the
  // ones with a parameter in the same position, and 'mine', 'admin' and
  // 'manage' are reserved slugs besides.
  for (const [method, path, tier, handler] of CAMPAIGN_ROUTES) {
    app[method.toLowerCase()](path, guard(tier), async (req, res) => {
      try { res.json(await handler(engine, req, req.campaignWho)); }
      catch (e) { send(res, e); }
    });
  }
  console.log(`[campaigns] ${CAMPAIGN_ROUTES.length} routes attached — funding ${fundingEnabled() ? 'ON' : 'off (CAMPAIGN_FUNDING)'}, X app token ${appBearerConfigured() ? 'set' : 'not set'}`);
}

/**
 * Call in: a seat joined with `campaign` in the body reserves the signed-in
 * account's slot before the join route runs, binds to the seat id the route
 * answers with, and gives the slot back when the route answers anything else.
 * Registered ahead of the join routes so it wraps all of them unchanged.
 */
export function campaignJoinMiddleware(engine, { resolveRoomId }) {
  return (req, res, next) => {
    const slug = req.body?.campaign ? String(req.body.campaign).slice(0, 40) : null;
    if (!slug) return next();
    const w = who(req);
    const roomId = resolveRoomId(req);
    let r;
    try { r = engine.reserve({ slug, accountId: w.accountId, kind: 'callin', roomId }); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message, reason: e.code || 'campaign_refused' }); }
    const json = res.json.bind(res);
    res.json = (body) => {
      res.json = json;
      try {
        if (res.statusCode < 400 && body?.success && body.seatId) engine.bind(r.claimId, { seatId: body.seatId });
        else engine.releaseSlot(r.claimId, 'join did not complete');
      } catch { /* the engine logs */ }
      return json(body);
    };
    res.on('finish', () => {
      const k = engine.store.getClaim(r.claimId);
      if (k && k.status === 'recorded' && !k.seatId) engine.releaseSlot(r.claimId, 'join did not complete');
    });
    next();
  };
}
