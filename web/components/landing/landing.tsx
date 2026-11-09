import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import type { PublicRoomCard } from '@/lib/api'
import type { BountyPool } from '@/lib/bounty-api'
import { formatDollars } from '@/lib/display-format'
import { BrandText } from '@/components/brand-text'
import { ThemeToggle } from '@/components/theme-toggle'
import { docsUrl } from '@/lib/docs-url.mjs'
import { PoolThumb } from './pool-thumb'
import { LandingHero } from './landing-hero'
import { WaysIn } from './ways-in'
import './landing.css'

function poolHref(pool: BountyPool): string {
  return pool.platform && pool.handle
    ? `/bounty/s/${encodeURIComponent(pool.platform)}/${encodeURIComponent(pool.handle)}`
    : '/bounty'
}


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
    <div className="mc-landing min-h-screen">
      <header className="mcl-nav">
        <Link href="/?stay=1" className="mcl-brand"><BrandText /></Link>
        <nav aria-label="Primary" className="mcl-nav-links">
          <Link href="/app" className="hidden sm:inline">Rooms</Link>
          <Link href="/bounty" className="hidden sm:inline">Bounties</Link>
          <Link href="/how-it-works" className="hidden md:inline">How it works</Link>
          <ThemeToggle />
          <Link href="/app" className="mcl-nav-cta">Enter app</Link>
        </nav>
      </header>

      <LandingHero />

      <main>
        <WaysIn />

        {/* .dark: the bounty band stays at night in light mode too (Stone) */}
        <section className="mcl-bounty dark">
          <div className="mcl-bounty-poster">
            <h2>Your favorite streamer<br />doesn&apos;t even know you.</h2>
            <p>Be more than a username.</p>
            <Link href="/bounty">Browse bounties <ArrowRight size={16} aria-hidden="true" /></Link>
          </div>
          <div className="mcl-mini-board">
            <header><span>Top bounties</span><Link href="/bounty">Full board</Link></header>
            {boardPools.length > 0 ? boardPools.map((pool, index) => (
              <Link key={pool.handleKey} href={poolHref(pool)} className="mcl-pool-row">
                <span>{String(index + 1).padStart(2, '0')}</span>
                <PoolThumb handle={pool.handle || pool.handleKey} platform={pool.platform} avatarUrl={pool.avatarUrl} />
                <p><strong>{pool.handle || pool.handleKey}</strong><small>{pool.platform || 'unlisted'} / {pool.contributionCount} backer{pool.contributionCount === 1 ? '' : 's'}</small></p>
                <b>{formatDollars(pool.remaining)}{pool.displayOnly ? <small> example</small> : null}</b>
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

        <section className="mcl-create-strip">
          <div><h2>Create a room.</h2><p>Set your rate, connect OBS, and decide how viewers can join.</p></div>
          <Link href="/dashboard">Create room <ArrowRight size={16} aria-hidden="true" /></Link>
        </section>
      </main>

      <footer className="mcl-footer">
        <span><BrandText /></span>
        <nav aria-label="Footer">
          <Link href="/app">Rooms</Link>
          <Link href="/bounty">Bounties</Link>
          <Link href="/how-it-works">How it works</Link>
          <Link href="/roadmap">Roadmap</Link>
          {docsUrl() ? <a href={docsUrl() as string}>Docs</a> : null}
          <a href={contactHref} target="_blank" rel="noreferrer">Contact</a>
        </nav>
      </footer>
    </div>
  )
}
