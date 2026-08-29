import Link from 'next/link'
import type { Metadata } from 'next'
import { LegacyHome } from '@/components/legacy-home'
import { contactUrl } from '@/components/site-footer'
import { loadInitialRooms } from '@/lib/rooms-server'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Legacy site — MegaChat',
  description: 'The previous MegaChat front end, kept for comparison.',
  robots: { index: false },
}

export default async function Page() {
  const initialRooms = await loadInitialRooms()
  return (
    <>
      <div className="flex items-center justify-center gap-3 bg-[#101014] px-4 py-2 text-xs text-[#a3a3ad]">
        <span>This is the previous MegaChat front end, kept for comparison.</span>
        <Link href="/?stay=1" className="font-semibold text-[#8fd8e4] hover:text-white">
          Back to the new site
        </Link>
      </div>
      <LegacyHome initialRooms={initialRooms} contactHref={contactUrl()} />
    </>
  )
}
