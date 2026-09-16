import type { Metadata } from 'next'
import { Booth } from '@/components/booth/booth'
import { loadBountyPools, loadInitialRooms } from '@/lib/rooms-server'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Rooms — MegaChat',
  description: 'Every room on the board. Take a camera seat, billed by the second.',
}

// Fonts come from the root layout — Jakarta for UI, Archivo for headlines,
// Space Mono for readouts — so this page loads none of its own.
export default async function Page() {
  const [rooms, pools] = await Promise.all([loadInitialRooms(), loadBountyPools()])
  return <Booth initialRooms={rooms} initialPools={pools} />
}
