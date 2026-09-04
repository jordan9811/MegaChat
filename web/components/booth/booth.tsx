'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { listPublicRooms, type PublicRoomCard } from '@/lib/api'
import { listBountyPools, type BountyPool } from '@/lib/bounty-api'
import { AccountChip } from '@/components/account-chip'
import { formatDollars } from '@/lib/display-format'
import { roomPresentation } from '@/lib/room-browse'
import './booth.css'
import { BrandText } from '@/components/brand-text'

const ROOM_POLL_MS = 5000
const POOL_POLL_MS = 30000

const WAYS_IN = [
  {
    title: 'MegaChats',
    color: '#3ae8ff',
    body: 'Record a clip, pay for the seconds it runs, and it plays on the broadcast by itself.',
    cta: 'How MegaChats work',
    href: '/how-it-works',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    title: 'Open mic',
    color: '#b8ff45',
    body: 'Buy a live camera seat beside the streamer. Billed by the second, only while you are on air.',
    cta: 'How live seats work',
    href: '/how-it-works',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="7" width="20" height="14" rx="2" />
        <path d="M12 7V4" />
        <circle cx="12" cy="14" r="3" />
      </svg>
    ),
  },
  {
    title: 'Bounties',
    color: '#ffd23d',
    body: 'Create a bounty for someone who is not here. They claim it by going live.',
    cta: 'Browse bounties',
    href: '/bounty',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 2 4 6v6c0 5 3.4 9.4 8 10 4.6-.6 8-5 8-10V6z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    ),
  },
]

const FIGURE_TINTS = [
  'rgba(91,190,238,0.46)',
  'rgba(244,184,99,0.38)',
  'rgba(184, 255, 69, 0.36)',
  'rgba(112,189,235,0.38)',
  'rgba(255, 210, 61, 0.3)',
  'rgba(102,189,224,0.34)',
]

function meshIndex(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % 6
}

function roomHref(room: PublicRoomCard): string {
  return room.handle ? `/${room.handle}` : `/join?room=${encodeURIComponent(room.id)}`
}

function poolHref(pool: BountyPool): string {
  return pool.platform && pool.handle
    ? `/bounty/s/${encodeURIComponent(pool.platform)}/${encodeURIComponent(pool.handle)}`
    : '/bounty'
}

function platformLabel(p: string): string {
  return p.charAt(0).toUpperCase() + p.slice(1)
}

function twitchChannel(room: PublicRoomCard): string | null {
  const c = room.twitchChannel?.trim().replace(/^@/, '').toLowerCase()
  return c && room.twitchLive ? c : null
}

function RateChip({ room }: { room: PublicRoomCard }) {
  return (
    <span className="mc-bc absolute right-2.5 top-2 bg-[rgba(5,6,9,0.66)] px-2 py-1 text-[13px] font-[600] text-[var(--mcb-fg)]">
      {roomPresentation(room).rate}
    </span>
  )
}

function StateChip({ room }: { room: PublicRoomCard }) {
  const { full, onAir, state: label } = roomPresentation(room)
  const color = full ? 'var(--mcb-queue)' : onAir ? 'var(--mcb-live)' : 'var(--mcb-off)'
  return (
    <span
      className="mc-bc mc-chip-plate absolute left-3 top-2.5 flex items-center gap-1.5 text-[11px] font-[700] tracking-[0.08em]"
      style={{ color }}
    >
      <span className="inline-block size-1.5 rounded-full" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  )
}

