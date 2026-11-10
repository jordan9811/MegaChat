import type { Metadata } from 'next'
import { SiteHeader } from '@/components/site-header'
import { GlitchBackground } from '@/components/glitch-background'
import { SiteFooter, contactUrl } from '@/components/site-footer'
import { RoadmapTimeline } from '@/components/roadmap-timeline'
import './roadmap.css'

export const metadata: Metadata = {
  title: 'Roadmap — Holler',
  description:
    'What has shipped on Holler, what is being built now, and what comes next: real-money bounties, Hollers by the second, Follow my stream, and the road to launch.',
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

        {/* min-w-0 on the column so the track's own scroller, not the page,
            takes the overflow on a phone. No kicker over the heading
            (owner, 2026-11-10). */}
        <main className="rm-page relative z-10 mx-auto min-w-0 max-w-[1400px] px-4 pb-16 pt-14 sm:px-6 md:pt-20">
          <h1
            className="reveal font-[family-name:var(--font-display)] text-4xl font-[800] leading-tight tracking-[-0.02em] text-hl-fg md:text-6xl"
            style={{ ['--reveal-delay' as string]: '0.05s' }}
          >
            Roadmap
          </h1>

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
              className="rounded-[2px] bg-hl-strap px-5 py-2.5 text-sm font-bold text-hl-on-strap transition-transform duration-150 ease-[cubic-bezier(.23,1,.32,1)] hover:bg-hl-strap-hover active:scale-[0.97]"
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
