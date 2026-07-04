'use client'

// Public browse directory — viewer-facing room list at the app root.
// Polls /api/rooms/public (active + listed rooms, sorted hottest first by the
// server: live count, then waiting count). Search filters by room name or id;
// an exact room id that isn't in the list (e.g. unlisted) resolves through
// /api/config so a direct id still gets you to its join page.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Radio, Users, Gift, ArrowRight } from 'lucide-react'
import { listPublicRooms, type PublicRoomCard } from '@/lib/api'
import { cn } from '@/lib/utils'

const POLL_MS = 5000

function RoomCard({ room }: { room: PublicRoomCard }) {
  const isLive = room.live > 0
  return (
    <a
      href={`/join?room=${encodeURIComponent(room.id)}`}
      className="group flex flex-col gap-3 rounded-2xl border border-border/70 bg-card/60 p-5 backdrop-blur-sm transition-all hover:-translate-y-0.5 hover:border-[var(--neon-magenta)]/60 hover:shadow-[0_0_24px_oklch(0.68_0.27_340/0.25)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-heading text-lg font-bold text-foreground">
            {room.name}
          </h3>
          <span className="font-mono text-xs text-muted-foreground">{room.id}</span>
        </div>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold uppercase tracking-wide',
            isLive
              ? 'border-[var(--neon-lime)]/60 text-[var(--neon-lime)]'
              : 'border-border text-muted-foreground',
          )}
        >
          <span
            className={cn(
              'size-1.5 rounded-full',
              isLive ? 'animate-pulse bg-[var(--neon-lime)]' : 'bg-muted-foreground',
            )}
          />
          {isLive ? 'Live' : 'Open'}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Radio className="size-3.5 text-[var(--neon-magenta)]" />
          {room.live}/{room.maxSeats} on camera
        </span>
        {room.waiting > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            <Users className="size-3.5 text-[var(--neon-cyan)]" />
            {room.waiting} waiting
          </span>
        ) : null}
        {room.rewardsEnabled ? (
          <span className="inline-flex items-center gap-1.5 text-[var(--neon-lime)]">
            <Gift className="size-3.5" />
            drops
          </span>
        ) : null}
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-border/50 pt-3">
        <span className="text-sm font-semibold text-foreground/90">
          {room.passkeyTickPrice} {room.paymentTokenSymbol}
          <span className="font-normal text-muted-foreground">
            {' '}/ {room.passkeyTickSeconds}s
          </span>
        </span>
        <span className="inline-flex items-center gap-1 text-sm font-bold uppercase tracking-wide text-[var(--neon-magenta)] transition-transform group-hover:translate-x-0.5">
          Join <ArrowRight className="size-4" />
        </span>
      </div>
    </a>
  )
}

