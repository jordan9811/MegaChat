'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { fetchPublicConfig, listClaimedAirings, listPublicRooms, listRecentAirings, type ClaimedAiring, type PublicRoomCard, type RecentAiring } from '@/lib/api'
import { listBountyPools, type BountyPool } from '@/lib/bounty-api'
import { AccountChip } from '@/components/account-chip'
import { PlatformPip } from '@/components/platform-pip'
import { TwitchPreview } from '@/components/twitch-preview'
import { formatDollars } from '@/lib/display-format'
import { BOARD_RECENT_CAP, featureKinds, roomPresentation, type RewardTerms, type RoomFeature } from '@/lib/room-browse'
import './booth.css'
import { BrandText } from '@/components/brand-text'
import { FeatureTag } from '@/components/feature-tag'
import { LivenessBadge } from '@/components/liveness-badge'
import { HollerMark } from '@/components/holler-mark'
import { ThemeToggle } from '@/components/theme-toggle'
import { RecentRail } from './recent-rail'
import { ClaimedPledges } from './claimed-pledges'
import { HostFace } from './host-face'
import { SiteFooter } from '@/components/site-footer'

const ROOM_POLL_MS = 5000
const POOL_POLL_MS = 30000
const AIRING_POLL_MS = 60000
const GRID_CAP = 8
// Up to this many tiles (recent + rooms + Create room) share one big row.
const SPARSE_MAX = 4

// Filters over the rooms, not over the page: bounties keep their own rail on
// the right, so a chip that swapped the grid to bounties would just show the
// same board twice. These four are the real ways a room differs.
type ChipKey = 'all' | 'seats' | 'letters' | 'free'

// The chips pick a KIND of room; `dot` is the feature colour for the two that
// pick a feature (booth.css). There is no On air filter: the header already
// counts the rooms on air and live rooms lead the board, so a toggle repeated
// that number and, left on, turned "show every room" into a dead end (owner,
// 2026-11-09).
const CHIPS: { key: ChipKey; label: string; dot?: 'callin' | 'holler' }[] = [
  { key: 'all', label: 'All' },
  { key: 'seats', label: 'Call in', dot: 'callin' },
  { key: 'letters', label: 'Hollers', dot: 'holler' },
  { key: 'free', label: 'Free rooms' },
]

const EMPTY_COPY: Record<ChipKey, string> = {
  all: 'No rooms on the board yet.',
  seats: 'No room is selling live camera seats right now.',
  letters: 'No room is taking recorded Hollers right now.',
  free: 'No room is running free right now.',
}

function onAir(room: PublicRoomCard): boolean {
  return room.live > 0 || room.twitchLive
}

