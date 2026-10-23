// Client for the reward-campaign routes (/api/campaigns, /api/reference-sets,
// /api/tokens). The shapes here mirror campaign-engine.js (the engine's
// shapes won, 2026-10-23): rules are an OBJECT keyed by rule name, the
// status ladder is draft → funded → live → closed with Fund and Open as two
// steps, and the token rides top-level on a response.
//
// A campaign is "if you meet <rules> I'll pay you <reward> to <action> on my
// stream". The creator funds the budget up front from their wallet (USDC or a
// custom Tempo ERC-20), claimants who pass the rules do the action, and the
// payout goes out on its own. Nothing in a campaign is ever an action ON X —
// X's developer policy forbids paying for a follow, reply, repost or quote —
// so the rules only READ a claimant's X profile, and the paid action is always
// the Holler or the Call in.

import { backendHttpUrl } from './backend'

// ── Rules ───────────────────────────────────────────────────────────────────

export type VerifiedType = 'blue' | 'business' | 'government'

/** Every rule reads the claimant's X profile; none asks them to do anything
 *  there. A key that is absent is a rule that is off. */
export type Rules = {
  minFollowers?: number
  /** Only if X exposes a verified-follower count on the profile read. */
  minVerifiedFollowers?: number
  verified?: true
  verifiedTypes?: VerifiedType[]
  identityVerified?: true
  minAccountAgeDays?: number
  minTweetCount?: number
  minListedCount?: number
  hasProfileImage?: true
  hasDescription?: true
  /** They are in this frozen set. */
  referenceSetId?: string
  /** Followed by at least `min` members of a frozen set. Checking this costs
   *  X-API calls per claim; the cap bounds what one claim may spend, and the
   *  spend comes out of the campaign budget. The server only enforces the
   *  rule when `enabled` is true, so the form always sends it and checks the
   *  echo (a rule that is stored but off would never be checked). */
  followedByFromSet?: { referenceSetId: string; min: number; perClaimCostCapUsd: number; enabled?: boolean; /** What checking may cost in all; blank = 20% of the budget. */ maxTotalUsd?: number }
}

export type RuleKey = keyof Rules

// ── Reference sets ──────────────────────────────────────────────────────────

export type ReferenceSetSource = 'x-following' | 'x-list' | 'manual'

/** A frozen list of X account ids. `root` is the Merkle root of the snapshot,
 *  so a set can be shown and checked without ever handing out the list. */
export type ReferenceSet = {
  id: string
  name: string
  source: ReferenceSetSource
  count: number
  snapshotAt: string
  root: string
}

export type ReferenceSetRequest = {
  /** Optional label; the server names the set from its source otherwise. */
  name?: string
  source: ReferenceSetSource
  /** x-following: ignored (the signed-in account's own). x-list: the List id.
   *  manual: pasted ids, one per line or comma-separated. */
  sourceRef?: string
  /** An X-sourced set costs a lookup, which is charged to one of the
   *  creator's FUNDED campaigns; the server refuses without one. */
  campaignId?: string
}

// ── Campaigns ───────────────────────────────────────────────────────────────

/** draft: private, nothing moved · funding_pending: the pull was sent, its
 *  receipt not yet seen (nothing can change until it is) · funded: budget
 *  pulled and confirmed, not yet open · live: open for claims · closed: no
 *  new claims, unspent budget refunds. */
export type CampaignStatus = 'draft' | 'funding_pending' | 'funded' | 'live' | 'closed'
export type ActionKind = 'holler' | 'callin'
/** When the action counts. holler: aired | approved. callin: aired | joined.
 *  The first is the default (the server's order too, campaign-engine.js). */
export type ActionRequire = 'approved' | 'aired' | 'joined'

export const REQUIRE_OPTIONS: Record<ActionKind, ActionRequire[]> = {
  holler: ['aired', 'approved'],
  callin: ['aired', 'joined'],
}

export type RewardInput = {
  type: 'usdc' | 'token'
  /** Required for 'token'; omitted for 'usdc'. */
  address?: string | null
  amount: string
}

export type CampaignInput = {
  title: string
  blurb: string
  reward: RewardInput
  budget: { amount: string }
  maxClaims: number
  /** ISO 8601. */
  deadline: string
  action: { kind: ActionKind; roomHandle: string; require: ActionRequire; minSeconds?: number }
  rules: Rules
}

/** N14: the Holler room's overlay link, judged over the last 10 minutes.
 *  keyed: the room's keyed overlay is connected (or was), so campaign Hollers
 *  count. unkeyed: only the old link without the key was seen, so Hollers
 *  play but cannot be counted. none: no overlay at all; OBS is not open. */
export type OverlayState = 'keyed' | 'unkeyed' | 'none'

