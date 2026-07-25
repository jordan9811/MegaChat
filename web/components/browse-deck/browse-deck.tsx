'use client'

// BROWSE DECK — the Kick-class browse shell. Pure layout: named slots
// (promoBanner / leftRail / featured / rightPanel / belowFold[]) filled from
// browse-deck.config.ts via the registry. It owns the #browse anchor the hero
// scroll cue and the nav "Browse rooms" item land on.
//
// Responsive: three columns at lg+; below that the featured area goes full
// width and the rail/right-panel live behind toggle buttons as slide-over
// sheets.
//
// Mounted from web/app/page.tsx unless BROWSE_DECK=0 — that env flag (or
// reverting the one <main> line there) restores the classic browse exactly.

import './deck.css'
import { useEffect, useState, type ReactNode } from 'react'
import { Trophy, MessageSquare, X } from 'lucide-react'
import { deckConfig, type DeckModuleId } from './browse-deck.config'
import { deckRegistry, MODULE_LABEL } from './registry'
import type { DeckCtx, PublicRoomCard } from './data'

function Slot({ id, ctx }: { id: DeckModuleId | null; ctx: DeckCtx }) {
  if (!id) return null
  const Mod = deckRegistry[id]
  return <Mod ctx={ctx} />
}

function MobileSheet({
  side,
  label,
  onClose,
  children,
}: {
  side: 'left' | 'right'
  label: string
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label={label}>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
      />
      <div
        className={`absolute inset-y-0 w-[min(360px,92vw)] overflow-y-auto border-border bg-background p-3 shadow-2xl ${
          side === 'left' ? 'left-0 border-r' : 'right-0 border-l'
        }`}
      >
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            {label}
          </span>
          <button
            type="button"
            aria-label={`Close ${label}`}
            onClick={onClose}
            className="grid size-8 place-items-center rounded-full border border-border/70 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function BrowseDeck({ initialRooms = [] }: { initialRooms?: PublicRoomCard[] }) {
  const ctx: DeckCtx = { initialRooms }
  const { slots } = deckConfig
  const [railOpen, setRailOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)

  return (
    <section id="browse" className="scroll-mt-20 border-t border-border/40">
      <div className="mx-auto max-w-[1500px] px-4 pb-2 pt-5 md:px-6">
        <Slot id={slots.promoBanner} ctx={ctx} />

        {/* tablet/mobile: rail + panel behind toggles */}
        {slots.leftRail || slots.rightPanel ? (
          <div className="mt-4 flex gap-2 lg:hidden">
            {slots.leftRail ? (
              <button
                type="button"
                onClick={() => setRailOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card/60 px-3.5 py-1.5 text-xs font-bold text-foreground transition-colors hover:border-[var(--neon-lime)]/60"
              >
                <Trophy className="size-3.5 text-[var(--neon-lime)]" />
                {MODULE_LABEL[slots.leftRail]}
              </button>
            ) : null}
            {slots.rightPanel ? (
              <button
                type="button"
                onClick={() => setChatOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card/60 px-3.5 py-1.5 text-xs font-bold text-foreground transition-colors hover:border-[var(--neon-cyan)]/60"
              >
                <MessageSquare className="size-3.5 text-[var(--neon-cyan)]" />
                {MODULE_LABEL[slots.rightPanel]}
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="mt-4 grid items-start gap-4 lg:grid-cols-[240px_minmax(0,1fr)_340px]">
          <aside className="sticky top-20 hidden min-w-0 lg:block">
            <Slot id={slots.leftRail} ctx={ctx} />
          </aside>
          <div className="min-w-0">
            <Slot id={slots.featured} ctx={ctx} />
          </div>
          <aside className="sticky top-20 hidden min-w-0 lg:block">
            <Slot id={slots.rightPanel} ctx={ctx} />
          </aside>
        </div>
      </div>

      {/* below the fold — full-width modules in config order */}
      {slots.belowFold.map((id) => (
        <Slot key={id} id={id} ctx={ctx} />
      ))}

      {railOpen && slots.leftRail ? (
        <MobileSheet side="left" label={MODULE_LABEL[slots.leftRail]} onClose={() => setRailOpen(false)}>
          <Slot id={slots.leftRail} ctx={ctx} />
        </MobileSheet>
      ) : null}
      {chatOpen && slots.rightPanel ? (
        <MobileSheet side="right" label={MODULE_LABEL[slots.rightPanel]} onClose={() => setChatOpen(false)}>
          <Slot id={slots.rightPanel} ctx={ctx} />
        </MobileSheet>
      ) : null}
    </section>
  )
}
