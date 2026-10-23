/**
 * campaign-engine.js — targeted reward campaigns: "if you have 10k followers /
 * are someone I follow / … I'll pay you to send a Holler on my stream".
 *
 * ── WHAT IS PAID FOR, AND WHAT NEVER IS ──────────────────────────────────
 * A campaign pays for ONE action on Holler: a Holler (a recorded clip that
 * plays on the creator's stream) or a Call in (a live camera seat) in the
 * creator's room. X's Developer Policy forbids paying people to take actions
 * on X, so no campaign may require or reward a follow, reply, repost, quote or
 * like. The X side is only ever READ, to decide who may take part
 * (campaign-eligibility.js); campaign copy is checked by `copyViolation`.
 *
 * ── MONEY: THE SETTLEMENT DOOR, AND NOTHING ELSE ─────────────────────────
 * This module never signs and holds no key. Every amount moves through
 * settlement.js against a recorded intent (Gate H, Tier 1):
 *
 *   fund    settlement.pull  — creator → platform wallet, by the ERC-20
 *           allowance the creator approved to the platform (seller) wallet in
 *           their browser, the same allowance shape a paid seat uses. Ref
 *           `campaign:fund:<id>:<attempt>`. Refused, without calling pull,
 *           when the door has no pull signer: a dry pull would record a
 *           budget nobody paid. The wallet must cite its own approve tx for
 *           exactly the budget, mined after the terms were last set
 *           (approvalProblem), AND sign an EIP-712 Fund message naming this
 *           campaign (fundSignatureProblem). The allowance is to a DEDICATED
 *           campaign spender (pullSigner), not the seat key. The pulled {token, atomic}
 *           is written into `funding`; payouts and the refund use only that
 *           (moneyToken). `funded` only on THAT transaction's own success
 *           receipt whose logs show the Transfer of the budget (settleFunding);
 *           until then the campaign is `funding_pending` and nothing about it
 *           can change.
 *   pay     settlement.release({ signer: 'platform', bucket: 'campaign' }) —
 *           platform wallet → the claimant's payout wallet, ONCE per claim
 *           (ref `campaign:pay:<claimId>`), only after the claim reached the
 *           campaign's required state, only while it is not closed.
 *   x-cost  settlement.release to the PLATFORM address, which the door records
 *           as RETAINED: what X billed for this campaign's lookups stays in
 *           the platform wallet and is subtracted from the budget, on the
 *           money ledger rather than in a side table. HELD against the budget
 *           before the first X call (holdX), settled after (settleX).
 *   refund  settlement.refund — platform wallet → the funding wallet, ONCE
 *           (ref `campaign:refund:<id>`), after close, after every owed and
 *           honoured claim and every X hold has settled: funded − Σ(pay and
 *           x-cost intents), in the pulled token.
 *
 * The door's flush executes PENDING intents with PLATFORM_SETTLEMENT_KEY;
 * without that key they wait, recorded. Real-money campaigns additionally need
 * CAMPAIGN_FUNDING=1 on the server (see `fundingEnabled`): an unflagged
 * deploy can draft campaigns and run every check, but cannot take a budget.
 *
 * ── BUDGET AND CLAIMS ARE ATOMIC ─────────────────────────────────────────
 * One claim per campaign per X user id AND per account. A slot is RESERVED
 * when the Holler or seat is created, synchronously, against
 * funded − (reserved + owed + paid + x-cost); maxClaims counts the same set.
 * A dropped clip or a seat that left early gives its slot back. A closed
 * campaign gives back every slot not yet bound to a Holler or seat; one
 * already submitted is honoured for CLOSE_GRACE_MS, and then expires.
 */
import { randomUUID } from 'crypto';
import { verifyTypedData as verifyTypedDataEoa, hashTypedData, parseEventLogs, erc20Abi } from 'viem';
import { toAtomic, fromAtomic } from './token-utils.js';
import { getAccount, setLinkAttributes } from './accounts.js';
import * as xApiDefault from './attestation/x-api.js';
import * as xTokensDefault from './x-token-store.js';
import { createCampaignStore } from './campaign-store.js';
import { merkleRoot, normaliseIds } from './campaign-merkle.js';
import {
  evaluate, normaliseRules, describeRules, copyViolation, RULE_MENU, ALWAYS_ATTRS,
} from './campaign-eligibility.js';

const DAY = 86_400_000;
export const ATTR_MAX_AGE_MS = DAY;
export const CHECK_VALID_MS = DAY;
const RESERVATION_STALE_MS = 2 * 60_000;
const WALLET_GRACE_MS = () => Math.max(DAY, Number(process.env.CAMPAIGN_WALLET_GRACE_DAYS || 14) * DAY);
export const fundingEnabled = () => process.env.CAMPAIGN_FUNDING === '1';
/** What a person is told when funding is off. Never names the env var. */
export const PAID_OFF_MSG = 'Paid campaigns aren’t open on this server yet. Nothing was charged.';
export const MAX_DEADLINE_DAYS = 90;
/** A live campaign's deadline moves at most this far past the deadline it opened with. */
export const MAX_EXTENSION_DAYS = 90;
/**
 * A Holler / Call in already SUBMITTED when the campaign closes (by the
 * creator, an admin, or its deadline) is honoured: it still counts if it
 * reaches the required state within this window after the close. The refund
 * waits for it, like it waits for owed claims.
 */
const CLOSE_GRACE_MS = () => Math.max(60 * 60_000, Number(process.env.CAMPAIGN_CLOSE_GRACE_HOURS || 48) * 60 * 60_000);
/** What one X profile / list lookup is held at before it runs (it bills $0.01). */
const LOOKUP_HOLD_USD = 0.05;
/** X estimates a campaign gets free (the platform absorbs the $0.01 lookup); after that they are charged. */
export const FREE_ESTIMATES = 3;
/** Holds written by an earlier process can never settle; sync drops them. */
const BOOT_ID = randomUUID();
/**
 * Custom ERC-20 rewards: the door pays every transfer's fee IN the token it
 * moves (settlement.js `feeToken: token.address`), so a token that is not an
 * accepted Tempo fee token cannot be pulled or paid out. Until one has been
 * tested on chain, a campaign may use a custom token only if the operator
 * lists its address in CAMPAIGN_FEE_TOKENS (comma or space separated).
 */
/**
 * The funding wallet's consent (OPEN-ISSUES N10): an EIP-712 message, signed
 * BY the wallet the budget is pulled from, naming the campaign, the wallet,
 * the token and the exact amount, valid for at most FUND_SIGNATURE_MAX_SECS.
 * The approve transaction alone proved only that SOME wallet approved the
 * spender; this proves the wallet meant THIS campaign. No verifyingContract:
 * the spender is a plain wallet, and the campaign id in the message is what
 * binds it (one signed message funds at most one attempt; see `fund`).
 */
export const FUND_SIGNATURE_MAX_SECS = 600;
export const FUND_TYPES = {
  Fund: [
    { name: 'campaignId', type: 'string' },
    { name: 'wallet', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'amountAtomic', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};
export function fundTypedData({ chainId, campaignId, wallet, token, amountAtomic, deadline }) {
  return {
    domain: { name: 'Holler Campaigns', version: '1', chainId: Number(chainId) },
    types: FUND_TYPES, primaryType: 'Fund',
    message: { campaignId: String(campaignId), wallet, token, amountAtomic: BigInt(amountAtomic), deadline: BigInt(deadline) },
  };
}
/** A funding_pending campaign with no transaction is resolved after this long (sweep or admin). */
export const STUCK_FUNDING_MS = 30 * 60_000;
/** followedByFromSet: what X checks may cost a campaign in all, by default, as a share of its budget. */
export const DEFAULT_X_CHECK_SHARE = 0.2;

export const campaignFeeTokens = () => new Set(String(process.env.CAMPAIGN_FEE_TOKENS || '').split(/[\s,;]+/).filter(Boolean).map((a) => a.toLowerCase()));
export const customTokenAllowed = (address) => campaignFeeTokens().has(String(address || '').toLowerCase());

/** Statuses that hold a slot (count toward maxClaims and the budget). */
export const ACTIVE = new Set(['recorded', 'approved', 'aired', 'joined', 'owed', 'releasing', 'paid', 'failed']);
/** Reached the action but not yet owed. */
const IN_FLIGHT = new Set(['recorded', 'approved', 'aired', 'joined']);
const RANK = {
  holler: { recorded: 0, approved: 1, aired: 2 },
  callin: { recorded: 0, joined: 1, aired: 2 },
};
/**
 * The FIRST option is the default. `aired` is the default for both: in an
 * auto-moderated room `approved` fires the moment the upload clears automated
 * moderation, with no person looking, and `joined` fires the moment a camera
 * track is published. Both stay selectable; docs/internal/campaigns.md says
 * what each means.
 */
export const REQUIRE_OPTIONS = { holler: ['aired', 'approved'], callin: ['aired', 'joined'] };
const RESERVED_SLUGS = new Set(['manage', 'admin', 'new', 'api', 'mine']);

function fail(code, message, status = 400, extra = {}) {
  const e = new Error(message); e.code = code; e.status = status; Object.assign(e, extra); return e;
}
const big = (v) => BigInt(v ?? 0);
/**
 * Whether a pull's error PROVES nothing was broadcast: the door tagged it
 * preSend (it threw before signing for the chain), or viem's error chain holds
 * a gas-estimate failure or a contract revert with its reason — both raised
 * while the transaction was still being built. Any other error (timeout,
 * "already known", nonce, transport) may have reached the node.
 */
export function provablyPreSend(e) {
  for (let x = e, i = 0; x && i < 10; x = x.cause, i++) {
    if (x.preSend === true) return true;
    if (x.name === 'EstimateGasExecutionError') return true;
    if (x.name === 'ContractFunctionRevertedError' && (x.reason || x.data || x.signature)) return true;
  }
  return false;
}
/**
 * A campaign spender key that resolves to ANY other server signer is refused
 * at boot (server.js): one address spending two kinds of allowance is the
 * seat/campaign mix-up the dedicated spender exists to prevent. `others` maps
 * an env var NAME to the address its key resolves to (or null). Returns the
 * colliding names; never a key or an address.
 */
export function spenderCollisions(spenderAddress, others = {}) {
  if (!spenderAddress) return [];
  return Object.entries(others).filter(([, a]) => sameAddr(a, spenderAddress)).map(([name]) => name);
}
/** Every X attribute a campaign rule can read (the menu plus the always-on labels). */
const CAMPAIGN_X_ATTRS = [...new Set([...ALWAYS_ATTRS, ...RULE_MENU.map((m) => m.attr).filter(Boolean)])];
/**
 * A profile read's records, plus an explicit null record for every campaign
 * attribute X left out: "known missing as of this read", which fails closed
 * and does not trigger another paid read until the read itself is stale.
 */
export function withKnownMissing(records, at = new Date().toISOString()) {
  const have = new Set(records.map((r) => r?.attribute));
  const trust = records.find((r) => r?.source === 'x-api')?.trust ?? 100;
  return [...records, ...CAMPAIGN_X_ATTRS.filter((n) => !have.has(n)).map((attribute) => ({ attribute, value: null, source: 'x-api', trust, fetchedAt: at, missing: true }))];
}
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
const sameAddr = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
const sameHash = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

/**
 * The engine's `confirmTx` over a viem public client (server.js wires it).
 * `checkReplacement: false` (cold review B1): viem's default answers a hash
 * whose nonce another transaction from the same sender used with THAT
 * transaction's receipt; for a pull, a receipt that is not this hash's own is
 * no answer at all. The receipt's hash must equal the hash asked about, and
 * its logs go to the engine, which decides from the Transfer in them
 * (settleFunding), never from `status` alone. Any throw (timeout, not mined)
 * → null: no receipt yet.
 */
export function receiptConfirmer(publicClient, { timeoutMs = 60_000 } = {}) {
  return async (hash) => {
    try {
      const r = await publicClient.waitForTransactionReceipt({ hash, timeout: timeoutMs, checkReplacement: false });
      if (!r || !sameHash(r.transactionHash, hash)) return null;
      return { status: r.status === 'success' ? 'success' : 'reverted', transactionHash: r.transactionHash, logs: r.logs || [] };
    } catch { return null; }
  };
}

/**
 * Σ of the ERC-20 Transfer(from → to) events `token` emitted in a receipt's
 * logs, or null when there is none. Decoded here, from the raw logs, so no
 * adapter can hand the engine a pre-decoded "it moved".
 */
export function transferredInReceipt(rcpt, { token, from, to }) {
  let logs;
  try { logs = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: Array.isArray(rcpt?.logs) ? rcpt.logs : [], strict: true }); } catch { return null; }
  const hits = logs.filter((l) => sameAddr(l.address, token) && sameAddr(l.args?.from, from) && sameAddr(l.args?.to, to));
  if (!hits.length) return null;
  return hits.reduce((s, l) => s + BigInt(l.args.value), 0n);
}