function RoomTile({ room, hero = false }: { room: PublicRoomCard; hero?: boolean }) {
  const mesh = meshIndex(room.id)
  const channel = twitchChannel(room)
  const presentation = roomPresentation(room)
  const full = presentation.full
  // ~2-minute cache-bust bucket, same as the directory's Twitch preview
  const bust = Math.floor(Date.now() / 120000)
  return (
    <a
      href={roomHref(room)}
      className={`mc-room-tile group relative block overflow-hidden mc-mesh-${mesh} min-h-[220px]`}
    >
      {channel ? (
        <img
          key={bust}
          src={`https://static-cdn.jtvnw.net/previews-ttv/live_user_${channel}-${hero ? '1280x720' : '440x248'}.jpg?b=${bust}`}
          alt=""
          loading="lazy"
          className="absolute inset-0 size-full object-cover"
          onError={(e) => {
            e.currentTarget.style.display = 'none'
          }}
        />
      ) : (
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-[58%] size-[190px] -translate-x-1/2 rounded-full blur-[28px]"
          style={{ background: FIGURE_TINTS[mesh] }}
        />
      )}
      <span
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(to top, rgba(5, 6, 9, 0.94) 0%, rgba(5, 6, 9, 0.3) 38%, rgba(5, 6, 9, 0) 66%)',
        }}
      />
      <StateChip room={room} />
      <RateChip room={room} />
      <span className="absolute inset-x-3 bottom-2.5 flex items-end justify-between gap-2.5">
        <span className="min-w-0">
          <span
            className={`mc-bc block truncate font-[700] leading-[1.05] tracking-[0.01em] ${hero ? 'text-[34px]' : 'text-[24px]'}`}
          >
            {room.name}
          </span>
          <span className="mt-0.5 block text-[12px] font-[500] text-[var(--mcb-muted)]">
            {presentation.capabilities}
            {room.live > 0 ? ` · ${room.live} on camera` : ''}
          </span>
        </span>
        <span
          className="whitespace-nowrap px-3 py-2 text-[12.5px] font-[700] text-[#050609] transition-transform group-hover:-translate-y-0.5"
          style={{ background: full ? 'var(--mcb-queue)' : 'var(--mcb-accent)' }}
        >
          {presentation.action}
        </span>
      </span>
    </a>
  )
}

function PoolTile({ pool }: { pool: BountyPool }) {
  return (
    <Link href={poolHref(pool)} className="group relative block min-h-[180px] overflow-hidden mc-mesh-4">
      <span
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(to top, rgba(5, 6, 9, 0.94) 0%, rgba(5, 6, 9, 0.3) 40%, rgba(5, 6, 9, 0) 68%)',
        }}
      />
      <span className="mc-bc mc-chip-plate absolute left-3 top-2.5 flex items-center gap-1.5 text-[11px] font-[700] tracking-[0.08em] text-[var(--mcb-off)]">
        <span className="inline-block size-1.5 rounded-full bg-[var(--mcb-off)]" aria-hidden="true" />
        Bounty <span className="font-[500] tracking-[0]">· {pool.displayOnly ? 'example' : pool.status === 'CLAIMED' ? 'claimed' : 'view pool'}</span>
      </span>
      <span className="absolute inset-x-3 bottom-2.5 flex items-end justify-between gap-2.5">
        <span className="min-w-0">
          <span className="mc-bc block truncate text-[24px] font-[700] leading-[1.05]">
            {pool.handle ?? pool.handleKey}
          </span>
          <span className="mt-0.5 flex items-baseline gap-2 text-[12px] font-[500] text-[var(--mcb-muted)]">
            <span className="text-[14px] font-[600] text-[var(--mcb-queue)]">
              {formatDollars(pool.remaining)}
            </span>
            {pool.contributionCount} backer{pool.contributionCount === 1 ? '' : 's'}
            {pool.platform ? ` · ${platformLabel(pool.platform)}` : ''}
          </span>
        </span>
        <span className="whitespace-nowrap bg-[var(--mcb-queue)] px-3.5 py-2 text-[12.5px] font-[700] text-[#050609] transition-transform group-hover:-translate-y-0.5">
          View bounty
        </span>
      </span>
    </Link>
  )
}

