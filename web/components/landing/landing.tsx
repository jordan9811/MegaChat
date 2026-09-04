import Link from 'next/link'
import { Archivo, Plus_Jakarta_Sans } from 'next/font/google'
import {
  ArrowRight,
  Clock3,
  Fingerprint,
  MessageSquareText,
  MonitorPlay,
  RefreshCcw,
  Trophy,
  Video,
} from 'lucide-react'
import type { PublicRoomCard } from '@/lib/api'
import type { BountyPool } from '@/lib/bounty-api'
import { formatDollars } from '@/lib/display-format'
import { LandingHero } from './landing-hero'
import './landing.css'

const ui = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-ui',
})

// The original hero treatment stays on Archivo. Product UI remains Jakarta.
const display = Archivo({ subsets: ['latin'], weight: ['800'], variable: '--font-display' })

function poolHref(pool: BountyPool): string {
  return pool.platform && pool.handle
    ? `/bounty/s/${encodeURIComponent(pool.platform)}/${encodeURIComponent(pool.handle)}`
    : '/bounty'
}

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

function PlatformMark({ p }: { p: { name: string; path?: string } }) {
  const cls = 'mcl-platform-mark shrink-0 opacity-45 transition-opacity duration-200 hover:opacity-100'
  if (!p.path) {
    return (
      <svg viewBox="0 0 24 24" className={`${cls} size-[38px] md:size-[46px]`} fill="currentColor" role="img" aria-label={p.name}>
        <title>{p.name}</title>
        <g transform="rotate(-45 12 12)">
          <rect x="0.5" y="7.25" width="23" height="9.5" rx="4.75" />
          <rect x="11.3" y="7.25" width="1.4" height="9.5" fill="var(--mcl-bg)" />
        </g>
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" className={`${cls} size-[38px] md:size-[46px]`} fill="currentColor" role="img" aria-label={p.name}>
      <title>{p.name}</title>
      <path d={p.path} />
    </svg>
  )
}

const ENTRY_PATHS = [
  {
    n: '01',
    tone: 'blue',
    icon: MessageSquareText,
    title: 'Record a MegaChat',
    body: 'Say it on camera. Set the clip loose on their broadcast.',
    cta: 'Find a streamer',
    href: '/app',
  },
  {
    n: '02',
    tone: 'green',
    icon: Video,
    title: 'Take a live seat',
    body: 'Join face-to-face and pay only for the seconds you use.',
    cta: 'Browse rooms',
    href: '/app',
  },
  {
    n: '03',
    tone: 'yellow',
    icon: Trophy,
    title: 'Start a bounty',
    body: 'Back a streamer before they have a room. They claim it by going live.',
    cta: 'Browse bounties',
    href: '/bounty',
  },
] as const

const PROOFS = [
  { icon: Clock3, title: 'Per-second', body: 'not per session' },
  { icon: Fingerprint, title: 'One-tap sign in', body: 'no seed phrase' },
  { icon: RefreshCcw, title: 'Automatic refunds', body: 'unused stays yours' },
  { icon: MonitorPlay, title: 'Built for OBS', body: 'one browser source' },
]

export function Landing({
  rooms: _rooms,
  pools,
  contactHref,
}: {
  rooms: PublicRoomCard[]
  pools: BountyPool[]
  contactHref: string
}) {
  const boardPools = [...pools].sort((a, b) => b.remaining - a.remaining).slice(0, 3)
  return (
    <div className={`mc-landing dark min-h-screen ${ui.variable} ${display.variable}`}>
      <header className="flex h-[72px] items-center justify-between px-6 md:px-16">
        <Link href="/?stay=1" className="text-[15px] font-[800] tracking-[0.2em] text-[var(--mcl-fg)]">MEGACHAT</Link>
        <nav aria-label="Primary" className="flex items-center gap-5 text-[13.5px] font-[500] text-[var(--mcl-muted)] md:gap-8">
          <Link href="/app" className="hidden hover:text-white sm:inline">Rooms</Link>
          <Link href="/bounty" className="hidden hover:text-white sm:inline">Bounties</Link>
          <Link href="/how-it-works" className="hidden hover:text-white md:inline">How it works</Link>
          <Link href="/app" className="border border-[rgba(143,216,228,0.5)] px-5 py-2.5 font-[700] text-[var(--mcl-mint)] transition-colors hover:border-[var(--mcl-mint)]">Enter app</Link>
        </nav>
      </header>

      <section className="mcl-hero-shell">
        <LandingHero />
      </section>

      <main>
        <section className="mcl-compat flex flex-wrap items-center gap-x-10 gap-y-7 px-6 md:gap-x-14 md:px-16">
          <span>Compatible with</span>
          {PLATFORMS.map((p) => <PlatformMark key={p.name} p={p} />)}
        </section>

        <section className="mcl-entry px-6 md:px-16">
          <div className="mcl-entry-grid">
            {ENTRY_PATHS.map(({ n, tone, icon: Icon, title, body, cta, href }) => (
              <Link key={n} href={href} className="mcl-entry-card" data-tone={tone}>
                <span className="mcl-card-number">{n}</span>
                <Icon size={28} strokeWidth={1.8} aria-hidden="true" />
                <h3>{title}</h3>
                <p>{body}</p>
                <strong>{cta}<ArrowRight size={16} aria-hidden="true" /></strong>
              </Link>
            ))}
          </div>
        </section>

        <section className="mcl-bounty">
          <div className="mcl-bounty-poster">
            <span className="mcl-coordinate">The bounty board</span>
            <h2>Your favorite streamer<br />doesn&apos;t even know you.</h2>
            <p>Be more than a username.</p>
            <Link href="/bounty">Browse bounties <ArrowRight size={17} aria-hidden="true" /></Link>
          </div>
          <div className="mcl-mini-board">
            <header><span>Top bounties</span><Link href="/bounty">Full board</Link></header>
            {boardPools.length > 0 ? boardPools.map((pool, index) => (
              <Link key={pool.handleKey} href={poolHref(pool)} className="mcl-pool-row">
                <span>{String(index + 1).padStart(2, '0')}</span>
                <i>{(pool.handle || pool.handleKey).charAt(0).toUpperCase()}</i>
                <p><strong>{pool.handle || pool.handleKey}</strong><small>{pool.platform || 'Unlisted'} / {pool.contributionCount} backer{pool.contributionCount === 1 ? '' : 's'}</small></p>
                <b>{formatDollars(pool.remaining)}{pool.displayOnly ? ' example' : ''}</b>
              </Link>
            )) : (
              <div className="mcl-pool-empty">
                <strong>No active bounties.</strong>
                <span>Create one for any streamer.</span>
                <Link href="/bounty">Create a bounty</Link>
              </div>
            )}
          </div>
        </section>

        <section className="mcl-proof">
          {PROOFS.map(({ icon: Icon, title, body }) => (
            <span key={title}><Icon size={22} strokeWidth={1.8} aria-hidden="true" /><b>{title}</b><small>{body}</small></span>
          ))}
        </section>

        <section className="mcl-create-strip px-6 md:px-16">
          <div><span className="mcl-coordinate">For streamers</span><h2>Open a room.</h2><p>Set your rate, connect OBS, and decide how viewers can join.</p></div>
          <Link href="/dashboard?new=1">Create room <ArrowRight size={17} /></Link>
        </section>
      </main>

      <footer className="flex flex-col items-center justify-between gap-4 border-t border-[var(--mcl-hairline)] px-6 py-7 text-[13px] text-[var(--mcl-faint)] md:flex-row md:px-16">
        <span className="tracking-[0.2em] text-[var(--mcl-dim)]">MEGACHAT</span>
        <nav aria-label="Footer" className="flex flex-wrap items-center justify-center gap-5 md:gap-7">
          <Link href="/app" className="hover:text-white">Rooms</Link>
          <Link href="/bounty" className="hover:text-white">Bounties</Link>
          <Link href="/how-it-works" className="hover:text-white">How it works</Link>
          <Link href="/roadmap" className="hover:text-white">Roadmap</Link>
          <Link href="/legacy" className="hover:text-white">Legacy site</Link>
          <a href={contactHref} target="_blank" rel="noreferrer" className="hover:text-white">Contact</a>
        </nav>
      </footer>
    </div>
  )
}
