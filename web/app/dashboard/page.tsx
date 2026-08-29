import { Suspense } from 'react'
import { Plus_Jakarta_Sans } from 'next/font/google'
import { contactUrl } from '@/components/site-footer'
import { RoomProvider } from '@/components/room-provider'
import { DashboardShell } from '@/components/dashboard-shell'

export const metadata = {
  title: 'MegaChat — Streamer dashboard',
  description: 'Tune pricing, share links, watch viewers roll onto camera.',
}

// The create surface wears the app skin, same face as the room board.
const ui = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-ui',
})

export default function DashboardPage() {
  return (
    <div className={`${ui.variable}`}>
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