function InviteTile() {
  return (
    <Link
      href="/dashboard?new=1"
      className="flex min-h-[150px] flex-col items-center justify-center gap-2.5 border border-dashed border-[rgba(242,242,244,0.3)] px-4 text-center transition-colors hover:border-[var(--mcb-accent)] md:min-h-0"
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--mcb-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
      <span className="text-[16px] font-[700] text-[var(--mcb-accent)]">Open a room</span>
      <span className="text-[12.5px] font-[500] leading-[1.5] text-[var(--mcb-dim)]">
        Your stream, your seats, your rate.
        <br />
        The next tile on this wall is yours.
      </span>
    </Link>
  )
}

export function Booth({
  initialRooms,
  initialPools,
}: {
  initialRooms: PublicRoomCard[]
  initialPools: BountyPool[]
}) {
  const [rooms, setRooms] = useState<PublicRoomCard[]>(initialRooms)
  const [pools, setPools] = useState<BountyPool[]>(initialPools)
  const [filter, setFilter] = useState<'all' | 'onair'>('all')
  const [showAll, setShowAll] = useState(false)

  // Entering the app marks the visitor as returning — the landing page
  // forwards them straight back here next time (?stay=1 opts out).
  useEffect(() => {
    try {
      window.localStorage.setItem('mc-entered', '1')
    } catch {
      /* storage blocked — bypass simply never engages */
    }
  }, [])

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const data = await listPublicRooms()
        if (alive) setRooms(data.rooms)
      } catch {
        /* keep last good data */
      }
    }
    void tick()
    const t = setInterval(tick, ROOM_POLL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const data = await listBountyPools()
        if (alive) setPools(data.pools.filter((p) => p.remaining > 0))
      } catch {
        /* bounty surface may be flag-gated off — that's a normal state */
      }
    }
    const t = setInterval(tick, POOL_POLL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const onAirCount = useMemo(
    () => rooms.filter((r) => r.live > 0 || r.twitchLive).length,
    [rooms],
  )
  const visible = useMemo(
    () => (filter === 'onair' ? rooms.filter((r) => r.live > 0 || r.twitchLive) : rooms),
    [rooms, filter],
  )
  const topPools = useMemo(
    () => [...pools].sort((a, b) => b.remaining - a.remaining),
    [pools],
  )

  const wall = visible.length >= 4
  const heroRoom = visible[0]
  const sideRooms = visible.slice(1, 3)
  const sidePools = topPools.slice(0, Math.max(0, 3 - 1 - sideRooms.length))

  return (
    <div className="mc-booth dark flex min-h-dvh flex-col">
      {/* chrome: one bar */}
      <header className="flex h-12 shrink-0 items-center justify-between px-4">
        <div className="flex items-center gap-5">
          <Link href="/?stay=1" className="mc-bc mc-booth-brand text-[19px] font-[700] tracking-[0.1em]">
            <BrandText />
          </Link>
          <span className="flex items-center gap-1.5 text-[13px] font-[600] text-[var(--mcb-live)]">
            <span className="inline-block size-1.5 rounded-full bg-[var(--mcb-live)]" aria-hidden="true" />
            {onAirCount} room{onAirCount === 1 ? '' : 's'} on air
          </span>
        </div>
        <nav className="flex items-center gap-5 text-[13px] font-[500] text-[var(--mcb-dim)]">
          <button
            type="button"
            aria-pressed={filter === 'all'}
            onClick={() => setFilter('all')}
            className={`py-3 ${filter === 'all' ? 'text-[var(--mcb-fg)] underline underline-offset-4' : 'hover:text-white'}`}
          >
            All
          </button>
          <button
            type="button"
            aria-pressed={filter === 'onair'}
            onClick={() => setFilter('onair')}
            className={`py-3 ${filter === 'onair' ? 'text-[var(--mcb-fg)] underline underline-offset-4' : 'hover:text-white'}`}
          >
            On air
          </button>
          <Link href="/bounty" className="hidden hover:text-white sm:inline">
            Bounties
          </Link>
          <a href="/demo" className="hover:text-white">Try demo</a>
          <Link href="/how-it-works" className="hidden hover:text-white md:inline">
            How it works
          </Link>
          <Link href="/dashboard?new=1" className="border border-[var(--mcb-accent)] px-3 py-2 font-[700] text-[var(--mcb-accent)] hover:bg-[rgba(58,232,255,0.1)]">
            Create room
          </Link>
          <AccountChip />
        </nav>
      </header>

      {/* the wall */}
      <main className="grow px-3 pb-6">
        <h1 className="sr-only">
          MegaChat rooms — {onAirCount} on air, {rooms.length} on the board
        </h1>
        {visible.length === 0 ? (
          <div className="grid h-full grid-cols-1 gap-1.5 md:grid-cols-[1.62fr_1fr]">
            <div className="flex flex-col items-center justify-center gap-4 border border-dashed border-[rgba(242,242,244,0.3)] px-6 text-center">
              <span className="text-[13px] font-[600] text-[var(--mcb-dim)]">
                {filter === 'onair' ? 'Nothing on air right now' : 'No rooms on the board yet'}
              </span>
              <a href="/demo" className="text-[20px] font-semibold text-[var(--mcb-accent)]">Try the demo room</a>
              <Link
                href="/dashboard?new=1"
                className="mt-1 bg-[var(--mcb-accent)] px-5 py-2.5 text-[13.5px] font-[700] text-[#050609]"
              >
                Open a room
              </Link>
            </div>
            <div className="hidden min-h-0 flex-col gap-1.5 md:flex">
              {topPools.slice(0, 2).map((p) => (
                <PoolTile key={p.handleKey} pool={p} />
              ))}
              <InviteTile />
            </div>
          </div>
        ) : wall ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {(showAll ? visible : visible.slice(0, 6)).map((room) => (
              <RoomTile key={room.id} room={room} />
            ))}
            {visible.length > 6 && <button type="button" onClick={() => setShowAll(!showAll)} className="col-span-full min-h-12 border border-[var(--mcb-hairline)] text-[14px] text-[var(--mcb-accent)]">{showAll ? 'Show fewer rooms' : `Show all ${visible.length} rooms`}</button>}
          </div>
        ) : (
          <div className="flex flex-col gap-7">
            {/* Featured room, at a sane size. A quiet night should not hand
                one room the whole viewport — that reads as an empty page,
                not a big room. */}
            <div className="grid grid-cols-1 gap-1.5 md:h-[340px] md:grid-cols-[1.35fr_1fr]">
              {heroRoom ? <RoomTile room={heroRoom} hero /> : null}
              <div className="flex flex-col gap-1.5 md:[&>*]:min-h-0 md:[&>*]:grow md:[&>*]:basis-0">
                {sideRooms.map((room) => (
                  <RoomTile key={room.id} room={room} />
                ))}
                {sidePools.map((pool) => (
                  <PoolTile key={pool.handleKey} pool={pool} />
                ))}
                <InviteTile />
              </div>
            </div>

            {/* Always true, whatever is live — the page explains itself
                instead of relying on a full board to look alive. */}
            <section className="flex flex-col gap-3">
              <h2 className="text-[18px] font-[700] tracking-[-0.01em] text-[var(--mcb-fg)]">
                How you get on a stream
              </h2>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
                {WAYS_IN.map((w) => (
                  <Link
                    key={w.title}
                    href={w.href}
                    className="group flex flex-col gap-2 border-l-2 bg-[#0a0c12] px-4 py-4 transition-colors hover:bg-[#0f1219]"
                    style={{ borderLeftColor: w.color }}
                  >
                    <span className="flex items-center gap-2.5">
                      <span style={{ color: w.color }}>{w.icon}</span>
                      <span className="text-[17px] font-[700] tracking-[-0.01em]">{w.title}</span>
                    </span>
                    <span className="text-[13px] leading-[1.5] text-[var(--mcb-muted)]">
                      {w.body}
                    </span>
                    <span
                      className="mt-auto pt-1 text-[12.5px] font-[700]"
                      style={{ color: w.color }}
                    >
                      {w.cta} &#8594;
                    </span>
                  </Link>
                ))}
              </div>
            </section>

            {/* Bounties get a real section here rather than only the thin
                rail — off-air names with money on them are content too. */}
            <section className="flex flex-col gap-3">
              <span className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-[18px] font-[700] tracking-[-0.01em] text-[var(--mcb-fg)]">
                  Bounties
                </h2>
                <Link
                  href="/bounty"
                  className="text-[13px] font-[500] text-[var(--mcb-dim)] hover:text-white"
                >
                  The bounty board &#8594;
                </Link>
              </span>
              {topPools.length > 0 ? (
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
                  {topPools.slice(0, 4).map((pool) => (
                    <PoolTile key={pool.handleKey} pool={pool} />
                  ))}
                </div>
              ) : (
                <Link
                  href="/bounty"
                  className="flex flex-col items-start gap-2 border border-dashed border-[rgba(242,242,244,0.22)] px-5 py-5 transition-colors hover:border-[var(--mcb-accent)]"
                >
                  <span className="text-[17px] font-[700] tracking-[-0.01em]">
                    No active bounties
                  </span>
                  <span className="max-w-[62ch] text-[13px] leading-[1.55] text-[var(--mcb-muted)]">
                    Choose any streamer who isn&#39;t here. Backers can add to the bounty, and the
                    first verified broadcast claims it &#8212; proof is read straight off the stream.
                  </span>
                  <span className="pt-1 text-[12.5px] font-[700] text-[var(--mcb-accent)]">
                    Start a pool &#8594;
                  </span>
                </Link>
              )}
            </section>
          </div>
        )}
      </main>

      {/* bounty rail */}
      <footer className="flex h-[72px] shrink-0 items-center gap-5 border-t border-[var(--mcb-hairline)] px-4">
        <h2 className="text-[13.5px] font-[700] leading-[1.25] text-[var(--mcb-dim)]">
          Bounties
        </h2>
        <div className="flex min-w-0 grow items-stretch gap-2 overflow-hidden">
          {topPools.length === 0 ? (
            <Link
              href="/bounty"
              className="flex grow items-center justify-center border border-dashed border-[rgba(255,255,255,0.18)] px-3 text-[13px] font-[500] text-[var(--mcb-dim)] hover:text-white"
            >
              Start a pool for any streamer →
            </Link>
          ) : (
            topPools.slice(0, 3).map((pool) => (
              <Link
                key={pool.handleKey}
                href={poolHref(pool)}
                className="flex min-w-0 grow flex-col justify-center border-l-2 border-[var(--mcb-queue)] bg-[#0a0c12] px-3 py-2 transition-colors hover:bg-[#0f1219]"
              >
                <span className="truncate text-[16px] font-[600] leading-[1.1]">
                  {pool.handle ?? pool.handleKey}
                </span>
                <span className="mt-0.5 flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 text-[13px] font-[600] text-[var(--mcb-queue)]">
                    {formatDollars(pool.remaining)}
                  </span>
                  <span className="truncate text-[12px] font-[500] text-[var(--mcb-dim)]">
                    {pool.displayOnly ? 'Example, not funded' : `${pool.contributionCount} backer${pool.contributionCount === 1 ? '' : 's'}`}
                  </span>
                </span>
              </Link>
            ))
          )}
        </div>
        <span className="hidden items-center gap-2 text-[12px] font-[500] leading-[1.35] text-[var(--mcb-muted)] lg:flex">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--mcb-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 2 4 6v6c0 5 3.4 9.4 8 10 4.6-.6 8-5 8-10V6z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          <span>
            Read back off
            <br />
            the broadcast
          </span>
        </span>
      </footer>
    </div>
  )
}
