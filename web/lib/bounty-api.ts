// Client for the creator-bounty routes (../bounty-routes.js).
// Every call 404s when BOUNTY_CLAIM is off, which is what keeps the UI dark:
// surfaces check `enabled` from /api/bounty/config before rendering anything.

import { backendHttpUrl } from './backend'

export type BountyPool = {
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
  /** Lowest broadcast height measured as reliably verifiable (720). */
  minVerifiableHeightPx: number
  /** How verification behaves per platform — one source of truth, shared
   *  with the verifier's sampling density. */
  platformProfiles: Record<string, PlatformProfile>
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

export function listBountyPools() {
  return req<{ pools: BountyPool[]; currency: string }>('/api/bounty/pools')
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
  }>(`/api/bounty/claim/${encodeURIComponent(id)}`)
}

export function startAirSession(claimId: string, platform: string, roomId?: string) {
  return req<{ ok: boolean; airSession: AirSession; code: { code: string } | null }>(
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
}

export type ProgramPool = PoolView & {
  seeded: boolean
  claimed: boolean
  promotional: boolean
  clipsWaiting: number
}

export function getProgram() {
  return req<{
    pools: ProgramPool[]
    currency: string
    totals: { realValue: number; displayedTotal: number; note: string }
  }>('/api/bounty/program')
}

export function getPoolView(platform: string, handle: string) {
  return req<{ view: PoolView; reserved: { claimedBy?: string | null; seeded?: boolean } | null; clips: number }>(
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
}) {
  return req<{
    ok: boolean
    pledge: { id: string; targets: string[]; expiresAt: number }
    contribution: { id: string }
    uploadUrl: string
    uploadDeadline: number
    clipLimits: { minSeconds: number; maxBytes: number }
    rejectionPolicy: RejectionPolicy
  }>('/api/bounty/pledge', { method: 'POST', body: args })
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
  targets: string[]
  pledgeStatus: string
  winner: string | null
  expiresAt: number
  state: string
  next: string
  clip: {
    clipId: string
    durationS: number
    moderation: { grade: string; confidence: number } | null
    approval: { state: string; reasonCode?: string } | null
    playCount: number
  } | null
}

export function getMyContributions(contributor: string) {
  return req<{ contributions: MyContribution[]; states: string[]; note: string }>(
    `/api/bounty/my?contributor=${encodeURIComponent(contributor)}`,
  )
}

export type QueueClip = {
  clipId: string
  durationS: number
  bytes: number
  storedAt: number
  contributor: string | null
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
