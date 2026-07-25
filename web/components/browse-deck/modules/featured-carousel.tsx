'use client'

// featured slot — legacyStreamerCarousel. Kick-class 16:9 hero player with a
// floating info card, dots + arrows, viewer badge, mute toggle, and a short
// simulated load between entries. No VOD assets exist in this repo (see
// DECISIONS.md), so the "player" is a branded animated thumb; dropping a real
// room id into browse-deck.config.ts roomOverrides re-points an entry's CTA
// at the live join page.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  Loader2,
  Volume2,
  VolumeX,
  ArrowRight,
} from 'lucide-react'
import { deckConfig } from '../browse-deck.config'
import { getFeaturedRooms, type DeckModuleProps } from '../data'
import { ACCENT, AnimatedThumb, DemoTag } from '../deck-bits'

export function FeaturedCarousel(_props: DeckModuleProps) {
  const entries = useMemo(() => getFeaturedRooms(), [])
  const [idx, setIdx] = useState(0)
  const [muted, setMuted] = useState(true)
  const [loading, setLoading] = useState(true)
  const [paused, setPaused] = useState(false)
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const entry = entries[idx]
  const acc = ACCENT[entry.accent]
  const realRoom = deckConfig.featured.roomOverrides[entry.id] ?? entry.roomId
  // Seeded entries land on the always-alive /demo room so the CTA is never a
  // dead end; a real room id (config) beats that.
  const ctaHref = realRoom ? `/join?room=${encodeURIComponent(realRoom)}` : '/demo'

  const go = useCallback(
    (next: number) => {
      setIdx(((next % entries.length) + entries.length) % entries.length)
    },
    [entries.length],
  )

  // Simulated player load on every entry switch.
  useEffect(() => {
    setLoading(true)
    if (loadTimer.current) clearTimeout(loadTimer.current)
    loadTimer.current = setTimeout(() => setLoading(false), deckConfig.featured.loadMs)
    return () => {
      if (loadTimer.current) clearTimeout(loadTimer.current)
    }
  }, [idx])

  // Auto-advance, paused while hovered. Keyed on idx so a manual jump resets
  // the clock instead of racing it.
  useEffect(() => {
    if (paused) return
    const t = setTimeout(() => go(idx + 1), deckConfig.featured.autoAdvanceMs)
    return () => clearTimeout(t)
  }, [idx, paused, go])

  return (
    <div
      aria-label="Featured rooms"
      className="relative aspect-video overflow-hidden rounded-2xl border border-border/70 bg-card/60"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* simulated player frame (crossfades per entry) */}
      <div key={entry.id} className="deck-fade absolute inset-0">
        <AnimatedThumb accent={entry.accent} label={entry.name} />
      </div>

      {loading ? (
        <div className="absolute inset-0 z-10 grid place-items-center bg-background/40 backdrop-blur-[2px]">
          <Loader2 className="size-8 animate-spin text-[var(--neon-cyan)]" />
        </div>
      ) : null}

      {/* top-left: live + viewers */}
      <div className="absolute left-3 top-3 z-20 flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-[var(--neon-magenta)] backdrop-blur-sm">
          <span className="size-1.5 animate-pulse rounded-full bg-[var(--neon-magenta)]" />
          Live
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-bold text-white backdrop-blur-sm">
          <Eye className="size-3.5" />
          <span className="tabular">{entry.viewers.toLocaleString('en-US')}</span>
        </span>
      </div>

      {/* top-right: demo tag + mute */}
      <div className="absolute right-3 top-3 z-20 flex items-center gap-2">
        {entry.demo ? <DemoTag /> : null}
        <button
          type="button"
          aria-pressed={!muted}
          aria-label={muted ? 'Unmute featured player' : 'Mute featured player'}
          onClick={() => setMuted((m) => !m)}
          className="grid size-8 place-items-center rounded-full bg-black/70 text-white backdrop-blur-sm transition-colors hover:bg-black/90"
        >
          {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
        </button>
      </div>

      {/* floating info card */}
      <div className="absolute inset-x-3 bottom-3 z-20 rounded-xl border border-border/70 bg-background/80 p-3 backdrop-blur-md sm:inset-x-4 sm:bottom-4 sm:p-4">
        <div className="flex items-center gap-3">
          <span
            className="grid size-10 shrink-0 place-items-center rounded-full border-2 font-heading text-sm font-black"
            style={{ borderColor: acc, color: acc }}
          >
            {entry.name.slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-heading text-sm font-bold text-foreground sm:text-base">
              {entry.name}
              <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                /{entry.handle}
              </span>
            </p>
            <p className="truncate text-xs text-muted-foreground sm:text-sm">{entry.title}</p>
          </div>
          <a
            href={ctaHref}
            className="inline-flex shrink-0 items-center gap-1 rounded-full px-3.5 py-2 text-xs font-bold text-black transition-transform hover:scale-[1.04] sm:text-sm"
            style={{ backgroundColor: acc }}
          >
            Drop in <ArrowRight className="size-3.5" />
          </a>
        </div>

        <div className="mt-2.5 flex items-center gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            <span
              className="rounded-full border px-2 py-0.5 text-[10px] font-bold"
              style={{ borderColor: `color-mix(in oklab, ${acc} 55%, transparent)`, color: acc }}
            >
              {entry.category}
            </span>
            {entry.tags.slice(0, 2).map((t) => (
              <span
                key={t}
                className="hidden rounded-full border border-border/70 px-2 py-0.5 text-[10px] text-muted-foreground sm:inline"
              >
                {t}
              </span>
            ))}
          </div>

          {/* dots + arrows */}
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              aria-label="Previous featured room"
              onClick={() => go(idx - 1)}
              className="grid size-7 place-items-center rounded-full border border-border/70 text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
            >
              <ChevronLeft className="size-4" />
            </button>
            <div className="flex items-center gap-1 px-1">
              {entries.map((e, i) => (
                <button
                  key={e.id}
                  type="button"
                  aria-label={`Show ${e.name}`}
                  aria-current={i === idx}
                  onClick={() => go(i)}
                  className="h-1.5 rounded-full transition-all"
                  style={{
                    width: i === idx ? 18 : 6,
                    backgroundColor:
                      i === idx ? acc : 'color-mix(in oklab, var(--foreground) 25%, transparent)',
                  }}
                />
              ))}
            </div>
            <button
              type="button"
              aria-label="Next featured room"
              onClick={() => go(idx + 1)}
              className="grid size-7 place-items-center rounded-full border border-border/70 text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
