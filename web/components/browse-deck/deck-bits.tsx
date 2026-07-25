'use client'

// Small shared pieces for browse-deck modules — panel chrome, accent lookup,
// demo tag. Modules stay self-contained; only cosmetics live here.

import type { ReactNode } from 'react'
import { deckConfig } from './browse-deck.config'
import type { DeckAccent } from './data'

/** Accent name → the CSS custom property defined in globals.css. */
export const ACCENT: Record<DeckAccent, string> = {
  magenta: 'var(--neon-magenta)',
  cyan: 'var(--neon-cyan)',
  lime: 'var(--neon-lime)',
  violet: 'var(--neon-violet)',
  amber: 'var(--neon-amber)',
}

/** Deterministic accent for a username — stable colors in the chat panel. */
export function accentFor(name: string): string {
  const order: DeckAccent[] = ['magenta', 'cyan', 'lime', 'violet', 'amber']
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return ACCENT[order[h % order.length]]
}

/** Seeded surfaces are labeled so demo activity is never mistaken for real. */
export function DemoTag() {
  if (!deckConfig.showDemoTag) return null
  return (
    <span className="rounded-full border border-border/70 bg-background/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
      demo
    </span>
  )
}

/** Standard glass panel used by the rail + right-panel modules. */
export function DeckPanel({
  title,
  icon,
  tag,
  id,
  children,
  bodyClassName = '',
}: {
  title: string
  icon?: ReactNode
  tag?: ReactNode
  id?: string
  children: ReactNode
  bodyClassName?: string
}) {
  return (
    <div
      id={id}
      className="flex flex-col overflow-hidden rounded-2xl border border-border/70 bg-card/60 backdrop-blur-sm"
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
        {icon}
        <h3 className="min-w-0 flex-1 truncate font-heading text-sm font-bold text-foreground">
          {title}
        </h3>
        {tag}
      </div>
      <div className={`min-w-0 ${bodyClassName}`}>{children}</div>
    </div>
  )
}

/** Branded animated stand-in where a video frame would go (no VOD assets in
 *  the repo — see DECISIONS.md). Accent-tinted drift + scanlines. */
export function AnimatedThumb({
  accent,
  label,
}: {
  accent: DeckAccent
  label: string
}) {
  const acc = ACCENT[accent]
  const words = label.split(/[\s._-]+/).filter(Boolean)
  // Two letters always — single-word names take their first two characters.
  const initials =
    words.length >= 2
      ? words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join('')
      : label.slice(0, 2).toUpperCase()
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 overflow-hidden"
      style={{ ['--acc' as string]: acc }}
    >
      <div className="absolute inset-0 bg-[radial-gradient(120%_120%_at_20%_10%,color-mix(in_oklab,var(--acc)_22%,transparent),transparent_55%),radial-gradient(120%_120%_at_85%_90%,color-mix(in_oklab,var(--neon-violet)_18%,transparent),transparent_60%)] bg-card" />
      <div className="deck-drift absolute -inset-1/2 bg-[linear-gradient(115deg,transparent_42%,color-mix(in_oklab,var(--acc)_14%,transparent)_50%,transparent_58%)]" />
      <div className="deck-scanlines absolute inset-0" />
      <span
        className="absolute inset-0 grid place-items-center font-heading text-6xl font-black tracking-tight"
        style={{ color: 'color-mix(in oklab, var(--acc) 45%, transparent)' }}
      >
        {initials}
      </span>
    </div>
  )
}
