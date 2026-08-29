import { Suspense } from 'react'
import { Barlow, Barlow_Condensed } from 'next/font/google'
import { contactUrl } from '@/components/site-footer'
import { RoomProvider } from '@/components/room-provider'
import { DashboardShell } from '@/components/dashboard-shell'

export const metadata = {
  title: 'MegaChat — Streamer dashboard',
  description: 'Tune pricing, share links, watch viewers roll onto camera.',
}

// The create surface wears the app skin (same as the room board), so the
// dashboard carries those faces for it.
const barlow = Barlow({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-barlow' })
const barlowCondensed = Barlow_Condensed({
  subsets: ['latin'],
  weight: ['600', '700'],
  variable: '--font-barlow-c',
})

export default function DashboardPage() {
  return (
    <div className={`${barlow.variable} ${barlowCondensed.variable}`}>
      {/* The shell picks its own chrome: creating is a full page of its own,
          managing keeps the header/tabs/footer control room. */}
      {/* Suspense: the shell reads ?new=1 to force the create page, and
          useSearchParams needs a boundary on a statically rendered route. */}
      <Suspense fallback={null}>
        <RoomProvider>
          <DashboardShell contactHref={contactUrl()} />
        </RoomProvider>
      </Suspense>
    </div>
  )
}