function matches(room: PublicRoomCard, chip: ChipKey): boolean {
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

/** What a room sells, as the key at the top of the board names it: the three
 *  feature colours (globals.css --f-*), in the order the product sells them. */
const FEATURE_KEY: { kind: RoomFeature; label: string }[] = [
  { kind: 'holler', label: 'Holler' },
  { kind: 'callin', label: 'Call in' },
  { kind: 'rewards', label: 'Rewards' },
]

/** A room's features as small colour squares on its picture, read with the
 *  key over the board, so the tile's text line is free for the name and the
 *  host (owner, 2026-11-09). Nothing when the room sells none of the three. */
function FeatureSquares({ room }: { room: PublicRoomCard }) {
  const kinds = featureKinds(room)
  if (!kinds.length) return null
  const names = kinds.map((k) => FEATURE_KEY.find((f) => f.kind === k)?.label ?? k)
  return (
    <span className="mcr-sq" role="img" aria-label={names.join(', ')}>
      {kinds.map((k) => (
        <i key={k} className={`is-${k}`} />
      ))}
    </span>
  )
}

/** Whose stream it is: the room's link handle, and the Twitch pip when the
 *  room follows a channel; then its seats and who is on camera. A room with
 *  none of that gets no line. */
function HostLine({ room, seats }: { room: PublicRoomCard; seats?: { taken: number; total: number } }) {
  const handle = room.handle ? `@${room.handle}` : room.twitchChannel || ''
  if (!handle && !seats && room.live <= 0) return null
  return (
    <span className="mcr-host">
      <HostFace url={room.avatarUrl ?? null} name={room.handle || room.twitchChannel || room.name} />
      {room.twitchChannel ? (
        <b className="mcr-host-pip" title={`Follows twitch.tv/${room.twitchChannel}`}>
          <PlatformPip platform="twitch" />
        </b>
      ) : null}
      {handle ? <span className="mcr-host-h">{handle}</span> : null}
      {seats ? <SeatDots {...seats} /> : null}
      {room.live > 0 ? <span className="mcr-oncam">{room.live} on camera</span> : null}
    </span>
  )
}

/** The card's media: a real Twitch preview when the channel is up AND Twitch
 *  actually has a frame for it, the house stage glow otherwise. "Otherwise"
 *  covers more than offline — a channel can be live while the CDN is still
 *  serving a black still for the size this card wants, and that falls through
 *  to the glow too. TwitchPreview owns both judgements. Scanlines sit over
 *  either outcome so one grammar reads. `linked` only on the featured card:
 *  its link is a layer over the picture, not a wrapper, so the liveness
 *  badge on top can be a button of its own (an anchor cannot hold one). A
 *  grid card lays its own link over the whole card the same way. */
function Stage({
  room,
  hero = false,
  linked = false,
}: {
  room: PublicRoomCard
  hero?: boolean
  linked?: boolean
}) {
  const { state, full, rates } = roomPresentation(room)
  const seats = rates.find((r) => r.seats)?.seats
  // `dark`: the stage is a video frame, so its chrome reads the dark tokens
  // in either theme (globals.css redeclares them on any .dark scope).
  return (
    <span className="mcr-stage dark">
      {/* The designed fallback, the same H◉ the create page shows in its
          stream preview: under everything, so a real frame covers it and the
          stage's glow plus this mark is what an empty stage shows. */}
      <span className="mcr-stage-fallback" aria-hidden="true">
        <HollerMark variant="icon" px={52} glow />
      </span>
      {/* Renders nothing at all when the channel is offline or has no usable
          frame, which is what lets the fallback above show through. It has to
          stay ahead of the chrome: neither the picture nor the scanlines nor
          the tags carry a z-index, so DOM order alone decides that the chrome
          paints over the picture rather than under it. Liveness and channel
          normalization both live inside the component — do not re-gate here. */}
      <TwitchPreview
        channel={room.twitchChannel}
        live={room.twitchLive}
        size={hero ? 'hero' : 'card'}
      />
      <span className="mcr-scan" aria-hidden="true" />
      {linked ? <a href={roomHref(room)} aria-label={room.name} className="mcr-stage-link" /> : null}
      {/* The featured stage shows the room's seats the way they sit on the
          broadcast — taken ones as guests, open ones as an empty frame — so
          what a "seat" is reads before any copy does. Decorative: the seat
          count is stated in text beside the price. */}
      {hero && seats ? (
        <span className="mcr-seats" aria-hidden="true">
          {Array.from({ length: seats.total }, (_, i) => (
            <span key={i} className={`mcr-seat ${i < seats.taken ? 'is-taken' : ''}`}>
              {i < seats.taken ? <i /> : '+'}
            </span>
          ))}
        </span>
      ) : null}
      <span className="mcr-tags">
        {onAir(room) || full || room.isDemo ? (
          <span className={`mcr-tag ${onAir(room) ? 'is-live' : full ? 'is-full' : ''}`}>
            <i aria-hidden="true" />
            {state}
          </span>
        ) : null}
        {/* Which check stands behind a Holler here right now, in a viewer's
            words; the detail opens on tap. Nothing when offline. */}
        <LivenessBadge liveness={room.liveness} audience="fan" />
      </span>
      <FeatureSquares room={room} />
    </span>
  )
}

type FeatureSize = 'normal' | 'big' | 'half'

/** A section's share of the sparse strip (booth.css .mcr-strip). */
function spanStyle(k: number): CSSProperties {
  return { ['--k' as string]: k } as CSSProperties
}

/** A room's seats as pips: solid = someone on camera, tinted = open. */
function SeatDots({ taken, total }: { taken: number; total: number }) {
  return (
    <span className="mcr-dots" role="img" aria-label={`${taken} of ${total} seats taken`}>
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={i < taken ? 'is-on' : ''} />
      ))}
    </span>
  )
}

