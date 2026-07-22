import { SiteHeader } from '@/components/site-header'
import { SiteFooter, contactUrl } from '@/components/site-footer'
import { RoomProvider } from '@/components/room-provider'
import { DashboardRooms } from '@/components/dashboard-rooms'
import { DashboardSections } from '@/components/dashboard-sections'

export const metadata = {
  title: 'MegaChat — Streamer dashboard',
  description: 'Tune pricing, share links, watch viewers roll onto camera.',
}

export default function DashboardPage() {
  const contactHref = contactUrl()
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />

      {/* Calm, usable dashboard */}
      <main
        id="dashboard"
        className="mx-auto max-w-6xl scroll-mt-20 px-6 py-14 md:py-20"
      >
        <div className="reveal mb-8 flex flex-col gap-1">
          <span className="text-xs font-bold uppercase tracking-widest text-[var(--neon-lime)]">
            Streamer dashboard
          </span>
          <h2 className="font-heading text-3xl font-bold text-foreground">
            Set up your MegaChat room
          </h2>
          <p className="max-w-lg text-sm leading-relaxed text-muted-foreground">
            Tune your pricing, share your links, and watch viewers roll onto
            camera in real time.
          </p>
        </div>

        <RoomProvider>
          {/* layout lives in DashboardRooms — it needs the room lifecycle
              (config vs runtime columns), which is client state */}
          <DashboardSections rooms={<DashboardRooms />} />
        </RoomProvider>
      </main>

      <SiteFooter contactHref={contactHref} />
    </div>
  )
}
