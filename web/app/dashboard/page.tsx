import { SiteHeader } from '@/components/site-header'
import { MegaChatSettings } from '@/components/megachat-settings'
import { OnCameraTable } from '@/components/on-camera-table'
import { RewardsCard } from '@/components/rewards-card'
import { RoomProvider } from '@/components/room-provider'
import { IntegrationsCard } from '@/components/integrations-card'

export const metadata = {
  title: 'MegaChat — Streamer dashboard',
  description: 'Tune pricing, share links, watch viewers roll onto camera.',
}

export default function DashboardPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />

      {/* Calm, usable dashboard */}
      <main
        id="dashboard"
        className="mx-auto max-w-6xl scroll-mt-20 px-6 py-14 md:py-20"
      >
        <div className="mb-8 flex flex-col gap-1">
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
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="lg:row-span-2">
              <MegaChatSettings />
            </div>
            <OnCameraTable />
            <RewardsCard />
            <IntegrationsCard />
          </div>
        </RoomProvider>
      </main>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-2 px-6 py-6 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:flex-row sm:items-center">
          <span>MegaChat — Skip the chat. Be the stream.</span>
          <span>Level up your stream. Own your audience.</span>
        </div>
      </footer>
    </div>
  )
}
