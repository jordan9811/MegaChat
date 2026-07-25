'use client'

// promoBanner slot — thin full-width campaign strip above the deck.
// All copy comes from seeds/banner.json via the adapter; money figures are
// placeholders with testnet framing baked into the copy itself.

import { Megaphone, ArrowRight } from 'lucide-react'
import { getBannerCampaign, type DeckModuleProps } from '../data'

export function PromoBanner(_props: DeckModuleProps) {
  const b = getBannerCampaign()
  return (
    <a
      href={b.ctaHref}
      className="group relative flex w-full items-center gap-4 overflow-hidden rounded-2xl border border-[var(--neon-magenta)]/40 bg-gradient-to-r from-[var(--neon-magenta)]/15 via-card/60 to-[var(--neon-violet)]/15 px-5 py-3.5 backdrop-blur-sm transition-colors hover:border-[var(--neon-magenta)]/70"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-full border border-[var(--neon-magenta)]/50 bg-background/50 text-[var(--neon-magenta)]">
        <Megaphone className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] font-bold uppercase tracking-widest text-[var(--neon-magenta)]">
          {b.kicker}
        </span>
        <span className="block truncate font-heading text-sm font-bold text-foreground sm:text-base">
          {b.headline}{' '}
          <span className="hidden font-body text-sm font-normal text-muted-foreground md:inline">
            {b.sub}
          </span>
        </span>
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 text-sm font-bold text-[var(--neon-magenta)] transition-transform group-hover:translate-x-0.5">
        <span className="hidden sm:inline">{b.ctaLabel}</span>
        <ArrowRight className="size-4" />
      </span>
    </a>
  )
}
