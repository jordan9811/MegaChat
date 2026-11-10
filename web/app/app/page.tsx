import type { Metadata } from 'next'
import { Booth } from '@/components/booth/booth'
import { SiteTour } from '@/components/site-tour'
import { contactUrl } from '@/components/site-footer'
import { loadBountyPools, loadClaimedAirings, loadInitialRooms, loadRecentAirings } from '@/lib/rooms-server'
import { BOARD_RECENT_CAP } from '@/lib/room-browse'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Rooms — Holler',
  description: 'Every room on the board. Take a camera seat, billed by the second.',
}

// Fonts come from the root layout — Jakarta for UI, Archivo for headlines,
// Space Mono for readouts — so this page loads none of its own.
export default async function Page() {
  const [rooms, pools, airings, claimed] = await Promise.all([
    loadInitialRooms({ withConfig: true }),
    loadBountyPools(),
    loadRecentAirings(BOARD_RECENT_CAP),
    loadClaimedAirings(),
  ])
  return (
    <>
      <Booth
        initialRooms={rooms}
        initialPools={pools}
        initialAirings={airings}
        initialClaimed={claimed}
        contactHref={contactUrl()}
      />
      <SiteTour chapter="rooms" />
    </>
  )
}
