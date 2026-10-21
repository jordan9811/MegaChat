import type { Metadata } from 'next'
import { SiteHeader } from '@/components/site-header'
import { GlitchBackground } from '@/components/glitch-background'
import { SiteFooter, contactUrl } from '@/components/site-footer'
import { RoadmapTimeline } from '@/components/roadmap-timeline'

export const metadata: Metadata = {
  title: 'Roadmap — Holler',
  description:
    'What ships next on Holler — LiveKit hardening, Twitch Drops OAuth, live AI moderation, the stinger marketplace — and the journey that got us here.',
}

// CONTACT_URL and JOURNEY_TWEET_URL are read at request time so they can
// change without a code edit (same treatment the landing page gives Contact).
export const dynamic = 'force-dynamic'

export default function RoadmapPage() {
  const contactHref = contactUrl()
  const journeyTweetUrl = process.env.JOURNEY_TWEET_URL || ''
  return (
    <div className="relative min-h-screen bg-hl-bg text-hl-fg">
      <SiteHeader />
      <div className="relative">
        <GlitchBackground />

        <main className="relative z-10 mx-auto max-w-4xl px-6 pb-16 pt-16 md:pt-20">
          {/* Eyebrow in Space Mono, headline in Archivo: the site's readout
              and display faces. */}
          <p
            className="reveal font-[family-name:var(--font-code)] text-[11px] font-normal uppercase tracking-[.14em] text-[color-mix(in_srgb,var(--hl-strap-hi)_72%,var(--hl-fg))]"
            style={{ ['--reveal-delay' as string]: '0.05s' }}
          >
            Where this is going
          </p>
          <h1
            className="reveal mt-2 font-[family-name:var(--font-display)] text-4xl font-[800] leading-tight tracking-[-0.02em] text-hl-fg md:text-6xl"
            style={{ ['--reveal-delay' as string]: '0.12s' }}
          >
            Roadmap
          </h1>
          <p
            className="reveal mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-hl-muted"
            style={{ ['--reveal-delay' as string]: '0.2s' }}
          >
            The spine stays the same — pay-to-join metered camera seats. What
            follows is priority order, top to bottom: green ships next, amber
            after that, purple is the big swing.
          </p>

          <RoadmapTimeline journeyTweetUrl={journeyTweetUrl} />

          {/* CTA */}
          <div className="mt-14 flex flex-wrap items-center gap-4 border-t border-hl-line pt-8">
            <p className="font-heading text-lg font-bold text-hl-fg">
              Want something bumped up the list?
            </p>
            <a
              href={contactHref}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-[2px] bg-hl-strap px-5 py-2.5 text-sm font-bold text-white transition-transform duration-150 ease-[cubic-bezier(.23,1,.32,1)] hover:bg-hl-strap-hover active:scale-[0.97]"
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
