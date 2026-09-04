import type { PublicRoomCard } from '@/lib/api'
import type { BountyPool } from '@/lib/bounty-api'
import { withBountyExamples } from '@/lib/bounty-examples'

// Server-side data loaders shared by the landing page (/), the app page
// (/app) and the legacy home (/legacy). All of them are force-dynamic server
// components, so these run per-request against our own Express process.
function backendBase(): string {
  const port = process.env.PORT || '3000'
  // BASE_URL is the PUBLIC origin and may carry a trailing slash; strip it so
  // we never build `//api/...`, which resolves to a different host entirely.
  return (process.env.BASE_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '')
}

export async function loadInitialRooms(): Promise<PublicRoomCard[]> {
  try {
    const res = await fetch(`${backendBase()}/api/rooms/public`, { cache: 'no-store' })
    if (!res.ok) {
      console.warn(`[landing] /api/rooms/public responded ${res.status}`)
      return []
    }
    const data = (await res.json()) as { rooms?: PublicRoomCard[] }
    return data.rooms ?? []
  } catch (err) {
    // An empty board and a broken backend render identically, so leave a
    // breadcrumb — otherwise an outage looks exactly like a quiet night.
    console.warn('[landing] could not load rooms:', (err as Error).message)
    return []
  }
}

// The bounty surface is env-gated (BOUNTY_CLAIM) — on an unflagged deploy
// /api/bounty/* does not exist at all. Absence is a normal state, not an
// error: callers render their "no pools" composition.
export async function loadBountyPools(): Promise<BountyPool[]> {
  try {
    const res = await fetch(`${backendBase()}/api/bounty/pools`, { cache: 'no-store' })
    // 404 is the expected shape of "BOUNTY_CLAIM is off" — not worth a warning.
    if (!res.ok) return []
    const data = (await res.json()) as { pools?: BountyPool[] }
    return withBountyExamples(data.pools ?? []).filter((p) => p.remaining > 0)
  } catch {
    return []
  }
}
