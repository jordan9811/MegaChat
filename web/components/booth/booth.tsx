'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { listPublicRooms, type PublicRoomCard } from '@/lib/api'
import { listBountyPools, type BountyPool } from '@/lib/bounty-api'
import './booth.css'

const ROOM_POLL_MS = 5000
const POOL_POLL_MS = 30000

const FIGURE_TINTS = [
  'rgba(96,164,190,0.5)',
  'rgba(206,120,140,0.44)',
  'rgba(112,186,138,0.42)',
  'rgba(150,138,216,0.42)',
  'rgba(190,170,120,0.28)',
  'rgba(110,150,170,0.34)',
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

function twitchChannel(room: PublicRoomCard): string | null {
  const c = room.twitchChannel?.trim().replace(/^@/, '').toLowerCase()
  return c && room.twitchLive ? c : null
}

function RateChip({ room }: { room: PublicRoomCard }) {
  return (
    <span className="mc-bc absolute right-2.5 top-2 bg-[rgba(8,8,10,0.55)] px-2 py-1 text-[13px] font-[600] tracking-[0.06em] text-[var(--mcb-fg)]">
      <span className="adv-only">
        {room.passkeyTickPrice} {room.paymentTokenSymbol}
      </span>
      <span className="simple-only">${room.passkeyTickPrice}</span>
      <span> / {room.passkeyTickSeconds}s</span>
    </span>
  )
}

function StateChip({ room }: { room: PublicRoomCard }) {
  const full = room.live >= room.maxSeats
  const onAir = room.live > 0 || room.twitchLive
  const color = full ? 'var(--mcb-queue)' : onAir ? 'var(--mcb-live)' : 'var(--mcb-off)'
  const label = full ? 'FULL' : onAir ? 'ON AIR' : 'OPEN'
  return (
    <span
      className="mc-bc absolute left-3 top-2.5 flex items-center gap-1.5 text-[11px] font-[700] tracking-[0.16em]"
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
  const full = room.live >= room.maxSeats
  // ~2-minute cache-bust bucket, same as the directory's Twitch preview
  const bust = Math.floor(Date.now() / 120000)
  return (
    <Link
      href={roomHref(room)}
      className={`group relative block overflow-hidden mc-mesh-${mesh} min-h-0`}
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
            'linear-gradient(to top, rgba(8,8,10,0.92) 0%, rgba(8,8,10,0.28) 34%, rgba(8,8,10,0) 62%)',
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
          <span className="mc-bc mt-0.5 block text-[11px] font-[500] tracking-[0.14em] text-[var(--mcb-muted)]">
            {room.live} OF {room.maxSeats} ON CAMERA
            {room.waiting > 0 ? ` · ${room.waiting} WAITING` : ''}
            {room.twitchChannel ? ' · TWITCH' : ''}
            {room.rewardsEnabled ? ' · DROPS' : ''}
          </span>
        </span>
        <span
          className="mc-bc whitespace-nowrap px-3 py-2 text-[11px] font-[700] tracking-[0.14em] text-[#08080a] transition-transform group-hover:-translate-y-0.5"
          style={{ background: full ? 'var(--mcb-queue)' : '#f2f2f4' }}
        >
          {full ? 'JOIN QUEUE' : 'TAKE A SEAT'}
        </span>
      </span>
    </Link>
  )
}

function PoolTile({ pool }: { pool: BountyPool }) {
  return (
    <Link href={poolHref(pool)} className="group relative block min-h-0 overflow-hidden mc-mesh-4">
      <span
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(to top, rgba(8,8,10,0.92) 0%, rgba(8,8,10,0.28) 40%, rgba(8,8,10,0) 66%)',
        }}
      />
      <span className="mc-bc absolute left-3 top-2.5 flex items-center gap-1.5 text-[11px] font-[700] tracking-[0.16em] text-[var(--mcb-off)]">
        <span className="inline-block size-1.5 rounded-full bg-[var(--mcb-off)]" aria-hidden="true" />
        OFF AIR · BOUNTY OPEN
      </span>
      <span className="absolute inset-x-3 bottom-2.5 flex items-end justify-between gap-2.5">
        <span className="min-w-0">
          <span className="mc-bc block truncate text-[24px] font-[700] leading-[1.05]">
            {pool.handle ?? pool.handleKey}
          </span>
          <span className="mc-bc mt-0.5 flex items-baseline gap-2 text-[11px] font-[500] tracking-[0.14em] text-[var(--mcb-muted)]">
            <span className="text-[14px] font-[600] text-[var(--mcb-queue)]">
              {pool.remaining.toFixed(2)} USDC
            </span>
            {pool.contributionCount} BACKER{pool.contributionCount === 1 ? '' : 'S'}
            {pool.platform ? ` · ${pool.platform.toUpperCase()}` : ''}
          </span>
        </span>
        <span className="mc-bc whitespace-nowrap bg-[var(--mcb-accent)] px-3.5 py-2 text-[11px] font-[700] tracking-[0.14em] text-[#08080a] transition-transform group-hover:-translate-y-0.5">
          CLAIM
        </span>
      </span>
    </Link>
  )
}

