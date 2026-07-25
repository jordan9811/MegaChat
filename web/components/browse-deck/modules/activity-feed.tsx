'use client'

// rightPanel ALTERNATE — activityFeed. Built and swappable (set
// slots.rightPanel: 'activityFeed' in browse-deck.config.ts) but unmounted by
// default. A rolling ticker of platform events instead of a chat: seat
// claims, MegaChats played, rooms going hot. Seeded — same honesty rules as
// lobbyChat (demo tag, no fake timestamps).

import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Mic, Clapperboard, Flame, UserPlus, Gift } from 'lucide-react'
import { deckConfig } from '../browse-deck.config'
import type { DeckModuleProps } from '../data'
import { DeckPanel, DemoTag, accentFor } from '../deck-bits'

type FeedEvent = {
  id: string
  kind: 'seat' | 'megachat' | 'hot' | 'join' | 'drops'
  text: string
}

const POOL: FeedEvent[] = [
  { id: 'e01', kind: 'seat', text: 'Seat claimed in /slugmoney — meter running' },
  { id: 'e02', kind: 'join', text: '0x9c…4f2a joined at $0.001/s' },
  { id: 'e03', kind: 'megachat', text: 'MegaChat played in /ninaverse — $1.20' },
  { id: 'e04', kind: 'hot', text: '/turbograg just went hot — 3 seats live' },
  { id: 'e05', kind: 'drops', text: 'Watch rewards started in /demo' },
  { id: 'e06', kind: 'seat', text: 'Co-host pinned in /profpixel — meter paused' },
  { id: 'e07', kind: 'join', text: '0x31…88de joined at $0.002/s' },
  { id: 'e08', kind: 'megachat', text: 'MegaChat queued in /ghostmall — awaiting overlay' },
  { id: 'e09', kind: 'hot', text: '/ninaverse hit its seat cap — waitlist open' },
  { id: 'e10', kind: 'join', text: '0xa4…c917 joined at $0.001/s' },
  { id: 'e11', kind: 'megachat', text: 'MegaChat played in /demo — $0.60' },
  { id: 'e12', kind: 'seat', text: 'Seat released in /slugmoney — balance refunded' },
]

function EventIcon({ kind }: { kind: FeedEvent['kind'] }) {
  const cls = 'size-3.5 shrink-0'
  if (kind === 'seat') return <Mic className={`${cls} text-[var(--neon-magenta)]`} />
  if (kind === 'megachat') return <Clapperboard className={`${cls} text-[var(--neon-cyan)]`} />
  if (kind === 'hot') return <Flame className={`${cls} text-[var(--neon-amber)]`} />
  if (kind === 'drops') return <Gift className={`${cls} text-[var(--neon-lime)]`} />
  return <UserPlus className={`${cls} text-[var(--neon-lime)]`} />
}

export function ActivityFeed(_props: DeckModuleProps) {
  const pool = useMemo(() => POOL, [])
  const [events, setEvents] = useState<FeedEvent[]>(() => pool.slice(0, 6))
  const nextRef = useRef(6)
  const seqRef = useRef(0)

  useEffect(() => {
    let stop = false
    let t: ReturnType<typeof setTimeout>
    const [lo, hi] = deckConfig.chat.cadenceMs
    const tick = () => {
      if (stop) return
      setEvents((prev) => {
        const src = pool[nextRef.current % pool.length]
        nextRef.current += 1
        seqRef.current += 1
        const next = [{ ...src, id: `${src.id}-${seqRef.current}` }, ...prev]
        return next.length > 24 ? next.slice(0, 24) : next
      })
      t = setTimeout(tick, lo + Math.random() * (hi - lo))
    }
    t = setTimeout(tick, lo)
    return () => {
      stop = true
      clearTimeout(t)
    }
  }, [pool])

  return (
    <DeckPanel
      title="Activity"
      icon={<Activity className="size-4 text-[var(--neon-lime)]" />}
      tag={<DemoTag />}
      bodyClassName="h-[440px] overflow-y-auto py-1 lg:h-[min(calc(100vh-14rem),620px)]"
    >
      <ul>
        {events.map((e) => (
          <li
            key={e.id}
            className="deck-line-in flex items-start gap-2 border-b border-border/40 px-4 py-2.5 last:border-b-0"
          >
            <span className="mt-0.5">
              <EventIcon kind={e.kind} />
            </span>
            <p className="min-w-0 flex-1 break-words text-[13px] leading-snug text-foreground/85">
              {e.text.split(/(\/[a-z0-9-]+)/g).map((part, i) =>
                part.startsWith('/') ? (
                  <span key={i} className="font-mono font-bold" style={{ color: accentFor(part) }}>
                    {part}
                  </span>
                ) : (
                  <span key={i}>{part}</span>
                ),
              )}
            </p>
          </li>
        ))}
      </ul>
    </DeckPanel>
  )
}
