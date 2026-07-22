import { SiteHeader } from '@/components/site-header'
import { SiteFooter, contactUrl } from '@/components/site-footer'
import { MegaChatSettings } from '@/components/megachat-settings'
import { OnCameraTable } from '@/components/on-camera-table'
import { RewardsCard } from '@/components/rewards-card'
import { LettersQueueCard } from '@/components/letters-queue-card'
import { HostCamCard } from '@/components/host-cam-card'
import { RoomProvider } from '@/components/room-provider'
import { IntegrationsCard } from '@/components/integrations-card'
import { ShareLinksCard } from '@/components/share-links-card'
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
          <DashboardSections
            rooms={
              /* TWO INDEPENDENT COLUMNS (items-start + per-column flow), not
                 a shared grid: the mile-long settings card was stretching
                 grid rows and leaving the side column ~70% empty void. Side
                 column ranks by streamer need: links → live seats → own
                 camera → clip queue → rewards → integrations. */
              <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[1.1fr_0.9fr]">
                <div className="reveal" style={{ ['--reveal-delay' as string]: '0.08s' }}>
                  <MegaChatSettings />
                </div>
                {/* empty:hidden — cards that render null (booth on vdo rooms,
                    links/queue in create mode) must not leave ghost wrappers
                    eating flex-gap slots: that was a visible dead band
                    between the surviving cards. */}
                <div className="flex flex-col gap-6">
                  <div className="reveal empty:hidden" style={{ ['--reveal-delay' as string]: '0.12s' }}>
                    <ShareLinksCard />
                  </div>
                  <div className="reveal empty:hidden" style={{ ['--reveal-delay' as string]: '0.16s' }}>
                    <OnCameraTable />
                  </div>
                  <div className="reveal empty:hidden" style={{ ['--reveal-delay' as string]: '0.24s' }}>
                    <HostCamCard />
                  </div>
                  <div className="reveal empty:hidden" style={{ ['--reveal-delay' as string]: '0.32s' }}>
                    <LettersQueueCard />
                  </div>
                  <div className="reveal empty:hidden" style={{ ['--reveal-delay' as string]: '0.4s' }}>
                    <RewardsCard />
                  </div>
                  <div className="reveal empty:hidden" style={{ ['--reveal-delay' as string]: '0.48s' }}>
                    <IntegrationsCard />
                  </div>
                </div>
              </div>
            }
          />
        </RoomProvider>
      </main>

      <SiteFooter contactHref={contactHref} />
    </div>
  )
}