export function BrowseDirectory({ initialRooms = [] }: { initialRooms?: PublicRoomCard[] }) {
  const [rooms, setRooms] = useState<PublicRoomCard[] | null>(initialRooms)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [directHit, setDirectHit] = useState<{ id: string; name: string } | null>(null)
  const directLookupRef = useRef(0)

  useEffect(() => {
    let stop = false
    const load = () =>
      listPublicRooms()
        .then((d) => {
          if (!stop) {
            setRooms(d.rooms)
            setLoadError(null)
          }
        })
        .catch((err) => {
          if (!stop) {
            setLoadError(err instanceof Error ? err.message : 'Could not load rooms')
            setRooms((prev) => prev ?? [])
          }
        })
    void load()
    const t = setInterval(load, POLL_MS)
    return () => { stop = true; clearInterval(t) }
  }, [])

  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!rooms) return null
    if (!q) return rooms
    return rooms.filter(
      (r) => r.id.toLowerCase().includes(q) || r.name.toLowerCase().includes(q),
    )
  }, [rooms, q])

  // Exact-id fallback: unlisted rooms don't appear in the list but still work
  // by direct link — resolve the id through the public config endpoint.
  useEffect(() => {
    setDirectHit(null)
    if (!q || !/^[a-z0-9-]{1,32}$/.test(q)) return
    if (filtered && filtered.some((r) => r.id.toLowerCase() === q)) return
    const token = ++directLookupRef.current
    const t = setTimeout(() => {
      fetch(`/api/config?room=${encodeURIComponent(q)}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((cfg) => {
          if (cfg?.roomId && directLookupRef.current === token) {
            setDirectHit({ id: cfg.roomId, name: cfg.roomName || cfg.roomId })
          }
        })
        .catch(() => {})
    }, 350)
    return () => clearTimeout(t)
  }, [q, filtered])

  const liveNow = rooms?.reduce((n, r) => n + (r.live > 0 ? 1 : 0), 0) ?? 0
  const seatsLive = rooms?.reduce((n, r) => n + r.live, 0) ?? 0

  return (
    <section id="browse" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-14 md:py-20">
      <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-bold uppercase tracking-widest text-[var(--neon-lime)]">
            Browse rooms
          </span>
          <h2 className="font-heading text-3xl font-bold text-foreground">
            Live now — grab a camera seat
          </h2>
          <p className="max-w-lg text-sm leading-relaxed text-muted-foreground">
            Hottest rooms first. Pay by the second, leave whenever — unused
            balance comes back to you.
          </p>
        </div>
        {seatsLive > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-2 rounded-full border border-[var(--neon-lime)]/50 bg-[var(--neon-lime)]/10 px-3.5 py-1.5 text-sm font-bold text-[var(--neon-lime)]">
            <span className="relative inline-flex size-2 text-[var(--neon-lime)]">
              <span className="pulse-ring absolute inset-0" />
              <span className="relative size-2 rounded-full bg-[var(--neon-lime)]" />
            </span>
            <span className="tabular">{seatsLive}</span> on camera ·{' '}
            <span className="tabular">{liveNow}</span> rooms hot
          </span>
        ) : null}
      </div>

      <div className="relative mb-8 max-w-md">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by room name or ID…"
          aria-label="Search rooms by name or ID"
          className="w-full rounded-xl border border-border bg-input/30 py-3 pl-11 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:border-[var(--neon-magenta)]/70 focus:outline-none"
        />
      </div>

      {loadError ? (
        <p className="mb-4 text-sm text-[var(--neon-magenta)]">
          {loadError} — retrying automatically. If this persists, refresh the
          page (Ctrl/Cmd+Shift+R).
        </p>
      ) : null}

      {filtered === null ? (
        <div
          aria-hidden="true"
          className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3"
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="flex animate-pulse flex-col gap-4 rounded-2xl border border-border/60 bg-card/40 p-5"
              style={{ animationDelay: `${(i % 3) * 0.12}s` }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-2">
                  <div className="h-4 w-32 rounded bg-foreground/10" />
                  <div className="h-3 w-16 rounded bg-foreground/10" />
                </div>
                <div className="h-6 w-14 rounded-full bg-foreground/10" />
              </div>
              <div className="h-3 w-40 rounded bg-foreground/10" />
              <div className="mt-2 flex items-center justify-between border-t border-border/50 pt-3">
                <div className="h-4 w-20 rounded bg-foreground/10" />
                <div className="h-4 w-12 rounded bg-foreground/10" />
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 && !directHit ? (
        <div className="rounded-2xl border border-dashed border-border/70 bg-card/40 px-6 py-10 text-center">
          <p className="font-heading text-lg font-bold text-foreground">
            {q ? 'No rooms match that search.' : 'No rooms are live right now.'}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {q
              ? 'Try another name, or paste an exact room ID to open an unlisted room.'
              : 'Be the first — spin up your own room in seconds.'}
          </p>
          <a
            href="/dashboard"
            className="mt-4 inline-block rounded-full bg-primary px-5 py-2.5 text-sm font-bold uppercase tracking-wide text-primary-foreground transition-transform hover:scale-[1.03]"
          >
            Start a room
          </a>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((room) => (
            <RoomCard key={room.id} room={room} />
          ))}
          {directHit ? (
            <a
              href={`/join?room=${encodeURIComponent(directHit.id)}`}
              className="group flex flex-col justify-center gap-2 rounded-2xl border border-dashed border-[var(--neon-cyan)]/50 bg-card/40 p-5 transition-all hover:-translate-y-0.5 hover:border-[var(--neon-cyan)]"
            >
              <span className="text-xs font-bold uppercase tracking-widest text-[var(--neon-cyan)]">
                Direct match
              </span>
              <h3 className="truncate font-heading text-lg font-bold text-foreground">
                {directHit.name}
              </h3>
              <span className="font-mono text-xs text-muted-foreground">
                {directHit.id}
              </span>
              <span className="mt-1 inline-flex items-center gap-1 text-sm font-bold uppercase tracking-wide text-[var(--neon-cyan)]">
                Open join page <ArrowRight className="size-4" />
              </span>
            </a>
          ) : null}
        </div>
      )}
    </section>
  )
}
