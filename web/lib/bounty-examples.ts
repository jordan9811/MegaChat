import type { BountyPool, ProgramPool } from './bounty-api'

// Presentation only. These entries never enter the escrow or claim APIs.
const TARGETS = [
  ['twitch', 'threadguy'],
  ['kick', 'chessbrah'],
  ['x', 'martinshkreli'],
  ['x', 'rasmr'],
  ['pumpfun', 'GnBQjwQibzB9zFPHEGEhoiASon7JfaRADxQe6C64pump'],
  ['twitch', 'asmongold'],
  ['twitch', 'pokimane'],
  ['kick', 'xqc'],
] as const

const AVATARS: Record<string, string> = {
  'twitch:threadguy': 'https://static-cdn.jtvnw.net/jtv_user_pictures/36375bf2-fec0-4fb3-a5f2-02575bb63325-profile_image-300x300.png',
  'kick:chessbrah': 'https://files.kick.com/images/user/1329939/profile_image/conversion/2e5379d9-f81e-44a5-8b49-50a82666a5cd-medium.webp',
  'kick:xqc': 'https://files.kick.com/images/user/676/profile_image/conversion/931b4e8f-5445-427c-bd82-b473530390cc-medium.webp',
}

export function bountyKey(platform: string, handle: string) {
  return `${platform}:${platform === 'pumpfun' ? handle : handle.toLowerCase()}`
}

export function withBountyExamples(pools: ProgramPool[]): ProgramPool[]
export function withBountyExamples(pools: BountyPool[]): BountyPool[]
export function withBountyExamples(pools: BountyPool[]): BountyPool[] {
  const result = [...pools]
  for (const [platform, handle] of TARGETS) {
    const key = bountyKey(platform, handle)
    const index = result.findIndex((p) => p.platform && p.handle && bountyKey(p.platform, p.handle) === key)
    const real = result[index] as ProgramPool | undefined
    // Once funded, real history always replaces its example, even after expiry.
    if (real && !real.displayOnly && (real.totalContributed > 0 || real.remaining > 0 || real.refunded > 0 || real.releasedContributor > 0)) continue
    const example: ProgramPool = {
      handleKey: key, platform, handle, status: 'EXAMPLE', displayOnly: true,
      contributionCount: 0, totalContributed: 0, refunded: 0,
      releasedContributor: 0, releasedPlatformMatch: 0, remaining: 200,
      guaranteed: 100, contestedTotal: 100,
      contested: [{ pledgeId: 'example-shared-100', amount: 100, rivals: 4, expiresAt: 0 }],
      openPledges: 0, seeded: false, claimed: !!real?.claimed || real?.status === 'CLAIMED', promotional: true,
      clipsWaiting: 0, avatarUrl: real?.avatarUrl || AVATARS[key] || null,
    }
    if (index < 0) result.push(example)
    else result[index] = example
  }
  return result.sort((a, b) => b.remaining - a.remaining)
}

export function exampleTotals(pools: ProgramPool[]) {
  const examples = pools.filter((p) => p.displayOnly)
  return {
    unique: examples.length * 100 + (examples.length ? 100 : 0),
    visible: examples.length * 200,
    count: examples.length,
  }
}
