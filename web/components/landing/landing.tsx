import Link from 'next/link'
import { Suspense } from 'react'
import { Archivo } from 'next/font/google'
import type { PublicRoomCard } from '@/lib/api'
import type { BountyPool } from '@/lib/bounty-api'
import { LandingHero, ReturningVisitorRedirect } from './landing-hero'
import './landing.css'

const archivo = Archivo({ subsets: ['latin'], weight: ['400', '500', '700', '800'] })

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

const STATS = [
  { big: '1s', label: 'BILLED PER SECOND' },
  { big: '3+1', label: 'PAID SEATS + FREE CO-HOST' },
  { big: '0', label: 'LOGINS TO WATCH' },
  { big: '100%', label: 'UNUSED BALANCE REFUNDED' },
]

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
    <div className={`mc-landing dark min-h-screen ${archivo.className}`}>
      <Suspense fallback={null}>
        <ReturningVisitorRedirect />
      </Suspense>

      {/* nav */}
      <header className="flex h-[72px] items-center justify-between px-6 md:px-16">
        <Link href="/?stay=1" className="text-[15px] font-[800] tracking-[0.3em] text-[var(--mcl-fg)]">
          MEGACHAT
        </Link>
        <nav aria-label="Primary" className="flex items-center gap-5 text-[12px] tracking-[0.18em] text-[var(--mcl-muted)] md:gap-8">
          <Link href="/app" className="hidden hover:text-white sm:inline">
            ROOMS
          </Link>
          <Link href="/bounty" className="hidden hover:text-white sm:inline">
            BOUNTIES
          </Link>
          <Link href="/how-it-works" className="hidden hover:text-white md:inline">
            HOW IT WORKS
          </Link>
          <Link
            href="/app"
            className="border border-[rgba(143,216,228,0.5)] px-5 py-2.5 font-[700] tracking-[0.18em] text-[var(--mcl-mint)] transition-colors hover:border-[var(--mcl-mint)]"
          >
            ENTER APP
          </Link>
        </nav>
      </header>

      {/* film hero */}
      <LandingHero />

      <main>
      {/* stat row — true product facts, not vanity metrics */}
      <section className="grid grid-cols-2 border-b border-[var(--mcl-hairline)] lg:grid-cols-4">
        {STATS.map((s, i) => (
          <div
            key={s.label}
            className={`flex flex-col gap-2 px-8 py-9 md:px-10 ${i < 3 ? 'lg:border-r lg:border-[var(--mcl-hairline)]' : ''} ${i % 2 === 0 ? 'border-r border-[var(--mcl-hairline)] lg:border-r' : ''} ${i < 2 ? 'border-b border-[var(--mcl-hairline)] lg:border-b-0' : ''}`}
          >
            <span className="text-[44px] font-[800] leading-none md:text-[54px]">{s.big}</span>
            <span className="text-[11px] tracking-[0.2em] text-[var(--mcl-dim)]">{s.label}</span>
          </div>
        ))}
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
              <span className="text-[12.5px] font-[800] tracking-[0.22em]" style={{ color: f.color }}>
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
          <span className="text-[10.5px] tracking-[0.2em] text-[var(--mcl-faint)]">
            LIVE FROM THE DIRECTORY
          </span>
        </div>
        {boardRooms.length === 0 ? (
          <div className="flex flex-col items-start gap-4 border border-dashed border-[rgba(255,255,255,0.18)] px-7 py-9">
            <p className="text-[15px] text-[var(--mcl-muted)]">
              No rooms on the board right now — the next one could be yours.
            </p>
            <Link
              href="/dashboard?new=1"
              className="bg-[var(--mcl-mint)] px-6 py-3 text-[12.5px] font-[800] tracking-[0.14em] text-[var(--mcl-mint-ink)]"
            >
              OPEN A ROOM
            </Link>
          </div>
        ) : (
          <div className="flex flex-col border-t border-[rgba(255,255,255,0.14)]">
            <div className="grid grid-cols-[2fr_1fr_1fr] gap-5 border-b border-[var(--mcl-hairline)] py-3 text-[10.5px] tracking-[0.2em] text-[var(--mcl-faint)] md:grid-cols-[2fr_1fr_1.2fr_1fr_1fr]">
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
                      <span className="text-[11.5px] font-[700] tracking-[0.16em] text-[#ffd23d]">QUEUE</span>
                    ) : onAir ? (
                      <span className="flex items-center gap-1.5 text-[11.5px] font-[700] tracking-[0.16em] text-[var(--mcl-live)]">
                        <span className="inline-block size-1.5 rounded-full bg-[var(--mcl-live)]" aria-hidden="true" />
                        ON AIR
                      </span>
                    ) : (
                      <span className="text-[11.5px] font-[700] tracking-[0.16em] text-[var(--mcl-dim)]">
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
          <Link href="/bounty" className="text-[10.5px] tracking-[0.2em] text-[var(--mcl-faint)] hover:text-white">
            THE BOUNTY BOARD →
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
              className="border border-[rgba(255,255,255,0.25)] px-6 py-3 text-[12.5px] font-[800] tracking-[0.14em] text-[var(--mcl-fg)] hover:border-white/60"
            >
              START A POOL
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
                      <span className="ml-2 text-[11px] uppercase tracking-[0.14em] text-[var(--mcl-dim)]">
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

      {/* how a seat works */}
      <section className="px-6 pb-16 pt-2 md:px-16">
        <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[22px] font-[800] tracking-[0.02em] md:text-[26px]">HOW A SEAT WORKS</h2>
          <Link
            href="/how-it-works"
            className="text-[10.5px] tracking-[0.2em] text-[var(--mcl-faint)] hover:text-white"
          >
            FULL WALKTHROUGH + FAQ →
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

      {/* statement */}
      <section className="flex flex-col items-center gap-6 px-6 pb-20 pt-10 md:px-16">
        <h2 className="max-w-[820px] text-center text-[32px] font-[800] leading-[1.08] tracking-[-0.01em] md:text-[44px]">
          A chat app for people who&apos;d rather be on TV.
        </h2>
        <p className="text-[12px] tracking-[0.18em] text-[var(--mcl-faint)]">
          CALL-IN SHOW + FACETIME + SUPERCHAT = MEGACHAT
        </p>
        <div className="flex flex-wrap items-center justify-center gap-4">
          <Link
            href="/dashboard?new=1"
            className="bg-[var(--mcl-mint)] px-8 py-4 text-[14px] font-[800] tracking-[0.14em] text-[var(--mcl-mint-ink)] transition-opacity hover:opacity-90"
          >
            CREATE A ROOM
          </Link>
          <Link
            href="/app"
            className="border border-[rgba(255,255,255,0.25)] px-8 py-[15px] text-[14px] font-[800] tracking-[0.14em] text-[var(--mcl-fg)] transition-colors hover:border-white/60"
          >
            BROWSE ROOMS
          </Link>
        </div>
        <p className="text-[12px] tracking-[0.18em] text-[var(--mcl-faint)]">
          BOUNTIES SETTLE IN USDC
        </p>
      </section>

      </main>

      {/* footer */}
      <footer className="flex flex-col items-center justify-between gap-4 border-t border-[var(--mcl-hairline)] px-6 py-7 text-[12px] tracking-[0.14em] text-[var(--mcl-faint)] md:flex-row md:px-16">
        <span className="tracking-[0.3em] text-[var(--mcl-dim)]">MEGACHAT</span>
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
