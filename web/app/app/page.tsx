import type { Metadata } from 'next'
import { Booth } from '@/components/booth/booth'
import { loadBountyPools, loadInitialRooms, loadRecentAirings } from '@/lib/rooms-server'
import { BOARD_RECENT_CAP } from '@/lib/room-browse'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Rooms — MegaChat',
  description: 'Every room on the board. Take a camera seat, billed by the second.',
}

// Fonts come from the root layout — Jakarta for UI, Archivo for headlines,
// Space Mono for readouts — so this page loads none of its own.
export default async function Page() {
  const [rooms, pools, airings] = await Promise.all([loadInitialRooms(), loadBountyPools(), loadRecentAirings(BOARD_RECENT_CAP)])
  return <Booth initialRooms={rooms} initialPools={pools} initialAirings={airings} />
}