function InviteTile() {
  return (
    <Link
      href="/dashboard"
      className="flex min-h-0 flex-col items-center justify-center gap-2.5 border border-dashed border-[rgba(242,242,244,0.3)] px-4 text-center transition-colors hover:border-[var(--mcb-accent)]"
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--mcb-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
      <span className="mc-bc text-[15px] font-[700] tracking-[0.16em] text-[var(--mcb-accent)]">
        OPEN A ROOM
      </span>
      <span className="mc-bc text-[12px] font-[500] leading-[1.5] tracking-[0.1em] text-[var(--mcb-dim)]">
        YOUR STREAM / YOUR SEATS / YOUR RATE
        <br />
        THE NEXT TILE ON THIS WALL IS YOURS
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
    <div className="mc-booth dark flex h-dvh min-h-[640px] flex-col overflow-hidden">
      {/* chrome: one bar */}
      <header className="flex h-12 shrink-0 items-center justify-between px-4">
        <div className="flex items-center gap-5">
          <Link href="/?stay=1" className="mc-bc text-[19px] font-[700] tracking-[0.1em]">
            MEGACHAT
          </Link>
          <span className="mc-bc flex items-center gap-1.5 text-[12px] font-[600] tracking-[0.16em] text-[var(--mcb-accent)]">
            <span className="inline-block size-1.5 rounded-full bg-[var(--mcb-accent)]" aria-hidden="true" />
            {onAirCount} ROOM{onAirCount === 1 ? '' : 'S'} ON AIR
          </span>
        </div>
        <nav className="mc-bc flex items-center gap-5 text-[12px] tracking-[0.14em] text-[var(--mcb-dim)]">
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={filter === 'all' ? 'text-[var(--mcb-fg)]' : 'hover:text-white'}
          >
            ALL
          </button>
          <button
            type="button"
            onClick={() => setFilter('onair')}
            className={filter === 'onair' ? 'text-[var(--mcb-fg)]' : 'hover:text-white'}
          >
            ON AIR
          </button>
          <Link href="/bounty" className="hidden hover:text-white sm:inline">
            BOUNTIES
          </Link>
          <Link href="/how-it-works" className="hidden hover:text-white md:inline">
            HOW IT WORKS
          </Link>
          <Link
            href="/dashboard"
            className="bg-[#f2f2f4] px-3.5 py-[7px] font-[700] text-[#08080a]"
          >
            SIGN IN
          </Link>
        </nav>
      </header>

      {/* the wall */}
      <main className="min-h-0 grow px-3 pb-0">
        {visible.length === 0 ? (
          <div className="grid h-full grid-cols-1 gap-1.5 md:grid-cols-[1.62fr_1fr]">
            <div className="flex flex-col items-center justify-center gap-4 border border-dashed border-[rgba(242,242,244,0.3)] px-6 text-center">
              <span className="mc-bc text-[13px] font-[600] tracking-[0.2em] text-[var(--mcb-dim)]">
                {filter === 'onair' ? 'NOTHING ON AIR RIGHT NOW' : 'NO ROOMS ON THE BOARD YET'}
              </span>
              <span className="mc-bc max-w-[420px] text-[26px] font-[700] leading-[1.15] tracking-[0.02em]">
                THE FIRST TILE ON THIS WALL IS YOURS.
              </span>
              <Link
                href="/dashboard"
                className="mc-bc mt-1 bg-[var(--mcb-accent)] px-5 py-2.5 text-[12px] font-[700] tracking-[0.14em] text-[#08080a]"
              >
                OPEN A ROOM
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
          <div className="grid h-full grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3 xl:grid-rows-2">
            {visible.slice(0, 5).map((room) => (
              <RoomTile key={room.id} room={room} />
            ))}
            {visible.length > 6 ? (
              <Link
                href="/legacy#browse"
                className="mc-bc flex items-center justify-center border border-dashed border-[rgba(242,242,244,0.3)] text-[13px] font-[700] tracking-[0.16em] text-[var(--mcb-dim)] hover:text-white"
              >
                +{visible.length - 5} MORE ROOMS
              </Link>
            ) : visible[5] ? (
              <RoomTile room={visible[5]} />
            ) : (
              <InviteTile />
            )}
          </div>
        ) : (
          <div className="grid h-full grid-cols-1 gap-1.5 md:grid-cols-[1.62fr_1fr]">
            {heroRoom ? <RoomTile room={heroRoom} hero /> : null}
            <div className="flex min-h-0 flex-col gap-1.5">
              {sideRooms.map((room) => (
                <RoomTile key={room.id} room={room} />
              ))}
              {sidePools.map((pool) => (
                <PoolTile key={pool.handleKey} pool={pool} />
              ))}
              <InviteTile />
            </div>
          </div>
        )}
      </main>

      {/* bounty rail */}
      <footer className="flex h-[72px] shrink-0 items-center gap-5 border-t border-[var(--mcb-hairline)] px-4">
        <span className="mc-bc text-[12px] font-[700] leading-[1.25] tracking-[0.16em] text-[var(--mcb-dim)]">
          HELD FOR
          <br />
          STREAMERS
        </span>
        <div className="flex min-w-0 grow items-stretch gap-2 overflow-hidden">
          {topPools.length === 0 ? (
            <Link
              href="/bounty"
              className="mc-bc flex grow items-center justify-center border border-dashed border-[rgba(255,255,255,0.18)] px-3 text-[11px] tracking-[0.16em] text-[var(--mcb-dim)] hover:text-white"
            >
              START A POOL FOR ANY STREAMER →
            </Link>
          ) : (
            topPools.slice(0, 4).map((pool) => (
              <Link
                key={pool.handleKey}
                href={poolHref(pool)}
                className="flex min-w-0 grow flex-col justify-center border-l-2 border-[var(--mcb-accent)] bg-[#101014] px-3 py-2 transition-colors hover:bg-[#16161c]"
              >
                <span className="mc-bc truncate text-[16px] font-[600] leading-[1.1]">
                  {pool.handle ?? pool.handleKey}
                </span>
                <span className="mt-0.5 flex items-baseline gap-2">
                  <span className="text-[13px] font-[600] text-[var(--mcb-accent)]">
                    {pool.remaining.toFixed(2)}
                  </span>
                  <span className="mc-bc text-[11px] font-[500] tracking-[0.12em] text-[var(--mcb-dim)]">
                    {pool.contributionCount} BACKER{pool.contributionCount === 1 ? '' : 'S'}
                  </span>
                </span>
              </Link>
            ))
          )}
        </div>
        <span className="mc-bc hidden items-center gap-2 text-[11px] font-[600] leading-[1.3] tracking-[0.13em] text-[var(--mcb-muted)] lg:flex">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--mcb-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 2 4 6v6c0 5 3.4 9.4 8 10 4.6-.6 8-5 8-10V6z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          <span>
            READ BACK OFF
            <br />
            THE BROADCAST
          </span>
        </span>
      </footer>
    </div>
  )
}
