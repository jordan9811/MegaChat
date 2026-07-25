'use client'

// belowFold — categories STUB. Clearly a stub: non-interactive tiles, a
// "coming soon" chip, no fake counts. Exists so the deck's information
// architecture is visible end-to-end; rooms don't carry categories yet.

import { LayoutGrid } from 'lucide-react'
import type { DeckModuleProps } from '../data'
import { ACCENT } from '../deck-bits'
import type { DeckAccent } from '../data'

const CATEGORIES: { name: string; accent: DeckAccent; glyph: string }[] = [
  { name: 'IRL', accent: 'magenta', glyph: '🌆' },
  { name: 'Just Chatting', accent: 'cyan', glyph: '💬' },
  { name: 'Music', accent: 'violet', glyph: '🎧' },
  { name: 'Gaming', accent: 'lime', glyph: '🎮' },
  { name: 'Talk Shows', accent: 'amber', glyph: '🎙️' },
  { name: 'Late Night', accent: 'magenta', glyph: '🌙' },
]

export function CategoriesStub(_props: DeckModuleProps) {
  return (
    <div className="mx-auto max-w-6xl px-6 pb-16">
      <div className="mb-5 flex items-center gap-2.5">
        <LayoutGrid className="size-4 text-[var(--neon-violet)]" />
        <h2 className="font-heading text-xl font-bold text-foreground">Categories</h2>
        <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
          coming soon
        </span>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {CATEGORIES.map((c) => (
          <div
            key={c.name}
            aria-disabled="true"
            className="flex aspect-[3/4] flex-col justify-between rounded-2xl border border-border/60 p-4 opacity-80"
            style={{
              background: `linear-gradient(160deg, color-mix(in oklab, ${ACCENT[c.accent]} 16%, transparent), transparent 70%)`,
            }}
          >
            <span className="text-2xl" aria-hidden="true">
              {c.glyph}
            </span>
            <div>
              <p className="font-heading text-sm font-bold leading-tight text-foreground">{c.name}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">rooms soon</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
