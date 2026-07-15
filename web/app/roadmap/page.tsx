import type { Metadata } from 'next'
import { SiteHeader } from '@/components/site-header'
import { GlitchBackground } from '@/components/glitch-background'
import { SiteFooter, contactUrl } from '@/components/site-footer'
import { RoadmapTimeline } from '@/components/roadmap-timeline'

export const metadata: Metadata = {
  title: 'Roadmap — MegaChat',
  description:
    'What ships next on MegaChat — LiveKit hardening, Twitch Drops OAuth, live AI moderation, the stinger marketplace — and the journey that got us here.',
}

// CONTACT_URL and JOURNEY_TWEET_URL are read at request time so they can
// change without a code edit (same treatment the landing page gives Contact).
export const dynamic = 'force-dynamic'

export default function RoadmapPage() {
  const contactHref = contactUrl()
  const journeyTweetUrl = process.env.JOURNEY_TWEET_URL || ''
  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <SiteHeader />
      <div className="relative">
        <GlitchBackground />

        <main className="relative z-10 mx-auto max-w-4xl px-6 pb-16 pt-16 md:pt-20">
          <p
            className="reveal text-xs font-bold uppercase tracking-widest text-[var(--neon-lime)]"
            style={{ ['--reveal-delay' as string]: '0.05s' }}
          >
            Where this is going
          </p>
          <h1
            className="reveal chromatic mt-2 font-heading text-4xl font-bold leading-tight text-foreground md:text-6xl"
            style={{ ['--reveal-delay' as string]: '0.12s' }}
          >
            Roadmap
          </h1>
          <p
            className="reveal mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-foreground/85"
            style={{ ['--reveal-delay' as string]: '0.2s' }}
          >
            The spine stays the same — pay-to-join metered camera seats. What
            follows is priority order, top to bottom: green ships next, amber
            after that, purple is the big swing.
          </p>

          <RoadmapTimeline journeyTweetUrl={journeyTweetUrl} />

          {/* CTA */}
          <div className="mt-14 flex flex-wrap items-center gap-4 border-t border-border/50 pt-8">
            <p className="font-heading text-lg font-bold text-foreground">
              Want something bumped up the list?
            </p>
            <a
              href={contactHref}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full border border-[var(--neon-cyan)]/60 bg-[var(--neon-cyan)]/10 px-5 py-2.5 text-sm font-bold uppercase tracking-wide text-[var(--neon-cyan)] transition-transform hover:scale-[1.03]"
            >
              Tell us on X
            </a>
          </div>
        </main>
      </div>
      <SiteFooter contactHref={contactHref} />
    </div>
  )
}
