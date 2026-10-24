import { Suspense } from 'react'
import { contactUrl } from '@/components/site-footer'
import { RoomProvider } from '@/components/room-provider'
import { DashboardShell } from '@/components/dashboard-shell'

export const metadata = {
  title: 'Holler — Streamer dashboard',
  description: 'Tune pricing, share links, watch viewers roll onto camera.',
}

export default function DashboardPage() {
  return (
    <div>
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
