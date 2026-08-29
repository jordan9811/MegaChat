import type { Metadata } from 'next'
import { Barlow, Barlow_Condensed } from 'next/font/google'
import { Booth } from '@/components/booth/booth'
import { loadBountyPools, loadInitialRooms } from '@/lib/rooms-server'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Rooms — MegaChat',
  description: 'Every room on the board. Take a camera seat, billed by the second.',
}

const barlow = Barlow({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-barlow' })
const barlowCondensed = Barlow_Condensed({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-barlow-c',
})

export default async function Page() {
  const [rooms, pools] = await Promise.all([loadInitialRooms(), loadBountyPools()])
  return (
    <div className={`${barlow.variable} ${barlowCondensed.variable}`}>
      <Booth initialRooms={rooms} initialPools={pools} />
    </div>
  )
}
