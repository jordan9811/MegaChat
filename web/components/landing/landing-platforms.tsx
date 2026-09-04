// The platforms a room can sit on top of. Marks only, no names: the band is
// recognition, not a claim.
export const PLATFORMS: { name: string; path?: string }[] = [
  {
    name: 'Twitch',
    path: 'M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z',
  },
  {
    name: 'Kick',
    path: 'M1.333 0h8v5.333H12V2.667h2.667V0h8v8H20v2.667h-2.667v2.666H20V16h2.667v8h-8v-2.667H12v-2.666H9.333V24h-8Z',
  },
  { name: 'pump.fun' },
  {
    name: 'X',
    path: 'M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z',
  },
  {
    name: 'Rumble',
    path: 'M14.4528 13.5458c.8064-.6542.9297-1.8381.2756-2.6445a1.8802 1.8802 0 0 0-.2756-.2756 21.2127 21.2127 0 0 0-4.3121-2.776c-1.066-.51-2.256.2-2.4261 1.414a23.5226 23.5226 0 0 0-.14 5.5021c.116 1.23 1.292 1.964 2.372 1.492a19.6285 19.6285 0 0 0 4.5062-2.704v-.008zm6.9322-5.4002c2.0335 2.228 2.0396 5.637.014 7.8723A26.1487 26.1487 0 0 1 8.2946 23.846c-2.6848.6713-5.4168-.914-6.1662-3.5781-1.524-5.2002-1.3-11.0803.17-16.3045.772-2.744 3.3521-4.4661 6.0102-3.832 4.9242 1.174 9.5443 4.196 13.0764 8.0121v.002z',
  },
]

export function PlatformMark({ p }: { p: { name: string; path?: string } }) {
  if (!p.path) {
    return (
      <svg viewBox="0 0 24 24" className="mcl-platform-mark" fill="currentColor" role="img" aria-label={p.name}>
        <title>{p.name}</title>
        <g transform="rotate(-45 12 12)">
          <rect x="0.5" y="7.25" width="23" height="9.5" rx="4.75" />
          <rect x="11.3" y="7.25" width="1.4" height="9.5" fill="var(--mcl-panel)" />
        </g>
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" className="mcl-platform-mark" fill="currentColor" role="img" aria-label={p.name}>
      <title>{p.name}</title>
      <path d={p.path} />
    </svg>
  )
}
