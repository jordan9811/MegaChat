'use client'

// MegaChat moderation queue — visible while managing a room with MegaChats in
// approve mode (also shows the live queue in auto mode for visibility).
// Rejecting refunds the payer from the platform wallet.

import { useCallback, useEffect, useState } from 'react'
import { Mail, Check, X, RefreshCw, Play, MonitorOff } from 'lucide-react'
import { GlassCard, CardHeader } from '@/components/glass-card'
import { useRoom } from '@/components/room-provider'
import type { LetterAdminItem } from '@/lib/api'

export function LettersQueueCard() {
  const { mode, room, lettersAdmin } = useRoom()
  const [letters, setLetters] = useState<LetterAdminItem[]>([])
  const [overlayLive, setOverlayLive] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const active = mode === 'managing' && !!room?.letters?.enabled

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

  return (
    <GlassCard>
      <CardHeader
        icon={<Mail className="size-5" />}
        title="MegaChats"
        description={
          room?.letters?.moderation === 'approve'
            ? 'Approve or reject before they hit the stream. Rejects auto-refund.'
            : 'Queued clips play automatically when a tile frees up.'
        }
        accent="cyan"
      />
      <div className="flex flex-col gap-2 px-5 py-5 sm:px-6">
        {!overlayLive && letters.some((l) => l.status === 'queued') ? (
          <p
            id="overlay-offline-note"
            className="flex items-start gap-2 rounded-lg border border-[var(--neon-amber)]/50 bg-[var(--neon-amber)]/10 px-3 py-2 text-xs font-semibold text-[var(--neon-amber)]"
          >
            <MonitorOff className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Your OBS overlay isn&apos;t connected — queued clips hold until it is
              (open the OBS link from Share links, or refresh the browser source in OBS).
              Or hit ▶ Play now to run one anyway.
            </span>
          </p>
        ) : null}
        {letters.length === 0 ? (
          <p className="text-sm text-muted-foreground">No MegaChats waiting.</p>
        ) : (
          letters.map((l) => (
            <div
              key={l.id}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-input/20 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-foreground">
                  📼 {l.username}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {l.durationS}s · {l.price} · {l.status.replace('_', ' ')}
                  </span>
                </p>
                {l.flaggedReason ? (
                  <p className="mt-1 inline-block rounded-md border border-[var(--neon-magenta)]/40 bg-[var(--neon-magenta)]/10 px-2 py-0.5 text-xs font-semibold text-[var(--neon-magenta)]">
                    🕵️ AI flag: {l.flaggedReason}
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
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--neon-lime)]/50 bg-[var(--neon-lime)]/10 px-3 py-1.5 text-xs font-bold text-[var(--neon-lime)] transition-colors hover:bg-[var(--neon-lime)]/20 disabled:opacity-50"
                  >
                    {busyId === l.id ? <RefreshCw className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                    Approve
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
              {l.status === 'queued' ? (
                <button
                  type="button"
                  disabled={busyId === l.id}
                  onClick={() => void act(l.id, 'play')}
                  title="Play on the overlay right now, even if overlay-detection disagrees"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--neon-cyan)]/50 bg-[var(--neon-cyan)]/10 px-3 py-1.5 text-xs font-bold text-[var(--neon-cyan)] transition-colors hover:bg-[var(--neon-cyan)]/20 disabled:opacity-50"
                >
                  {busyId === l.id ? <RefreshCw className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                  Play now
                </button>
              ) : null}
            </div>
          ))
        )}
        {error ? <p className="text-xs text-[var(--neon-magenta)]">{error}</p> : null}
      </div>
    </GlassCard>
  )
}
