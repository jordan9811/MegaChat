'use client'

// Overlay health — the streamer's answer to "is my OBS source actually going
// to show a guest when someone pays?"
//
// This matters specifically BECAUSE of lazy connect. The old overlay was
// always connected, so it could never fail to show a guest — it just billed
// forever (see LIVEKIT-AUDIT.md). Lazy connect trades that cost for a new
// failure mode: signal dies → guest pays → nobody appears → refund on a live
// broadcast. This card is how the streamer sees that BEFORE it happens.

import { useEffect, useState } from 'react'
import { Radio, CircleAlert, Moon, EyeOff, Copy, Check } from 'lucide-react'
import { useRoom } from '@/components/room-provider'
import { useOverlayVisibility } from '@/components/obs/use-overlay-visibility'
import { useObsPassword } from '@/components/obs/obs-password'
import { obsOverlayLink, useOverlayEnv } from '@/components/obs/use-overlay-env'

/**
 * The one fix the "Overlay not open" card can point to (ov-link-mistakes): a
 * link that names no room now draws nothing at all instead of the test room
 * or the site's 404, so a streamer whose OBS source is open but whose card
 * still says "not open" is holding a wrong or old link.
 */
function RecopyOverlayLink({ link }: { link: string | null }) {
  const [copied, setCopied] = useState(false)
  if (!link) return null
  return (
    <button
      type="button"
      onClick={() => { void navigator.clipboard?.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800) }).catch(() => {}) }}
      className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-input/30 px-3 text-xs font-bold text-foreground"
    >
      {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
      {copied ? 'Copied — paste it into your OBS browser source' : 'Re-copy overlay link'}
    </button>
  )
}

/** Plain-English cause, in the streamer's terms, not OBS's. */
const HIDDEN_COPY: Record<string, string> = {
  scene: 'the overlay is not in the scene you are broadcasting',
  disabled: 'the overlay source is switched off (the eye is unticked)',
  offcanvas: 'the overlay is off the canvas, or sized to nothing',
  covered: 'another source is sitting on top of the overlay',
}

/** What /api/rooms/:id/seat-escrow reports — see seat-escrow.js, summaryFor. */
type SeatMoney = {
  seats: number
  signalled: boolean
  pending: string
  released: string
  holdbackOutstanding: string
  manualHeldSeats: number
  manualHoldUntil: number | null
  holdbackFraction: number
  clawbackWindowMs: number
  manualTailMs: number
  manualMaxHoldMs: number
}

type Health = {
  present: boolean
  healthy: boolean
  lkState: string
  activityState: string
  lastBeatMsAgo: number | null
  seats: number
  pendingPrewarms: number
}

const POLL_MS = 5000

