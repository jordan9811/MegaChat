'use client'

// leftRail ALTERNATE — recommendedRooms. Built and swappable (set
// slots.leftRail: 'recommendedRooms' in browse-deck.config.ts) but unmounted
// by default. Kick-style compact live list wired to REAL room data — same
// endpoint the shipped grid polls, slower cadence (the grid below already
// polls hot).

import { useEffect, useState } from 'react'
import { Radio, Compass } from 'lucide-react'
import { getRooms, type DeckModuleProps, type PublicRoomCard } from '../data'
import { DeckPanel, accentFor } from '../deck-bits'

const POLL_MS = 30_000

export function RecommendedRooms({ ctx }: DeckModuleProps) {
  const [rooms, setRooms] = useState<PublicRoomCard[]>(ctx.initialRooms)

  useEffect(() => {
    let stop = false
    const load = () =>
      getRooms()
        .then((d) => {
          if (!stop) setRooms(d.rooms)
        })
        .catch(() => {})
    const t = setInterval(load, POLL_MS)
    void load()
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [])

  return (
    <DeckPanel
      title="Recommended rooms"
      icon={<Compass className="size-4 text-[var(--neon-cyan)]" />}
      bodyClassName="max-h-[calc(100vh-12rem)] overflow-y-auto py-1"
    >
      {rooms.length === 0 ? (
        <div className="px-4 py-6 text-center">
          <p className="text-sm text-muted-foreground">No rooms live right now.</p>
          <a href="/dashboard" className="mt-1 inline-block text-sm font-bold text-[var(--neon-magenta)]">
            Start one →
          </a>
        </div>
      ) : (
        <ul>
          {rooms.map((r) => (
            <li key={r.id}>
              <a
                href={r.handle ? `/${r.handle}` : `/join?room=${encodeURIComponent(r.id)}`}
                className="flex items-center gap-2.5 px-4 py-2.5 transition-colors hover:bg-foreground/5"
              >
                <span
                  className="grid size-8 shrink-0 place-items-center rounded-full border font-heading text-[11px] font-black"
                  style={{ borderColor: accentFor(r.name), color: accentFor(r.name) }}
                >
                  {r.name.slice(0, 2).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-foreground">{r.name}</span>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Radio
                      className={`size-3 ${r.live > 0 ? 'text-[var(--neon-magenta)]' : 'text-muted-foreground/60'}`}
                    />
                    {r.live}/{r.maxSeats} on camera
                  </span>
                </span>
                <span className="shrink-0 text-xs font-semibold text-foreground/80">
                  <span className="simple-only">${r.passkeyTickPrice}</span>
                  <span className="adv-only">
                    {r.passkeyTickPrice} {r.paymentTokenSymbol}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </DeckPanel>
  )
}
