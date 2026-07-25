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
  badgeTooSmall?: boolean
}

export type BountyClientConfig = {
  enabled: boolean
  currency: string
  codeRotateMs: number
  badgeMinHeightRatio: number
  badgeMinHeightPx: number
  disputeWindowMs: number
  releaseRatePerMinute: number
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
    verifiedMinutes: number
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

export function adminOverride(platform: string, handle: string, to: string, reason: string) {
  return req<{ ok: boolean }>('/api/bounty/admin/override', {
    method: 'POST',
    body: { platform, handle, to, reason, actor: 'admin' },
  })
}