export type OverlayLink = {
  state: OverlayState
  /** state === 'keyed', as a boolean. */
  keyed: boolean
  /** Connected right now (the seen-at times cover the 10-minute window). */
  keyedConnected: boolean
  unkeyedConnected: boolean
  /** ISO; null when never seen since the server started. */
  keyedSeenAt: string | null
  unkeyedSeenAt: string | null
}

export type Campaign = {
  id: string
  /** Server-minted. Public claim page is /c/<slug>. */
  slug: string
  status: CampaignStatus
  title: string
  blurb: string
  reward: { type: 'usdc' | 'token'; address?: string | null; amount: string }
  /** `amount` is the plan; funded/released/refunded are what the server has
   *  moved, decimal strings in the token's units, 0 on a draft. */
  budget: { amount: string; funded?: string; released?: string; refunded?: string }
  token: { address: string | null; symbol: string; decimals: number }
  maxClaims: number
  deadline: string | null
  action: { kind: ActionKind; roomHandle: string; require: ActionRequire; minSeconds?: number }
  rules: Rules
  /** `total` is every claim row, ineligible checks included; `active` is the
   *  claims holding a place (eligible, recorded, owed, paid…), which is what
   *  counts against maxClaims. */
  claims?: { total: number; paid: number; active?: number; counts?: Partial<Record<ClaimStatus, number>> }
  createdAt: string
  updatedAt: string
  openedAt?: string | null
  closedAt?: string | null
  // ── The creator's view only (manageView); every one optional, so a server
  // that does not say leaves the page to its defaults. ──
  /** The server's own warnings about this campaign, in its words. */
  warnings?: string[]
  /** N14: the Holler room's overlay over the last 10 minutes. null/absent: a
   *  Call in, or a server that does not say. Read it through overlayState(). */
  overlay?: OverlayState | null
  /** The older boolean form of `overlay` (true = keyed). A server that sends
   *  only this cannot tell 'unkeyed' from 'none': false reads as unkeyed. */
  overlayKeyed?: boolean | null
  /** The detail behind `overlay`: what is connected now and when each kind
   *  of overlay was last seen. */
  overlayLink?: OverlayLink | null
  /** false: this server records payout intents but cannot send them yet. */
  payoutsEnabled?: boolean
  /** Whether this server holds an X app token (what the followed-by check needs). */
  xAppToken?: boolean
  /** The server's word on follower checks. Its shape is the server's; the
   *  client only reads a warning sentence out of it when one is there. */
  xCheck?: Record<string, unknown> | null
}

export type ClaimStatus =
  | 'ineligible'
  | 'eligible'
  | 'recorded'
  | 'approved'
  | 'aired'
  | 'joined'
  | 'owed'
  | 'releasing'
  | 'paid'
  | 'failed'
  | 'rejected'

export type ClaimCheck = { rule: RuleKey | string; pass: boolean; detail: string }

export type Claim = {
  id: string
  status: ClaimStatus
  /** Holler handle; null when the account has none yet. */
  handle: string | null
  /** X username, without the @. */
  xHandle: string | null
  checks: ClaimCheck[]
  /** Set once a payout intent exists. `door` is the settlement door's own
   *  status for that intent (what "failed" means, when it fails). */
  payout?: { amount: string; symbol: string; txHash?: string | null; intentRef?: string; door?: string | null; to?: string; error?: string } | null
  /** Owed, but the claimant has not named a payout wallet yet. */
  needsWallet?: boolean
  /** Submitted before the close: still counts if it reaches the required
   *  state before this (ISO). Absent on every other claim. */
  honourUntil?: string | null
  /** false: this server records payout intents but cannot send them yet. */
  payoutsEnabled?: boolean
  /** N14: the Holler played on air, but through an overlay link without the
   *  room's key, so the server could not confirm it aired and did not count it. */
  playedUnauthed?: boolean
  /** ISO; when that play happened. */
  playedUnauthedAt?: string | null
  createdAt: string
}

/** The overlay word for a creator's campaign view: `overlay` when the server
 *  sends it, else the older `overlayKeyed` boolean (true → keyed, false →
 *  unkeyed), else null. Always null for a Call in. */
export function overlayState(c: Pick<Campaign, 'action' | 'overlay' | 'overlayKeyed'>): OverlayState | null {
  if (c.action?.kind !== 'holler') return null
  if (c.overlay === 'keyed' || c.overlay === 'unkeyed' || c.overlay === 'none') return c.overlay
  if (c.overlayKeyed === true) return 'keyed'
  if (c.overlayKeyed === false) return 'unkeyed'
  return null
}

/** Fund either pulls the budget, or asks for an ERC-20 allowance first when
 *  the creator's wallet has not approved enough (or no wallet was named). */
