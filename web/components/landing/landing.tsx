import Link from 'next/link'
import { Archivo, Plus_Jakarta_Sans } from 'next/font/google'
import type { PublicRoomCard } from '@/lib/api'
import type { BountyPool } from '@/lib/bounty-api'
import { LandingHero } from './landing-hero'
import './landing.css'

// Jakarta runs the page; Archivo is kept for the hero headline alone,
// where its density is the reason the line lands.
const ui = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-ui',
})
const display = Archivo({ subsets: ['latin'], weight: ['800'], variable: '--font-display' })

function roomHref(room: PublicRoomCard): string {
  return room.handle ? `/${room.handle}` : `/join?room=${encodeURIComponent(room.id)}`
}

function poolHref(pool: BountyPool): string {
  return pool.platform && pool.handle
    ? `/bounty/s/${encodeURIComponent(pool.platform)}/${encodeURIComponent(pool.handle)}`
    : '/bounty'
}

// Prices arrive as strings from the server config; show them verbatim in the
// site's dual register (advanced = token units, simple = dollars) via the
// existing html[data-ui] CSS switch.
function Rate({ room }: { room: PublicRoomCard }) {
  return (
    <span className="font-[700] text-[var(--mcl-mint)]">
      <span className="adv-only">
        {room.passkeyTickPrice} {room.paymentTokenSymbol}
      </span>
      <span className="simple-only">${room.passkeyTickPrice}</span>
      <span className="text-[var(--mcl-dim)]"> / {room.passkeyTickSeconds}s</span>
    </span>
  )
}

const FEATURES = [
  {
    kicker: 'SEATS',
    color: '#9b6bff',
    body: 'Three paid camera seats per room, right on the broadcast — plus a pinned co-host who rides free. When they fill, a queue forms; being visible is the whole point.',
  },
  {
    kicker: 'THE METER',
    color: '#c05ce0',
    body: 'Streamers set a per-second rate. It runs while your camera is live and stops the instant you leave. No subscriptions, no minimums.',
  },
  {
    kicker: 'BOUNTIES',
    color: '#f0246f',
    body: "Want a streamer who isn't here? Stack USDC on their name with everyone else who wants them. The first verified broadcast takes the pool.",
  },
  {
    kicker: 'NO WALL',
    color: '#8fd8e4',
    body: 'Every room is watchable without an account. Sign-up starts at the moment you want on camera, not a second before.',
  },
]