export function OverlayHealthCard() {
  const { room, mode, overlayUrl } = useRoom()
  // The overlay's own badge report, for EVERY room (ov-too-small-on-air): the
  // OBS-WebSocket scene check below only runs where this browser holds the
  // OBS password, which a manual-setup streamer never gave it.
  const overlayEnv = useOverlayEnv(room?.id, mode === 'managing')
  const [health, setHealth] = useState<Health | null>(null)
  // The obs-websocket password the one-click flow stored, current as soon as
  // OBS accepts it (obs-password.ts). It never leaves this browser.
  const obsPassword = useObsPassword()
  const [seatMoney, setSeatMoney] = useState<SeatMoney | null>(null)

  // Guest-seat money: pending, released, held back — and for a manual-paste
  // room, why it holds longer and until when (Pass C Part 3c).
  useEffect(() => {
    if (!room?.id || mode !== 'managing') return
    let stop = false
    const load = () =>
      fetch(`/api/rooms/${encodeURIComponent(room.id)}/seat-escrow`, { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (!stop && d) setSeatMoney(d) })
        .catch(() => { /* transient — next poll retries */ })
    void load()
    const t = setInterval(load, 30_000)
    return () => { stop = true; clearInterval(t) }
  }, [room?.id, mode])

  // Accident detection, for ANY live room. A manual-paste streamer has no
  // password stored, so this never runs and never reports for them — silence
  // is the correct output, not a warning.
  const visibility = useOverlayVisibility({
    roomId: room?.id ?? null,
    password: obsPassword,
    enabled: mode === 'managing' && !!room?.active,
  })

  useEffect(() => {
    if (!room?.id || mode !== 'managing') return
    let stop = false
    const load = () =>
      fetch(`/api/livekit/overlay/health?room=${encodeURIComponent(room.id)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (!stop && d) setHealth(d) })
        .catch(() => { /* transient — next poll retries */ })
    void load()
    const t = setInterval(load, POLL_MS)
    return () => { stop = true; clearInterval(t) }
  }, [room?.id, mode])

  // The visibility banner stands on its own: it is about the OBS scene, not
  // about LiveKit, so it must render even for a vdo room or before the health
  // endpoint has answered — the two failures are unrelated and a streamer
  // whose overlay is buried needs telling either way.
  const hidden = visibility?.signal === 'overlay_hidden'
  // Too small: OBS's scene says the source is scaled down, OR the overlay
  // itself measured its bounty badge under the floor (the warning that used
  // to air as "BADGE TOO SMALL — NOT EARNING" in front of the audience).
  const badgeSmall = overlayEnv?.env?.badgeTooSmall === true
  const scaled = visibility?.signal === 'overlay_scaled_below_floor' || (!hidden && badgeSmall)
  const banner = (hidden || scaled) ? (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-2xl border border-border/70 bg-card/60 p-4 backdrop-blur-sm"
    >
      <EyeOff className="mt-0.5 size-4 shrink-0 text-hl-danger" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">
          {hidden ? 'Your overlay is not on screen' : 'Your overlay is too small to be read'}
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {hidden ? (
            <>
              OBS says {HIDDEN_COPY[visibility?.reason ?? ''] ?? 'the overlay is not visible'}.
              Guests and Hollers are not reaching your broadcast.
            </>
          ) : visibility?.signal === 'overlay_scaled_below_floor' ? (
            <>
              The overlay source is scaled down, which shrinks the verification
              badge with it. A Holler that plays now may not be provable.
              Set the source back to 100%.
            </>
          ) : (
            <>
              The overlay measured its verification badge too small
              {overlayEnv?.env?.height ? ` on a ${overlayEnv.env.width}×${overlayEnv.env.height} source` : ''}, so
              bounty clips are not earning. Set the browser source to your canvas size
              (1920×1080 is right) at 100%.
            </>
          )}
        </p>
      </div>
      <span className="mt-1 size-2 shrink-0 rounded-full bg-hl-danger" style={{ animation: 'pulse 2s ease-in-out infinite' }} />
    </div>
  ) : null

  // Why seat money holds longer for a manual-paste room, and what shortens it.
  // Shown only once a metered seat has existed, so an empty room says nothing.
  const seatNote = seatMoney && seatMoney.seats > 0 ? (
    <p className="mt-2 text-xs leading-relaxed text-muted-foreground" data-seat-hold={seatMoney.signalled ? 'signalled' : 'manual'}>
      {seatMoney.signalled ? (
        <>
          Guest-seat payouts release in chunks as OBS confirms the overlay is on screen;{' '}
          {Math.round(seatMoney.holdbackFraction * 100)}% of each chunk holds for{' '}
          {Math.round(seatMoney.clawbackWindowMs / 3_600_000)} h in case a check disagrees.
        </>
      ) : (
        <>
          Guest-seat payouts hold until your stream ends plus{' '}
          {Math.round(seatMoney.manualTailMs / 60_000)} min (at most{' '}
          {Math.round(seatMoney.manualMaxHoldMs / 3_600_000)} h) because we can&apos;t see your
          overlay. Connect OBS under <em>OBS setup</em> and they release within a check of each chunk.
        </>
      )}
      {parseFloat(seatMoney.pending) > 0 ? <> Pending now: <span className="font-semibold text-f-bounty-ink">${seatMoney.pending}</span>.</> : null}
    </p>
  ) : null

  if (mode !== 'managing' || room?.transport !== 'livekit' || !health) return <>{banner}{seatNote}</>

  // Three states worth distinguishing, and only one is bad.
  const connected = health.lkState === 'live'
  const bad = health.present && !health.healthy

  // ink = the icon, dot = the light. Not open is a warning (bounty yellow; the
  // dot is -ui, since raw yellow vanishes on a light card), not responding is
  // a fault (danger orange, never Holler pink), on air is the record light with
  // the call-in guest's colour on the icon, and idle-ready is call-in waiting.
  const tone = !health.present
    ? { icon: CircleAlert, ink: 'var(--f-bounty-ink)', dot: 'var(--f-bounty-ui)', label: 'Overlay not open' }
    : bad
      ? { icon: CircleAlert, ink: 'var(--hl-danger)', dot: 'var(--hl-danger)', label: 'Overlay not responding' }
      : connected
        ? { icon: Radio, ink: 'var(--f-callin-ink)', dot: 'var(--hl-record)', label: 'On air — guest connected' }
        : { icon: Moon, ink: 'var(--f-callin-ink)', dot: 'var(--f-callin)', label: 'Ready — sleeping until a guest joins' }

  const Icon = tone.icon

  return (
    <>
    {banner}
    <div className="flex items-start gap-3 rounded-2xl border border-border/70 bg-card/60 p-4 backdrop-blur-sm">
      <Icon className="mt-0.5 size-4 shrink-0" style={{ color: tone.ink }} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">{tone.label}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {!health.present ? (
            <>
              Add the overlay browser source in OBS. Until it&apos;s open, a paying
              guest won&apos;t appear on your broadcast.
            </>
          ) : bad ? (
            <>
              The overlay stopped checking in
              {health.lastBeatMsAgo != null
                ? ` ${Math.round(health.lastBeatMsAgo / 1000)}s ago`
                : ''}
              . Refresh the browser source in OBS before taking a paid guest.
            </>
          ) : connected ? (
            <>
              {health.seats > 0
                ? `${health.seats} on camera.`
                : 'Holding the connection for an incoming guest.'}
            </>
          ) : (
            <>
              Idle costs nothing — the connection opens the moment someone starts
              buying a seat, and closes again after they leave.
            </>
          )}
        </p>
        {!health.present ? <RecopyOverlayLink link={obsOverlayLink(room, overlayUrl)} /> : null}
      </div>
      <span
        className="mt-1 size-2 shrink-0 rounded-full"
        style={{
          backgroundColor: tone.dot,
          animation: connected || bad ? 'pulse 2s ease-in-out infinite' : undefined,
        }}
      />
    </div>
    {seatNote}
    </>
  )
}
