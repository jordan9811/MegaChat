'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { listPublicRooms, type PublicRoomCard } from '@/lib/api'
import { listBountyPools, type BountyPool } from '@/lib/bounty-api'
import { AccountChip } from '@/components/account-chip'
import { PlatformPip } from '@/components/platform-pip'
import { TwitchPreview } from '@/components/twitch-preview'
import { formatDollars } from '@/lib/display-format'
import { roomPresentation } from '@/lib/room-browse'
import './booth.css'
import { BrandText } from '@/components/brand-text'

const ROOM_POLL_MS = 5000
const POOL_POLL_MS = 30000
const GRID_CAP = 8

// Filters over the rooms, not over the page: bounties keep their own rail on
// the right, so a chip that swapped the grid to bounties would just show the
// same board twice. These five are the real ways a room differs.
type ChipKey = 'all' | 'live' | 'seats' | 'letters' | 'free'

const CHIPS: { key: ChipKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'live', label: 'Live now' },
  { key: 'seats', label: 'Live seats' },
  { key: 'letters', label: 'MegaChats' },
  { key: 'free', label: 'Free rooms' },
]

const EMPTY_COPY: Record<ChipKey, string> = {
  all: 'No rooms on the board yet.',
  live: 'Nothing is on air this minute.',
  seats: 'No room is selling live camera seats right now.',
  letters: 'No room is taking recorded MegaChats right now.',
  free: 'No room is running free right now.',
}

function onAir(room: PublicRoomCard): boolean {
  return room.live > 0 || room.twitchLive
}

function matches(room: PublicRoomCard, chip: ChipKey): boolean {
  if (chip === 'live') return onAir(room)
  if (chip === 'seats') return room.joinStream?.enabled === true
  if (chip === 'letters') return room.letters?.enabled === true
  if (chip === 'free') return roomPresentation(room).rate === 'Free'
  return true
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

function initial(name: string): string {
  return (name.trim().charAt(0) || '?').toUpperCase()
}

/** The card's media: a real Twitch preview when the channel is up AND Twitch
 *  actually has a frame for it, the house stage glow otherwise. "Otherwise"
 *  covers more than offline — a channel can be live while the CDN is still
 *  serving a black still for the size this card wants, and that falls through
 *  to the glow too. TwitchPreview owns both judgements. Scanlines sit over
 *  either outcome so one grammar reads. `linked` only on the featured card —
 *  a grid card is one big anchor already, and an anchor inside an anchor is
 *  not markup a browser keeps. */
function Stage({
  room,
  hero = false,
  linked = false,
}: {
  room: PublicRoomCard
  hero?: boolean
  linked?: boolean
}) {
  const { state, rate, full } = roomPresentation(room)
  const Tag = linked ? 'a' : 'span'
  return (
    <Tag
      {...(linked ? { href: roomHref(room), 'aria-label': room.name } : {})}
      className="mcr-stage"
    >
      {/* Renders nothing at all when the channel is offline or has no usable
          frame, which is what lets the stage's own glow act as the fallback.
          It has to stay FIRST here: neither the picture nor the scanlines nor
          the tags carry a z-index, so DOM order alone decides that the chrome
          paints over the picture rather than under it. Liveness and channel
          normalization both live inside the component — do not re-gate here. */}
      <TwitchPreview
        channel={room.twitchChannel}
        live={room.twitchLive}
        size={hero ? 'hero' : 'card'}
      />
      <span className="mcr-scan" aria-hidden="true" />
      <span className="mcr-tags">
        <span className={`mcr-tag ${onAir(room) ? 'is-live' : full ? 'is-full' : ''}`}>
          <i aria-hidden="true" />
          {state}
        </span>
        <span className="mcr-tag">{rate}</span>
      </span>
    </Tag>
  )
}

function FeaturedRoom({ room }: { room: PublicRoomCard }) {
  const { action, capabilities, full } = roomPresentation(room)
  return (
    <div className={`mcr-feat ${onAir(room) ? 'is-live' : ''}`}>
      <Stage room={room} hero linked />
      <div className="mcr-feat-body">
        <h2>
          <a href={roomHref(room)}>{room.name}</a>
        </h2>
        <span className="mcr-meta">
          {capabilities}
          {room.live > 0 ? ` · ${room.live} on camera` : ''}
          {room.waiting > 0 ? ` · ${room.waiting} waiting` : ''}
        </span>
        <span className="mcr-cta">
          <a href={roomHref(room)} className={`mcr-btn ${full ? 'is-queue' : ''}`}>
            {action}
          </a>
          <Link href="/how-it-works" className="mcr-ghost">
            How it works
          </Link>
        </span>
      </div>
    </div>
  )
}

function RoomCard({ room }: { room: PublicRoomCard }) {
  const { action, capabilities } = roomPresentation(room)
  return (
    <a href={roomHref(room)} className={`mcr-card ${onAir(room) ? 'is-live' : ''}`}>
      <Stage room={room} />
      <span className="mcr-card-body">
        <span className="mcr-mono" aria-hidden="true">
          {initial(room.name)}
        </span>
        <span className="mcr-t">
          <span className="mcr-name">{room.name}</span>
          <span className="mcr-sub">
            {capabilities}
            {room.live > 0 ? ` · ${room.live} on camera` : ''}
          </span>
        </span>
        <span className="mcr-ghost is-sm">{action}</span>
      </span>
    </a>
  )
}

function OpenRoomCard() {
  return (
    <Link href="/dashboard" className="mcr-open">
      <span className="mcr-plus" aria-hidden="true">
        +
      </span>
      <strong>Open a room</strong>
      <small>Your stream, your seats, your rate.</small>
    </Link>
  )
}

function BountyFace({ pool }: { pool: BountyPool }) {
  const [broken, setBroken] = useState(false)
  const handle = pool.handle ?? pool.handleKey
  return (
    <span className="mcr-face">
      {pool.avatarUrl && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={pool.avatarUrl}
          alt=""
          width={44}
          height={44}
          loading="lazy"
          onError={() => setBroken(true)}
        />
      ) : (
        <i aria-hidden="true">{initial(handle)}</i>
      )}
      <b>
        <PlatformPip platform={pool.platform} />
      </b>
    </span>
  )
}

