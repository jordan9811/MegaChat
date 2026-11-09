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

import { useCallback, useEffect, useRef, useState } from 'react'
import { Mail, Check, X, RefreshCw, Play, MonitorOff, Clock, Copy } from 'lucide-react'
import { GlassCard, CardHeader } from '@/components/glass-card'
import { useRoom } from '@/components/room-provider'
import type { LetterAdminItem } from '@/lib/api'
import { formatDollars } from '@/lib/display-format'
import { obsOverlayLink } from '@/components/obs/use-overlay-env'

/** The stuck-clip note's one action: the link OBS needs, on the clipboard. */
function CopyObsLinkButton({ link }: { link: string | null }) {
  const [copied, setCopied] = useState(false)
  if (!link) return null
  return (
    <button
      type="button"
      onClick={() => { void navigator.clipboard?.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800) }).catch(() => {}) }}
      className="inline-flex items-center gap-1.5 rounded-lg border border-f-bounty-line bg-card/60 px-3 py-1.5 text-xs font-bold text-foreground"
    >
      {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
      {copied ? 'Copied — paste it into your OBS browser source' : 'Copy OBS overlay link'}
    </button>
  )
}

/** What waits on the streamer: clips to review, and approved clips held to air. */
export type QueueCounts = { review: number; ready: number }

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

export function LettersQueueCard({ onCounts }: { onCounts?: (counts: QueueCounts) => void } = {}) {
  const { mode, room, lettersAdmin, overlayUrl } = useRoom()
  // "Air it" while the overlay is offline asks once before using the clip up.
  const [confirmAir, setConfirmAir] = useState<string | null>(null)
  const [letters, setLetters] = useState<LetterAdminItem[]>([])
  // The dashboard lifts this card up and counts it in the status bar while
  // anything waits (ss-live-desk-below-fold), so it reports what it holds.
  const review = letters.filter((l) => l.status === 'pending_approval').length
  const readyCount = letters.filter((l) => l.status === 'ready').length
  useEffect(() => { onCounts?.({ review, ready: readyCount }) }, [onCounts, review, readyCount])
  useEffect(() => () => onCounts?.({ review: 0, ready: 0 }), [onCounts])
  const [overlayLive, setOverlayLive] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const active = mode === 'managing' && !!room?.letters?.enabled
  const producer = room?.letters?.moderation === 'approve'
  const roomId = room?.id ?? null
  const roomRef = useRef(roomId)
  roomRef.current = roomId

  const refresh = useCallback(async () => {
    if (!active) return
    const asked = roomRef.current
    try {
      const data = await lettersAdmin.list()
      if (roomRef.current !== asked) return // the streamer switched rooms meanwhile
      setLetters(data.letters)
      setOverlayLive(data.overlayLive)
      setError(null)
    } catch (e) {
      if (roomRef.current !== asked) return
      setError(e instanceof Error ? e.message : 'Failed to load Hollers')
    }
  }, [active, lettersAdmin])

  useEffect(() => {
    // A room switch: the old room's queue, with live Approve and Reject
    // buttons, must not stay up until the next poll (audit web-20).
    setLetters([])
    setError(null)
    if (!active) return
    void refresh()
    const poll = setInterval(() => void refresh(), 5000)
    return () => clearInterval(poll)
  }, [active, refresh, roomId])

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
          {/* "[record mark] SweepFan · 8 s · $0.15": the pile header above
              already says the status, so the row does not repeat it. */}
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-foreground">
            <span className="mcc-queue-mark" aria-hidden="true"><i /></span>
            <span className="truncate">{l.username}</span>
            <span className="text-xs font-normal text-muted-foreground">
              · {l.durationS} s · {parseFloat(l.price) > 0 ? formatDollars(l.price) : 'Free'}
            </span>
            {left ? (
              <span
                className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground"
                title={`Refunded to the fan in ${left} if nobody ${l.status === 'ready' ? 'airs' : 'reviews'} it`}
              >
                <Clock className="size-3" aria-hidden="true" />
                Refunds in {left}
              </span>
            ) : null}
          </p>
          {l.flaggedReason ? (
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
              <span className="rounded-md border border-f-holler-line bg-f-holler-bg px-1.5 py-0.5 text-[11px] font-bold text-f-holler-ink">Flagged</span>
              <span>{l.flaggedReason}</span>
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
              className="inline-flex items-center gap-1.5 rounded-lg border border-hl-strap bg-hl-strap px-3 py-1.5 text-xs font-bold text-primary-foreground transition-colors hover:border-hl-strap-hover hover:bg-hl-strap-hover disabled:opacity-50"
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
        {(l.status === 'ready' || l.status === 'queued') && confirmAir === l.id ? (
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-f-bounty-ink" role="alert">
            <span>OBS isn&apos;t showing Holler. Air anyway and use up this clip?</span>
            <button
              type="button"
              disabled={busyId === l.id}
              onClick={() => { setConfirmAir(null); void act(l.id, 'play') }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-f-holler-solid bg-f-holler-solid px-3 py-1.5 text-xs font-bold text-f-holler-on disabled:opacity-50"
            >
              <Play className="size-3.5" />
              Air anyway
            </button>
            <button
              type="button"
              onClick={() => setConfirmAir(null)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-input/30 px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
            >
              Keep it
            </button>
          </div>
        ) : l.status === 'ready' || l.status === 'queued' ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busyId === l.id}
              onClick={() => { if (!overlayLive) setConfirmAir(l.id); else void act(l.id, 'play') }}
              title="Put this on screen right now, even if overlay detection disagrees"
              className="inline-flex items-center gap-1.5 rounded-lg border border-f-holler-solid bg-f-holler-solid px-3 py-1.5 text-xs font-bold text-f-holler-on transition-transform active:scale-[0.97] disabled:opacity-50"
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
        title="Hollers"
        description={
          producer
            ? 'You choose what airs and when. Approving holds a clip; nothing reaches the stream until you air it.'
            : undefined
        }
        accent="holler"
      />
      <div className="flex flex-col gap-4 px-5 py-5 sm:px-6">
        {!overlayLive && (ready.length > 0 || running.length > 0) ? (
          <p
            id="overlay-offline-note"
            className="flex items-start gap-2 rounded-lg border border-f-bounty-line bg-f-bounty-bg px-3 py-2 text-xs font-semibold text-f-bounty-ink"
          >
            <MonitorOff className="mt-0.5 size-3.5 shrink-0" />
            {/* ss-share-links-stale: the note IS the fix. It used to send the
                streamer to a "Share links" section that no longer exists, and
                to air a clip anyway, which plays to nobody and uses it up. */}
            <span className="flex flex-col items-start gap-2">
              Your OBS overlay isn&apos;t connected, so these clips are waiting.
              <CopyObsLinkButton link={obsOverlayLink(room, overlayUrl)} />
            </span>
          </p>
        ) : null}
        {letters.length === 0 ? (
          <p className="text-sm text-muted-foreground">No Hollers waiting.</p>
        ) : (
          <>
            {pile('Waiting for review', 'watch, then approve or reject', waiting)}
            {producer ? pile('Ready to air', 'approved and held — nothing plays until you air it', ready) : null}
            {pile(producer ? 'On screen' : 'Queued', producer ? 'airing now' : 'plays automatically when a tile frees', running)}
          </>
        )}
        {error ? <p className="text-xs text-hl-danger">{error}</p> : null}
      </div>
    </GlassCard>
  )
}
