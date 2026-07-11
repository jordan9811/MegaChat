'use client'

// Letter moderation queue — visible while managing a room with letters in
// approve mode (also shows the live queue in auto mode for visibility).
// Rejecting refunds the payer from the platform wallet.

import { useCallback, useEffect, useState } from 'react'
import { Mail, Check, X, RefreshCw } from 'lucide-react'
import { GlassCard, CardHeader } from '@/components/glass-card'
import { useRoom } from '@/components/room-provider'
import type { LetterAdminItem } from '@/lib/api'

export function LettersQueueCard() {
  const { mode, room, lettersAdmin } = useRoom()
  const [letters, setLetters] = useState<LetterAdminItem[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const active = mode === 'managing' && !!room?.letters?.enabled

  const refresh = useCallback(async () => {
    if (!active) return
    try {
      setLetters(await lettersAdmin.list())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load letters')
    }
  }, [active, lettersAdmin])

  useEffect(() => {
    if (!active) return
    void refresh()
    const poll = setInterval(() => void refresh(), 5000)
    return () => clearInterval(poll)
  }, [active, refresh])

  if (!active) return null

  const act = async (letterId: string, action: 'approve' | 'reject') => {
    setBusyId(letterId)
    try {
      if (action === 'approve') await lettersAdmin.approve(letterId)
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
        title="Letters"
        description={
          room?.letters?.moderation === 'approve'
            ? 'Approve or reject before they hit the stream. Rejects auto-refund.'
            : 'Queued clips play automatically when a tile frees up.'
        }
        accent="cyan"
      />
      <div className="flex flex-col gap-2 px-5 py-5 sm:px-6">
        {letters.length === 0 ? (
          <p className="text-sm text-muted-foreground">No letters waiting.</p>
        ) : (
          letters.map((l) => (
            <div
              key={l.id}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-input/20 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-foreground">
                  ✉ {l.username}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {l.durationS}s · {l.price} · {l.status.replace('_', ' ')}
                  </span>
                </p>
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
            </div>
          ))
        )}
        {error ? <p className="text-xs text-[var(--neon-magenta)]">{error}</p> : null}
      </div>
    </GlassCard>
  )
}