function BountyBoard({ pools }: { pools: BountyPool[] }) {
  return (
    <aside className="mcr-board">
      <header className="mcr-board-head">
        <h2>Bounty board</h2>
        <Link href="/bounty">See the board &#8594;</Link>
      </header>
      {pools.length === 0 ? (
        <div className="mcr-board-foot">
          No pools open yet. <Link href="/bounty">Start one for any streamer &#8594;</Link>
        </div>
      ) : (
        <>
          {pools.map((pool) => (
            <Link key={pool.handleKey} href={poolHref(pool)} className="mcr-row">
              <BountyFace pool={pool} />
              <span>
                <strong>{pool.handle ?? pool.handleKey}</strong>
                <small>
                  {pool.platform ? platformLabel(pool.platform) : 'Unlisted'} ·{' '}
                  {pool.displayOnly
                    ? 'example'
                    : `${pool.contributionCount} backer${pool.contributionCount === 1 ? '' : 's'}`}
                </small>
              </span>
              <span className="mcr-money">{formatDollars(pool.remaining)}</span>
            </Link>
          ))}
          <div className="mcr-board-foot">
            Back a streamer before they have a room. They claim it by going live.
          </div>
        </>
      )}
    </aside>
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
  const [chip, setChip] = useState<ChipKey>('all')
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

  const onAirCount = useMemo(() => rooms.filter(onAir).length, [rooms])
  const visible = useMemo(() => rooms.filter((r) => matches(r, chip)), [rooms, chip])
  const topPools = useMemo(() => [...pools].sort((a, b) => b.remaining - a.remaining), [pools])

  // What earns the big card: whatever is live, else the demo — the room a
  // first-time visitor can actually try — else whatever is hottest.
  const featured = useMemo(() => {
    return (
      visible.find(onAir) ??
      visible.find((r) => r.isDemo || r.handle === 'demo') ??
      visible[0] ??
      null
    )
  }, [visible])
  const rest = useMemo(
    () => (featured ? visible.filter((r) => r.id !== featured.id) : visible),
    [visible, featured],
  )
  const shown = showAll ? rest : rest.slice(0, GRID_CAP)

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
          <Link href="/bounty" className="hidden hover:text-white sm:inline">
            Bounties
          </Link>
          <a href="/demo" className="hover:text-white">Try demo</a>
          <Link href="/how-it-works" className="hidden hover:text-white md:inline">
            How it works
          </Link>
          <Link href="/dashboard" className="border border-[var(--mcb-accent)] px-3 py-2 font-[700] text-[var(--mcb-accent)] hover:bg-[rgba(58,232,255,0.1)]">
            Create room
          </Link>
          <AccountChip />
        </nav>
      </header>

      <main className="grow px-4 pb-10 pt-3.5">
        <h1 className="sr-only">
          MegaChat rooms — {onAirCount} on air, {rooms.length} on the board
        </h1>

        {/* Filters moved out of the nav: the nav is where you leave this page,
            the chips are how you read it. */}
        <div className="mcr-chips">
          {CHIPS.map((c) => (
            <button
              key={c.key}
              type="button"
              className="mcr-chip"
              aria-pressed={chip === c.key}
              onClick={() => {
                setChip(c.key)
                setShowAll(false)
              }}
            >
              {c.label}
            </button>
          ))}
          <span className="mcr-sort">sort · hottest</span>
        </div>

        <div className="mcr-cols">
          <div>
            {featured ? (
              <>
                <FeaturedRoom room={featured} />
                <div className="mcr-grid">
                  {shown.map((room) => (
                    <RoomCard key={room.id} room={room} />
                  ))}
                  <OpenRoomCard />
                  {rest.length > GRID_CAP ? (
                    <button type="button" className="mcr-more" onClick={() => setShowAll(!showAll)}>
                      {showAll ? 'Show fewer rooms' : `Show all ${rest.length + 1} rooms`}
                    </button>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="mcr-empty">
                <h2>{EMPTY_COPY[chip]}</h2>
                <p>
                  The demo room is always open — take a seat, record a MegaChat, and watch it play
                  back on the broadcast for a fraction of a cent.
                </p>
                <span className="mcr-cta">
                  <a href="/demo" className="mcr-btn">
                    Try the demo
                  </a>
                  {chip === 'all' ? (
                    <Link href="/dashboard" className="mcr-ghost">
                      Open a room
                    </Link>
                  ) : (
                    <button type="button" className="mcr-ghost" onClick={() => setChip('all')}>
                      Show every room
                    </button>
                  )}
                </span>
              </div>
            )}
          </div>

          <BountyBoard pools={topPools.slice(0, 5)} />
        </div>
      </main>
    </div>
  )
}