function FeaturedRoom({ room, size = 'normal', terms }: { room: PublicRoomCard; size?: FeatureSize; terms?: RewardTerms }) {
  const { action, capabilities, full, rates } = roomPresentation({ ...room, rewards: terms })
  const kinds = featureKinds(room)
  const counts = [
    room.viewers ? `${room.viewers.toLocaleString('en-US')} watching` : '',
    room.live > 0 ? `${room.live} on camera` : '',
    room.waiting > 0 ? `${room.waiting} waiting` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className={`mcr-feat ${onAir(room) ? 'is-live' : ''} ${size === 'normal' ? '' : `is-${size}`}`}>
      <Stage room={room} hero linked />
      <div className="mcr-feat-body">
        <h2>
          <a href={roomHref(room)}>{room.name}</a>
        </h2>
        <span className="mcr-meta">
          <HostLine room={room} />
          {!kinds.length ? <span>{capabilities}</span> : null}
          {counts ? <span className="mcr-counts">{counts}</span> : null}
        </span>
        {rates.length ? (
          <dl className="mcr-rates">
            {/* One line per feature, each in its colour: Hollers, Call in
                (with its seats), then Watching in the reward's green. */}
            {rates.map((r) => (
              <div key={r.label} data-kind={r.kind}>
                <dt>
                  <span className="mcr-rate-k">
                    <i aria-hidden="true" />
                    {r.label}
                  </span>
                  {r.seats ? <SeatDots {...r.seats} /> : null}
                </dt>
                <dd>{r.rate}</dd>
              </div>
            ))}
          </dl>
        ) : null}
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

/** A tile: the picture (state, liveness, rate and the feature squares on it),
 *  then the room's name and whose it is. No monogram and no button-look label
 *  beside the name: the whole card is the link, and the name gets the row.
 *  The link is a layer over the card rather than its wrapper, so the
 *  liveness badge on the picture can open its detail on a tap. */
function RoomCard({ room }: { room: PublicRoomCard }) {
  const { rates } = roomPresentation(room)
  const seats = rates.find((r) => r.seats)?.seats
  return (
    <div className={`mcr-card ${onAir(room) ? 'is-live' : ''}`}>
      <a
        href={roomHref(room)}
        className="mcr-card-link"
        aria-label={room.handle ? `${room.name}, @${room.handle}` : room.name}
      />
      <Stage room={room} />
      <span className="mcr-card-body">
        <span className="mcr-t">
          <span className="mcr-name">{room.name}</span>
          <HostLine room={room} seats={seats} />
        </span>
      </span>
    </div>
  )
}

function OpenRoomCard() {
  return (
    <Link href="/dashboard" className="mcr-open">
      <span className="mcr-plus" aria-hidden="true">
        +
      </span>
      <strong>Create room</strong>
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
        </>
      )}
    </aside>
  )
}

