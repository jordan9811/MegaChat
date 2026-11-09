'use client'

// LIVENESS BADGE — which check stands behind money on a room right now
// (server: liveness.js). Four tiers, one pill, the detail on hover:
//   off     not on air (hidden unless `showOff`)
//   red     live, but the Holler overlay is not on the broadcast
//   yellow  on air with the keyed overlay up (the "half-baked" check)
//   green   badge verification running (the "bounty-grade" check)
// Styles in app/globals.css under .lv; colours from the feature tokens
// (rewards green, bounty yellow, the danger orange) so the badge reads in
// the same language as the rest of the board.
//
// Two audiences. The default speaks to backers and streamers (the server's
// label, the full detail and the backer note in a hover title): bounty and
// room pages. `audience="fan"` is the rooms board: a viewer's words, and the
// detail's first sentence opens on tap, focus or hover (a title never shows on
// touch), with no backer setting in it.
import { useEffect, useId, useRef, useState } from 'react'

export type LivenessTier = 'off' | 'red' | 'yellow' | 'green'

export type Liveness = {
  tier: LivenessTier
  label?: string
  onAir?: boolean
  channelLive?: boolean
  overlayConnected?: boolean
  overlayRecent?: boolean
  verifying?: boolean
  overlayConnectedMs?: number | null
  sampledMs?: number | null
}

export const TIER_LABEL: Record<LivenessTier, string> = {
  off: 'Offline',
  red: 'Live, no overlay',
  yellow: 'Overlay up',
  green: 'Verified',
}

const TIER_DETAIL: Record<LivenessTier, string> = {
  off: 'Not on air right now.',
  red: 'The channel is live, but the Holler overlay is not on the broadcast: nothing can air or count until it is.',
  yellow: 'The keyed overlay is on the broadcast, checked every 30 seconds. Hollers air and campaigns count; a bounty whose backers allowed this tier can release on a finished broadcast. It protects against a forgotten overlay, not against fraud.',
  green: 'Badge verification is running: a bounty release pays only for a clip whose code was read off the real frames.',
}

const BACKER_NOTE = 'Backers choose the tier their pledges release at: Account → Bounty protection.'

/** What a viewer deciding whether to send a Holler needs from each tier. */
export const FAN_LABEL: Record<LivenessTier, string> = {
  off: 'Offline',
  red: 'Unverified',
  yellow: 'Hollers on',
  green: 'Verified',
}

const FAN_DETAIL: Record<LivenessTier, string> = {
  off: 'Not on air right now.',
  red: 'The streamer’s Holler overlay isn’t on the broadcast yet, so a Holler sent now won’t air until it is.',
  yellow: 'The Holler overlay is on the broadcast, checked every 30 seconds, so Hollers air.',
  green: 'Holler is reading its code off the live picture, the strongest proof that what you send airs.',
}

/** The fan badge: a button, so a tap or keyboard focus opens the detail. The
 *  same pointer rules as InfoTip (info-tip.tsx): a mouse opens it on hover, a
 *  tap toggles it, a press anywhere else closes it. Its click never reaches a
 *  link it sits over. */
function FanLivenessBadge({ tier, size, className }: { tier: LivenessTier; size: 'sm' | 'md'; className?: string }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const pointer = useRef('')

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  return (
    <span
      ref={rootRef}
      className="lv-tip"
      data-open={open}
      onPointerEnter={(event) => { if (event.pointerType === 'mouse') setOpen(true) }}
      onPointerLeave={(event) => { if (event.pointerType === 'mouse') setOpen(false) }}
    >
      <button
        type="button"
        className={['lv', `lv--${tier}`, `lv--${size}`, className].filter(Boolean).join(' ')}
        aria-expanded={open}
        aria-describedby={id}
        onPointerDown={(event) => { pointer.current = event.pointerType }}
        onClick={(event) => {
          event.preventDefault(); event.stopPropagation()
          const by = pointer.current
          pointer.current = ''
          if (by === 'mouse') setOpen(true)
          else setOpen((value) => !value)
        }}
        onFocus={(event) => { if (event.currentTarget.matches(':focus-visible')) setOpen(true) }}
        onBlur={(event) => { if (!rootRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false) }}
        onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false) }}
      >
        <span className="lv-dot" aria-hidden="true" />
        {FAN_LABEL[tier]}
      </button>
      <span
        role="tooltip"
        id={id}
        className="lv-pop"
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen(false) }}
      >
        {FAN_DETAIL[tier]}
      </span>
    </span>
  )
}

export function livenessTitle(l: Liveness): string {
  const mins = l.overlayConnectedMs != null ? Math.round(l.overlayConnectedMs / 60_000) : null
  const sampled = l.tier !== 'off' && mins != null ? ` Overlay up ${mins} min of this broadcast so far.` : ''
  return `${TIER_LABEL[l.tier]}: ${TIER_DETAIL[l.tier]}${sampled} ${BACKER_NOTE}`
}

export function LivenessBadge({
  liveness,
  size = 'sm',
  showOff = false,
  audience = 'backer',
  className,
}: {
  liveness: Liveness | null | undefined
  size?: 'sm' | 'md'
  /** Render the Offline state too (pages); cards leave it out. */
  showOff?: boolean
  /** 'fan': viewer wording, detail on tap/focus, no backer note (the board). */
  audience?: 'backer' | 'fan'
  className?: string
}) {
  if (!liveness) return null
  if (liveness.tier === 'off' && !showOff) return null
  if (audience === 'fan') return <FanLivenessBadge tier={liveness.tier} size={size} className={className} />
  const label = liveness.label || TIER_LABEL[liveness.tier]
  return (
    <span
      className={['lv', `lv--${liveness.tier}`, `lv--${size}`, className].filter(Boolean).join(' ')}
      title={livenessTitle(liveness)}
      aria-label={`Liveness: ${label}`}
    >
      <span className="lv-dot" aria-hidden="true" />
      {label}
    </span>
  )
}
