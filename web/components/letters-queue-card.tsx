'use client'

// MegaChat review — the producer's desk.
//
// In APPROVE mode this is two piles: what is waiting for a decision, and what
// has been approved and is held ready. Approving does not put a clip on
// screen; a mod airs each one when the show wants it. In AUTO mode there is
// nothing to decide, so it is just the live queue, shown for visibility.
//
// Rejecting refunds the payer. A held clip is refunded automatically if
// nobody airs it before it expires, which is why every held row shows how
// long is left.

import { useCallback, useEffect, useState } from 'react'
import { Mail, Check, X, RefreshCw, Play, MonitorOff, Clock } from 'lucide-react'
import { GlassCard, CardHeader } from '@/components/glass-card'
import { useRoom } from '@/components/room-provider'
import type { LetterAdminItem } from '@/lib/api'

/** "4h 12m" / "23m" / "under a minute" — how long before the payer is refunded. */
function timeLeft(expiresAt: number | null | undefined): string | null {
  if (!expiresAt) return null
  const ms = expiresAt - Date.now()
  if (ms <= 0) return 'expiring now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'under a minute'
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

export function LettersQueueCard() {
  const { mode, room, lettersAdmin } = useRoom()
  const [letters, setLetters] = useState<LetterAdminItem[]>([])
  const [overlayLive, setOverlayLive] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const active = mode === 'managing' && !!room?.letters?.enabled
  const producer = room?.letters?.moderation === 'approve'

  const refresh = useCallback(async () => {
    if (!active) return
    try {
      const data = await lettersAdmin.list()
      setLetters(data.letters)
      setOverlayLive(data.overlayLive)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load MegaChats')
    }
  }, [active, lettersAdmin])

  useEffect(() => {
    if (!active) return
    void refresh()
    const poll = setInterval(() => void refresh(), 5000)
    return () => clearInterval(poll)
  }, [active, refresh])

  if (!active) return null

  const act = async (letterId: string, action: 'approve' | 'reject' | 'play') => {
    setBusyId(letterId)
    try {
      if (action === 'approve') await lettersAdmin.approve(letterId)
      else if (action === 'play') await lettersAdmin.playNow(letterId)
      else await lettersAdmin.reject(letterId)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : `${action} failed`)
    } finally {
      setBusyId(null)
    }
  }

  const waiting = letters.filter((l) => l.status === 'pending_approval' || l.status === 'reviewing')
  const ready = letters.filter((l) => l.status === 'ready')
  const running = letters.filter((l) => l.status === 'queued' || l.status === 'playing')

  const row = (l: LetterAdminItem) => {
    const left = timeLeft(l.expiresAt)
    return (
      <div
        key={l.id}
        className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-input/20 px-4 py-3"
      >
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold text-foreground">
            <span className="truncate">📼 {l.username}</span>
            <span className="text-xs font-normal text-muted-foreground">
              {l.durationS}s · {parseFloat(l.price) > 0 ? l.price : 'Free'} · {l.status.replace('_', ' ')}
            </span>
          </p>
          {l.flaggedReason ? (
            <p className="mt-1 inline-block rounded-md border border-[var(--neon-magenta)]/40 bg-[var(--neon-magenta)]/10 px-2 py-0.5 text-xs font-semibold text-[var(--neon-magenta)]">
              🕵️ AI flag: {l.flaggedReason}
            </p>
          ) : null}
          {left ? (
            <p className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="size-3" />
              Refunds in {left} if nobody {l.status === 'ready' ? 'airs' : 'reviews'} it
            </p>
          ) : null}
          {l.mediaUrl ? (
            <video
              src={l.mediaUrl}
              controls
              preload="metadata"
              className="mt-2 max-h-28 rounded-lg border border-border"
            />
          ) : null}
        </div>
        {l.status === 'pending_approval' ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busyId === l.id}
              onClick={() => void act(l.id, 'approve')}
              title={producer ? 'Move to Ready to air — it will not play until you air it' : 'Approve; the scheduler plays it when a tile frees'}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--neon-lime)]/50 bg-[var(--neon-lime)]/10 px-3 py-1.5 text-xs font-bold text-[var(--neon-lime)] transition-colors hover:bg-[var(--neon-lime)]/20 disabled:opacity-50"
            >
              {busyId === l.id ? <RefreshCw className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              {producer ? 'Approve' : 'Approve'}
            </button>
            <button
              type="button"
              disabled={busyId === l.id}
              onClick={() => void act(l.id, 'reject')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-input/30 px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              <X className="size-3.5" />
              Reject
            </button>
          </div>
        ) : null}
        {l.status === 'ready' || l.status === 'queued' ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busyId === l.id}
              onClick={() => void act(l.id, 'play')}
              title="Put this on screen right now, even if overlay detection disagrees"
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--neon-cyan)]/50 bg-[var(--neon-cyan)]/10 px-3 py-1.5 text-xs font-bold text-[var(--neon-cyan)] transition-colors hover:bg-[var(--neon-cyan)]/20 disabled:opacity-50"
            >
              {busyId === l.id ? <RefreshCw className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              {l.status === 'ready' ? 'Air it' : 'Play now'}
            </button>
            {l.status === 'ready' ? (
              <button
                type="button"
                disabled={busyId === l.id}
                onClick={() => void act(l.id, 'reject')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-input/30 px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                <X className="size-3.5" />
                Drop
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  }

  const pile = (title: string, note: string, items: LetterAdminItem[]) =>
    items.length === 0 ? null : (
      <div className="flex flex-col gap-2">
        <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          {title} <span className="font-normal normal-case tracking-normal">· {note}</span>
        </p>
        {items.map(row)}
      </div>
    )

  return (
    <GlassCard>
      <CardHeader
        icon={<Mail className="size-5" />}
        title="MegaChats"
        description={
          producer
            ? 'You choose what airs and when. Approving holds a clip; nothing reaches the stream until you air it.'
            : 'Queued clips play automatically when a tile frees up.'
        }
        accent="cyan"
      />
      <div className="flex flex-col gap-4 px-5 py-5 sm:px-6">
        {!overlayLive && (ready.length > 0 || running.length > 0) ? (
          <p
            id="overlay-offline-note"
            className="flex items-start gap-2 rounded-lg border border-[var(--neon-amber)]/50 bg-[var(--neon-amber)]/10 px-3 py-2 text-xs font-semibold text-[var(--neon-amber)]"
          >
            <MonitorOff className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Your OBS overlay isn&apos;t connected — queued clips hold until it is
              (open the OBS link from Share links, or refresh the browser source in OBS).
              {producer ? ' Airing one anyway still works.' : ' Or hit ▶ Play now to run one anyway.'}
            </span>
          </p>
        ) : null}
        {letters.length === 0 ? (
          <p className="text-sm text-muted-foreground">No MegaChats waiting.</p>
        ) : (
          <>
            {pile('Waiting for review', 'watch, then approve or reject', waiting)}
            {producer ? pile('Ready to air', 'approved and held — nothing plays until you air it', ready) : null}
            {pile(producer ? 'On screen' : 'Queued', producer ? 'airing now' : 'plays automatically when a tile frees', running)}
          </>
        )}
        {error ? <p className="text-xs text-[var(--neon-magenta)]">{error}</p> : null}
      </div>
    </GlassCard>
  )
}
