// Client for the creator-bounty routes (../bounty-routes.js).
// Every call 404s when BOUNTY_CLAIM is off, which is what keeps the UI dark:
// surfaces check `enabled` from /api/bounty/config before rendering anything.

import { backendHttpUrl } from './backend'
import { withBountyExamples } from './bounty-examples'

export type BountyPool = {
  displayOnly?: boolean
  /** Profile photo, server-fetched and cached; null when that platform has no
   *  image API (X, Rumble) or the fetch failed — callers draw a monogram. */
  avatarUrl?: string | null
  handleKey: string
  platform: string | null
  handle: string | null
  status: string | null
  contributionCount: number
  totalContributed: number
  refunded: number
  releasedContributor: number
  releasedPlatformMatch: number
  remaining: number
}

export type BountyClaim = {
  id: string
  handleKey: string
  claimant: string
  verificationState: 'PENDING' | 'VERIFIED' | 'DENIED' | string
  verificationMethod?: string
  createdAt: number
  expiresAt: number
}

export type AirSession = {
  id: string
  claimId: string
  roomId: string | null
  platform: string | null
  codes: { code: string; issuedAt: number; expiresAt: number }[]
  status: string
  violations: { type: string; at: number; detail?: unknown }[]
  startedAt: number
  endedAt: number | null
  verifiedMinutes: number
  verifiedClips?: number
  verifiedClipSeconds?: number
  badgeTooSmall?: boolean
}

export type BountyClientConfig = {
  enabled: boolean
  currency: string
  codeRotateMs: number
  badgeMinHeightRatio: number
  badgeMinHeightPx: number
  disputeWindowMs: number
  releaseRatePerClip: number
  minClipSeconds: number
  /** Largest clip the upload route takes (BOUNTY_CLIP_MAX_BYTES). The
   *  recorder refuses a bigger take before any pledge. Absent from a server
   *  that predates it: then nothing is refused here. */
  clipMaxBytes?: number
  /** Lowest broadcast height measured as reliably verifiable (720). */
  minVerifiableHeightPx: number
  /** How verification behaves per platform — one source of truth, shared
   *  with the verifier's sampling density. */
  platformProfiles: Record<string, PlatformProfile>
  /** OBS one-click flag + the badge geometry its verify step checks. */
  obsOneClick?: boolean
  badgeCssPx?: number
  /** How often the claim page asks OBS whether the overlay is on screen. */
  obsScenePollMs?: number
  /** Smallest plausible overlay canvas side, CSS px. */
  overlayMinCanvasPx?: number
  /** Real money (BOUNTY_FUNDING=1): a pledge needs the fan's wallet before it counts. */
  fundingEnabled?: boolean
  /** Liveness tiers: how long the overlay must stay up and the slice a yellow release pays. */
  tiers?: { yellowMinMs: number; yellowReleaseFraction: number; defaultMinTier: 'green' | 'yellow' }
  /** What the server's money looks like: ledger-only, or real with the
   *  spender a fan's wallet approves and the platform wallet that holds pools. */
  money?: {
    mode: 'ledger-only' | 'real'
    /** Real mode and a spender is configured: pledges can be funded right now. */
    fundingOpen?: boolean
    spender?: string | null
    holder?: string
    token?: string
  }
}

/** The funding ask a pledge answers with: the same envelope a campaign's Fund step uses. */
export type PledgeApprovalAsk = {
  token: { address: string; symbol: string; decimals: number }
  /** The bounty spender the wallet approves (only pulls pledges). */
  spender: string | null
  /** The platform wallet the pledge is pulled INTO; it holds pools and pays releases and refunds. */
  holder?: string
  amountAtomic: string
  walletRequired?: boolean
  approveRequired?: boolean
  allowance?: string
  holds?: boolean
  sign?: {
    domain: { name: string; version: string; chainId: number }
    types: Record<string, { name: string; type: string }[]>
    primaryType: string
    message: Record<string, string>
    maxSeconds?: number
  }
}
export type PledgeFundProof = {
  approveTx: string
  signature: string
  typedData: { domain: PledgeApprovalAsk['sign'] extends infer S ? (S extends { domain: infer D } ? D : never) : never; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, string> }
}
/** Where a real-money pledge stands, as the server tells its owner. */
export type PledgeFunding = {
  state: 'unfunded' | 'pulling' | 'pending' | 'funded' | 'needs_person' | 'abandoned' | 'short' | 'unproven' | 'failed' | 'ledger-only' | string
  txHash?: string | null
  wallet?: string | null
  at?: string | null
  needsPerson?: string | null
  failures?: number
}