export function Booth({
  initialRooms,
  initialPools,
  initialAirings = [],
  initialClaimed = [],
  contactHref,
}: {
  initialRooms: PublicRoomCard[]
  initialPools: BountyPool[]
  initialAirings?: RecentAiring[]
  initialClaimed?: ClaimedAiring[]
  /** Read on the server (CONTACT_URL), for the footer's Contact link. */
  contactHref?: string
}) {
  const [rooms, setRooms] = useState<PublicRoomCard[]>(initialRooms)
  const [pools, setPools] = useState<BountyPool[]>(initialPools)
  const [airings, setAirings] = useState<RecentAiring[]>(initialAirings)
  const [claimed, setClaimed] = useState<ClaimedAiring[]>(initialClaimed)
  const [chip, setChip] = useState<ChipKey>('all')
  const [showAll, setShowAll] = useState(false)

  // Entering the app marks the visitor as returning. Nothing reads the flag
  // since the landing's returning-visitor bypass was removed (98b6429,
  // landing-hero.tsx); it is kept so bringing the bypass back needs no data.
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

  // A broadcast that just ended should reach the board without a reload.
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const data = await listRecentAirings(BOARD_RECENT_CAP)
        if (alive) setAirings(data.airings || [])
      } catch {
        /* keep last good data */
      }
    }
    // The first HTML carries them; ask now only if it came without any (the
    // server's own fetch can fail), rather than leaving the rail out for 60s.
    if (!initialAirings.length) void tick()
    const t = setInterval(tick, AIRING_POLL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Claimed pledges ride the same clock: a broadcast that just ended with
  // pledged clips on it reaches the (closed) row's count without a reload.
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const data = await listClaimedAirings()
        if (alive) setClaimed(data.airings || [])
      } catch {
        /* keep last good data */
      }
    }
    const t = setInterval(tick, AIRING_POLL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const onAirCount = useMemo(() => rooms.filter(onAir).length, [rooms])
  const visible = useMemo(() => rooms.filter((r) => matches(r, chip)), [rooms, chip])
  const topPools = useMemo(() => [...pools].sort((a, b) => b.remaining - a.remaining), [pools])

  // WHAT FILLS THE BOARD, IN ORDER. This is the hierarchy the board has had
  // since 43b169f and lost pieces of in the cd118e7 rebuild; keep it written
  // down here so the next rebuild keeps it too.
  //   1. THE FEATURED TIER. A big stream (live on Twitch with the server's
  //      BOARD_BIG_VIEWERS or more) gets the big card — the stage takes most
  //      of the row; two big streams at once get two big cards side by side.
  //      Otherwise one card at the normal size: whatever is live (most
  //      viewers, then most on camera), else the demo — the room a first-time
  //      visitor can actually try — else whatever is hottest.
  //   2. Nothing live? Recently aired comes next, above the idle rooms: a room
  //      that was busy an hour ago is more interesting than an empty grid
  //      cell (server.js "what the board shows when nothing is live").
  //   3. The rooms, live ones first, then the server's order (most on camera,
  //      most waiting, newest), capped with a "show all".
  //   4. Create room, always the last tile.
  //   5. Something live? Recently aired follows the rooms instead.
  //   TILE SIZE FOLLOWS HOW FULL THE BOARD IS. With a handful of tiles
  //   (SPARSE_MAX) they share ONE row and split it — big, up to 520px each —
  //   so a quiet board does not look like three stamps on an empty page. Past
  //   that they drop to ~236px tiles, six across at 1920, so a busy board
  //   still fits a row of each section above the fold at 1440x900.
  //   The bounty board rides alongside all of it.
  const liveRanked = useMemo(
    () => visible.filter(onAir).sort((a, b) => (b.viewers ?? 0) - (a.viewers ?? 0) || b.live - a.live),
    [visible],
  )
  const featuredList = useMemo(() => {
    const big = liveRanked.filter((r) => r.bigStream)
    if (big.length) return big.slice(0, 2)
    const one = liveRanked[0] ?? visible.find((r) => r.isDemo || r.handle === 'demo') ?? visible[0]
    return one ? [one] : []
  }, [liveRanked, visible])
  // What watching earns lives in each room's config, which the board's room
  // loaders (lib/api listPublicRooms, lib/rooms-server) do not carry. Read it
  // for the featured cards only, the ones that print rates, from the page's
  // shared /api/config cache.
  const [rewardTermsById, setRewardTermsById] = useState<Record<string, RewardTerms>>({})
  const wantTerms = featuredList.filter((r) => r.rewardsEnabled && !(r.id in rewardTermsById)).map((r) => r.id).join(',')
  useEffect(() => {
    if (!wantTerms) return
    let alive = true
    for (const id of wantTerms.split(',')) {
      fetchPublicConfig(id)
        .then(({ ok, body }) => {
          const terms = body.rewards as RewardTerms | undefined
          if (alive && ok && terms) setRewardTermsById((current) => ({ ...current, [id]: terms }))
        })
        .catch(() => {})
    }
    return () => {
      alive = false
    }
  }, [wantTerms])
  const featuredSize: FeatureSize =
    featuredList.length === 2 ? 'half' : featuredList[0]?.bigStream ? 'big' : 'normal'
  const rest = useMemo(() => {
    const ids = new Set(featuredList.map((r) => r.id))
    const others = visible.filter((r) => !ids.has(r.id))
    return [...others.filter(onAir), ...others.filter((r) => !onAir(r))]
  }, [visible, featuredList])
  const shown = showAll ? rest : rest.slice(0, GRID_CAP)
  // Recent broadcasts are not rooms, so the chips that pick KINDS of room
  // (Call in, Hollers, free) do not show them; "All" does — "nothing is on
  // air, here is what just was".
  const recentAirings = chip === 'all' ? airings.slice(0, BOARD_RECENT_CAP) : []
  const quiet = onAirCount === 0
  const tiles = recentAirings.length + shown.length + 1 // + Create room
  const sparse = tiles <= SPARSE_MAX && rest.length <= GRID_CAP
  // Past GRID_CAP, Create room leaves the grid for the end of the "Show all"
  // row: as a tile it dropped alone onto a half-height third row whenever
  // the 8 tiles filled two rows of four.
  const capped = rest.length > GRID_CAP
  // Claimed pledges (claimed-pledges.tsx), on the "All" chip only, as Recently
  // aired is, and closed until opened. Where Recently aired stacks above the
  // rooms, the closed toggle docks on the end of its heading line and the
  // opened cards drop in between it and the rooms: a row of its own there
  // pushed the first room off the fold on a busy board (_gate-board-fold F4).
  // In the sparse strip, where the sections share one row side by side, it is
  // its own heading row under the strip — inside, it would split that row.
  const showClaimed = chip === 'all'
  const recentSection = recentAirings.length ? (
    <RecentRail
      key="recent"
      airings={recentAirings}
      span={recentAirings.length}
    />
  ) : null
  const roomsSection = (
    <section key="rooms" className="mcr-rooms" style={spanStyle(shown.length + 1)}>
      {recentSection ? <h2 className="mcr-sec-h">Rooms</h2> : null}
      <div className="mcr-grid">
        {shown.map((room) => (
          <RoomCard key={room.id} room={room} />
        ))}
        {capped ? (
          <div className="mcr-more-row">
            <button type="button" className="mcr-more" onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show fewer rooms' : `Show all ${rest.length + 1} rooms`}
            </button>
            <Link href="/dashboard" className="mcr-more-create">
              <span aria-hidden="true">+</span> Create room
            </Link>
          </div>
        ) : (
          <OpenRoomCard />
        )}
      </div>
    </section>
  )
  const claimedSection = showClaimed ? (
    <ClaimedPledges key="claimed" airings={claimed} />
  ) : null
  const sections = quiet ? [recentSection, roomsSection] : [roomsSection, recentSection]
  // Claimed pledges always comes after the rooms.
  const stacked = quiet ? [recentSection, roomsSection, claimedSection] : [roomsSection, recentSection, claimedSection]

  return (
    // No forced theme: the board follows next-themes' class on <html>, and
    // booth.css maps its colours onto the Holler tokens for both.
    <div className="mc-booth flex min-h-dvh flex-col">
      {/* chrome: one bar, on the shared header sizes (bar height, mark,
          nav type) so it does not change between the board and the rest */}
      <header className="relative flex h-[60px] shrink-0 items-center justify-between px-4">
        <div className="flex items-center gap-5">
          <Link href="/?stay=1" aria-label="Holler home" className="mc-bc mc-booth-brand">
            <BrandText />
          </Link>
          <span className={`mcr-onair ${onAirCount ? 'is-live' : ''}`}>
            <i aria-hidden="true" />
            {onAirCount} room{onAirCount === 1 ? '' : 's'} on air
          </span>
        </div>
        <nav className="flex items-center gap-5 text-[13.5px] font-[600] text-hl-muted">
          {/* The page links as one group, so a wide screen can centre them the
              way the other product headers do (booth.css .mcr-nav-links). */}
          <span className="mcr-nav-links">
            <Link href="/bounty" className="hidden hover:text-hl-fg sm:inline">
              Bounties
            </Link>
            <a href="/demo" className="hover:text-hl-fg">Try demo</a>
            <Link href="/how-it-works" className="hidden hover:text-hl-fg md:inline">
              How it works
            </Link>
          </span>
          <Link href="/dashboard" className="mcr-create">
            Create room
          </Link>
          <ThemeToggle />
          <AccountChip />
        </nav>
      </header>

      <main className="grow px-4 pb-10 pt-3.5">
        <h1 className="sr-only">
          Holler rooms — {onAirCount} on air, {rooms.length} on the board
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
              {c.dot ? <i className={`mcr-chip-dot is-${c.dot}`} aria-hidden="true" /> : null}
              {c.label}
            </button>
          ))}
          {/* The key to the squares on every tile's picture. */}
          <span className="mcr-key">
            {FEATURE_KEY.map((f) => (
              <span key={f.kind}>
                <i className={`is-${f.kind}`} aria-hidden="true" />
                {f.label}
              </span>
            ))}
          </span>
          <span className="mcr-sort">sort · hottest</span>
        </div>

        <div className="mcr-cols">
          <div className="mcr-main">
            {featuredList.length ? (
              <>
                {featuredSize === 'half' ? (
                  <div className="mcr-feat-pair">
                    {featuredList.map((room) => (
                      <FeaturedRoom key={room.id} room={room} size="half" terms={rewardTermsById[room.id]} />
                    ))}
                  </div>
                ) : (
                  <FeaturedRoom room={featuredList[0]} size={featuredSize} terms={rewardTermsById[featuredList[0].id]} />
                )}
                {sparse ? (
                  <>
                    <div className="mcr-strip" data-n={tiles} style={{ ['--n' as string]: tiles } as CSSProperties}>
                      {sections}
                    </div>
                    {claimedSection}
                  </>
                ) : (
                  stacked
                )}
              </>
            ) : (
              <div className="mcr-empty">
                <h2>{EMPTY_COPY[chip]}</h2>
                <p>
                  The demo room is always open — take a seat, record a Holler, and watch it play
                  back on the broadcast for a fraction of a cent.
                </p>
                <span className="mcr-cta">
                  <a href="/demo" className="mcr-btn">
                    Try the demo
                  </a>
                  {/* A filter emptied the board: undo it. Only an empty board
                      itself asks someone to open a room. */}
                  {chip === 'all' ? (
                    <Link href="/dashboard" className="mcr-ghost">
                      Create room
                    </Link>
                  ) : (
                    <button
                      type="button"
                      className="mcr-ghost"
                      onClick={() => {
                        setChip('all')
                        setShowAll(false)
                      }}
                    >
                      Show all rooms
                    </button>
                  )}
                </span>
              </div>
            )}
            {featuredList.length ? null : recentSection}
            {featuredList.length ? null : claimedSection}
          </div>

          <BountyBoard pools={topPools.slice(0, 5)} />
        </div>
      </main>
      {contactHref ? <SiteFooter contactHref={contactHref} /> : null}
    </div>
  )
}