export type ApprovalAsk = {
  token: { address: string; symbol: string; decimals: number }
  /** The address the wallet approves: Holler's campaign spender, which only pulls campaign budgets. */
  spender: string
  /** The platform wallet the budget is pulled INTO; it holds budgets and pays rewards and refunds (not the spender). */
  holder?: string
  amountAtomic: string
  /** The body named no wallet. */
  walletRequired?: boolean
  /** The body cited no approve transaction. */
  approveRequired?: boolean
  /** What the wallet has approved so far, atomic. */
  allowance?: string
  /** true when the server states the spender is the wallet that holds every
   *  campaign budget and pays every reward; the approve step only says so
   *  on that word. */
  holds?: boolean
  /** The EIP-712 Fund message the approving wallet signs after the approve
   *  mines; the client adds `wallet` and a `deadline` (unix seconds, at most
   *  `maxSeconds` away). */
  sign?: FundSignTerms
}
export type FundSignTerms = {
  domain: { name: string; version: string; chainId: number }
  types: Record<string, { name: string; type: string }[]>
  primaryType: string
  message: { campaignId: string; token: string; amountAtomic: string }
  maxSeconds?: number
}
/** What a fund call cites once the wallet approved and signed. */
export type FundProof = {
  approveTx: string
  signature: string
  typedData: {
    domain: FundSignTerms['domain']
    types: FundSignTerms['types']
    primaryType: string
    message: FundSignTerms['message'] & { wallet: string; deadline: string }
  }
}
export type FundResult =
  | { ok: true; campaign?: Campaign }
  | { ok?: false; needsApproval: ApprovalAsk }

export type TokenInfo = {
  address: string
  symbol: string
  decimals: number
  name?: string
  /** Whether this server takes the token for a campaign (custom tokens need an on-chain test first). */
  campaignAllowed?: boolean
}

// ── Transport ───────────────────────────────────────────────────────────────

export class CampaignsApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function req<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${backendHttpUrl()}${path}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string; hint?: string }
  if (!res.ok) {
    const msg = [data.error || (res.status === 404 ? 'Not available on this server' : `Request failed (${res.status})`), data.hint]
      .filter(Boolean)
      .join(' — ')
    throw new CampaignsApiError(res.status, msg)
  }
  return data as T
}

// ── Campaigns ───────────────────────────────────────────────────────────────

/** The signed-in creator's campaigns, every status. */
export function listMyCampaigns() {
  return req<{ campaigns: Campaign[] }>('/api/campaigns/mine')
}

export function getCampaign(id: string) {
  return req<{ campaign: Campaign }>(`/api/campaigns/${encodeURIComponent(id)}`)
}

/** Creates a DRAFT; the server mints the slug. Nothing moves until Fund. */
export function createCampaign(input: CampaignInput) {
  return req<Campaign>('/api/campaigns', { method: 'POST', body: input })
}

