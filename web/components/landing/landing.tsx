import Link from 'next/link'
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
import { BrandText } from '@/components/brand-text'
import { LandingHero } from './landing-hero'
import './landing.css'

function poolHref(pool: BountyPool): string {
  return pool.platform && pool.handle
    ? `/bounty/s/${encodeURIComponent(pool.platform)}/${encodeURIComponent(pool.handle)}`
    : '/bounty'
}

const ENTRY_PATHS = [
  {
    n: '01',
    tone: 'cyan',
    icon: MessageSquareText,
    title: 'Record a MegaChat',
    body: 'Say it on camera. Set the clip loose on their broadcast.',
    cta: 'Find a streamer',
    href: '/app',
  },
  {
    n: '02',
    tone: 'lime',
    icon: Video,
    title: 'Take a live seat',
    body: 'Join face-to-face and pay only for the seconds you use.',
    cta: 'Browse rooms',
    href: '/app',
  },
  {
    n: '03',
    tone: 'pink',
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
    <div className="mc-landing dark min-h-screen">
      <header className="mcl-nav">
        <Link href="/?stay=1" className="mcl-brand"><BrandText /></Link>
        <nav aria-label="Primary" className="mcl-nav-links">
          <Link href="/app" className="hidden sm:inline">Rooms</Link>
          <Link href="/bounty" className="hidden sm:inline">Bounties</Link>
          <Link href="/how-it-works" className="hidden md:inline">How it works</Link>
          <Link href="/app" className="mcl-nav-cta">Enter app</Link>
        </nav>
      </header>

      <LandingHero />

      <main>
        <section className="mcl-entry">
          <div className="mcl-entry-grid">
            {ENTRY_PATHS.map(({ n, tone, icon: Icon, title, body, cta, href }) => (
              <Link key={n} href={href} className="mcl-entry-card" data-tone={tone}>
                <span className="mcl-card-top">
                  <Icon size={22} strokeWidth={1.8} aria-hidden="true" />
                  <span>{n}</span>
                </span>
                <h3>{title}</h3>
                <p>{body}</p>
                <strong>{cta}<ArrowRight size={14} aria-hidden="true" /></strong>
              </Link>
            ))}
          </div>
        </section>

        <section className="mcl-bounty">
          <div className="mcl-bounty-poster">
            <span className="mcl-coordinate mcl-coordinate-pink">// The bounty board</span>
            <h2>Your favorite streamer<br />doesn&apos;t even know you.</h2>
            <p>Be more than a username.</p>
            <Link href="/bounty">Browse bounties <ArrowRight size={16} aria-hidden="true" /></Link>
          </div>
          <div className="mcl-mini-board">
            <header><span>Top bounties</span><Link href="/bounty">Full board</Link></header>
            {boardPools.length > 0 ? boardPools.map((pool, index) => (
              <Link key={pool.handleKey} href={poolHref(pool)} className="mcl-pool-row">
                <span>{String(index + 1).padStart(2, '0')}</span>
                <i>{(pool.handle || pool.handleKey).charAt(0).toUpperCase()}</i>
                <p><strong>{pool.handle || pool.handleKey}</strong><small>{pool.platform || 'unlisted'} / {pool.contributionCount} backer{pool.contributionCount === 1 ? '' : 's'}</small></p>
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

        <section className="mcl-create-strip">
          <div><span className="mcl-coordinate mcl-coordinate-cyan">// For streamers</span><h2>Open a room.</h2><p>Set your rate, connect OBS, and decide how viewers can join.</p></div>
          <Link href="/dashboard?new=1">Create room <ArrowRight size={16} aria-hidden="true" /></Link>
        </section>
      </main>

      <footer className="mcl-footer">
        <span><BrandText /></span>
        <nav aria-label="Footer">
          <Link href="/app">Rooms</Link>
          <Link href="/bounty">Bounties</Link>
          <Link href="/how-it-works">How it works</Link>
          <Link href="/roadmap">Roadmap</Link>
          <Link href="/legacy">Legacy site</Link>
          <a href={contactHref} target="_blank" rel="noreferrer">Contact</a>
        </nav>
      </footer>
    </div>
  )
}