export type PlatformProfile = {
  platform: string
  /** False for Kick: no VOD listing API, so the live pass is the only pass. */
  vodRetry: boolean
  samplingMultiplier: number
  notice: string
}

async function req<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${backendHttpUrl()}${path}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`)
  return data as T
}

/** Returns null when the feature is off (routes aren't mounted → 404). */
export async function getBountyConfig(): Promise<BountyClientConfig | null> {
  try {
    return await req<BountyClientConfig>('/api/bounty/config')
  } catch {
    return null
  }
}

export async function listBountyPools() {
  const result = await req<{ pools: BountyPool[]; currency: string }>('/api/bounty/pools')
  return { ...result, pools: withBountyExamples(result.pools) }
}

export function startClaim(platform: string, handle: string, claimant: string) {
  return req<{ ok: boolean; claim: BountyClaim; identity: { approved: boolean; method: string }; pool: BountyPool }>(
    '/api/bounty/claim',
    { method: 'POST', body: { platform, handle, claimant } },
  )
}

export function getClaim(id: string) {
  return req<{
    claim: BountyClaim
    pool: BountyPool
    airSessions: AirSession[]
    verifiedClips: number
    verifiedClipSeconds: number
    verifiedMinutes: number
    underReview: boolean
    reviewOpenedAt: number | null
    /** Badge legibility as MEASURED on their own broadcast. */
    quality: {
      belowFloorClips: number
      smallestBadgePx: number | null
      floorPx: number
      minVerifiableHeightPx: number
    }
    platformProfile: PlatformProfile | null
    disputeWindowEndsAt: number | null
    ledger: { id: string; type: string; amount: string; bucket: string; at: number; reason: string | null }[]
    /** Real money: the payout wallet releases go to, and whether one is still needed. Null in ledger-only mode. */
    payout: {
      account: string | null
      wallet: string | null
      needsWallet: boolean
      releases: { rowId: string; bucket: string; amount: string; state: 'owed' | 'pending' | 'paid' | 'failed' | 'voided' }[]
      mine: boolean
    } | null
  }>(`/api/bounty/claim/${encodeURIComponent(id)}`)
}

/** Set the signed-in account's payout wallet (shared with campaign rewards); owed bounty releases pay to it at once. */
export function setPayoutWallet(address: string) {
  return req<{ ok: true; payoutWallet: string | null }>('/api/account/payout-wallet', { method: 'POST', body: { address } })
}

export function startAirSession(claimId: string, platform: string, roomId?: string) {
  return req<{
    ok: boolean
    airSession: AirSession
    code: { code: string } | null
    /** The room the session was bound to — given, owned, or created (E37). */
    roomId: string
    /** The stable overlay address to paste into OBS. Carries `room` so the
     *  overlay renders MegaChats, and `bountyRoom` so the badge survives the
     *  next stream. */
    overlayPath: string
  }>(
    '/api/bounty/air-session',
    { method: 'POST', body: { claimId, platform, roomId } },
  )
}

export function listAdminSessions() {
  return req<{
    sessions: (AirSession & { verifications: unknown[]; claim: BountyClaim | null })[]
    settlementIntents: { kind: string; to: string | null; amount: string; bucket: string; ref: string }[]
  }>('/api/bounty/admin/sessions')
}

export type BountyReview = {
  id: string
  airSessionId: string
  handleKey: string
  confidence: number
  reason: string | null
  state: 'OPEN' | 'RESOLVED_APPROVE' | 'RESOLVED_REJECT' | string
  assignee: string | null
  openedAt: number
  resolvedAt: number | null
  resolvedBy: string | null
  resolutionReason: string | null
  ageMs: number
  breachedSla: boolean
}

export function listReviews() {
  return req<{ reviews: BountyReview[]; slaMs: number; openCount: number; breachedCount: number }>(
    '/api/bounty/admin/reviews',
  )
}

export function resolveReview(id: string, approve: boolean, reason: string) {
  return req<{ ok: boolean; review: BountyReview; release: unknown }>(
    `/api/bounty/admin/reviews/${encodeURIComponent(id)}/resolve`,
    { method: 'POST', body: { approve, reason, actor: 'admin' } },
  )
}

export function adminOverride(platform: string, handle: string, to: string, reason: string) {
  return req<{ ok: boolean }>('/api/bounty/admin/override', {
    method: 'POST',
    body: { platform, handle, to, reason, actor: 'admin' },
  })
}

// ── Bounty program (fan-facing) ─────────────────────────────────────────────

export type PoolView = BountyPool & {
  guaranteed: number
  contestedTotal: number
  contested: { pledgeId: string; amount: number; rivals: number; expiresAt: number }[]
  openPledges: number
  /** Money each liveness tier can release (server liveness.js): badge-only backers, and backers who allowed the overlay check. */
  tiers?: { greenOnly: number; yellowOk: number; yellowReleased: number }
  /** Each card split by its own money (pool-view only): locked here, and every open shared pledge naming this handle. */
  cardTiers?: {
    locked: { greenOnly: number; yellowOk: number }
    contested: { greenOnly: number; yellowOk: number }
  }
}

/** The claimant's room right now (server liveness.js); null before a claim. */
export type PoolLiveness = {
  tier: 'off' | 'red' | 'yellow' | 'green'
  label?: string
  roomId?: string
  handle?: string | null
  onAir?: boolean
  channelLive?: boolean
  overlayConnected?: boolean
  overlayRecent?: boolean
  verifying?: boolean
  overlayConnectedMs?: number | null
  sampledMs?: number | null
}

export type ProgramPool = PoolView & {
  seeded: boolean
  claimed: boolean
  promotional: boolean
  clipsWaiting: number
  /** Profile photo, server-fetched and cached. null means no image API for
   *  that platform (X, Rumble) or the fetch failed — the leaderboard draws a
   *  monogram in the same slot rather than a broken frame. */
  avatarUrl: string | null
}

export async function getProgram() {
  const result = await req<{
    pools: ProgramPool[]
    currency: string
    totals: { realValue: number; displayedTotal: number; note: string }
  }>('/api/bounty/program')
  return { ...result, pools: withBountyExamples(result.pools) }
}

export function getPoolView(platform: string, handle: string) {
  return req<{ view: PoolView; reserved: { claimedBy?: string | null; seeded?: boolean } | null; clips: number; liveness?: PoolLiveness | null }>(
    `/api/bounty/pool-view?platform=${encodeURIComponent(platform)}&handle=${encodeURIComponent(handle)}`,
  )
}

export type RejectionPolicy = {
  streamerDeclineRefund: number
  firstPolicyRejectionRefund: number
  repeatPolicyRejectionRefund: number
  withheldShareGoesTo: string
  strikesRequire: string
}

export function createPledge(args: {
  targets: { platform: string; handle: string }[]
  contributor: string
  amount: string
  expiresInMs: number
  /** The liveness tier this pledge releases at; the account preference when absent. */
  minTier?: 'green' | 'yellow'
  /** Names the take: a repeat within 10 minutes gets the first pledge back. */
  attemptId?: string
}) {
  return req<{
    ok: boolean
    pledge: { id: string; targets: string[]; expiresAt: number; status?: string }
    contribution: { id: string; status?: string }
    /** Real money: the pledge is UNFUNDED until the wallet funds it (the
     *  upload is refused until then); `funding.needsApproval` is the ask. */
    requiresFunding?: boolean
    funding?: { needsApproval: PledgeApprovalAsk; fundUrl: string } | null
    uploadUrl: string
    uploadDeadline: number
    clipLimits: { minSeconds: number; maxBytes: number }
    rejectionPolicy: RejectionPolicy
    /** true when this answered a repeat of an earlier attempt. */
    deduped?: boolean
  }>('/api/bounty/pledge', { method: 'POST', body: args })
}

export type FundPledgeResult =
  | { ok: true; pledge: { id: string; status: string }; funding: PledgeFunding; contribution?: { id: string; status: string } | null; already?: boolean }
  | { ok?: false; needsApproval: PledgeApprovalAsk }

/** Fund a real-money pledge: pulls the amount once the wallet approved and signed, or asks for the approval. */
export function fundPledge(pledgeId: string, body: { wallet: string; approveTx?: string | null; signature?: string; typedData?: PledgeFundProof['typedData'] }) {
  return req<FundPledgeResult>(`/api/bounty/pledge/${encodeURIComponent(pledgeId)}/fund`, { method: 'POST', body })
}

/** The signed-in fan's own pledge: status, funding state, whether a clip can be uploaded yet. */
export function getPledge(pledgeId: string) {
  return req<{
    pledge: { id: string; status: string; amount: string; targets: string[]; expiresAt: number }
    contribution: { id: string; status: string } | null
    funding: PledgeFunding
    needsApproval: PledgeApprovalAsk | null
    uploadUrl: string
    canUpload: boolean
  }>(`/api/bounty/pledge/${encodeURIComponent(pledgeId)}`)
}

export function postFrames(uploadUrl: string, frames: string[]) {
  return req<{ ok: boolean; frames: number }>(`${uploadUrl}/frames`, {
    method: 'POST', body: { frames },
  })
}

export async function uploadClip(uploadUrl: string, blob: Blob, durationS: number) {
  const res = await fetch(`${backendHttpUrl()}${uploadUrl}?durationS=${durationS}`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'video/webm', 'x-clip-duration': String(durationS) },
    body: blob,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `Upload failed (${res.status})`)
  return data as { ok: boolean; clip: { clipId: string } }
}

export type MyContribution = {
  pledgeId: string
  contributionId: string | null
  amount: string
  /** The name this pledge goes by: the display name typed, else the fan's @handle. */
  from?: string | null
  targets: string[]
  pledgeStatus: string
  winner: string | null
  expiresAt: number
  state: string
  next: string
  /** Real money: where the funding stands (null in ledger-only mode). */
  funding?: PledgeFunding | null
  /** The liveness tier this pledge releases at. */
  minTier?: 'green' | 'yellow'
  /** Real money: where a refund stands on the settlement door, or null. */
  refund?: 'pending' | 'paid' | 'failed' | 'voided' | null
  clip: {
    clipId: string
    durationS: number
    moderation: { grade: string; confidence: number } | null
    approval: { state: string; reasonCode?: string } | null
    playCount: number
  } | null
}

export function getMyContributions() {
  // "My" means the signed-in account — the server ignores any contributor
  // param on purpose (it was an enumeration hole before the lockdown).
  return req<{ contributions: MyContribution[]; states: string[]; note: string }>('/api/bounty/my')
}

export type QueueClip = {
  clipId: string
  durationS: number
  bytes: number
  storedAt: number
  /** Who it is from: the fan's display name, else their @handle. Never an account id. */
  from: string | null
  moderation: { grade: string; confidence: number; topCategory: string | null } | null
  mediaUrl: string
}

export function getQueue(platform: string, handle: string) {
  return req<{ queue: QueueClip[]; count: number }>(
    `/api/bounty/queue?platform=${encodeURIComponent(platform)}&handle=${encodeURIComponent(handle)}`,
  )
}

export function approveClip(clipId: string, by: string) {
  return req<{ ok: boolean }>(`/api/bounty/clip/${encodeURIComponent(clipId)}/approve`, {
    method: 'POST', body: { by },
  })
}

export function rejectClip(clipId: string, args: { by: string; reasonCode: 'STREAMER_DECLINED' | 'POLICY_VIOLATION'; reason: string }) {
  return req<{ ok: boolean; refunded?: string; withheld?: string; strike?: boolean }>(
    `/api/bounty/clip/${encodeURIComponent(clipId)}/reject`,
    { method: 'POST', body: args },
  )
}
