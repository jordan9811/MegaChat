import Link from 'next/link'
import { ArrowRight, BadgeCheck, Mic, RotateCcw, ShieldCheck, Video, Wallet } from 'lucide-react'
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

// What keeps it fair, beside the three ways. Each line is true of the code
// today: every Holler clears the room's moderation (a person, or the
// automatic check in an auto-moderated room); unpaid pledges and unspent
// campaign budgets are refunded; payouts settle in USDC; a bounty pays only a
// streamer who proves the channel on air (bounty-claim.config.js). "Instant"
// was left off on purpose: a bounty pays on a verified broadcast, not at once.
const TRUST = [
  { k: 'holler', Icon: ShieldCheck, title: 'Checked before it airs', line: 'Every Holler clears the room’s moderation first.' },
  { k: 'bounty', Icon: RotateCcw, title: 'Unused money comes back', line: 'Pledges and campaign budgets refund what isn’t paid out.' },
  { k: 'rewards', Icon: Wallet, title: 'Paid in USDC', line: 'Payouts go straight to your wallet once they count.' },
  { k: 'callin', Icon: BadgeCheck, title: 'Verified streamers', line: 'A bounty pays only a streamer who proves the channel on air.' },
] as const

// Starting points for a streamer's first campaign, after the form's own
// examples (campaign-form.tsx PLACEHOLDER).
const CAMPAIGN_IDEAS = [
  { kind: 'holler', title: 'Holler your worst take', detail: 'Holler / paid when it airs', price: '$0.25' },
  { kind: 'callin', title: 'Call in with a hot take', detail: 'Call in / 5 min on camera', price: '$0.50' },
  { kind: 'holler', title: 'First time here? Say hi', detail: 'Holler / paid when it airs', price: '$1.00' },
] as const

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
        {/* Mock D (owner, 2026-11-11): the three ways with what keeps it fair
            beside them, then the two pitches as equal boards: fans pledge,
            streamers start a campaign. Each row stacks below 1280. */}
        <div className="mcl-duo">
          <WaysIn />
          <aside className="mcl-trust" aria-label="How Holler keeps it fair">
            {TRUST.map(({ k, Icon, title, line }) => (
              <div key={title} className="mcl-trust-item" data-k={k}>
                <span aria-hidden="true"><Icon size={18} strokeWidth={2} /></span>
                <p><strong>{title}</strong><small>{line}</small></p>
              </div>
            ))}
          </aside>
        </div>

        {/* .dark: the boards stay at night in light mode too (Stone) */}
        <section className="mcl-bounty mcl-boards dark">
          <div className="mcl-half" data-k="bounty">
            <div className="mcl-bounty-poster">
              <h2>Your favorite streamer doesn&apos;t even know you.</h2>
              <p>Be more than a username.</p>
              <Link href="/bounty">Pledge your favorite streamer <ArrowRight size={16} aria-hidden="true" /></Link>
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
          </div>

          {/* Campaigns: the streamer pays viewers for engagement (campaign-engine.js).
              There is no public list of campaigns, so the board is starting
              points: each opens the new-campaign form. */}
          <div className="mcl-half" data-k="campaign">
            <div className="mcl-bounty-poster">
              <h2>New to streaming? Grow your audience with Holler.</h2>
              <p>Pay viewers to Holler or call in.</p>
              <Link href="/dashboard/campaigns/new">Start a campaign <ArrowRight size={16} aria-hidden="true" /></Link>
            </div>
            <div className="mcl-mini-board">
              <header><span>Campaigns to try</span><Link href="/dashboard/campaigns">Your campaigns</Link></header>
              {CAMPAIGN_IDEAS.map((c) => (
                <Link key={c.title} href="/dashboard/campaigns/new" className="mcl-pool-row mcl-idea-row">
                  <span className="mcl-idea-kind" data-kind={c.kind} aria-hidden="true">{c.kind === 'holler' ? <Mic size={16} /> : <Video size={16} />}</span>
                  <p><strong>{c.title}</strong><small>{c.detail}</small></p>
                  <b>{c.price}<small> example</small></b>
                </Link>
              ))}
            </div>
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
