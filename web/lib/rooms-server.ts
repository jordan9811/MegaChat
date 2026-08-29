import type { PublicRoomCard } from '@/lib/api'
import type { BountyPool } from '@/lib/bounty-api'

// Server-side data loaders shared by the landing page (/), the app page
// (/app) and the legacy home (/legacy). All of them are force-dynamic server
// components, so these run per-request against our own Express process.
function backendBase(): string {
  const port = process.env.PORT || '3000'
  return process.env.BASE_URL || `http://127.0.0.1:${port}`
}

export async function loadInitialRooms(): Promise<PublicRoomCard[]> {
  try {
    const res = await fetch(`${backendBase()}/api/rooms/public`, { cache: 'no-store' })
    if (!res.ok) return []
    const data = (await res.json()) as { rooms?: PublicRoomCard[] }
    return data.rooms ?? []
  } catch {
    return []
  }
}

// The bounty surface is env-gated (BOUNTY_CLAIM) — on an unflagged deploy
// /api/bounty/* does not exist at all. Absence is a normal state, not an
// error: callers render their "no pools" composition.
export async function loadBountyPools(): Promise<BountyPool[]> {
  try {
    const res = await fetch(`${backendBase()}/api/bounty/pools`, { cache: 'no-store' })
    if (!res.ok) return []
    const data = (await res.json()) as { pools?: BountyPool[] }
    return (data.pools ?? []).filter((p) => p.remaining > 0)
  } catch {
    return []
  }
}
