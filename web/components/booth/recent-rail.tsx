// RECENTLY AIRED — finished broadcasts, each with a picture of itself.
//
// The board's job is to look alive with few streamers, and a room that was
// busy an hour ago is more interesting than an empty grid cell. So when
// nothing is live this row sits directly under the featured room, above the
// idle rooms (booth.tsx), and it arrives in the first HTML rather than after a
// client fetch — on a quiet night it IS the board.
//
// TWO KINDS OF CARD, AND THEY LOOK DIFFERENT ON PURPOSE. `poster.kind` decides
// which, and it is read off the airing rather than inferred here:
//
//   'frame' — a real photograph of that broadcast (airing-posters.js): our own
//             capture, a frame of the recording, Twitch's live preview kept
//             while a guest was on, or the recording's thumbnail.
//   'card'  — a broadcast with no picture at all. Drawn as an obvious graphic
//             with no video treatment, because a generated card that could
//             pass for a screenshot is a lie about what we have.

import type { CSSProperties } from 'react'
import type { RecentAiring } from '@/lib/api'

function ago(ms: number): string {
  const mins = Math.max(1, Math.round((Date.now() - ms) / 60000))
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

function length(ms: number | null): string {
  if (!ms) return ''
  const mins = Math.max(1, Math.round(ms / 60000))
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

/** Distinct people who took a seat — what "moments" meant to a viewer. */
function guestCount(a: RecentAiring): number {
  return new Set(a.moments.filter((m) => m.kind === 'seat').map((m) => m.label || '')).size
}

function RecentCard({ a }: { a: RecentAiring }) {
  // A plain anchor, never next/link: /<handle> is served by Express, and a
  // client-side route to it is the 404 5993024 fixed on the room cards.
  // ?replay= opens THIS broadcast's replay on the room page (while the room
  // is offline), at its MegaChat or first guest (/api/rooms/:id/replay).
  const replay = `replay=${encodeURIComponent(a.airingId)}`
  const href = a.handle ? `/${a.handle}?${replay}` : `/join?room=${encodeURIComponent(a.roomId)}&${replay}`
  const p = a.poster
  const guests = guestCount(a)
  return (
    <a href={href} className="mcr-recent" aria-label={`${a.name}, aired ${ago(a.endedAt)}`}>
      <span className="mcr-recent-stage">
        {p?.kind === 'frame' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.url} alt="" loading="lazy" decoding="async" />
        ) : (
          <span className="mcr-recent-card" aria-hidden="true">
            <b>{(p?.kind === 'card' ? p.title : a.name)?.trim().charAt(0).toUpperCase() || '?'}</b>
            {p?.kind === 'card' && p.guests.length ? <em>{p.guests.slice(0, 3).join(' · ')}</em> : null}
          </span>
        )}
        {p?.kind === 'frame' ? <span className="mcr-scan" aria-hidden="true" /> : null}
        <span className="mcr-recent-tag">
          {p?.kind === 'frame' ? 'Aired' : a.vodUrl ? 'Recorded' : 'No recording'}
        </span>
        {a.durationMs ? <span className="mcr-recent-len">{length(a.durationMs)}</span> : null}
      </span>
      <span className="mcr-recent-meta">
        <strong>{a.name}</strong>
        {/* "11h ago" is computed on both sides of hydration; a minute boundary
            between them is not a bug worth a console error. */}
        <small suppressHydrationWarning>
          {ago(a.endedAt)}
          {guests ? ` · ${guests} guest${guests === 1 ? '' : 's'} on camera` : ''}
        </small>
      </span>
    </a>
  )
}

/** `span`: how many of the sparse strip's columns this section takes (booth.css .mcr-strip). */
export function RecentRail({ airings, span }: { airings: RecentAiring[]; span?: number }) {
  if (!airings.length) return null
  return (
    <section
      className="mcr-recent-rail"
      aria-label="Recently aired"
      style={span ? ({ ['--k' as string]: span } as CSSProperties) : undefined}
    >
      <h2 className="mcr-sec-h">Recently aired</h2>
      <div className="mcr-recent-grid">
        {airings.map((a) => (
          <RecentCard key={a.airingId} a={a} />
        ))}
      </div>
    </section>
  )
}
