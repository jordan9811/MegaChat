import type { PublicRoomCard, RecentAiring } from '@/lib/api'
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

export async function loadInitialRooms({ withConfig = false } = {}): Promise<PublicRoomCard[]> {
  try {
    const res = await fetch(`${backendBase()}/api/rooms/public`, { cache: 'no-store' })
    if (!res.ok) {
      console.warn(`[landing] /api/rooms/public responded ${res.status}`)
      return []
    }
    const data = (await res.json()) as { rooms?: PublicRoomCard[] }
    const rooms = data.rooms ?? []
    if (!withConfig) return rooms
    // What a room sells (MegaChats, live seats) lives in its config, not in
    // the public list. The board's client poll adds it (listPublicRooms), but
    // only after its first 5s tick — so without it here the first paint says
    // "View rates", the chips filter on nothing, and the featured card grows
    // its price lines a beat later. Same fields the client merges.
    return await Promise.all(
      rooms.map(async (room) => {
        try {
          const r = await fetch(`${backendBase()}/api/config?room=${encodeURIComponent(room.id)}`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(1500),
          })
          if (!r.ok) return room
          const config = (await r.json()) as Partial<PublicRoomCard>
          return { ...room, letters: config.letters, joinStream: config.joinStream, isDemo: config.isDemo }
        } catch {
          return room
        }
      }),
    )
  } catch (err) {
    // An empty board and a broken backend render identically, so leave a
    // breadcrumb — otherwise an outage looks exactly like a quiet night.
    console.warn('[landing] could not load rooms:', (err as Error).message)
    return []
  }
}

// Recently aired, in the first HTML rather than after a client fetch: on a
// quiet night it is the board's main content, and a section that pops in a
// beat after load shoves everything under it down the page.
export async function loadRecentAirings(limit = 8): Promise<RecentAiring[]> {
  try {
    const res = await fetch(`${backendBase()}/api/rooms/recent?limit=${limit}`, { cache: 'no-store' })
    if (!res.ok) return []
    const data = (await res.json()) as { airings?: RecentAiring[] }
    return data.airings ?? []
  } catch {
    return [] // a rail that cannot load is a quiet rail, never an error
  }
}

// The bounty surface is env-gated (BOUNTY_CLAIM) — on an unflagged deploy
// /api/bounty/* does not exist at all. Absence is a normal state, not an
// error: callers render their "no pools" composition.
export async function loadBountyPools(): Promise<BountyPool[]> {
  try {
    // /program rather than /pools: same rows, but it carries the resolved
    // profile photos, so the landing board shows the faces the bounty page
    // shows instead of a column of monograms. Avatars are cached server-side.
    const res = await fetch(`${backendBase()}/api/bounty/program`, { cache: 'no-store' })
    // 404 is the expected shape of "BOUNTY_CLAIM is off" — not worth a warning.
    if (!res.ok) return []
    const data = (await res.json()) as { pools?: BountyPool[] }
    return withBountyExamples(data.pools ?? []).filter((p) => p.remaining > 0)
  } catch {
    return []
  }
}
