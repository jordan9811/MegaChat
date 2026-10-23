// The public shapes behind /c/<slug> (campaign-engine.js publicView,
// claimView). The creator dashboard has its own client in lib/campaigns-api.ts.

export type SetFingerprint = {
  id: string
  name: string
  source: 'x-following' | 'x-list' | 'manual'
  count: number
  snapshotAt: string
  root: string
  version: number
}

export type PublicCampaign = {
  slug: string
  title: string
  blurb: string
  status: 'live' | 'closed'
  creator: { handle: string } | null
  /** `moderation` is the room's Holler moderation when the server exposes
   *  it: 'auto' means an approval is the automatic check, nobody looking. */
  action: { kind: 'holler' | 'callin'; roomHandle: string; require: 'approved' | 'aired' | 'joined'; minSeconds?: number; moderation?: 'auto' | 'approve' | string | null }
  joinUrl: string
  reward: { type: 'usdc' | 'token'; amount: string; symbol: string; tokenAddress: string | null }
  budget: { amount: string; left: string; symbol: string }
  maxClaims: number
  spotsLeft: number
  deadline: string | null
  rules: string[]
  referenceSet: SetFingerprint | null
  followedBySet: SetFingerprint | null
  funded: boolean
}

export type CampaignCheck = { rule: string; pass: boolean; detail: string }

export type CampaignClaim = {
  id: string
  status: 'ineligible' | 'eligible' | 'recorded' | 'approved' | 'aired' | 'joined' | 'owed' | 'releasing' | 'paid' | 'failed' | 'rejected' | 'expired'
  checks: CampaignCheck[]
  checkedAt: string | null
  xUsername: string | null
  owed: { amount: string; symbol: string } | null
  payout: { to: string; door: string | null; amount: string; symbol: string; txHash: string | null } | null
  needsWallet: boolean
  /** Set on a claim submitted before the campaign closed: it still counts
   *  if it reaches the required state before this (ISO). Absent otherwise. */
  honourUntil?: string | null
  /** Whether this server can send payouts at all. false: the intent is
   *  recorded and queued until payouts are switched on. Absent: unknown. */
  payoutsEnabled?: boolean
  /** The room's Holler moderation was automatic when this was approved. */
  autoModerated?: boolean
  /** The Holler played on air, but through an overlay link without the
   *  room's key, so the server could not confirm it aired and did not count
   *  it. The streamer has to update their OBS overlay link. */
  playedUnauthed?: boolean
  playedUnauthedAt?: string | null
}

export type MyClaim = {
  signedIn: boolean
  xLinked: boolean
  xUsername: string | null
  payoutWallet: string | null
  xSignIn: boolean
  claim: CampaignClaim | null
}