export function createCampaignEngine({
  dataDir,
  settlement,
  platformAddress,
  spender = platformAddress,
  usdc = { address: null, decimals: 6, symbol: 'USDC' },
  readAllowance = async () => 0n,
  readTokenMeta = async () => { throw new Error('token metadata unavailable'); },
  confirmTx = async () => null,
  /**
   * async (txHash) → {from, to, status, timestampMs, approvals: [{token,
   * owner, spender, value}]} | null — the creator's approve transaction as
   * the chain recorded it (server.js reads it with viem). It is the proof
   * that the funding wallet is the caller's: nothing else ties a wallet to an
   * account (a payout wallet is set without a signature).
   */
  readApproval = async () => null,
  /**
   * async ({token, from, to, atomic, sinceMs}) → {found: bool, txHash?} —
   * whether the chain has an ERC-20 Transfer(from → to) of exactly `atomic`
   * in `token` since `sinceMs` (server.js reads the token's Transfer logs).
   * The stuck-funding sweep decides "did the pull land" from THIS, never from
   * the allowance (which the creator controls). null (not wired), or a
   * throw, means it cannot tell: a person decides, nothing is reverted.
   */
  findFundingTransfer = null,
  /**
   * async (address) → number: the spender's MINED transaction count (viem
   * getTransactionCount, blockTag 'latest'). With `txKnown` and
   * findFundingTransfer it decides that a signed pull can no longer land: its
   * nonce was used by another transaction (droppedPullVerdict). null → never
   * decided that way; a person resolves it.
   */
  readSpenderNonce = null,
  /** async (hash) → bool: whether the node knows the transaction at all (mined or pending). Throws when it cannot tell. */
  txKnown = null,
  /**
   * (roomId) → bool: the room is ON AIR — the same source of truth the Holler
   * `aired` hook uses (letters.js: an open airing in airings-store.js, recorded
   * when Twitch says the room's channel is live). A Call in counts toward a
   * campaign only on air (cold review B2). Not wired → never on air.
   */
  roomOnAir = () => false,
  /** The chain id the funding signature's EIP-712 domain names (server.js passes its Tempo CHAIN_ID). */
  chainId = 4217,
  /**
   * async ({address, domain, types, primaryType, message, signature}) → bool.
   * The default is viem's local ECDSA check (EOAs). server.js passes the
   * Tempo public client's verifyTypedData, which also answers for contract
   * wallets (ERC-1271 / ERC-6492) and Tempo's P256 / WebAuthn envelopes.
   */
  verifyFundSignature = (args) => verifyTypedDataEoa(args),
  /**
   * The door's signer slot that pulls a campaign budget: a DEDICATED spender
   * (CAMPAIGN_SPENDER_KEY), never the seat pull key, so an allowance a
   * creator grants a campaign can never be spent by a seat, and the reverse.
   */
  pullSigner = 'campaignPull',
  resolveRoom = () => null,
  /**
   * Whether the server receives SIGNED LiveKit webhooks (track_published),
   * the only signal a Call in counts from. False → Call in campaigns refuse to
   * reserve: there would be nothing server-side to count from.
   */
  seatSignalAvailable = () => false,
  /**
   * The Holler room's overlay, as the server sees it (OPEN-ISSUES N14):
   * (roomId) → { keyedConnected, unkeyedConnected, keyedSeenAt, keyed }.
   * Shown to the creator only; null wiring shows nothing.
   */
  overlayKeyState = null,
  xApi = xApiDefault,
  xTokens = xTokensDefault,
  now = () => Date.now(),
  log = console,
} = {}) {
  const store = createCampaignStore({ dataDir });
  const checking = new Set();
  const funding = new Set();       // in-process lock: a fund() is between its first and last await
  const reconciling = new Set();   // a sync-started funding reconcile is awaiting a receipt
  const seatTimers = new Map();
  const xLocks = new Map();        // campaignId → tail of the X-spend queue
  const usd2usdc = (usd) => BigInt(Math.round((Number(usd) || 0) * 1e6)) * 10n ** BigInt(usdc.decimals - 6);
  /** The token money moves in: what was PULLED, once there is a pull; the draft's token before. */
  const moneyToken = (c) => c?.funding?.token || c?.token;
  const isUsdc = (c) => sameAddr(moneyToken(c)?.address, usdc.address);
  /** Funded = a pull whose receipt was seen to succeed. Nothing else counts. */
  const fundedAtomic = (c) => {
    const f = c?.funding;
    if (!f) return 0n;
    if (f.state ? f.state === 'confirmed' : f.receipt === 'success') return big(f.atomic);
    return 0n;
  };
  const heldAtomic = (c) => Object.values(c?.xHolds || {}).reduce((s, h) => s + big(h.atomic), 0n);

  // ── accounting ────────────────────────────────────────────────────────────
  function totals(campaignId) {
    const c = store.getCampaign(campaignId);
    const claims = store.listClaims(campaignId);
    const active = claims.filter((k) => ACTIVE.has(k.status));
    const reserved = active.reduce((s, k) => s + big(k.reservedAtomic), 0n);
    const xCost = big(c?.xCostAtomic);
    const xHeld = heldAtomic(c);
    const funded = fundedAtomic(c);
    const committed = reserved + xCost + xHeld;
    return { funded, reserved, xCost, xHeld, committed, remaining: funded - committed, activeCount: active.length, claims };
  }

  function history(claim, to, why) {
    claim.history = [...(claim.history || []), { at: new Date(now()).toISOString(), from: claim.status, to, why: why || null }].slice(-40);
    claim.status = to;
    claim.updatedAt = new Date(now()).toISOString();
  }

  /**
   * What the DOOR has recorded for this campaign under a ref prefix — read
   * from each intent's first row, because a RETAINED row (an x-cost kept in
   * the platform wallet) carries its amount there and not in the fold.
   */
  function doorSum(campaignId, prefix, kind = null) {
    let sum = 0n;
    for (const rec of settlement.intentsFor(prefix)) {
      const row = rec.rows?.[0] || rec;
      if (row.meta?.campaignId !== campaignId) continue;
      if (kind && row.kind !== kind) continue;
      sum += big(row.amountAtomic);
    }
    return sum;
  }

  // ── campaigns ─────────────────────────────────────────────────────────────
  function validateDraft(input, { existing = null, isAdmin = false, accountId } = {}) {
    const title = String(input.title ?? existing?.title ?? '').trim().slice(0, 90);
    const blurb = String(input.blurb ?? existing?.blurb ?? '').trim().slice(0, 600);
    if (!title) throw fail('invalid', 'A campaign needs a title.');
    const bad = copyViolation(`${title}\n${blurb}`);
    if (bad) throw fail('x_policy', bad);
    const actionIn = input.action || existing?.action || {};
    const kind = actionIn.kind === 'callin' ? 'callin' : 'holler';
    const require = REQUIRE_OPTIONS[kind].includes(actionIn.require) ? actionIn.require : REQUIRE_OPTIONS[kind][0];
    const roomHandle = String(actionIn.roomHandle || '').trim().replace(/^@/, '').toLowerCase();
    const room = resolveRoom(roomHandle);
    if (!room) throw fail('invalid', `No room has the handle "${roomHandle}".`);
    if (!isAdmin && room.ownerKey && room.ownerKey !== accountId) throw fail('not_your_room', 'A campaign can only send people to a room you own.', 403);
    if (kind === 'callin' && room.transport && room.transport !== 'livekit') throw fail('needs_livekit', 'A Call in campaign needs a room on the LiveKit camera transport: that is where the server sees a camera go live. This room uses another transport.', 409);
    const minSeconds = kind === 'callin' ? Math.max(10, Math.min(3600, Math.floor(Number(actionIn.minSeconds) || 60))) : null;
    const { rules, errors } = normaliseRules(input.rules ?? existing?.rules ?? {});
    if (errors.length) throw fail('invalid', errors.join('; '));
    for (const sid of [rules.referenceSetId, rules.followedByFromSet?.referenceSetId].filter(Boolean)) {
      const s = store.getSet(sid);
      if (!s) throw fail('invalid', `Reference set ${sid} does not exist.`);
      if (!isAdmin && s.createdBy !== accountId) throw fail('invalid', 'You can only use reference sets you built.', 403);
    }
    const maxClaims = Math.max(1, Math.min(100_000, Math.floor(Number(input.maxClaims ?? existing?.maxClaims) || 0)));
    if (!maxClaims) throw fail('invalid', 'maxClaims must be at least 1.');
    // A deadline is required, in the future, and at most MAX_DEADLINE_DAYS out:
    // a campaign with no end holds a creator's budget (and the refund) forever.
    let deadline = input.deadline ?? existing?.deadline ?? null;
    if (!deadline) throw fail('invalid', 'A campaign needs a deadline.');
    const dt = Date.parse(deadline);
    if (!Number.isFinite(dt)) throw fail('invalid', 'deadline must be a date.');
    if (dt <= now()) throw fail('invalid', 'The deadline is in the past.');
    if (dt > now() + MAX_DEADLINE_DAYS * DAY) throw fail('invalid', `The deadline can be at most ${MAX_DEADLINE_DAYS} days away.`);
    deadline = new Date(dt).toISOString();
    return { title, blurb, action: { kind, roomHandle, require, ...(minSeconds ? { minSeconds } : {}) }, rules, maxClaims, deadline };
  }

  /** {address, symbol, decimals} for a Tempo ERC-20, read on chain once and cached. */
  const tokenCache = new Map();
  async function tokenInfo(address) {
    if (!isAddr(address)) throw fail('invalid', 'That is not a token address (0x followed by 40 hex characters).');
    const k = address.toLowerCase();
    // `campaignAllowed`: whether a campaign may use it here (see customTokenAllowed).
    const allowed = sameAddr(address, usdc.address) || customTokenAllowed(address);
    if (tokenCache.has(k)) return { ...tokenCache.get(k), campaignAllowed: allowed };
    let meta;
    try { meta = await readTokenMeta(address); } catch (e) { throw fail('invalid_token', `That address did not answer as an ERC-20 token on Tempo (${e.shortMessage || e.message}).`, 404); }
    const decimals = Number(meta?.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw fail('invalid_token', 'That token reports no usable decimals.', 404);
    const out = { address, symbol: String(meta.symbol || 'TOKEN').slice(0, 16), decimals };
    tokenCache.set(k, out);
    return { ...out, campaignAllowed: allowed };
  }

  async function resolveToken(input) {
    if (!input || input.type !== 'token') return { type: 'usdc', token: { ...usdc } };
    if (!isAddr(input.address)) throw fail('invalid', 'A custom-token campaign needs the token\'s contract address. Campaigns in off-chain credit or points are not supported.');
    if (!sameAddr(input.address, usdc.address) && !customTokenAllowed(input.address)) {
      throw fail('token_not_allowed', 'Custom tokens need an on-chain test first: the platform pays each transfer\'s network fee in the token it moves, so a token that is not an accepted Tempo fee token could be collected but never paid out. This server only takes custom tokens its operator has tested and listed. Use USDC for now.', 409);
    }
    let meta;
    try { meta = await readTokenMeta(input.address); } catch (e) { throw fail('invalid_token', `That address did not answer as an ERC-20 token on Tempo (${e.shortMessage || e.message}).`); }
    const decimals = Number(meta?.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw fail('invalid_token', 'That token reports no usable decimals.');
    return { type: 'token', token: { address: input.address, decimals, symbol: String(meta.symbol || 'TOKEN').slice(0, 16) } };
  }

  function amounts(token, rewardAmount, budgetAmount) {
    let reward, budget;
    try { reward = toAtomic(String(rewardAmount), token.decimals); budget = toAtomic(String(budgetAmount), token.decimals); }
    catch { throw fail('invalid', 'Reward and budget must be numbers.'); }
    if (reward <= 0n) throw fail('invalid', 'The reward must be above zero.');
    if (budget < reward) throw fail('invalid', 'The budget must cover at least one reward.');
    return {
      reward: { amount: fromAtomic(reward, token.decimals), atomic: reward.toString() },
      budget: { amount: fromAtomic(budget, token.decimals), atomic: budget.toString() },
    };
  }

  async function createCampaign(input, { accountId, isAdmin = false }) {
    if (!accountId) throw fail('auth_required', 'Sign in to create a campaign.', 401);
    let slug = String(input.slug || '').trim().toLowerCase();
    if (slug) {
      if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(slug) || RESERVED_SLUGS.has(slug)) throw fail('invalid', 'The link name is 3-40 characters: lowercase letters, numbers and dashes.');
      if (store.slugTaken(slug)) throw fail('slug_taken', 'That link name is taken.', 409);
    } else {
      // Minted from the title when the creator did not pick one: lowercase,
      // dashes, at most 32 characters, then -2, -3… until it is free.
      const base = (String(input.title || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '')) || 'campaign';
      const root = base.length >= 3 && !RESERVED_SLUGS.has(base) ? base : `${base}-campaign`.replace(/^-/, '');
      slug = root;
      for (let i = 2; store.slugTaken(slug); i++) slug = `${root}-${i}`;
    }
    const d = validateDraft(input, { isAdmin, accountId });
    const { type, token } = await resolveToken(input.reward);
    const a = amounts(token, input.reward?.amount, input.budget?.amount);
    if (BigInt(a.reward.atomic) * BigInt(d.maxClaims) < BigInt(a.budget.atomic)) {
      // Fine: maxClaims is the binding limit. Nothing to do; noted for clarity.
    }
    const at = new Date(now()).toISOString();
    const c = {
      id: `cmp_${randomUUID().replace(/-/g, '').slice(0, 14)}`, slug, ...d,
      reward: { type, ...a.reward }, budget: a.budget, token,
      status: 'draft', hidden: false, creatorAccountId: accountId,
      funding: null, fundingAttempts: 0, xCostAtomic: '0', refund: null,
      // When the money terms (token, budget) were last set: an approve cited
      // to fund must be mined after this, not merely after createdAt.
      termsAt: at,
      createdAt: at, updatedAt: at,
    };
    store.appendLedger({ kind: 'created', campaignId: c.id, by: accountId });
    return store.putCampaign(c);
  }

  /** Drafts change freely; a funded campaign can change rules until it opens; a live one only its copy and a later deadline. */
  const fundingBusy = (id, c) => funding.has(id) || c?.status === 'funding_pending';
  const FUNDING_BUSY_MSG = 'The budget is being collected and confirmed on chain; nothing about this campaign can change until that finishes.';

  async function updateCampaign(id, input, { accountId, isAdmin = false }) {
    const pre = store.getCampaign(id);
    if (!pre) throw fail('not_found', 'No such campaign.', 404);
    if (!isAdmin && pre.creatorAccountId !== accountId) throw fail('forbidden', 'This is not your campaign.', 403);
    if (fundingBusy(id, pre)) throw fail('funding_in_progress', FUNDING_BUSY_MSG, 409);
    // The only await: resolve a new reward token. Everything after it is
    // synchronous — re-read, re-check, write — so a fund() that started while
    // the token was being read cannot be overwritten (the token-switch hole).
    const resolved = pre.status === 'draft' && input.reward ? await resolveToken(input.reward) : null;
    const c = store.getCampaign(id);
    if (!c) throw fail('not_found', 'No such campaign.', 404);
    if (fundingBusy(id, c)) throw fail('funding_in_progress', FUNDING_BUSY_MSG, 409);
    if (c.status === 'closed') throw fail('closed', 'A closed campaign cannot change.', 409);
    if (c.status === 'live') {
      const next = { ...c };
      if (input.title != null || input.blurb != null) {
        const title = String(input.title ?? c.title).trim().slice(0, 90);
        const blurb = String(input.blurb ?? c.blurb).trim().slice(0, 600);
        const bad = copyViolation(`${title}\n${blurb}`);
        if (bad) throw fail('x_policy', bad);
        Object.assign(next, { title, blurb });
      }
      if (input.deadline) {
        const t = Date.parse(input.deadline);
        if (!Number.isFinite(t) || (c.deadline && t < Date.parse(c.deadline))) throw fail('invalid', 'A live campaign\'s deadline can only move later.');
        // Later, but bounded: at most MAX_DEADLINE_DAYS from now (the draft
        // rule), and at most MAX_EXTENSION_DAYS past the deadline it OPENED
        // with — an unbounded extension holds the creator's refund forever.
        if (t > now() + MAX_DEADLINE_DAYS * DAY) throw fail('invalid', `The deadline can be at most ${MAX_DEADLINE_DAYS} days away.`);
        const opened = Date.parse(c.originalDeadline || c.deadline);
        if (Number.isFinite(opened) && t > opened + MAX_EXTENSION_DAYS * DAY) throw fail('invalid', `A live campaign's deadline can move at most ${MAX_EXTENSION_DAYS} days past the one it opened with (${new Date(opened).toISOString().slice(0, 10)}).`);
        next.deadline = new Date(t).toISOString();
      }
      next.updatedAt = new Date(now()).toISOString();
      return store.putCampaign(next);
    }
    const d = validateDraft(input, { existing: c, isAdmin, accountId });
    const next = { ...c, ...d, updatedAt: new Date(now()).toISOString() };
    if (c.status === 'draft' && (input.reward || input.budget)) {
      const { type, token } = input.reward ? resolved : { type: c.reward.type, token: c.token };
      const a = amounts(token, input.reward?.amount ?? c.reward.amount, input.budget?.amount ?? c.budget.amount);
      Object.assign(next, { reward: { type, ...a.reward }, budget: a.budget, token });
      // New money terms: an approve mined before now cannot fund them (an old
      // draft edited to match an approve someone else sent).
      if (!sameAddr(token?.address, c.token?.address) || String(a.budget.atomic) !== String(c.budget?.atomic)) next.termsAt = next.updatedAt;
    }
    return store.putCampaign(next);
  }

  // ── funding: the creator's allowance, pulled through the door ─────────────
  function fundTerms(id, { accountId, isAdmin = false }) {
    const c = store.getCampaign(id);
    if (!c) throw fail('not_found', 'No such campaign.', 404);
    if (!isAdmin && c.creatorAccountId !== accountId) throw fail('forbidden', 'This is not your campaign.', 403);
    return {
      spender, token: c.token, amountAtomic: c.budget.atomic, amount: c.budget.amount,
      // `spender` is approved and pulls; `holder` is where the budget then
      // sits and what pays rewards and the refund (the platform wallet).
      holder: platformAddress,
      fundingEnabled: fundingEnabled(), pullSigner: !!spender && !!settlement?.hasSigner?.(pullSigner),
      status: c.status,
      // What the funding wallet signs after its approve mines: everything but
      // `wallet` and `deadline`, which the client fills in (fundTypedData).
      sign: { domain: { name: 'Holler Campaigns', version: '1', chainId: Number(chainId) }, types: FUND_TYPES, primaryType: 'Fund', message: { campaignId: c.id, token: c.token.address, amountAtomic: c.budget.atomic }, maxSeconds: FUND_SIGNATURE_MAX_SECS },
    };
  }

  /**
   * Fund: pull the budget, then wait for the receipt.
   *
   * The token and amount pulled are SNAPSHOTTED before the first await and
   * written into `funding` ({token, atomic, ref, wallet}); payouts and the
   * refund use only that record (moneyToken), never the draft's editable
   * fields. While a fund() runs the in-process lock refuses updateCampaign
   * and close, and from the moment the pull is attempted the campaign is
   * `funding_pending` on disk, which refuses them across restarts too.
   *
   * Only a SUCCESS receipt makes a campaign `funded`. No receipt (timeout,
   * RPC down) leaves it `funding_pending` and `sync` reconciles it from the
   * door's PULL row; a reverted pull puts it back to `draft` with the failure
   * recorded in `fundingFailures`.
   */
  async function fund(id, { wallet, approveTx = null, signature = null, typedData = null }, { accountId, isAdmin = false }) {
    const c = store.getCampaign(id);
    if (!c) throw fail('not_found', 'No such campaign.', 404);
    if (!isAdmin && c.creatorAccountId !== accountId) throw fail('forbidden', 'This is not your campaign.', 403);
    if (fundingBusy(id, c)) throw fail('funding_in_progress', FUNDING_BUSY_MSG, 409);
    if (c.status !== 'draft' || c.funding) throw fail('already_funded', 'This campaign is already funded.', 409);
    if (!fundingEnabled()) throw fail('funding_off', PAID_OFF_MSG, 503);
    // A dry pull would record a budget nobody paid. Refuse before calling it.
    // Only the dedicated campaign spender pulls a budget: with no such key
    // there is nothing safe to approve, so nothing is asked for.
    if (!spender || !settlement?.hasSigner?.(pullSigner)) throw fail('no_pull_signer', 'This server cannot take a campaign budget right now. Nothing was charged.', 503);
    if (!isAddr(wallet)) throw fail('invalid', 'Connect the wallet that approved the budget.');
    // The wallet a budget is pulled from must PROVE it is the caller's: a
    // fresh approve transaction it sent, for exactly this budget, after this
    // campaign existed. A bare address is never enough — the spender is the
    // same key seat payments approve, so any wallet with leftover seat
    // allowance could otherwise be pulled into someone else's campaign.
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(approveTx || ''))) throw fail('approve_required', 'Approve the budget from the funding wallet first: that approval is what shows the wallet is yours. Nothing was charged.', 402);
    funding.add(id);
    try {
      const terms = { token: { address: c.token.address, decimals: c.token.decimals, symbol: c.token.symbol }, atomic: c.budget.atomic };
      const need = big(terms.atomic);
      let ap;
      try { ap = await readApproval(approveTx); } catch (e) { throw fail('approve_unreadable', `Could not read the approval transaction on chain (${e.shortMessage || e.message}). Nothing was charged.`, 502); }
      const bad = approvalProblem(ap, { wallet, token: terms.token.address, atomic: terms.atomic, after: Date.parse(c.termsAt || c.createdAt) });
      if (bad) {
        store.appendLedger({ kind: 'funding-refused', campaignId: id, approveTx, from: wallet, why: bad });
        throw fail('approve_invalid', `That approval does not fund this campaign: ${bad}. Nothing was charged.`, 403);
      }
      // The wallet's own signature over THIS campaign (N10): an approve proves
      // only that the wallet approved the spender, which a stranger's seat or
      // another campaign's approve also does.
      const sig = await fundSignatureProblem({ c, wallet, terms, signature, typedData });
      if (sig.problem) {
        store.appendLedger({ kind: 'funding-refused', campaignId: id, approveTx, from: wallet, why: sig.problem });
        throw fail(sig.code, sig.code === 'signature_required' ? sig.problem : `That signature does not fund this campaign: ${sig.problem}. Nothing was charged.`, sig.status);
      }
      let allowance;
      try { allowance = big(await readAllowance(terms.token.address, wallet)); } catch (e) { throw fail('allowance_unreadable', `Could not read the allowance on chain (${e.shortMessage || e.message}). Nothing was charged.`, 502); }
      if (allowance < need) throw fail('insufficient_allowance', `The wallet has approved ${fromAtomic(allowance, terms.token.decimals)} ${terms.token.symbol} to ${spender}; the budget is ${c.budget.amount}. Nothing was charged.`, 402, { allowance: allowance.toString() });
      // Re-read after the await: nothing may have changed (the lock makes
      // this belt and braces, but a direct store write would not hold it).
      const cur = store.getCampaign(id);
      if (!cur || cur.status !== 'draft' || cur.funding || !sameTerms(cur, terms)) throw fail('terms_changed', 'The campaign changed while funding was starting. Nothing was charged; try again.', 409);
      // One approval funds one campaign (checked here, synchronously with the
      // write below, so two campaigns cannot race to use the same one).
      if (approveTxUsedElsewhere(approveTx, id)) throw fail('approve_reused', 'That approval was already used to fund another campaign. Approve again for this one. Nothing was charged.', 409);
      // One signed message funds at most one attempt, on any campaign. Keyed
      // by the message hash, not the signature bytes, so a re-encoded
      // signature over the same message is the same message.
      if (fundSigUsed(sig.hash)) throw fail('signature_reused', 'That signature was already used. Sign again to fund this campaign. Nothing was charged.', 409);
      const attempt = (cur.fundingAttempts || 0) + 1;
      const ref = `campaign:fund:${c.id}:${attempt}`;
      const at = new Date(now()).toISOString();
      store.putCampaign({ ...cur, status: 'funding_pending', fundingAttempts: attempt, funding: { state: 'pulling', wallet, ref, token: terms.token, atomic: terms.atomic, txHash: null, receipt: null, at, approveTx, fundSigHash: sig.hash }, updatedAt: at });
      store.appendLedger({ kind: 'funding-started', campaignId: c.id, ref, atomic: terms.atomic, token: terms.token.address, from: wallet, fundSigHash: sig.hash, approveTx });
      let r;
      try { r = await settlement.pull({ from: wallet, to: platformAddress, token: terms.token, amountAtomic: need.toString(), ref, signer: pullSigner, meta: { campaignId: c.id, approveTx } }); }
      catch (e) {
        const why = e.shortMessage || e.message;
        // Only an error that PROVABLY came before anything was sent (the gas
        // estimate or simulation reverted, or the door says it signed
        // nothing) puts the campaign back to draft. Anything else — an RPC
        // timeout, "already known", a dropped connection — may have been
        // broadcast and may land: the campaign stays funding_pending, flagged
        // for a person, and the door's PULL_SENT hash (when there is one)
        // lets sync settle it from the receipt. A retry is refused meanwhile,
        // so a creator can never be pulled twice for one budget.
        if (provablyPreSend(e)) { backToDraft(id, ref, `the pull was refused before sending: ${why}`); throw fail('pull_failed', `The budget could not be collected (${why}). Nothing was sent; nothing was charged.`, 502); }
        const sentHash = settlement.status(ref)?.txHash || null;
        const note = sentHash ? `the pull threw after it was signed (${why}); its transaction ${sentHash} is on record and its receipt decides` : `the pull threw and may have been sent (${why}): check the wallet's transfers on chain`;
        if (sentHash) patchFunding(id, ref, { state: 'pending', txHash: sentHash });
        store.appendLedger({ kind: 'funding-unknown', campaignId: id, ref, txHash: sentHash, why: note });
        log.error?.(`[campaigns] ${c.slug}: funding ${ref} — ${note}`);
        patchFunding(id, ref, { needsPerson: note });
        throw fail('pull_unconfirmed', 'The budget transfer may have gone through; it is being checked on chain. Do not approve or fund again: this campaign stays locked until the chain answers or a person resolves it.', 502);
      }
      if (r.dry) { backToDraft(id, ref, 'the pull ran dry (no pull signer)'); throw fail('no_pull_signer', 'The pull ran dry: no pull signer. Nothing was charged.', 503); }
      patchFunding(id, ref, { state: 'pending', txHash: r.txHash || null });
      const rcpt = r.txHash ? await confirmTx(r.txHash) : null;
      const out = settleFunding(id, ref, rcpt, r.txHash);
      if (out.outcome === 'reverted') throw fail('pull_reverted', `The funding transfer reverted on chain (${r.txHash}). Nothing was recorded as funded; try again.`, 502);
      if (out.outcome === 'short' || out.outcome === 'unproven') throw fail(`funding_${out.outcome}`, `${out.why}. The campaign is not funded and stays locked until a person resolves it. Do not approve or fund again.`, 502);
      return out.campaign;
    } finally {
      funding.delete(id);
    }
  }

  /** Why an approve transaction does not prove this wallet funds this campaign, or null. */
  function approvalProblem(ap, { wallet, token, atomic, after }) {
    if (!ap) return 'it was not found on chain (or is not mined yet)';
    if (ap.status !== 'success') return 'it did not succeed on chain';
    if (!sameAddr(ap.from, wallet)) return 'it was not sent from the funding wallet';
    const toToken = sameAddr(ap.to, token) || (Array.isArray(ap.calls) && ap.calls.some((x) => sameAddr(x?.to, token)));
    if (!toToken) return 'it was not sent to the reward token contract';
    // Block timestamps are whole SECONDS; `after` is a millisecond time. An
    // approve mined in the same second the terms were set is after them.
    if (!(Math.floor(Number(ap.timestampMs) / 1000) >= Math.floor(after / 1000))) return 'it was made before this campaign (or its current budget) existed';
    const ok = (ap.approvals || []).some((l) => sameAddr(l.token, token) && sameAddr(l.owner, wallet) && sameAddr(l.spender, spender) && String(l.value) === String(atomic));
    if (!ok) return 'it does not approve exactly the budget to the platform from this wallet';
    return null;
  }

  /**
   * Why `signature` is not the funding wallet's consent to fund THIS campaign
   * with THESE terms, or {hash} of the signed message when it is. The message
   * the client sent is compared field by field (for a plain answer), then the
   * signature is verified against the message rebuilt from the campaign —
   * never against the client's domain or types.
   */
  async function fundSignatureProblem({ c, wallet, terms, signature, typedData }) {
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130,}$/.test(signature)) {
      return { problem: 'Sign the funding message in your wallet after the approval: it shows this wallet means to fund this campaign. Nothing was charged.', code: 'signature_required', status: 402 };
    }
    const m = typedData?.message || {};
    const invalid = (problem) => ({ problem, code: 'signature_invalid', status: 403 });
    if (String(m.campaignId ?? '') !== c.id) return invalid('it names a different campaign');
    if (!sameAddr(m.wallet, wallet)) return invalid('it names a different wallet');
    if (!sameAddr(m.token, terms.token.address)) return invalid('it names a different token');
    if (String(m.amountAtomic ?? '') !== String(terms.atomic)) return invalid('it names a different amount');
    const deadline = Number(m.deadline);
    const nowS = Math.floor(now() / 1000);
    if (!Number.isSafeInteger(deadline) || deadline < nowS) return { ...invalid('it has expired; sign again'), code: 'signature_expired' };
    if (deadline > nowS + FUND_SIGNATURE_MAX_SECS + 60) return invalid(`its deadline is more than ${FUND_SIGNATURE_MAX_SECS / 60} minutes away`);
    const td = fundTypedData({ chainId, campaignId: c.id, wallet, token: terms.token.address, amountAtomic: terms.atomic, deadline });
    let ok = false;
    try { ok = await verifyFundSignature({ address: wallet, ...td, signature }); }
    catch (e) { throw fail('signature_unreadable', `Could not check the signature (${e.shortMessage || e.message}). Nothing was charged.`, 502); }
    if (!ok) return invalid('it was not signed by the funding wallet');
    return { problem: null, hash: hashTypedData(td) };
  }

  // Reuse is checked against the campaign LEDGER — every `funding-started`
  // row ever written, which is append-only and never trimmed — and not only
  // against `fundingFailures`, which keeps the last 10 failures for display
  // (after 10 later failures a signature used to fall off it and fund again).
  // The campaign records are still read for attempts started before the
  // ledger row carried approveTx.
  function fundSigUsed(hash) {
    const h = String(hash).toLowerCase();
    if (store.ledger().some((r) => r.kind === 'funding-started' && String(r.fundSigHash || '').toLowerCase() === h)) return true;
    return store.listCampaigns().some((x) => String(x.funding?.fundSigHash || '').toLowerCase() === h || (x.fundingFailures || []).some((f) => String(f.fundSigHash || '').toLowerCase() === h));
  }

  /** One approve funds one campaign; retrying the SAME campaign with it is fine (the signature is the one-time consent). */
  function approveTxUsedElsewhere(hash, id) {
    const h = String(hash).toLowerCase();
    if (store.ledger().some((r) => r.kind === 'funding-started' && r.campaignId !== id && String(r.approveTx || '').toLowerCase() === h)) return true;
    return store.listCampaigns().some((x) => x.id !== id && (String(x.funding?.approveTx || '').toLowerCase() === h || (x.fundingFailures || []).some((f) => String(f.approveTx || '').toLowerCase() === h)));
  }

  function sameTerms(c, terms) {
    return sameAddr(c.token?.address, terms.token.address) && Number(c.token?.decimals) === Number(terms.token.decimals) && String(c.budget?.atomic) === String(terms.atomic);
  }

  function patchFunding(id, ref, patch) {
    const cur = store.getCampaign(id);
    if (!cur?.funding || cur.funding.ref !== ref) return cur;
    return store.putCampaign({ ...cur, funding: { ...cur.funding, ...patch }, updatedAt: new Date(now()).toISOString() });
  }

  /** A pull that moved nothing (threw, ran dry, reverted): back to draft, the attempt on record. */
  function backToDraft(id, ref, why) {
    const cur = store.getCampaign(id);
    if (!cur?.funding || cur.funding.ref !== ref) return cur;
    const failure = { ref, txHash: cur.funding.txHash || null, approveTx: cur.funding.approveTx || null, fundSigHash: cur.funding.fundSigHash || null, why, at: new Date(now()).toISOString() };
    store.appendLedger({ kind: 'funding-failed', campaignId: id, ref, txHash: failure.txHash, why });
    log.warn?.(`[campaigns] ${cur.slug}: funding ${ref} did not complete — ${why}`);
    return store.putCampaign({ ...cur, status: 'draft', funding: null, fundingFailures: [...(cur.fundingFailures || []), failure].slice(-10), updatedAt: failure.at });
  }

  /**
   * The receipt decides — but only THIS transaction's receipt, and only what
   * its own logs say moved. Synchronous: called by fund() and by the reconcile
   * that sync starts.
   *   no receipt, or a receipt for another hash (a replacement: cold review
   *     B1/B5)                                  → stays funding_pending
   *   reverted                                  → draft
   *   success, no Transfer(wallet → platform) of the pulled token in its logs
   *                                             → funding_pending, a person
   *   success, the Transfer is SHORT of the budget (a fee-on-transfer token:
   *     B4)                                     → funding_pending, a person,
   *                                               the shortfall on record
   *   success, the Transfer is the budget       → funded (credited exactly
   *     what moved); unless the campaign's terms no longer match what was
   *     pulled, in which case it does NOT open for business: it closes and the
   *     refund returns exactly what was pulled, in the token that was pulled.
   */
  function settleFunding(id, ref, rcpt, askedHash = null) {
    const cur = store.getCampaign(id);
    if (!cur?.funding || cur.funding.ref !== ref || cur.status !== 'funding_pending') return { campaign: cur, outcome: 'stale' };
    const hash = askedHash || cur.funding.txHash;
    if (rcpt && !sameHash(rcpt.transactionHash, hash)) {
      // Not this transaction's receipt (viem's replacement answer, or an RPC
      // answering for another hash). It proves nothing about this pull.
      store.appendLedger({ kind: 'funding-receipt-foreign', campaignId: id, ref, txHash: hash, receiptHash: rcpt.transactionHash || null });
      log.error?.(`[campaigns] ${cur.slug}: funding ${ref} — the receipt answered for ${rcpt.transactionHash || 'no hash'}, not ${hash}: ignored`);
      rcpt = null;
    }
    if (!rcpt) {
      store.appendLedger({ kind: 'funding-unconfirmed', campaignId: id, ref, txHash: hash });
      return { campaign: cur, outcome: 'pending' };
    }
    if (rcpt.status !== 'success') return { campaign: backToDraft(id, ref, `the funding transfer reverted on chain (${hash})`), outcome: 'reverted' };
    // What the pull actually moved, from the receipt's own Transfer logs.
    const moved = transferredInReceipt(rcpt, { token: cur.funding.token?.address, from: cur.funding.wallet, to: platformAddress });
    const want = big(cur.funding.atomic);
    if (moved == null || moved < want) {
      const sym = cur.funding.token?.symbol || '';
      const dec = cur.funding.token?.decimals ?? 6;
      const why = moved == null
        ? `the funding transaction ${hash} succeeded but its logs show no ${sym} Transfer from the funding wallet to the platform wallet`
        : `the funding transfer ${hash} delivered ${fromAtomic(moved, dec)} ${sym} of the ${fromAtomic(want, dec)} budget (short by ${fromAtomic(want - moved, dec)})`;
      const outcome = moved == null ? 'unproven' : 'short';
      if (cur.funding.needsPerson !== why) {
        store.appendLedger({ kind: `funding-${outcome}`, campaignId: id, ref, txHash: hash, receivedAtomic: moved == null ? '0' : moved.toString(), shortfallAtomic: (moved == null ? want : want - moved).toString(), why });
        log.error?.(`[campaigns] ${cur.slug}: ${why} — not funded; needs a person`);
      }
      const c2 = patchFunding(id, ref, { state: outcome, receivedAtomic: moved == null ? '0' : moved.toString(), shortfallAtomic: (moved == null ? want : want - moved).toString(), needsPerson: why });
      return { campaign: c2, outcome, why };
    }
    const at = new Date(now()).toISOString();
    // Credited exactly what moved: more than the budget falls to the mismatch
    // path below (closed, and exactly what moved is refunded).
    const f = { ...cur.funding, atomic: moved.toString(), receivedAtomic: moved.toString(), state: 'confirmed', receipt: 'success', confirmedAt: at, needsPerson: null };
    if (!sameTerms(cur, { token: f.token, atomic: f.atomic })) {
      store.appendLedger({ kind: 'funding-mismatch', campaignId: id, ref, pulled: { token: f.token.address, atomic: f.atomic }, campaign: { token: cur.token?.address, atomic: cur.budget?.atomic } });
      log.error?.(`[campaigns] ${cur.slug}: the pull (${f.atomic} of ${f.token.symbol}) does not match the campaign's terms — closing it and refunding what was pulled`);
      store.putCampaign({ ...cur, funding: f, status: 'closed', closedAt: at, closeReason: 'funding did not match the campaign terms', updatedAt: at });
      store.appendLedger({ kind: 'closed', campaignId: id, reason: 'funding mismatch' });
      maybeRefund(id);
      return { campaign: store.getCampaign(id), outcome: 'mismatch' };
    }
    store.appendLedger({ kind: 'funded', campaignId: id, ref, atomic: f.atomic, token: f.token.address, txHash: f.txHash, from: f.wallet });
    log.log?.(`[campaigns] ${cur.slug} funded ${fromAtomic(big(f.atomic), f.token.decimals)} ${f.token.symbol} (${ref}, tx ${f.txHash})`);
    return { campaign: store.putCampaign({ ...cur, status: 'funded', funding: f, updatedAt: at }), outcome: 'funded' };
  }

  /**
   * A funding_pending campaign nobody in this process is pulling: look up the
   * door's PULL row for its ref and ask for the receipt again. A campaign
   * still 'pulling' with no PULL row means a process stopped mid-pull: whether
   * the transfer was broadcast is unknowable from here, so it stays pending
   * and is flagged for a person (never guessed either way).
   */
  async function reconcileFunding(id) {
    const c = store.getCampaign(id);
    if (!c || c.status !== 'funding_pending' || !c.funding || funding.has(id) || reconciling.has(id)) return c;
    reconciling.add(id);
    try {
      const rec = settlement.status(c.funding.ref);
      if (!rec) {
        // No PULL / PULL_SENT row and no tx hash. After STUCK_FUNDING_MS the
        // chain's Transfer logs decide (stuckFundingVerdict): no transfer of
        // the budget since the attempt → draft; anything else → a person.
        const stuck = stuckFundingVerdict(c);
        if (stuck.resolve) {
          const v = await stuck.resolve();
          if (v.toDraft) return backToDraft(id, c.funding.ref, v.why);
          if (c.funding.needsPerson !== v.why) {
            store.appendLedger({ kind: 'funding-unknown', campaignId: id, ref: c.funding.ref, why: v.why });
            patchFunding(id, c.funding.ref, { needsPerson: v.why });
          }
          return store.getCampaign(id);
        }
        if (!c.funding.needsPerson) {
          store.appendLedger({ kind: 'funding-unknown', campaignId: id, ref: c.funding.ref, why: 'no PULL row for this ref: the process stopped mid-pull' });
          log.error?.(`[campaigns] ${c.slug}: funding ${c.funding.ref} has no PULL row — needs a person (check the wallet's transfers on chain)`);
          patchFunding(id, c.funding.ref, { needsPerson: 'no PULL row: the process stopped mid-pull' });
        }
        return store.getCampaign(id);
      }
      if (rec.status === 'PULLED_DRY') return backToDraft(id, c.funding.ref, 'the pull ran dry (no pull signer)');
      const txHash = rec.txHash || c.funding.txHash;
      if (!txHash) return store.getCampaign(id);
      if (!c.funding.txHash) patchFunding(id, c.funding.ref, { state: 'pending', txHash });
      let rcpt = null;
      try { rcpt = await confirmTx(txHash); } catch { rcpt = null; }
      const out = settleFunding(id, c.funding.ref, rcpt, txHash);
      // A hash on record (PULL_SENT or PULL) and still no receipt after
      // STUCK_FUNDING_MS: it is never re-sent. Back to draft ONLY when the
      // chain proves it can no longer land (droppedPullVerdict: its nonce was
      // used by another transaction, no node knows it, and no Transfer of the
      // budget arrived); otherwise a person.
      if (out.outcome === 'pending' && now() - Date.parse(c.funding.at || 0) >= STUCK_FUNDING_MS) {
        const dropped = await droppedPullVerdict(store.getCampaign(id), rec, txHash);
        if (dropped.toDraft) return backToDraft(id, c.funding.ref, dropped.why);
        const why = `transaction ${txHash} has no receipt after ${Math.round((now() - Date.parse(c.funding.at)) / 60_000)} min${dropped.why ? ` (${dropped.why})` : ''}: check it on chain`;
        if (out.campaign?.funding?.needsPerson !== why) { store.appendLedger({ kind: 'funding-unknown', campaignId: id, ref: c.funding.ref, txHash, why }); return patchFunding(id, c.funding.ref, { needsPerson: why }); }
      }
      return out.campaign;
    } finally {
      reconciling.delete(id);
    }
  }

  /**
   * Whether a funding_pending campaign with no PULL row (and so no tx hash) is
   * old enough to resolve, and how: from CHAIN FACTS only — a Transfer of
   * exactly the budget from the funding wallet to the platform wallet since
   * the attempt (findFundingTransfer). Never from the allowance: the creator
   * sets it, and re-approving after a landed pull made a landed pull look
   * like one that never happened. Back to draft only when the search ran and
   * found no such transfer; found, unreadable or not wired → a person.
   */
  function stuckFundingVerdict(c) {
    const f = c?.funding;
    if (!f || f.txHash || now() - Date.parse(f.at || 0) < STUCK_FUNDING_MS) return { resolve: null };
    const mins = Math.round((now() - Date.parse(f.at)) / 60_000);
    return {
      resolve: async () => {
        if (typeof findFundingTransfer !== 'function') return { toDraft: false, why: 'no transaction on record, and this server cannot search the token\'s transfers: check the funding wallet\'s transfers on chain' };
        let hit;
        try { hit = await findFundingTransfer({ token: f.token.address, from: f.wallet, to: platformAddress, atomic: String(f.atomic), sinceMs: Date.parse(f.at) }); }
        catch (e) { return { toDraft: false, why: `no transaction on record, and the token's transfers could not be read (${e.shortMessage || e.message}): check the funding wallet on chain` }; }
        if (hit?.found === true) return { toDraft: false, why: `no pull on record, but a transfer of the whole budget from the funding wallet to the platform wallet is on chain${hit.txHash ? ` (${hit.txHash})` : ''}: the pull may have landed — a person matches it to this campaign` };
        if (hit?.found === false) return { toDraft: true, why: `no transaction after ${mins} min, and no transfer of the budget from the funding wallet to the platform wallet on chain since the attempt: the pull never landed` };
        return { toDraft: false, why: 'no transaction on record, and the transfer search gave no answer: check the funding wallet on chain' };
      },
    };
  }

  /**
   * A signed pull with no receipt (cold review B1b: the node refused it as a
   * same-nonce replacement, or dropped it): it can no longer land, and the
   * campaign goes back to draft, only when ALL of these are chain facts —
   *   1. the door recorded the protocol nonce it was signed with (PULL_SENT
   *      `nonce`, no Tempo nonce key), and the spender's MINED transaction
   *      count is past it: another transaction used that nonce;
   *   2. no node knows the hash (txKnown false — not pending, not mined);
   *   3. no Transfer of the budget from the funding wallet to the platform
   *      wallet since the attempt (findFundingTransfer found: false).
   * Anything unknown, unwired or unreadable → { toDraft: false } with why.
   */
  async function droppedPullVerdict(c, rec, txHash) {
    const f = c?.funding;
    if (!f) return { toDraft: false, why: null };
    const nonce = rec?.nonce;
    if (typeof nonce !== 'number' || rec?.nonceKey) return { toDraft: false, why: 'its signing nonce is not on record' };
    if (typeof readSpenderNonce !== 'function' || typeof txKnown !== 'function' || typeof findFundingTransfer !== 'function' || !spender) return { toDraft: false, why: 'this server cannot read the spender nonce, the transaction pool and the token transfers' };
    let mined, known, hit;
    try { mined = Number(await readSpenderNonce(spender)); } catch (e) { return { toDraft: false, why: `the spender nonce could not be read (${e.shortMessage || e.message})` }; }
    if (!(mined > nonce)) return { toDraft: false, why: `its nonce ${nonce} is not used yet (the spender has ${mined} mined)` };
    try { known = await txKnown(txHash); } catch (e) { return { toDraft: false, why: `the node could not say whether it knows the transaction (${e.shortMessage || e.message})` }; }
    if (known !== false) return { toDraft: false, why: 'a node still knows the transaction' };
    try { hit = await findFundingTransfer({ token: f.token.address, from: f.wallet, to: platformAddress, atomic: String(f.atomic), sinceMs: Date.parse(f.at) }); }
    catch (e) { return { toDraft: false, why: `the token's transfers could not be read (${e.shortMessage || e.message})` }; }
    if (hit?.found !== false) return { toDraft: false, why: hit?.found ? 'a transfer of the budget from the funding wallet is on chain: it may have landed' : 'the transfer search gave no answer' };
    return { toDraft: true, why: `the pull ${txHash} can no longer land: its nonce ${nonce} was used by another transaction (the spender has ${mined} mined), no node knows it, and no transfer of the budget reached the platform wallet` };
  }

  /**
   * Admin: resolve a campaign stuck in funding_pending now, by the same rule
   * the sweep uses (no PULL row, no tx hash, older than STUCK_FUNDING_MS, and
   * no Transfer of the budget on chain since the attempt → draft). With a tx
   * hash it re-asks for the receipt. It never marks anything funded on a guess.
   */
  async function resolveStuckFunding(id, { isAdmin = false } = {}) {
    if (!isAdmin) throw fail('forbidden', 'Admins only.', 403);
    const c = store.getCampaign(id);
    if (!c) throw fail('not_found', 'No such campaign.', 404);
    if (c.status !== 'funding_pending' || !c.funding) throw fail('not_stuck', `This campaign is ${c.status}, not waiting on its funding.`, 409);
    if (funding.has(id)) throw fail('funding_in_progress', 'A pull for this campaign is running in this process right now.', 409);
    if (!c.funding.txHash && !settlement.status(c.funding.ref) && now() - Date.parse(c.funding.at || 0) < STUCK_FUNDING_MS) {
      throw fail('too_soon', `Wait until ${new Date(Date.parse(c.funding.at) + STUCK_FUNDING_MS).toISOString()}: a pull this recent may still land.`, 409);
    }
    const out = await reconcileFunding(id);
    return { campaign: out, status: out?.status, needsPerson: out?.funding?.needsPerson || null };
  }

  function open(id, { accountId, isAdmin = false }) {
    const c = store.getCampaign(id);
    if (!c) throw fail('not_found', 'No such campaign.', 404);
    if (!isAdmin && c.creatorAccountId !== accountId) throw fail('forbidden', 'This is not your campaign.', 403);
    if (c.status !== 'funded' || fundedAtomic(c) <= 0n) throw fail('not_funded', c.status === 'draft' ? 'Fund the campaign before opening it.' : c.status === 'funding_pending' ? 'The funding transfer is not confirmed on chain yet.' : `A ${c.status} campaign cannot open.`, 409);
    if (c.deadline && Date.parse(c.deadline) <= now()) throw fail('past_deadline', 'The deadline has passed; move it later before opening.', 409);
    store.appendLedger({ kind: 'opened', campaignId: c.id });
    return store.putCampaign({ ...c, status: 'live', openedAt: new Date(now()).toISOString(), originalDeadline: c.originalDeadline || c.deadline, updatedAt: new Date(now()).toISOString() });
  }

  /**
   * Close: no new slots. A claim whose Holler / Call in was already SUBMITTED
   * (bound to a letter or a seat) is honoured — it still counts if it reaches
   * the required state within CLOSE_GRACE_MS of the close — and the refund
   * waits for it. A slot reserved but never bound to anything expires now.
   */
  function close(id, { accountId = null, isAdmin = false, reason = 'closed by creator', system = false } = {}) {
    const c = store.getCampaign(id);
    if (!c) throw fail('not_found', 'No such campaign.', 404);
    if (!system && !isAdmin && c.creatorAccountId !== accountId) throw fail('forbidden', 'This is not your campaign.', 403);
    if (c.status === 'closed') return c;
    // A pull in flight or awaiting its receipt decides first: closing now
    // would be overwritten by the pull's own write, or refund a budget whose
    // transfer has not been seen to land.
    if (fundingBusy(id, c)) throw fail('funding_in_progress', FUNDING_BUSY_MSG, 409);
    const closedAt = new Date(now()).toISOString();
    const until = new Date(endOf({ ...c, status: 'closed', closedAt }) + CLOSE_GRACE_MS()).toISOString();
    for (const k of store.listClaims(id)) {
      if (!IN_FLIGHT.has(k.status)) continue;
      if (submitted(k)) {
        k.honourUntil = until;
        store.putClaim(k);
        store.appendLedger({ kind: 'honoured', campaignId: id, claimId: k.id, atomic: k.reservedAtomic, until, why: 'submitted before the campaign closed' });
      } else {
        store.appendLedger({ kind: 'released', campaignId: id, claimId: k.id, atomic: k.reservedAtomic, why: 'campaign closed before anything was submitted' });
        history(k, 'expired', 'campaign closed before anything was submitted');
        k.reservedAtomic = null;
        store.putClaim(k);
      }
    }
    const next = store.putCampaign({ ...c, status: 'closed', closedAt, closeReason: reason, updatedAt: closedAt });
    store.appendLedger({ kind: 'closed', campaignId: id, reason });
    sync();
    return store.getCampaign(id) || next;
  }

  function setHidden(id, hidden) {
    const c = store.getCampaign(id);
    if (!c) throw fail('not_found', 'No such campaign.', 404);
    store.appendLedger({ kind: hidden ? 'hidden' : 'unhidden', campaignId: id });
    return store.putCampaign({ ...c, hidden: !!hidden, updatedAt: new Date(now()).toISOString() });
  }

  const isOpen = (c) => c && c.status === 'live' && !c.hidden && !(c.deadline && Date.parse(c.deadline) <= now());

  // ── x costs: held before the first call, retained at the door after ──────
  //
  // Every X spend charged to a campaign is HELD first, synchronously, against
  // funded − (reserved + x-cost + held): a hold that does not fit is refused
  // before anything is called, so concurrent spends cannot each see the same
  // `remaining`. After the calls the hold is settled — the actual cost, never
  // more than the hold, becomes an x-cost (RETAINED at the door), and the hold
  // goes. A failure releases it. Holds are on the campaign record, so the
  // refund waits for them; a hold from an earlier process can never settle
  // and sync drops it (the platform absorbs whatever it may have spent).
  const xSpendable = (c) => !!c && (c.status === 'funded' || c.status === 'live') && !c.refund && fundedAtomic(c) > 0n;

  function holdX(campaignId, usd, why, { alsoNeed = 0n } = {}) {
    const c = store.getCampaign(campaignId);
    if (!xSpendable(c)) throw fail('closed', 'This campaign is closed or not funded; it cannot pay for X lookups.', 409);
    if (!isUsdc(c)) throw fail('needs_usdc', 'X lookups are billed in dollars, so only a USDC campaign can pay for them.', 409);
    const atomic = usd2usdc(usd);
    if (atomic <= 0n) throw fail('invalid', 'An X spend needs a cost above zero.');
    if (totals(campaignId).remaining < atomic + alsoNeed) throw fail('budget_spent', 'The campaign budget cannot cover this X lookup.', 409);
    const holdId = `xh_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const at = new Date(now()).toISOString();
    store.putCampaign({ ...c, xHolds: { ...(c.xHolds || {}), [holdId]: { atomic: atomic.toString(), usd, why, at, boot: BOOT_ID } } });
    store.appendLedger({ kind: 'x-hold', campaignId, holdId, atomic: atomic.toString(), usd, why });
    return holdId;
  }

  /** Settle a hold with what X actually billed (0 = release). Synchronous. */
  function settleX(campaignId, holdId, actualUsd, tag) {
    const c = store.getCampaign(campaignId);
    if (!c) return null;
    const h = c.xHolds?.[holdId] || null;
    const holds = { ...(c.xHolds || {}) }; delete holds[holdId];
    let atomic = usd2usdc(Math.max(0, Number(actualUsd) || 0));
    const cap = h ? big(h.atomic) : 0n;
    if (atomic > cap) {
      store.appendLedger({ kind: 'x-cost-absorbed', campaignId, holdId, atomic: (atomic - cap).toString(), why: h ? 'X billed past the hold' : 'no hold on record' });
      atomic = cap;
    }
    let ref = null;
    if (atomic > 0n && c.refund) {
      // The refund already went out: the budget cannot pay for this any more.
      store.appendLedger({ kind: 'x-cost-absorbed', campaignId, holdId, atomic: atomic.toString(), why: 'campaign already refunded' });
      atomic = 0n;
    }
    if (atomic > 0n) {
      ref = `campaign:xcost:${tag}:${campaignId}:${randomUUID()}`;
      const r = settlement.release({ signer: 'platform', to: platformAddress, token: moneyToken(c), amountAtomic: atomic.toString(), bucket: 'campaign-x-cost', ref, meta: { campaignId, usd: actualUsd } });
      if (r.deduped) atomic = 0n;
    }
    const xCheck = String(tag).startsWith('check:') ? { xCheckAtomic: (big(c.xCheckAtomic) + atomic).toString() } : {};
    store.putCampaign({ ...c, xHolds: holds, xCostAtomic: (big(c.xCostAtomic) + atomic).toString(), ...xCheck });
    store.appendLedger({ kind: atomic > 0n ? 'x-cost' : 'x-hold-released', campaignId, holdId, ref, atomic: atomic.toString(), usd: actualUsd });
    // A close that waited for this hold can refund now.
    const after = store.getCampaign(campaignId);
    if (after.status === 'closed' && !after.refund) maybeRefund(campaignId);
    return ref;
  }

  /**
   * followedByFromSet checks run for every applicant, qualifying or not, and
   * each costs up to perClaimCostCapUsd. Their total is capped per campaign:
   * rules.followedByFromSet.maxTotalUsd, or DEFAULT_X_CHECK_SHARE of the
   * budget. Past it, checks stop (fail closed, with a plain reason).
   */
  function xCheckCeilingAtomic(c) {
    const set = Number(c.rules?.followedByFromSet?.maxTotalUsd);
    if (set > 0) return usd2usdc(set);
    return big(c.budget?.atomic) * BigInt(Math.round(DEFAULT_X_CHECK_SHARE * 100)) / 100n;
  }
  const xCheckCommittedAtomic = (c) => big(c?.xCheckAtomic) + Object.values(c?.xHolds || {}).filter((h) => String(h.why || '').startsWith('followedBy check')).reduce((s, h) => s + big(h.atomic), 0n);

  /** One X spend at a time per campaign: callers queue (no refusal), in order. */
  async function withXLock(campaignId, fn) {
    const prev = xLocks.get(campaignId) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const tail = prev.then(() => mine);
    xLocks.set(campaignId, tail);
    try { await prev; return await fn(); }
    finally { release(); if (xLocks.get(campaignId) === tail) xLocks.delete(campaignId); }
  }

  // ── followedByFromSet ─────────────────────────────────────────────────────
  async function countFollowedBy({ campaign, applicantXId, set }) {
    const fb = campaign.rules.followedByFromSet;
    const per = xApi.X_COST_PER_USER_USD;
    const cap = fb.perClaimCostCapUsd;
    let spent = 0, count = 0, capped = false;
    const holders = xTokens.holdersByXUserId();
    const trusted = [];
    for (const id of set.ids) if (holders.has(id) && id !== applicantXId) trusted.push({ xUserId: id, accountId: holders.get(id) });
    // The creator's own token vouches only when the creator is ON the list
    // (then it is asked first). It used to be added unconditionally, which let
    // a creator count themselves toward a list they are not on.
    const creatorX = (getAccount(campaign.creatorAccountId)?.links || []).find((l) => l.provider === 'x');
    const ci = creatorX ? trusted.findIndex((t) => t.xUserId === creatorX.platformId) : -1;
    if (ci > 0) trusted.unshift(...trusted.splice(ci, 1));
    if (trusted.length) {
      let asked = 0;
      for (const t of trusted) {
        if (count >= fb.min) break;
        if (spent + per > cap + 1e-9) { capped = true; break; }
        const token = await xTokens.getXAccessToken(t.accountId, { log });
        if (!token) continue;
        const r = await xApi.lookupConnection({ accessToken: token, ids: [applicantXId], log });
        spent += r.costUsd || 0;
        asked += 1;
        if (r.ok && r.byId[applicantXId]?.following) count += 1;
      }
      if (asked > 0) return { count, method: 'connection_status', costUsd: Math.round(spent * 100) / 100, capped, asked };
    }
    // Fallback: no token holder could answer. Read the applicant's own
    // followers (app token), capped, and count the ones on the list.
    if (!xApi.appBearerConfigured()) return { error: 'not available: no list member has signed in with X, and X_BEARER_TOKEN is not set', count: 0, costUsd: spent };
    const onList = new Set(set.ids);
    let next = null;
    do {
      const budgetUsers = Math.floor((cap - spent) / per + 1e-9);
      if (budgetUsers < 1) { capped = true; break; }
      const page = await xApi.pageUsers({ kind: 'followers', id: applicantXId, maxResults: Math.min(1000, budgetUsers), paginationToken: next, log });
      if (!page.ok) return { error: page.error === 'rate_limited' ? 'X rate limit; try again in a few minutes' : page.error, count, costUsd: Math.round((spent + (page.costUsd || 0)) * 100) / 100 };
      spent += page.costUsd;
      for (const u of page.users) if (onList.has(u.id)) count += 1;
      next = page.nextToken;
    } while (next && count < fb.min);
    if (next && count < fb.min) capped = true;
    return { count, method: 'followers', costUsd: Math.round(spent * 100) / 100, capped };
  }

  // ── the check ─────────────────────────────────────────────────────────────
  async function check(slug, { accountId }) {
    if (!accountId) throw fail('auth_required', 'Sign in to check.', 401);
    const c = store.campaignBySlug(slug);
    if (!c || c.hidden || ['draft', 'funding_pending', 'funded'].includes(c.status)) throw fail('not_found', 'No such campaign.', 404);
    if (!isOpen(c)) throw fail('closed', 'This campaign is closed.', 409);
    let account = getAccount(accountId);
    if (!account) throw fail('auth_required', 'Sign in to check.', 401);
    const link = account.links.find((l) => l.provider === 'x');
    if (!link) return { claim: null, result: evaluate(c, account, null, { now: now() }) };
    const { byAccount, byX } = store.claimFor({ campaignId: c.id, accountId, xUserId: link.platformId });
    if (byX && byX.accountId !== accountId) throw fail('x_already_claimed', 'This X account already has a claim on this campaign, from another Holler account.', 409);
    if (byAccount && byAccount.xUserId !== link.platformId) throw fail('x_changed', `Your claim on this campaign belongs to the X account @${byAccount.xUsername || byAccount.xUserId}.`, 409);
    if (byAccount && !['ineligible', 'eligible'].includes(byAccount.status)) return { claim: byAccount, result: { eligible: byAccount.status !== 'rejected', checks: byAccount.checks } };
    if (checking.has(accountId)) throw fail('busy', 'A check is already running for you.', 409);
    checking.add(accountId);
    try {
      // Refresh the X profile (a platform-paid $0.01 read, app token) only
      // when the last read is older than a day, or the link has never had a
      // profile read at all. A field X left OUT of a read is stored as null —
      // known missing, failing closed in evaluate — and is NOT a reason to
      // read again: before this, one field X never sends made every check by
      // that account a paid refresh. The route also rate-limits /check per
      // account (campaign-routes.js CHECK_PER_MIN). A failed fetch fails CLOSED.
      let stale = null;
      const old = !link.attributesFetchedAt || now() - Date.parse(link.attributesFetchedAt) > ATTR_MAX_AGE_MS;
      const neverRead = !(link.attributes || []).some((r) => r?.source === 'x-api');
      if (old || neverRead) {
        const r = xApi.appBearerConfigured() ? await xApi.fetchUserById({ userId: link.platformId, log }) : { ok: false, error: 'not-configured' };
        if (r.ok) { setLinkAttributes(accountId, 'x', withKnownMissing(r.records || [])); account = getAccount(accountId); }
        else stale = 'Your X details need refreshing and we could not do it from here. Reconnect X (one click) to refresh them.';
      }
      const set = c.rules.referenceSetId ? store.getSet(c.rules.referenceSetId) : null;
      const extra = { now: now(), stale };
      const fb = c.rules.followedByFromSet;
      let followedBy = byAccount?.followedBy && now() - Date.parse(byAccount.followedBy.at) < CHECK_VALID_MS ? byAccount.followedBy : null;
      const claimId = byAccount?.id || `clm_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      if (fb?.enabled) {
        const fset = store.getSet(fb.referenceSetId);
        extra.followedBySet = fset;
        if (!followedBy) {
          let holdId = null;
          const ceiling = xCheckCeilingAtomic(c);
          if (!isUsdc(c)) followedBy = { error: 'only available on USDC campaigns', count: 0, costUsd: 0 };
          else if (!fset) followedBy = { error: 'the list is unavailable', count: 0, costUsd: 0 };
          else if (xCheckCommittedAtomic(store.getCampaign(c.id)) + usd2usdc(fb.perClaimCostCapUsd) > ceiling) {
            followedBy = { error: `this campaign has used its X checking allowance ($${fromAtomic(ceiling, usdc.decimals)}); the creator can raise it`, count: 0, costUsd: 0, ceiling: true };
          } else {
            // Hold the cost cap (and room for the reward) BEFORE any X call.
            try { holdId = holdX(c.id, fb.perClaimCostCapUsd, `followedBy check ${claimId}`, { alsoNeed: big(c.reward.atomic) }); }
            catch (e) { followedBy = { error: e.code === 'budget_spent' ? 'the campaign budget cannot cover this check' : 'the campaign cannot pay for this check now', count: 0, costUsd: 0 }; }
          }
          if (holdId) {
            let spent = 0;
            try {
              followedBy = await withXLock(c.id, async () => {
                if (!isOpen(store.getCampaign(c.id))) return { error: 'the campaign closed before the check ran', count: 0, costUsd: 0 };
                return countFollowedBy({ campaign: c, applicantXId: link.platformId, set: fset });
              });
              spent = followedBy.costUsd || 0;
              followedBy.at = new Date(now()).toISOString();
            } finally {
              settleX(c.id, holdId, spent, `check:${claimId}`);
            }
          }
        }
        extra.followedBy = followedBy;
      }
      const result = evaluate(c, account, set ? { ...set, _idSet: new Set(set.ids) } : null, extra);
      const at = new Date(now()).toISOString();
      // Re-read after the awaits: the claim may have been reserved (and even
      // reached owed) while X answered. A check only ever writes over a claim
      // that is still eligible or ineligible; anything else is returned as is.
      const current = store.getClaim(claimId);
      if (current && !['ineligible', 'eligible'].includes(current.status)) {
        return { claim: current, result: { eligible: current.status !== 'rejected', checks: current.checks || result.checks } };
      }
      const claim = current || { id: claimId, campaignId: c.id, accountId, xUserId: link.platformId, createdAt: at, history: [] };
      claim.xUsername = link.username || null;
      claim.checks = result.checks;
      claim.checkedAt = at;
      if (followedBy && !followedBy.error) claim.followedBy = followedBy;
      const to = result.eligible ? 'eligible' : 'ineligible';
      if (claim.status !== to) history(claim, to, 'check');
      else claim.updatedAt = at;
      store.putClaim(claim);
      return { claim: store.getClaim(claim.id), result };
    } finally {
      checking.delete(accountId);
    }
  }

  // ── reserving a slot when the Holler / seat is created ────────────────────
  function reserve({ slug, accountId, kind, roomId }) {
    if (!accountId) throw fail('auth_required', 'Sign in with the account that qualified, then send.', 401);
    const c = store.campaignBySlug(slug);
    if (!c || c.hidden) throw fail('not_found', 'No such campaign.', 404);
    if (!isOpen(c)) throw fail('closed', 'This campaign is closed.', 409);
    if (c.action.kind !== kind) throw fail('wrong_action', kind === 'holler' ? 'This campaign pays for a Call in, not a Holler.' : 'This campaign pays for a Holler, not a Call in.', 409);
    const room = resolveRoom(c.action.roomHandle);
    if (!room || room.id !== roomId) throw fail('wrong_room', `This campaign pays for a ${kind === 'holler' ? 'Holler' : 'Call in'} in @${c.action.roomHandle}'s room only.`, 409);
    if (kind === 'callin') {
      // A Call in counts only from a camera track the SERVER saw published
      // (a signed LiveKit webhook). Without that signal nothing could count,
      // so the slot is never taken.
      if (room.transport && room.transport !== 'livekit') throw fail('needs_livekit', 'This room is not on the LiveKit camera transport, so a Call in cannot be counted toward this campaign right now.', 409);
      if (!seatSignalAvailable()) throw fail('callin_unverifiable', 'This server cannot see cameras go live right now (no LiveKit webhooks), so a Call in cannot be counted toward this campaign.', 503);
    }
    const { byAccount: claim } = store.claimFor({ campaignId: c.id, accountId });
    if (!claim) throw fail('not_checked', 'Check that you qualify first.', 403);
    const staleReservation = claim.status === 'recorded' && !claim.letterId && !claim.seatId && now() - Date.parse(claim.reservedAt || 0) > RESERVATION_STALE_MS;
    if (claim.status !== 'eligible' && !staleReservation) {
      throw fail(claim.status === 'ineligible' ? 'ineligible' : 'already_claimed',
        claim.status === 'ineligible' ? 'You do not qualify for this campaign, so this cannot count toward it.' : 'You have already used your place in this campaign.', 403);
    }
    if (now() - Date.parse(claim.checkedAt || 0) > CHECK_VALID_MS) throw fail('check_expired', 'Your check is more than a day old. Check again first.', 403);
    const t = totals(c.id);
    const held = staleReservation ? big(claim.reservedAtomic) : 0n;
    const countNow = t.activeCount - (staleReservation ? 1 : 0);
    if (countNow + 1 > c.maxClaims) throw fail('full', 'Every place in this campaign is taken.', 409);
    if (t.remaining + held < big(c.reward.atomic)) throw fail('budget_spent', 'This campaign\'s budget is spent.', 409);
    claim.reservedAtomic = c.reward.atomic;
    claim.reservedAt = new Date(now()).toISOString();
    if (claim.status !== 'recorded') history(claim, 'recorded', `${kind} started`);
    store.putClaim(claim);
    store.appendLedger({ kind: 'reserved', campaignId: c.id, claimId: claim.id, atomic: c.reward.atomic });
    return { claimId: claim.id, campaignId: c.id };
  }

  /** Give a reservation back (the payment step refused, the upload never came, the seat left early). */
  function releaseSlot(claimId, why) {
    const k = store.getClaim(claimId);
    if (!k || !IN_FLIGHT.has(k.status)) return null;
    store.appendLedger({ kind: 'released', campaignId: k.campaignId, claimId, atomic: k.reservedAtomic, why });
    history(k, 'eligible', why);
    k.reservedAtomic = null; k.letterId = null; k.seatId = null; k.cameraOnAt = null; k.cameraLive = false;
    return store.putClaim(k);
  }

  function bind(claimId, { letterId = null, seatId = null }) {
    const k = store.getClaim(claimId);
    if (!k || k.status !== 'recorded') return null;
    // Past the deadline (or closed), nothing new is SUBMITTED: a slot reserved
    // a moment before the deadline but bound after it, inside the sweep's
    // 15 s, would otherwise be honoured for the 48 h grace.
    const c = store.getCampaign(k.campaignId);
    if (!c || endOf(c) != null || !isOpen(c)) return null;
    if (letterId) k.letterId = letterId;
    if (seatId) k.seatId = seatId;
    return store.putClaim(k);
  }

  // ── progress → owed → the payout intent ───────────────────────────────────
  /** A claim whose action was submitted: a Holler bound to its letter, a Call in to its seat. */
  const submitted = (k) => IN_FLIGHT.has(k.status) && !!(k.letterId || k.seatId);
  /** When the campaign stopped taking actions: its close, or its deadline if that came first. null while open. */
  function endOf(c) {
    const dl = c.deadline ? Date.parse(c.deadline) : null;
    const closed = c.status === 'closed' && c.closedAt ? Date.parse(c.closedAt) : null;
    const pastDl = dl != null && dl <= now() ? dl : null;
    if (closed != null) return pastDl != null ? Math.min(closed, pastDl) : closed;
    return pastDl;
  }

  function advance(k, reached, why) {
    const c = store.getCampaign(k.campaignId);
    // Hidden by an admin: nothing counts while it is hidden. Not live and not
    // closed (draft, funding): nothing can be in flight.
    if (!c || c.hidden || (c.status !== 'live' && c.status !== 'closed')) return k;
    // Closed, or past the deadline: only an action SUBMITTED before the end
    // counts, and only within the grace window after it.
    const end = endOf(c);
    if (end != null) {
      if (!submitted(k)) return k;
      if (Date.parse(k.reservedAt || 0) > end) return k;
      if (now() > end + CLOSE_GRACE_MS()) return k;
    }
    if (!IN_FLIGHT.has(k.status)) return k;                 // ineligible, owed, paid… : nothing to do
    const rank = RANK[c.action.kind];
    if (rank[reached] == null) return k;
    if (rank[reached] > rank[k.status]) history(k, reached, why);
    if (rank[k.status] >= rank[c.action.require]) {
      history(k, 'owed', `${c.action.require} reached`);
      k.owedAtomic = k.reservedAtomic;
      store.appendLedger({ kind: 'owed', campaignId: c.id, claimId: k.id, atomic: k.owedAtomic });
    }
    store.putClaim(k);
    if (k.status === 'owed') tryPay(k.id);
    return store.getClaim(k.id);
  }

  function tryPay(claimId) {
    const k = store.getClaim(claimId);
    if (!k || k.status !== 'owed') return k;
    const c = store.getCampaign(k.campaignId);
    // Hidden by an admin: nothing is paid while it is hidden (the claim stays
    // owed; unhiding lets the sweep pay it).
    if (!c || c.hidden) return k;
    if (fundedAtomic(c) <= 0n) return k;
    const wallet = getAccount(k.accountId)?.payoutWallet || null;
    if (!wallet) return k;                                  // the page asks them to connect one
    // Belt and braces: the door dedupes on ref, and this refuses to go past
    // what was funded even if the claim table were somehow wrong. Read from
    // the DOOR, not the campaign record (cold review B3): every release the
    // door holds for this campaign — payouts AND x-costs — so a stop between
    // settleX's door write and its campaign write cannot open a gap. The
    // record's x-cost counts too if it is ever the larger (it never should be).
    const paidSoFar = doorSum(c.id, 'campaign:pay:', 'release');
    const xcDoor = doorSum(c.id, 'campaign:xcost:', 'release');
    const xc = xcDoor > big(c.xCostAtomic) ? xcDoor : big(c.xCostAtomic);
    if (paidSoFar + xc + big(k.owedAtomic) > fundedAtomic(c) && !settlement.status(`campaign:pay:${k.id}`)) {
      log.warn?.(`[campaigns] ${c.slug}: refusing payout for ${k.id} — it would exceed the funded budget`);
      return k;
    }
    const ref = `campaign:pay:${k.id}`;
    // The token that was PULLED — never the draft's editable token field.
    const r = settlement.release({ signer: 'platform', to: wallet, token: moneyToken(c), amountAtomic: k.owedAtomic, bucket: 'campaign', ref, meta: { campaignId: c.id, claimId: k.id } });
    k.payout = { ref, to: wallet, at: new Date(now()).toISOString() };
    history(k, r.retained ? 'paid' : 'releasing', 'payout intent recorded');
    store.appendLedger({ kind: 'intent', campaignId: c.id, claimId: k.id, ref, atomic: k.owedAtomic, to: wallet, deduped: !!r.deduped });
    return store.putClaim(k);
  }

  function onLetterEvent(letterId, event, why = null) {
    const k = store.claimByLetter(letterId);
    if (!k || k.letterId !== letterId) return null;
    if (event === 'approved' || event === 'aired') return advance(k, event, why || `Holler ${event}`);
    if (event === 'rejected') {
      if (!IN_FLIGHT.has(k.status)) return k;
      store.appendLedger({ kind: 'released', campaignId: k.campaignId, claimId: k.id, atomic: k.reservedAtomic, why: 'Holler rejected by the room' });
      history(k, 'rejected', 'Holler rejected by the room'); k.reservedAtomic = null;
      return store.putClaim(k);
    }
    if (event === 'dropped') return releaseSlot(k.id, why || 'Holler did not reach the stream');
    if (event === 'played_unauthed') {
      // N14: it played to the end on air, but no KEYED overlay was connected,
      // so nothing proves it rendered on stream. The claim does not move;
      // this is recorded so the page can say why rather than "counts once it
      // airs" after it already played.
      if (!IN_FLIGHT.has(k.status)) return k;
      k.playedUnauthed = true;
      k.playedUnauthedAt = new Date(now()).toISOString();
      k.history = [...(k.history || []), { at: k.playedUnauthedAt, from: k.status, to: k.status, why: why || 'played through an unkeyed overlay link' }].slice(-40);
      k.updatedAt = k.playedUnauthedAt;
      return store.putClaim(k);
    }
    return k;
  }

  /**
   * Call in progress, from SERVER-SIDE signals only:
   *   camera_on   a signed LiveKit webhook says the seat's identity published
   *               a camera (video) track — `joined`; the on-camera clock starts
   *   camera_off  that track was unpublished, or the participant left LiveKit
   *   ended       the seat was removed (server.js removeParticipant)
   * `aired` = the camera stayed published for minSeconds, timed from the
   * webhook, never from the client. The client's `camera_ready` message does
   * not reach this function at all (it is not a signal anyone can trust:
   * whoever holds the seat id can send it).
   *
   * ON AIR ONLY (cold review B2): `joined` and `aired` count only while the
   * room is on air — `roomOnAir`, the same open-airing record the Holler
   * `aired` hook reads (letters.js). The on-camera clock runs only on air: a
   * camera published off air starts nothing (`cameraLive` is remembered, and
   * the sweep starts the clock if the room goes on air with the camera still
   * up); the room going off air stops the clock, and a later minute starts
   * from zero.
   */
  const callinOnAir = (c) => {
    const room = c?.action?.roomHandle ? resolveRoom(c.action.roomHandle) : null;
    if (!room?.id) return false;
    try { return roomOnAir(room.id) === true; } catch { return false; }
  };
  const clearSeatTimer = (seatId) => { clearTimeout(seatTimers.get(seatId)); seatTimers.delete(seatId); };
  /** Start the on-camera clock (on air, camera published): `joined` now, `aired` at minSeconds. */
  function startSeatClock(k, c) {
    const seatId = k.seatId;
    const minMs = (c?.action?.minSeconds || 60) * 1000;
    if (!k.cameraOnAt) { k.cameraOnAt = new Date(now()).toISOString(); k.offAirAt = null; store.putClaim(k); }
    const out = advance(store.getClaim(k.id), 'joined', 'camera track published on air (LiveKit webhook)');
    clearSeatTimer(seatId);
    const t = setTimeout(() => {
      seatTimers.delete(seatId);
      const cur = store.claimBySeat(seatId);
      if (!cur?.cameraOnAt) return;
      if (!callinOnAir(store.getCampaign(cur.campaignId))) { stopSeatClock(cur, 'the room went off air'); return; }
      if (now() - Date.parse(cur.cameraOnAt) >= minMs) advance(cur, 'aired', `on camera ${Math.round(minMs / 1000)}s on air (LiveKit)`);
    }, minMs + 250);
    t.unref?.();
    seatTimers.set(seatId, t);
    return out;
  }
  /** Stop the clock without counting (off air, or the track went away early). */
  function stopSeatClock(k, why) {
    clearSeatTimer(k.seatId);
    if (!k.cameraOnAt || !IN_FLIGHT.has(k.status)) return k;
    k.cameraOnAt = null;
    if (why) { k.offAirAt = new Date(now()).toISOString(); k.history = [...(k.history || []), { at: k.offAirAt, from: k.status, to: k.status, why }].slice(-40); }
    return store.putClaim(k);
  }

  function onSeatEvent(seatId, event) {
    const k = store.claimBySeat(seatId);
    if (!k || k.seatId !== seatId) return null;
    const c = store.getCampaign(k.campaignId);
    const minMs = (c?.action?.minSeconds || 60) * 1000;
    if (event === 'camera_on') {
      if (!IN_FLIGHT.has(k.status)) return k;
      k.cameraLive = true;
      if (!callinOnAir(c)) {
        // Off air: nothing counts and no clock runs. Recorded so the page can
        // say why rather than "counts once you are on camera".
        k.cameraOnAt = null;
        k.offAirAt = new Date(now()).toISOString();
        k.history = [...(k.history || []), { at: k.offAirAt, from: k.status, to: k.status, why: 'camera published while the room was off air: does not count' }].slice(-40);
        clearSeatTimer(seatId);
        return store.putClaim(k);
      }
      store.putClaim(k);
      return startSeatClock(store.getClaim(k.id), c);
    }
    if (event === 'camera_off' || event === 'ended') {
      clearSeatTimer(seatId);
      let cur = store.getClaim(k.id);
      if (cur.cameraLive) { cur.cameraLive = false; cur = store.putClaim(cur); }
      const onMs = cur.cameraOnAt ? Math.max(0, now() - Date.parse(cur.cameraOnAt)) : 0;
      if (cur.cameraOnAt && onMs >= minMs && callinOnAir(c)) cur = advance(cur, 'aired', `on camera ${Math.round(onMs / 1000)}s on air (LiveKit)`);
      else if (cur.cameraOnAt && IN_FLIGHT.has(cur.status)) cur = stopSeatClock(cur, callinOnAir(c) ? null : 'the room went off air'); // the clock restarts on the next publish
      if (event === 'ended' && IN_FLIGHT.has(cur.status)) {
        return releaseSlot(cur.id, onMs > 0 ? `left after ${Math.round(onMs / 1000)}s on camera` : 'no camera track was counted on air');
      }
      return cur;
    }
    return k;
  }

  /** The sweep's half of the on-air rule: start or stop a seat's clock when the room's on-air state changed under it. */
  function syncSeatClock(k, c) {
    if (c?.action?.kind !== 'callin' || !k.seatId || !IN_FLIGHT.has(k.status)) return;
    const onAir = callinOnAir(c);
    if (k.cameraOnAt && !onAir) stopSeatClock(k, 'the room went off air');
    else if (!k.cameraOnAt && k.cameraLive && onAir) startSeatClock(k, c);
  }

  // ── the sweep: deadlines, wallets that arrived, door outcomes, refunds ────
  function sync() {
    for (const c0 of store.listCampaigns()) {
      let c = c0;
      if (c.status === 'funding_pending') { if (!funding.has(c.id)) reconcileFunding(c.id).catch((e) => log.warn?.(`[campaigns] funding reconcile failed for ${c.id}: ${e.message}`)); continue; }
      // Holds written by an earlier process can never settle: drop them.
      const orphans = Object.entries(c.xHolds || {}).filter(([, h]) => h.boot !== BOOT_ID);
      if (orphans.length) {
        const holds = { ...c.xHolds };
        for (const [hid, h] of orphans) { delete holds[hid]; store.appendLedger({ kind: 'x-hold-orphaned', campaignId: c.id, holdId: hid, atomic: h.atomic, why: 'held by an earlier process; whatever it spent is absorbed by the platform' }); }
        c = store.putCampaign({ ...c, xHolds: holds });
      }
      if (c.status === 'live' && c.deadline && Date.parse(c.deadline) <= now()) { close(c.id, { system: true, reason: 'deadline passed' }); continue; }
      const claims = store.listClaims(c.id);
      const end = c.status === 'closed' ? endOf(c) : null;
      for (const k of claims) {
        if (end != null && IN_FLIGHT.has(k.status) && (!submitted(k) || now() > end + CLOSE_GRACE_MS())) {
          // Honoured after the close, but it did not count within the window.
          clearTimeout(seatTimers.get(k.seatId)); seatTimers.delete(k.seatId);
          store.appendLedger({ kind: 'released', campaignId: c.id, claimId: k.id, atomic: k.reservedAtomic, why: 'did not count within the grace window after the campaign closed' });
          history(k, 'expired', 'did not count within the grace window after the campaign closed');
          k.reservedAtomic = null;
          store.putClaim(k);
          continue;
        }
        if (IN_FLIGHT.has(k.status) && k.seatId && !c.hidden && (c.status === 'live' || c.status === 'closed')) { syncSeatClock(k, c); continue; }
        if (k.status === 'owed') {
          if (c.status === 'closed' && now() - Date.parse(c.closedAt) > WALLET_GRACE_MS() && !getAccount(k.accountId)?.payoutWallet) {
            store.appendLedger({ kind: 'forfeited', campaignId: c.id, claimId: k.id, atomic: k.owedAtomic, why: 'no payout wallet within the grace period' });
            history(k, 'expired', 'no payout wallet within the grace period'); k.reservedAtomic = null;
            store.putClaim(k);
          } else tryPay(k.id);
        } else if (k.status === 'releasing' && k.payout?.ref) {
          const st = settlement.status(k.payout.ref)?.status;
          if (st === 'DONE' || st === 'RETAINED') { history(k, 'paid', `door ${st}`); store.putClaim(k); }
          else if (st === 'FAILED') { history(k, 'failed', 'door FAILED — needs a person'); store.putClaim(k); }
        }
      }
      if (c.status === 'closed' && c.funding && !c.refund) maybeRefund(c.id);
    }
  }

  function maybeRefund(id) {
    const c = store.getCampaign(id);
    if (!c || c.status !== 'closed' || !c.funding || c.refund) return null;
    if (fundedAtomic(c) <= 0n) return null;                 // nothing confirmed as pulled: nothing to return
    if (Object.keys(c.xHolds || {}).length) return null;    // an X spend in flight settles first
    const claims = store.listClaims(id);
    if (claims.some((k) => k.status === 'owed' || IN_FLIGHT.has(k.status))) return null; // every owed claim intended first
    const spent = doorSum(id, 'campaign:', 'release');
    const unspent = fundedAtomic(c) - spent;
    if (unspent < 0n) { log.error?.(`[campaigns] ${c.slug}: releases exceed funding — refund withheld`); return null; }
    const ref = `campaign:refund:${id}`;
    // Exactly what was pulled, in the token that was pulled, to the wallet it came from.
    const r = settlement.refund({ signer: 'platform', to: c.funding.wallet, token: moneyToken(c), amountAtomic: unspent.toString(), ref, meta: { campaignId: id } });
    store.appendLedger({ kind: 'refund', campaignId: id, ref, atomic: unspent.toString(), to: c.funding.wallet, deduped: !!r.deduped });
    return store.putCampaign({ ...c, refund: { ref, atomic: unspent.toString(), at: new Date(now()).toISOString() } });
  }

  // ── reference sets ────────────────────────────────────────────────────────
  async function estimateSet({ source, sourceRef, accountId = null }) {
    if (source === 'manual') return { source, count: normaliseIds(String(sourceRef || '').split(/[\s,;]+/)).length, costUsd: 0, requests: 0, lookupCostUsd: 0 };
    if (!xApi.appBearerConfigured()) throw fail('no_bearer', 'Building from X needs X_BEARER_TOKEN on the server. Paste numeric X ids instead.', 503);
    if (source === 'x-following') {
      // No sourceRef: the caller's OWN following list, through their X link.
      let ref = String(sourceRef || '').trim().replace(/^@/, '');
      if (!ref) {
        ref = (getAccount(accountId)?.links || []).find((l) => l.provider === 'x')?.platformId || '';
        if (!ref) throw fail('needs_x', 'Connect your X account first, or name the account whose following list to freeze.', 409);
      }
      const r = /^\d{1,20}$/.test(ref) ? await xApi.fetchUserById({ userId: ref, log }) : await xApi.fetchUserByUsername({ username: ref, log });
      if (!r.ok) throw fail('x_lookup_failed', `X did not return that account (${r.error}).`, 502);
      const n = Number(r.user.followingCount) || 0;
      const requests = Math.max(1, Math.ceil(n / 1000));
      return { source, sourceRef: r.user.id, label: `Accounts @${r.user.username} follows`, count: n, requests, costUsd: Math.round(n * xApi.X_COST_PER_USER_USD * 100) / 100, lookupCostUsd: r.costUsd, minutes: requests > 300 ? Math.ceil(requests / 300) * 15 : 0 };
    }
    if (source === 'x-list') {
      const r = await xApi.fetchList({ listId: String(sourceRef || '').trim(), log });
      if (!r.ok) throw fail('x_lookup_failed', `X did not return that list (${r.error}).`, 502);
      const n = Number(r.list.memberCount) || 0;
      const requests = Math.max(1, Math.ceil(n / 100));
      return { source, sourceRef: r.list.id, label: r.list.name ? `X List "${r.list.name}"` : `X List ${r.list.id}`, count: n, requests, costUsd: Math.round(n * xApi.X_COST_PER_USER_USD * 100) / 100, lookupCostUsd: r.costUsd, minutes: requests > 300 ? Math.ceil(requests / 300) * 15 : 0 };
    }
    throw fail('invalid', 'source must be manual, x-following or x-list.');
  }

  /**
   * POST /api/reference-sets/estimate. A pasted list, or a server with no
   * X_BEARER_TOKEN, makes no X call and is free. Otherwise a creator names
   * one of their funded USDC campaigns: its first FREE_ESTIMATES estimates
   * are on the platform, and every one after that is held and charged to the
   * campaign like any other X lookup. (The route also rate-limits per account.)
   */
  async function estimateForCampaign({ source, sourceRef, campaignId = null }, { accountId, isAdmin = false }) {
    if (source === 'manual' || !xApi.appBearerConfigured()) return estimateSet({ source, sourceRef, accountId });
    if (isAdmin && !campaignId) return estimateSet({ source, sourceRef, accountId });
    const c = campaignId ? store.getCampaign(campaignId) : null;
    if (!c || (!isAdmin && c.creatorAccountId !== accountId)) throw fail('needs_campaign', 'Estimating an X list costs a lookup; name one of your funded campaigns (campaignId).', 403);
    if (c.status !== 'funded') throw fail('needs_funded', 'Fund the campaign first: X lookups are paid from its budget.', 409);
    const n = (c.xEstimates || 0) + 1;
    store.putCampaign({ ...c, xEstimates: n });
    if (n <= FREE_ESTIMATES) return { ...(await estimateSet({ source, sourceRef, accountId })), charged: false, freeLeft: FREE_ESTIMATES - n };
    const holdId = holdX(c.id, LOOKUP_HOLD_USD, `estimate ${n}`);
    let spent = 0;
    try {
      const est = await withXLock(c.id, async () => {
        if (!xSpendable(store.getCampaign(c.id))) throw fail('closed', 'The campaign closed; nothing was spent.', 409);
        return estimateSet({ source, sourceRef, accountId });
      });
      spent = est.lookupCostUsd || 0;
      return { ...est, charged: true, freeLeft: 0 };
    } finally {
      settleX(c.id, holdId, spent, 'estimate');
    }
  }

  /**
   * Snapshot a list into a NEW frozen set. X sources require `confirm: true`
   * and `confirmCostUsd` at or above the estimate; a non-admin's X build is
   * charged to one of their FUNDED USDC campaigns (retained at the door).
   * Only ids and handles are kept. A partial list is never stored.
   */
  async function buildSet({ name, source, sourceRef, confirm = false, confirmCostUsd = 0, campaignId = null, supersedes = null }, { accountId, isAdmin = false }) {
    if (!accountId && !isAdmin) throw fail('auth_required', 'Sign in.', 401);
    const label = String(name || '').trim().slice(0, 80);
    let ids = [], handles = {}, costUsd = 0, est = null, resolvedRef = sourceRef;
    if (source === 'manual') {
      ids = normaliseIds(String(sourceRef || '').split(/[\s,;]+/));
      if (!ids.length) throw fail('invalid', 'Paste at least one numeric X user id.');
      if (ids.length > 50_000) throw fail('invalid', 'A pasted list holds at most 50,000 ids.');
      resolvedRef = null;
    } else {
      let chargeTo = null;
      if (!isAdmin) {
        const c = campaignId ? store.getCampaign(campaignId) : null;
        if (!c || c.creatorAccountId !== accountId) throw fail('needs_campaign', 'Building a list from X costs money; name one of your funded campaigns to charge it to.', 403);
        if (c.status !== 'funded') throw fail('needs_funded', 'Fund the campaign first (and build lists before opening it): X lookups are paid from its budget.', 409);
        if (!isUsdc(c)) throw fail('needs_usdc', 'X lookups are billed in dollars, so only a USDC campaign can pay for them. Paste ids instead.', 409);
        chargeTo = c;
      }
      // The confirmed cap (plus the source lookup) is HELD against the budget
      // before the first X call; concurrent builds that do not fit are refused
      // here, synchronously. Unconfirmed, only the lookup is held.
      const cap = confirm ? Math.max(0, Number(confirmCostUsd) || 0) : 0;
      const holdId = chargeTo ? holdX(chargeTo.id, cap + LOOKUP_HOLD_USD, `reference set from ${source}`) : null;
      try {
        await withXLock(chargeTo?.id || 'admin', async () => {
          if (chargeTo && !xSpendable(store.getCampaign(chargeTo.id))) throw fail('closed', 'The campaign closed before the snapshot ran; nothing was spent.', 409);
          est = await estimateSet({ source, sourceRef, accountId });
          costUsd += est.lookupCostUsd;
          if (!confirm || !(cap >= est.costUsd)) {
            throw fail('confirm_required', `This snapshot reads ${est.count.toLocaleString('en-US')} accounts and costs about $${est.costUsd.toFixed(2)}. Send confirm: true with confirmCostUsd to run it.`, 402, { estimate: est });
          }
          resolvedRef = est.sourceRef;
          const kind = source === 'x-list' ? 'list-members' : 'following';
          let next = null;
          do {
            const room = Math.floor((cap - (costUsd - est.lookupCostUsd)) / xApi.X_COST_PER_USER_USD + 1e-9);
            if (room < 1) throw fail('over_cost', 'The list grew past the confirmed cost; nothing was stored. Estimate again.', 409);
            let page = await xApi.pageUsers({ kind, id: est.sourceRef, maxResults: Math.min(kind === 'list-members' ? 100 : 1000, room), paginationToken: next, log });
            if (!page.ok && page.error === 'rate_limited' && page.resetAt && page.resetAt - now() <= 60_000) {
              await new Promise((r) => setTimeout(r, Math.max(0, page.resetAt - now()) + 500));
              page = await xApi.pageUsers({ kind, id: est.sourceRef, maxResults: Math.min(kind === 'list-members' ? 100 : 1000, room), paginationToken: next, log });
            }
            if (!page.ok) throw fail('x_page_failed', page.error === 'rate_limited' ? 'X rate limit reached part-way; nothing was stored. Try again in 15 minutes.' : `X refused a page (${page.error}); nothing was stored.`, 502);
            costUsd += page.costUsd;
            for (const u of page.users) { ids.push(u.id); if (u.username) handles[u.id] = u.username; }
            next = page.nextToken;
          } while (next);
        });
      } finally {
        if (holdId) settleX(chargeTo.id, holdId, Math.round(costUsd * 100) / 100, 'set');
      }
      ids = normaliseIds(ids);
      handles = Object.fromEntries(ids.filter((i) => handles[i]).map((i) => [i, handles[i]]));
    }
    const prev = supersedes ? store.getSet(supersedes) : null;
    const set = {
      id: `rs_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      name: label || est?.label || 'Pasted list',
      source, sourceRef: resolvedRef, snapshotAt: new Date(now()).toISOString(),
      ids, handles, count: ids.length, root: merkleRoot(ids),
      version: prev ? (prev.version || 1) + 1 : 1, supersedes: prev?.id || null,
      createdBy: accountId || 'admin', costUsd: Math.round(costUsd * 100) / 100,
    };
    store.insertSet(set);
    store.appendLedger({ kind: 'reference-set', setId: set.id, count: set.count, root: set.root, costUsd: set.costUsd, by: set.createdBy });
    const { ids: _i, handles: _h, ...summary } = set;
    return summary;
  }

  async function refreshSet(setId, opts, who) {
    const s = store.getSet(setId);
    if (!s) throw fail('not_found', 'No such reference set.', 404);
    if (!who.isAdmin && s.createdBy !== who.accountId) throw fail('forbidden', 'Not your reference set.', 403);
    if (s.source === 'manual') throw fail('invalid', 'A pasted list has no source to refresh from; paste a new one.');
    return buildSet({ ...opts, name: s.name, source: s.source, sourceRef: s.sourceRef, supersedes: s.id }, who);
  }

  // ── views ─────────────────────────────────────────────────────────────────
  function setFingerprint(id) {
    const s = id ? store.getSet(id) : null;
    return s ? { id: s.id, name: s.name, source: s.source, count: s.count, snapshotAt: s.snapshotAt, root: s.root, version: s.version || 1 } : null;
  }

  function publicView(slug) {
    const c = store.campaignBySlug(slug);
    if (!c || c.hidden || ['draft', 'funding_pending', 'funded'].includes(c.status)) return null;
    const t = totals(c.id);
    const sets = {};
    for (const sid of [c.rules.referenceSetId, c.rules.followedByFromSet?.referenceSetId].filter(Boolean)) { const s = store.getSet(sid); if (s) sets[sid] = s; }
    const creator = getAccount(c.creatorAccountId);
    const remaining = t.remaining > 0n ? t.remaining : 0n;
    return {
      slug: c.slug, title: c.title, blurb: c.blurb, status: isOpen(c) ? 'live' : 'closed',
      creator: creator ? { handle: creator.handle } : null,
      action: c.action,
      joinUrl: `/join?room=${encodeURIComponent(c.action.roomHandle)}&campaign=${encodeURIComponent(c.slug)}`,
      reward: { type: c.reward.type, amount: c.reward.amount, symbol: moneyToken(c).symbol, tokenAddress: moneyToken(c).address },
      budget: { amount: c.budget.amount, left: fromAtomic(remaining, moneyToken(c).decimals), symbol: moneyToken(c).symbol },
      maxClaims: c.maxClaims, spotsLeft: Math.max(0, c.maxClaims - t.activeCount),
      deadline: c.deadline,
      rules: describeRules(c.rules, { refSets: sets }),
      referenceSet: setFingerprint(c.rules.referenceSetId),
      followedBySet: c.rules.followedByFromSet?.enabled ? setFingerprint(c.rules.followedByFromSet.referenceSetId) : null,
      funded: !!c.funding,
    };
  }

  function claimView(k) {
    if (!k) return null;
    const c = store.getCampaign(k.campaignId);
    const door = k.payout?.ref ? settlement.status(k.payout.ref) : null;
    const st = door?.status || null;
    return {
      id: k.id, status: k.status, checks: k.checks || [], checkedAt: k.checkedAt || null,
      xUsername: k.xUsername || null, letterId: k.letterId || null, seatId: k.seatId || null,
      owed: k.owedAtomic ? { amount: fromAtomic(big(k.owedAtomic), moneyToken(c).decimals), symbol: moneyToken(c).symbol } : null,
      payout: k.payout ? {
        to: k.payout.to, door: st, intentRef: k.payout.ref, txHash: door?.txHash || null,
        amount: fromAtomic(big(k.owedAtomic), moneyToken(c).decimals), symbol: moneyToken(c).symbol,
      } : null,
      needsWallet: k.status === 'owed' && !getAccount(k.accountId)?.payoutWallet,
      // Submitted before the close or deadline: still counts until then.
      honourUntil: k.honourUntil || (IN_FLIGHT.has(k.status) && submitted(k) && c && endOf(c) != null ? new Date(endOf(c) + CLOSE_GRACE_MS()).toISOString() : null),
      // Whether this server can SEND payouts (a platform payout signer); off,
      // an owed reward is recorded and queued, not sent.
      payoutsEnabled: !!settlement?.hasSigner?.('platform'),
      // N14: the Holler played on air through an overlay link without the
      // room's key, so it was not counted. The streamer needs the keyed link.
      playedUnauthed: !!k.playedUnauthed,
      playedUnauthedAt: k.playedUnauthedAt || null,
      // Cold review B2: a Call in's camera counts only while the room is on
      // air; set when it was seen off air and no on-air clock is running.
      offAir: !!k.offAirAt && !k.cameraOnAt && IN_FLIGHT.has(k.status),
      offAirAt: k.offAirAt || null,
      updatedAt: k.updatedAt || null,
    };
  }

  /** N14: the Holler room's overlay link state, for the creator. null for a Call in or unwired. */
  function overlayStateFor(c) {
    if (c.action?.kind !== 'holler' || typeof overlayKeyState !== 'function') return null;
    const roomId = resolveRoom(c.action.roomHandle)?.id;
    if (!roomId) return null;
    try { return overlayKeyState(roomId); } catch { return null; }
  }

  function myClaim(slug, accountId) {
    const c = store.campaignBySlug(slug);
    if (!c || !accountId) return null;
    return claimView(store.claimFor({ campaignId: c.id, accountId }).byAccount);
  }

  /**
   * A campaign as its creator's dashboard sees it. `budget` keeps the input
   * {amount, atomic} and adds what the DOOR has recorded — funded (the pull),
   * released (payout intents), refunded (the refund intent) — in the reward
   * token's units; `claims` is {total, paid}. `reward` carries the token too.
   */
  function manageView(c) {
    const t = totals(c.id);
    const counts = {};
    for (const k of t.claims) counts[k.status] = (counts[k.status] || 0) + 1;
    const dec = moneyToken(c).decimals;
    const refundRow = c.refund ? (settlement.status(c.refund.ref)?.rows?.[0] || null) : null;
    // A warning, not a refusal: budget above reward × maxClaims can never all
    // be paid out; the extra comes back in the refund.
    const warnings = big(c.budget.atomic) > big(c.reward.atomic) * BigInt(c.maxClaims)
      ? [`The budget is more than reward × max claims (${fromAtomic(big(c.reward.atomic) * BigInt(c.maxClaims), dec)} ${moneyToken(c).symbol}). The extra can never be paid out; it comes back when the campaign closes.`]
      : [];
    const xAppToken = !!xApi.appBearerConfigured?.();
    if (c.rules?.followedByFromSet?.enabled && !xAppToken) warnings.push('This server has no X app token, so "followed by accounts on your list" can only be checked through list members who signed in with X; when none has, every applicant fails that rule.');
    const overlayLink = overlayStateFor(c);
    return {
      ...c,
      warnings,
      // N14: the Holler room's overlay, last 10 minutes. `overlay`:
      // 'keyed' (counts), 'unkeyed' (OBS has the old link: Hollers will not
      // count), 'none' (no overlay: OBS is not open). null for a Call in.
      // `overlayKeyed` is overlay === 'keyed', kept as a boolean.
      overlay: overlayLink ? overlayLink.state : null,
      overlayKeyed: overlayLink ? overlayLink.keyed : null,
      overlayLink,
      xAppToken,
      payoutsEnabled: !!settlement?.hasSigner?.('platform'),
      xCheck: { spent: fromAtomic(big(c.xCheckAtomic), usdc.decimals), ceiling: fromAtomic(xCheckCeilingAtomic(c), usdc.decimals) },
      token: moneyToken(c),
      reward: { ...c.reward, address: moneyToken(c).address, symbol: moneyToken(c).symbol, decimals: dec },
      budget: {
        ...c.budget,
        funded: fromAtomic(t.funded, dec),
        released: fromAtomic(doorSum(c.id, 'campaign:pay:'), dec),
        refunded: fromAtomic(big(refundRow?.amountAtomic), dec),
        xCost: fromAtomic(t.xCost, dec),
      },
      claims: { total: t.claims.length, paid: counts.paid || 0, active: t.activeCount, counts },
      liveAt: c.openedAt || null,
      totals: {
        funded: fromAtomic(t.funded, moneyToken(c).decimals), committed: fromAtomic(t.committed, moneyToken(c).decimals),
        remaining: fromAtomic(t.remaining > 0n ? t.remaining : 0n, moneyToken(c).decimals), xCost: fromAtomic(t.xCost, moneyToken(c).decimals),
        activeCount: t.activeCount, counts,
      },
      referenceSet: setFingerprint(c.rules.referenceSetId),
      refundDoor: c.refund ? settlement.status(c.refund.ref)?.status || null : null,
    };
  }

  function listManaged({ accountId, isAdmin = false, all = false }) {
    return store.listCampaigns().filter((c) => (isAdmin && all) || c.creatorAccountId === accountId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(manageView);
  }

  function getManaged(id, { accountId, isAdmin = false }) {
    const c = store.getCampaign(id);
    if (!c) throw fail('not_found', 'No such campaign.', 404);
    if (!isAdmin && c.creatorAccountId !== accountId) throw fail('forbidden', 'This is not your campaign.', 403);
    return c;
  }

  function claimsFor(id, who) {
    getManaged(id, who);
    return store.listClaims(id).map((k) => ({
      ...claimView(k), accountId: k.accountId, handle: getAccount(k.accountId)?.handle || null,
      xHandle: k.xUsername || null, xUserId: k.xUserId, createdAt: k.createdAt, history: k.history || [],
    }));
  }

  function listSets({ accountId, isAdmin = false }) {
    return store.listSets().filter((s) => isAdmin || s.createdBy === accountId).sort((a, b) => String(b.snapshotAt).localeCompare(String(a.snapshotAt)));
  }

  function getSetView(id, { accountId, isAdmin = false }) {
    const s = store.getSet(id);
    if (!s || (!isAdmin && s.createdBy !== accountId)) throw fail('not_found', 'No such reference set.', 404);
    const { ids, handles, ...rest } = s;
    return { ...rest, preview: ids.slice(0, 50).map((i) => ({ id: i, username: handles?.[i] || null })) };
  }

  let timer = null;
  return {
    store, totals, tokenInfo,
    createCampaign, updateCampaign, fundTerms, fund, open, close, setHidden,
    check, reserve, releaseSlot, bind, advance, tryPay, onLetterEvent, onSeatEvent, sync, maybeRefund,
    estimateSet, estimateForCampaign, buildSet, refreshSet, listSets, getSetView, reconcileFunding, resolveStuckFunding,
    publicView, myClaim, claimView, listManaged, getManaged, manageView, claimsFor,
    start(ms = 15_000) { if (!timer) { timer = setInterval(() => { try { sync(); } catch (e) { log.warn?.(`[campaigns] sync failed: ${e.message}`); } }, ms); timer.unref?.(); } return this; },
    stop() { clearInterval(timer); timer = null; for (const t of seatTimers.values()) clearTimeout(t); seatTimers.clear(); },
  };
}
