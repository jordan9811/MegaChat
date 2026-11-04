// LIVENESS BADGE — which check stands behind money on a room right now
// (server: liveness.js). Four tiers, one pill, the detail on hover:
//   off     not on air (hidden unless `showOff`)
//   red     live, but the Holler overlay is not on the broadcast
//   yellow  on air with the keyed overlay up (the "half-baked" check)
//   green   badge verification running (the "bounty-grade" check)
// Styles in app/globals.css under .lv; colours from the feature tokens
// (rewards green, bounty yellow, the danger orange) so the badge reads in
// the same language as the rest of the board.

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

export function livenessTitle(l: Liveness): string {
  const mins = l.overlayConnectedMs != null ? Math.round(l.overlayConnectedMs / 60_000) : null
  const sampled = l.tier !== 'off' && mins != null ? ` Overlay up ${mins} min of this broadcast so far.` : ''
  return `${TIER_LABEL[l.tier]}: ${TIER_DETAIL[l.tier]}${sampled} ${BACKER_NOTE}`
}

export function LivenessBadge({
  liveness,
  size = 'sm',
  showOff = false,
  className,
}: {
  liveness: Liveness | null | undefined
  size?: 'sm' | 'md'
  /** Render the Offline state too (pages); cards leave it out. */
  showOff?: boolean
  className?: string
}) {
  if (!liveness) return null
  if (liveness.tier === 'off' && !showOff) return null
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