// "Compatible with" marks. Paths are the single-path monochrome versions
// from simple-icons (CC0), drawn in one muted colour via currentColor so the
// band reads as one row rather than five brand palettes fighting.
//
// The overlay is an OBS browser source, so it is genuinely platform-agnostic
// — this claim is about the overlay, not about bounty verification, which is
// only proven end-to-end on Twitch and pump.fun so far.
//
// pump.fun has no icon in any published set; its capsule is drawn below.
// Swap `path` for the official vector if we ever get one.
const PLATFORMS: { name: string; path?: string }[] = [
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

// Icon-only at ~2x, sitting at low opacity so the row reads as texture over
// the page rather than a panel of five logos demanding attention. It lifts
// to full on hover.
function PlatformMark({ p }: { p: { name: string; path?: string } }) {
  const cls =
    'shrink-0 opacity-45 transition-opacity duration-200 hover:opacity-100'
  // pump.fun: the capsule, at the same optical size as the icon marks. The
  // split is painted in the page ground rather than cut out, which is fine
  // because this strip sits straight on --mcl-bg with nothing behind it.
  if (!p.path) {
    return (
      <svg
        viewBox="0 0 24 24"
        className={`${cls} size-[38px] text-[var(--mcl-fg)] md:size-[46px]`}
        fill="currentColor"
        role="img"
        aria-label={p.name}
      >
        <title>{p.name}</title>
        <g transform="rotate(-45 12 12)">
          {/* rotating a rect shrinks its footprint to (w+h)·cos45, so the
              geometry is oversized here to match the other marks optically */}
          <rect x="0.5" y="7.25" width="23" height="9.5" rx="4.75" />
          <rect x="11.3" y="7.25" width="1.4" height="9.5" fill="var(--mcl-bg)" />
        </g>
      </svg>
    )
  }
  return (
    <svg
      viewBox="0 0 24 24"
      className={`${cls} size-[38px] text-[var(--mcl-fg)] md:size-[46px]`}
      fill="currentColor"
      role="img"
      aria-label={p.name}
    >
      <title>{p.name}</title>
      <path d={p.path} />
    </svg>
  )
}

const STEPS = [
  {
    n: '01',
    title: 'Pick a live room',
    body: 'Browse everything on the board and watch without an account.',
  },
  {
    n: '02',
    title: 'Take a seat',
    body: "Claim a paid camera seat at the streamer's per-second rate. Billing starts when your camera goes live.",
  },
  {
    n: '03',
    title: 'Leave whenever',
    body: 'The meter stops that second — every unspent cent refunds straight back to your wallet.',
  },
]

export function Landing({
  rooms,
  pools,
  contactHref,
}: {
  rooms: PublicRoomCard[]
  pools: BountyPool[]
  contactHref: string
}) {
  const boardRooms = rooms.slice(0, 6)
  const boardPools = [...pools].sort((a, b) => b.remaining - a.remaining).slice(0, 3)

  return (
    <div className={`mc-landing dark min-h-screen ${ui.variable} ${display.variable}`}>
      {/* nav */}
      <header className="flex h-[72px] items-center justify-between px-6 md:px-16">
        <Link href="/?stay=1" className="text-[15px] font-[800] tracking-[0.2em] text-[var(--mcl-fg)]">
          MEGACHAT
        </Link>
        <nav aria-label="Primary" className="flex items-center gap-5 text-[13.5px] font-[500] text-[var(--mcl-muted)] md:gap-8">
          <Link href="/app" className="hidden hover:text-white sm:inline">
            Rooms
          </Link>
          <Link href="/bounty" className="hidden hover:text-white sm:inline">
            Bounties
          </Link>
          <Link href="/how-it-works" className="hidden hover:text-white md:inline">
            How it works
          </Link>
          <Link
            href="/app"
            className="border border-[rgba(143,216,228,0.5)] px-5 py-2.5 font-[700] text-[var(--mcl-mint)] transition-colors hover:border-[var(--mcl-mint)]"
          >
            Enter app
          </Link>
        </nav>
      </header>

      {/* film hero */}
      <LandingHero />

      <main>
      {/* Works-with band. No panel, no fill — the marks sit straight on the
          page at low opacity so the strip reads as a watermark under the
          hero rather than a logo wall. */}
      <section className="flex flex-wrap items-center gap-x-10 gap-y-7 border-b border-[var(--mcl-hairline)] px-6 py-10 md:gap-x-14 md:px-16">
        <span className="text-[10.5px] font-[700] uppercase tracking-[0.2em] text-[var(--mcl-faint)]">
          Compatible with
        </span>
        {PLATFORMS.map((p) => (
          <PlatformMark key={p.name} p={p} />
        ))}
      </section>

      {/* how a seat works — moved up from the bottom of the page: it is what
          a first-time reader needs immediately after the hero, not after
          three sections of board data. */}
      <section className="px-6 pb-8 pt-12 md:px-16">
        <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[22px] font-[800] tracking-[0.02em] md:text-[26px]">HOW A SEAT WORKS</h2>
          <Link
            href="/how-it-works"
            className="text-[12.5px] text-[var(--mcl-faint)] hover:text-white"
          >
            Full walkthrough + FAQ →
          </Link>
        </div>
        <div className="flex flex-col">
          {STEPS.map((s, i) => (
            <div
              key={s.n}
              className={`grid grid-cols-[56px_minmax(0,1fr)] items-baseline gap-4 border-t border-[rgba(255,255,255,0.12)] py-6 md:grid-cols-[90px_minmax(0,1fr)_minmax(0,1.4fr)] md:gap-7 ${i === STEPS.length - 1 ? 'border-b border-[rgba(255,255,255,0.12)]' : ''}`}
            >
              <span className="text-[15px] font-[800] text-[var(--mcl-mint)]">{s.n}</span>
              <span className="text-[16.5px] font-[700]">{s.title}</span>
              <p className="col-span-2 text-[14.5px] leading-relaxed text-[var(--mcl-muted)] md:col-span-1">
                {s.body}
              </p>
            </div>
          ))}
        </div>
      </section>


      {/* feature rows */}
      <section className="px-6 pb-10 pt-16 md:px-16">
        <h2 className="mb-6 text-[24px] font-[800] tracking-[0.01em] md:text-[30px]">
          THE ONLY CHAT THAT PAYS YOU BACK IN AIR TIME
        </h2>
        <div className="flex flex-col">
          {FEATURES.map((f, i) => (
            <div
              key={f.kicker}
              className={`grid grid-cols-1 items-baseline gap-2 border-t border-[rgba(255,255,255,0.12)] py-6 md:grid-cols-[220px_minmax(0,1fr)] md:gap-8 ${i === FEATURES.length - 1 ? 'border-b border-[rgba(255,255,255,0.12)]' : ''}`}
            >
              <span className="text-[12.5px] font-[800] tracking-[0.12em]" style={{ color: f.color }}>
                {f.kicker}
              </span>
              <p className="text-[15px] leading-relaxed text-[var(--mcl-muted)] md:text-[15.5px]">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* live rooms table — real data from the directory */}
      <section className="px-6 pb-16 pt-6 md:px-16">
        <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[22px] font-[800] tracking-[0.02em] md:text-[26px]">ON THE BOARD</h2>
          <span className="text-[12.5px] text-[var(--mcl-faint)]">Live from the directory</span>
        </div>
        {boardRooms.length === 0 ? (
          <div className="flex flex-col items-start gap-4 border border-dashed border-[rgba(255,255,255,0.18)] px-7 py-9">
            <p className="text-[15px] text-[var(--mcl-muted)]">
              No rooms on the board right now — the next one could be yours.
            </p>
            <Link
              href="/dashboard?new=1"
              className="bg-[var(--mcl-mint)] px-6 py-3 text-[14px] font-[800] text-[var(--mcl-mint-ink)]"
            >
              Open a room
            </Link>
          </div>
        ) : (
          <div className="flex flex-col border-t border-[rgba(255,255,255,0.14)]">
            <div className="grid grid-cols-[2fr_1fr_1fr] gap-5 border-b border-[var(--mcl-hairline)] py-3 text-[11px] font-[600] tracking-[0.1em] text-[var(--mcl-faint)] md:grid-cols-[2fr_1fr_1.2fr_1fr_1fr]">
              <span>ROOM</span>
              <span className="hidden md:inline">PLATFORM</span>
              <span className="hidden md:inline">ON CAMERA</span>
              <span>RATE</span>
              <span className="text-right">STATUS</span>
            </div>
            {boardRooms.map((room) => {
              const onAir = room.live > 0 || room.twitchLive
              const full = room.live >= room.maxSeats
              return (
                <a
                  key={room.id}
                  href={roomHref(room)}
                  className="grid grid-cols-[2fr_1fr_1fr] items-center gap-5 border-b border-[var(--mcl-hairline)] py-5 text-[15px] transition-colors hover:bg-white/[0.03] md:grid-cols-[2fr_1fr_1.2fr_1fr_1fr]"
                >
                  <span className="truncate font-[700]">{room.name}</span>
                  <span className="hidden text-[var(--mcl-muted)] md:inline">
                    {room.twitchChannel ? 'Twitch' : '—'}
                  </span>
                  <span className="hidden text-[var(--mcl-muted)] md:inline">
                    {room.live}/{room.maxSeats}
                    {room.waiting > 0 ? ` · ${room.waiting} waiting` : ''}
                  </span>
                  <Rate room={room} />
                  <span className="flex justify-end">
                    {full ? (
                      <span className="text-[11.5px] font-[700] tracking-[0.08em] text-[#ffd23d]">QUEUE</span>
                    ) : onAir ? (
                      <span className="flex items-center gap-1.5 text-[11.5px] font-[700] tracking-[0.08em] text-[var(--mcl-live)]">
                        <span className="inline-block size-1.5 rounded-full bg-[var(--mcl-live)]" aria-hidden="true" />
                        ON AIR
                      </span>
                    ) : (
                      <span className="text-[11.5px] font-[700] tracking-[0.08em] text-[var(--mcl-dim)]">
                        OPEN SEATS
                      </span>
                    )}
                  </span>
                </a>
              )
            })}
          </div>
        )}
      </section>

      {/* bounty board */}
      <section className="px-6 pb-16 pt-2 md:px-16">
        <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[22px] font-[800] tracking-[0.02em] md:text-[26px]">HELD FOR STREAMERS</h2>
          <Link href="/bounty" className="text-[12.5px] text-[var(--mcl-faint)] hover:text-white">
            The bounty board →
          </Link>
        </div>
        {boardPools.length === 0 ? (
          <div className="flex flex-col items-start gap-4 border border-dashed border-[rgba(255,255,255,0.18)] px-7 py-9">
            <p className="max-w-[560px] text-[15px] leading-relaxed text-[var(--mcl-muted)]">
              Fans pool USDC for streamers who aren&apos;t here yet — the first verified broadcast
              claims the pool, and proof is read off the stream itself.
            </p>
            <Link
              href="/bounty"
              className="border border-[rgba(255,255,255,0.25)] px-6 py-3 text-[14px] font-[800] text-[var(--mcl-fg)] hover:border-white/60"
            >
              Start a pool
            </Link>
          </div>
        ) : (
          <>
            <div className="flex flex-col border-t border-[rgba(255,255,255,0.14)]">
              {boardPools.map((pool, i) => (
                <Link
                  key={pool.handleKey}
                  href={poolHref(pool)}
                  className="grid grid-cols-[44px_2fr_1fr_1fr] items-center gap-4 border-b border-[var(--mcl-hairline)] py-4 text-[15px] transition-colors hover:bg-white/[0.03] md:gap-5"
                >
                  <span className={`font-[800] ${i === 0 ? 'text-[var(--mcl-mint)]' : 'text-[var(--mcl-dim)]'}`}>
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="truncate font-[700]">
                    {pool.handle ?? pool.handleKey}
                    {pool.platform ? (
                      <span className="ml-2 text-[11px] uppercase tracking-[0.08em] text-[var(--mcl-dim)]">
                        {pool.platform}
                      </span>
                    ) : null}
                  </span>
                  <span className="font-[700] text-[var(--mcl-mint)]">{pool.remaining.toFixed(2)} USDC</span>
                  <span className="text-right text-[var(--mcl-dim)]">
                    {pool.contributionCount} backer{pool.contributionCount === 1 ? '' : 's'}
                  </span>
                </Link>
              ))}
            </div>
            <p className="mt-4 max-w-[640px] text-[13.5px] leading-relaxed text-[var(--mcl-dim)]">
              A pool pays out to its streamer&apos;s first verified broadcast — proof is read off the
              stream itself. Anyone can pledge to any name.
            </p>
          </>
        )}
      </section>

      {/* statement */}
      <section className="flex flex-col items-center gap-6 px-6 pb-20 pt-10 md:px-16">
        <h2 className="max-w-[820px] text-center text-[40px] font-[800] leading-[1.05] tracking-[-0.02em] md:text-[64px]">
          You&apos;re more than a username.
        </h2>
        <p className="text-[12px] tracking-[0.12em] text-[var(--mcl-faint)]">
          CALL-IN SHOW + FACETIME + SUPERCHAT = MEGACHAT
        </p>
        <div className="flex flex-wrap items-center justify-center gap-4">
          <Link
            href="/dashboard?new=1"
            className="bg-[var(--mcl-mint)] px-8 py-4 text-[15px] font-[800] text-[var(--mcl-mint-ink)] transition-opacity hover:opacity-90"
          >
            Create a room
          </Link>
          <Link
            href="/app"
            className="border border-[rgba(255,255,255,0.25)] px-8 py-[15px] text-[15px] font-[800] text-[var(--mcl-fg)] transition-colors hover:border-white/60"
          >
            Browse rooms
          </Link>
        </div>
        <p className="text-[12.5px] text-[var(--mcl-faint)]">Bounties settle in USDC</p>
      </section>

      </main>

      {/* footer */}
      <footer className="flex flex-col items-center justify-between gap-4 border-t border-[var(--mcl-hairline)] px-6 py-7 text-[13px] text-[var(--mcl-faint)] md:flex-row md:px-16">
        <span className="tracking-[0.2em] text-[var(--mcl-dim)]">MEGACHAT</span>
        <nav aria-label="Footer" className="flex flex-wrap items-center justify-center gap-5 md:gap-7">
          <Link href="/app" className="hover:text-white">
            Rooms
          </Link>
          <Link href="/bounty" className="hover:text-white">
            Bounties
          </Link>
          <Link href="/how-it-works" className="hover:text-white">
            How it works
          </Link>
          <Link href="/roadmap" className="hover:text-white">
            Roadmap
          </Link>
          <Link href="/legacy" className="hover:text-white">
            Legacy site
          </Link>
          <a href={contactHref} target="_blank" rel="noreferrer" className="hover:text-white">
            Contact
          </a>
        </nav>
      </footer>
    </div>
  )
}
