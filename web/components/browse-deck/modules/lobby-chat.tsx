'use client'

// rightPanel slot — lobbyChat. Seeded, clearly-labeled demo feed: the repo has
// NO chat infrastructure at all (WS = seats/letters/overlay only — see
// DECISIONS.md), so this defines the LobbyMessage model real chat should
// adopt. Colored names, badges, reply threading, pinned bot line, join
// events, autoscroll that respects a reader who scrolled up, and a read-only
// input that says so instead of pretending.

import { useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquare, Pin, Crown, Mic, Gift, Bot, UserPlus, Send } from 'lucide-react'
import { deckConfig } from '../browse-deck.config'
import { getLobbyMessages, type DeckModuleProps, type LobbyMessage } from '../data'
import { DeckPanel, DemoTag, accentFor } from '../deck-bits'

function Badge({ kind }: { kind: string }) {
  const cls = 'size-3 shrink-0'
  if (kind === 'og') return <Crown className={`${cls} text-[var(--neon-amber)]`} />
  if (kind === 'seat') return <Mic className={`${cls} text-[var(--neon-magenta)]`} />
  if (kind === 'drops') return <Gift className={`${cls} text-[var(--neon-lime)]`} />
  if (kind === 'bot') return <Bot className={`${cls} text-[var(--neon-cyan)]`} />
  return null
}

function ChatLine({ m }: { m: LobbyMessage }) {
  if (m.kind === 'join') {
    return (
      <p className="deck-line-in flex items-center gap-1.5 px-4 py-1 text-xs text-[var(--neon-lime)]/80">
        <UserPlus className="size-3 shrink-0" />
        <span className="min-w-0 truncate font-mono">{m.text}</span>
      </p>
    )
  }
  return (
    <div className="deck-line-in px-4 py-1">
      {m.replyTo ? (
        <p className="truncate text-[11px] text-muted-foreground/80">↩ replying to @{m.replyTo}</p>
      ) : null}
      <p className="break-words text-[13px] leading-snug text-foreground/90">
        <span className="mr-1 inline-flex translate-y-px items-center gap-1 align-baseline">
          {m.badges.map((b) => (
            <Badge key={b} kind={b} />
          ))}
        </span>
        <span className="font-bold" style={{ color: accentFor(m.user) }}>
          {m.user}
        </span>
        <span className="text-muted-foreground">: </span>
        {m.text}
      </p>
    </div>
  )
}

export function LobbyChat(_props: DeckModuleProps) {
  const { pinned, pool } = useMemo(() => getLobbyMessages(), [])
  const [messages, setMessages] = useState<LobbyMessage[]>(() =>
    pool.slice(0, 8).map((m) => ({ ...m })),
  )
  const nextRef = useRef(8)
  const seqRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const nearBottomRef = useRef(true)

  // Seeded cadence: push the next pool message on a jittered timer, looping
  // with fresh keys, trimming to the configured DOM cap.
  useEffect(() => {
    let stop = false
    let t: ReturnType<typeof setTimeout>
    const [lo, hi] = deckConfig.chat.cadenceMs
    const tick = () => {
      if (stop) return
      setMessages((prev) => {
        const src = pool[nextRef.current % pool.length]
        nextRef.current += 1
        seqRef.current += 1
        const next = [...prev, { ...src, id: `${src.id}-${seqRef.current}` }]
        return next.length > deckConfig.chat.keep ? next.slice(-deckConfig.chat.keep) : next
      })
      t = setTimeout(tick, lo + Math.random() * (hi - lo))
    }
    t = setTimeout(tick, lo)
    return () => {
      stop = true
      clearTimeout(t)
    }
  }, [pool])

  // Autoscroll — only while the reader is already at the bottom.
  useEffect(() => {
    const el = scrollRef.current
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages])

  return (
    <DeckPanel
      title={deckConfig.chat.title}
      icon={<MessageSquare className="size-4 text-[var(--neon-cyan)]" />}
      tag={<DemoTag />}
    >
      {/* pinned bot line */}
      <div className="border-b border-border/60 bg-[var(--neon-cyan)]/5 px-4 py-2.5">
        <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-[var(--neon-cyan)]">
          <Pin className="size-3" /> Pinned
        </p>
        <p className="mt-1 text-xs leading-snug text-muted-foreground">
          <Bot className="mr-1 inline size-3 translate-y-[-1px] text-[var(--neon-cyan)]" />
          <span className="font-bold text-[var(--neon-cyan)]">{pinned.user}</span>
          <span>: </span>
          {pinned.text}
        </p>
      </div>

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
        className="h-[380px] overflow-y-auto py-2 lg:h-[min(calc(100vh-21rem),560px)]"
      >
        {messages.map((m) => (
          <ChatLine key={m.id} m={m} />
        ))}
      </div>

      {/* read-only — no chat backend exists; the input explains itself */}
      <div className="border-t border-border/60 p-3">
        <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-input/30 px-3.5 py-2.5">
          <input
            disabled
            placeholder="Read-only lobby — chat lives in the rooms"
            aria-label="Lobby chat is read-only"
            className="min-w-0 flex-1 bg-transparent text-sm text-muted-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <Send className="size-4 shrink-0 text-muted-foreground/50" />
        </div>
      </div>
    </DeckPanel>
  )
}
