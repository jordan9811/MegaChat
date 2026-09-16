'use client'

// RECENT ROOMS — finished broadcasts with something to show.
//
// The board's job is to look alive with few streamers, and a room that was
// busy an hour ago is more interesting than an empty grid cell. Each card
// shows what the room looked like WHILE SOMEBODY WAS ON, not a placeholder and
// not the last frame of the stream (which is an end card or black).
//
// TWO KINDS OF CARD, AND THEY LOOK DIFFERENT ON PURPOSE. `poster.kind` decides
// which, and it is read off the room record rather than inferred here:
//
//   'frame' — a real photograph, extracted from the self-capture at the
//             deepest point of the longest clip playback.
//   'card'  — a room that never had a capture to pull from (capture only runs
//             during a bounty air session). Drawn as an obvious graphic with
//             no video treatment, because a generated card that could pass for
//             a screenshot is a lie about what we have.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { listRecentAirings, type RecentAiring } from '@/lib/api'

function ago(ms: number): string {
  const mins = Math.max(1, Math.round((Date.now() - ms) / 60000))
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

function mins(ms: number | null): string {
  if (!ms) return ''
  return `${Math.max(1, Math.round(ms / 60000))} min`
}

function RecentCard({ a }: { a: RecentAiring }) {
  const href = a.handle ? `/${a.handle}` : `/join?room=${encodeURIComponent(a.roomId)}`
  const p = a.poster
  return (
    <Link href={href} className="mcr-recent" aria-label={a.name}>
      <span className="mcr-recent-stage">
        {p?.kind === 'frame' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/rooms/${encodeURIComponent(a.roomId)}/poster.jpg`} alt="" loading="lazy" />
        ) : (
          <span className="mcr-recent-card" aria-hidden="true">
            <b>{(p?.kind === 'card' ? p.title : a.name)?.trim().charAt(0).toUpperCase() || '?'}</b>
            {p?.kind === 'card' && p.guests.length ? (
              <em>{p.guests.slice(0, 3).join(' · ')}</em>
            ) : null}
          </span>
        )}
        <span className="mcr-scan" aria-hidden="true" />
        <span className="mcr-recent-tag">
          {p?.kind === 'frame' ? 'Aired' : 'No recording'}
        </span>
      </span>
      <span className="mcr-recent-meta">
        <strong>{a.name}</strong>
        <small>
          {ago(a.endedAt)}
          {a.durationMs ? ` · ${mins(a.durationMs)}` : ''}
          {a.moments.length ? ` · ${a.moments.length} moment${a.moments.length === 1 ? '' : 's'}` : ''}
        </small>
      </span>
    </Link>
  )
}

export function RecentRail() {
  const [rows, setRows] = useState<RecentAiring[] | null>(null)

  useEffect(() => {
    let alive = true
    listRecentAirings(8)
      .then((d) => { if (alive) setRows(d.airings || []) })
      // A rail that cannot load is a quiet rail, never an error on the board.
      .catch(() => { if (alive) setRows([]) })
    return () => { alive = false }
  }, [])

  if (!rows || rows.length === 0) return null

  return (
    <section className="mcr-recent-rail" aria-label="Recently aired">
      <h2>Recently aired</h2>
      <div className="mcr-recent-grid">
        {rows.map((a) => <RecentCard key={a.airingId} a={a} />)}
      </div>
    </section>
  )
}

