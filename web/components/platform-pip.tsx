// The little platform badge that rides in the corner of a streamer's avatar,
// in the platform's own logo and colour so "where" reads at a glance
// (owner, 2026-11-09: real logos, "easier to see, quicker to know"). One
// source for the landing's bounty thumbnails, the rooms board and the bounty
// board. Each badge draws its own plate, so it holds on any background.

type Brand = { bg: string; fg: string; d?: string; ring?: boolean }

const BRANDS: Record<string, Brand> = {
  twitch: {
    bg: '#9146FF',
    fg: '#FFFFFF',
    d: 'M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z',
  },
  kick: {
    bg: '#53FC18',
    fg: '#000000',
    d: 'M1.333 0h8v5.333H12V2.667h2.667V0h8v8H20v2.667h-2.667v2.666H20V16h2.667v8h-8v-2.667H12v-2.666H9.333V24h-8Z',
  },
  x: {
    bg: '#000000',
    fg: '#FFFFFF',
    ring: true,
    d: 'M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z',
  },
  rumble: {
    bg: '#85C742',
    fg: '#FFFFFF',
    d: 'M14.4528 13.5458c.8064-.6542.9297-1.8381.2756-2.6445a1.8802 1.8802 0 0 0-.2756-.2756 21.2127 21.2127 0 0 0-4.3121-2.776c-1.066-.51-2.256.2-2.4261 1.414a23.5226 23.5226 0 0 0-.14 5.5021c.116 1.23 1.292 1.964 2.372 1.492a19.6285 19.6285 0 0 0 4.5062-2.704v-.008zm6.9322-5.4002c2.0335 2.228 2.0396 5.637.014 7.8723A26.1487 26.1487 0 0 1 8.2946 23.846c-2.6848.6713-5.4168-.914-6.1662-3.5781-1.524-5.2002-1.3-11.0803.17-16.3045.772-2.744 3.3521-4.4661 6.0102-3.832 4.9242 1.174 9.5443 4.196 13.0764 8.0121v.002z',
  },
}
BRANDS.twitter = BRANDS.x

const LABELS: Record<string, string> = {
  twitch: 'Twitch', kick: 'Kick', x: 'X', twitter: 'X', youtube: 'YouTube', rumble: 'Rumble', pumpfun: 'pump.fun', 'pump.fun': 'pump.fun',
}

/** The plate every badge sits on: a rounded square filling the viewBox. */
function Plate({ fill, ring }: { fill: string; ring?: boolean }) {
  return <rect x="0.5" y="0.5" width="23" height="23" rx="5.5" fill={fill} stroke={ring ? 'rgba(255,255,255,.28)' : 'none'} strokeWidth="1" />
}

export function PlatformPip({
  platform,
  // Kept for callers that pass it; the badge now draws its own plate.
  notch: _notch,
  label: withLabel = false,
}: {
  platform: string | null
  notch?: string
  /** Announce the platform (role=img + its name) instead of hiding the badge. */
  label?: boolean
}) {
  const k = String(platform || '').toLowerCase()
  const name = LABELS[k] || (platform ? String(platform) : '')
  const a11y = withLabel ? { role: 'img', 'aria-label': name } : { 'aria-hidden': true as const }
  if (k === 'youtube') {
    return (
      <svg viewBox="0 0 24 24" {...a11y} className="mc-pip">
        <Plate fill="#FF0000" />
        <path d="M9.6 7.6v8.8L17 12z" fill="#FFFFFF" />
      </svg>
    )
  }
  if (k === 'pumpfun' || k === 'pump.fun') {
    return (
      <svg viewBox="0 0 24 24" {...a11y} className="mc-pip">
        <Plate fill="#0B0B0B" ring />
        <g transform="translate(12 12) rotate(-45) scale(0.62) translate(-12 -12)">
          <rect x="0.5" y="7.25" width="23" height="9.5" rx="4.75" fill="#5FD38C" />
          <rect x="0.5" y="7.25" width="11.5" height="9.5" rx="4.75" fill="#FFFFFF" />
          <rect x="11.3" y="7.25" width="1.4" height="9.5" fill="#0B0B0B" />
        </g>
      </svg>
    )
  }
  const b = BRANDS[k]
  if (!b) {
    if (!name) return null
    // Anything else still gets a badge: the platform's first letter.
    return (
      <svg viewBox="0 0 24 24" {...a11y} className="mc-pip">
        <Plate fill="#2A2724" ring />
        <text x="12" y="16.5" textAnchor="middle" fontSize="13" fontWeight="800" fill="#F4EFE6" fontFamily="system-ui, sans-serif">{name.charAt(0).toUpperCase()}</text>
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" {...a11y} className="mc-pip">
      <Plate fill={b.bg} ring={b.ring} />
      {/* The glyph at 58% of the plate, centred. */}
      <g transform="translate(5 5) scale(0.5833)">
        <path d={b.d} fill={b.fg} />
      </g>
    </svg>
  )
}
