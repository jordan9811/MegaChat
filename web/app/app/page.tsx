import type { Metadata } from 'next'
import { Plus_Jakarta_Sans } from 'next/font/google'
import { Booth } from '@/components/booth/booth'
import { loadBountyPools, loadInitialRooms } from '@/lib/rooms-server'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Rooms — MegaChat',
  description: 'Every room on the board. Take a camera seat, billed by the second.',
}

// One UI face across the app. Archivo stays on the landing hero only —
// that is a poster using a display face, not a second system.
const ui = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-ui',
})

export default async function Page() {
  const [rooms, pools] = await Promise.all([loadInitialRooms(), loadBountyPools()])
  return (
    <div className={`${ui.variable}`}>
      <Booth initialRooms={rooms} initialPools={pools} />
    </div>
  )
}