export function updateCampaign(id: string, patch: Partial<CampaignInput>) {
  return req<Campaign>(`/api/campaigns/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })
}

/** Pulls the budget from `wallet` (draft → funded). Answers {needsApproval}
 *  instead when that wallet's allowance to the spender is short; after the
 *  approval confirms, call again with its `approveTx` so the pull cites it. */
export function fundCampaign(id: string, body: { wallet: string; approveTx?: string | null; signature?: string; typedData?: FundProof['typedData'] }) {
  return req<FundResult>(`/api/campaigns/${encodeURIComponent(id)}/fund`, { method: 'POST', body })
}

/** Opens a funded campaign to claims (funded → live). */
export function openCampaign(id: string) {
  return req<{ ok: true; campaign?: Campaign }>(`/api/campaigns/${encodeURIComponent(id)}/open`, { method: 'POST' })
}

/** Stops new claims. Owed payouts still settle; the unspent budget refunds. */
export function closeCampaign(id: string) {
  return req<{ ok: true; campaign?: Campaign }>(`/api/campaigns/${encodeURIComponent(id)}/close`, { method: 'POST' })
}

export function listClaims(id: string) {
  return req<{ claims: Claim[] }>(`/api/campaigns/${encodeURIComponent(id)}/claims`)
}

/** What this server has switched on. `fundingEnabled` false means Fund
 *  cannot take a budget here (drafts and checks still work); the X app token
 *  is what X-sourced frozen lists and the followed-by check need. */
export type CampaignConfig = {
  fundingEnabled: boolean
  xAppToken: boolean
  /** Whether this server can SEND payouts; null when it does not say. */
  payoutsEnabled: boolean | null
  /** The server's own sentence on follower checks, when it sends one. */
  xCheckWarning: string | null
}

export async function getCampaignConfig(): Promise<CampaignConfig> {
  const d = await req<{ fundingEnabled?: boolean; xAppToken?: boolean; xBearer?: boolean; payoutsEnabled?: boolean; xCheck?: unknown }>('/api/campaign-config')
  return {
    fundingEnabled: d.fundingEnabled === true,
    xAppToken: (d.xAppToken ?? d.xBearer) === true,
    payoutsEnabled: typeof d.payoutsEnabled === 'boolean' ? d.payoutsEnabled : null,
    xCheckWarning: xCheckWarning(d.xCheck),
  }
}

/** The server's own warning sentence out of its `xCheck` object, whatever
 *  key it lands under; null when there is none (or it is only figures). */
export function xCheckWarning(x: unknown): string | null {
  if (typeof x === 'string') return x.trim() || null
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  for (const k of ['warning', 'message', 'text', 'reason', 'detail', 'copy']) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

export const FUNDING_OFF_COPY = 'Paid campaigns aren’t open yet on this server.'

/** Follower checks ("followed by people on a list") need the X app token;
 *  without it the server can still check through list members who signed in
 *  with X, and only fails everyone when none has. Softer than "will fail". */
export const FOLLOWER_CHECKS_OFF_COPY = 'This server can’t run follower checks through the X app token; checks can still run through list members who signed in with X.'

/** Whether the server can run the followed-by rule, and what it says about
 *  it. Reads the creator's campaign view first (its `xCheck` sentence, then
 *  its `warnings`), then the config, then falls back to this client's copy.
 *  `canRun` is null when nothing said either way. */
export function followerCheckState(c: Partial<Pick<Campaign, 'rules' | 'xAppToken' | 'xCheck' | 'warnings'>> | null | undefined, cfg: Pick<CampaignConfig, 'xAppToken' | 'xCheckWarning'> | null | undefined) {
  const ruleOn = !!c?.rules?.followedByFromSet
  const fromView = c?.xCheck ? xCheckWarning(c.xCheck) : null
  const fromWarnings = (c?.warnings || []).find((w) => /follow|X app token/i.test(w)) || null
  const xc = c?.xCheck && typeof c.xCheck === 'object' ? (c.xCheck as Record<string, unknown>) : null
  const xcSaysOff = !!xc && ['available', 'ok', 'enabled', 'canRun'].some((k) => xc[k] === false)
  const canRun: boolean | null = typeof c?.xAppToken === 'boolean' ? c.xAppToken && !xcSaysOff : xcSaysOff ? false : cfg ? cfg.xAppToken : null
  const blocked = ruleOn && canRun === false
  return { ruleOn, canRun, blocked, warning: blocked ? fromView || fromWarnings || cfg?.xCheckWarning || FOLLOWER_CHECKS_OFF_COPY : null }
}

// ── Reference sets ──────────────────────────────────────────────────────────

export function listMyReferenceSets() {
  return req<{ sets: ReferenceSet[] }>('/api/reference-sets/mine')
}

/** What freezing this set would cost in X-API spend, before committing. */
export function estimateReferenceSet(body: ReferenceSetRequest) {
  return req<{ estimatedUsd: number; count?: number }>('/api/reference-sets/estimate', { method: 'POST', body })
}

/** Freezes the set. `confirmCostUsd` must echo the estimate the creator saw. */
export function createReferenceSet(body: ReferenceSetRequest & { confirmCostUsd: number }) {
  return req<ReferenceSet>('/api/reference-sets', { method: 'POST', body })
}

// ── Tokens and chain ────────────────────────────────────────────────────────

/** Resolves symbol and decimals for a Tempo ERC-20 the creator typed in. */
export function lookupToken(address: string) {
  return req<TokenInfo>(`/api/tokens/${encodeURIComponent(address)}`)
}

const DEFAULT_EXPLORER = 'https://explore.tempo.xyz'

/** Explorer origin and the platform USDC, from the public config the join
 *  page already reads. Falls back to the Tempo explorer when unreachable. */
export async function getChainInfo(): Promise<{ explorerUrl: string; usdcAddress: string | null }> {
  try {
    const d = await req<{ explorerUrl?: string; usdcAddress?: string }>('/api/config')
    return { explorerUrl: (d.explorerUrl || DEFAULT_EXPLORER).replace(/\/$/, ''), usdcAddress: d.usdcAddress || null }
  } catch {
    return { explorerUrl: DEFAULT_EXPLORER, usdcAddress: null }
  }
}

export function explorerTxUrl(explorerUrl: string, txHash: string) {
  return `${explorerUrl}/tx/${txHash}`
}

export function explorerAddressUrl(explorerUrl: string, address: string) {
  return `${explorerUrl}/address/${address}`
}
