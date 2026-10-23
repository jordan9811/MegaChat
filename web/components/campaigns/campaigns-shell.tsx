'use client'

// The frame for every /dashboard/campaigns page: the shared product header
// (same bar height, mark size and nav type as /account and /bounty, from the
// --hl-hdr-* tokens), the signed-out gate, and the page title block.
// Styles: app/dashboard/campaigns/campaigns.css under .mc-camp.

import type { ReactNode } from 'react'
import { AccountChip } from '@/components/account-chip'
import { BrandText } from '@/components/brand-text'
import { ThemeToggle } from '@/components/theme-toggle'
import { useAccount } from '@/lib/use-account'
import { docsUrl } from '@/lib/docs-url.mjs'

/** The shared product header: the same bar every product page wears
 *  (/account, /bounty, /join), with the campaigns link marked current on
 *  the dashboard pages and plain on the public offer page. */
export function CampaignsHeader({ tag, current = true }: { tag: string; current?: boolean }) {
  const docs = docsUrl() as string | null
  return (
    <header className="mcp-header">
      <div>
        <span className="mcp-brand-lockup">
          <a href="/?stay=1" className="mcp-brand"><BrandText /></a>
          <i aria-hidden="true" />
          <span>{tag}</span>
        </span>
        <nav aria-label="Product navigation">
          <a href="/app">Rooms</a>
          <a href="/bounty">Bounties</a>
          <a href="/dashboard/campaigns" aria-current={current ? 'page' : undefined}>Campaigns</a>
          <a href="/how-it-works">How it works</a>
          {docs ? <a href={docs}>Docs</a> : null}
        </nav>
        <span className="mcp-header-end">
          <a href="/dashboard" className="mcp-header-cta">Your room</a>
          <ThemeToggle />
          <AccountChip accent="var(--f-bounty-ui)" />
        </span>
      </div>
    </header>
  )
}

export function CampaignsShell({ tag = 'Campaigns', children }: { tag?: string; children: ReactNode }) {
  const { loaded, signedIn, wallet, openSignIn, authError } = useAccount()
  return (
    <div className="mc-camp">
      <CampaignsHeader tag={tag} />
      <main className="mcp-shell">
        {!loaded ? (
          <p className="mcp-hint">Loading…</p>
        ) : !signedIn ? (
          <section className="mcp-card mcp-signed-out">
            <span className="mcp-coordinate">Campaigns / private</span>
            <h1>Sign in to run a campaign</h1>
            <p>
              A campaign pays people who meet your rules to send a Holler or call in on your stream.
              It is tied to your account, so sign in first.
            </p>
            <button
              type="button"
              className="mcp-btn"
              onClick={openSignIn}
              disabled={wallet.modalOpen}
              title={wallet.configured ? 'Twitch, X, Google, email or passkey' : 'Sign-in is not configured on this server'}
            >
              {wallet.modalOpen ? 'Opening…' : 'Sign in'}
            </button>
            {authError ? <p role="alert" className="mcp-error">{authError}</p> : null}
          </section>
        ) : children}
      </main>
    </div>
  )
}

export function PageTitle({ coordinate, title, lead, actions }: { coordinate: string; title: ReactNode; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mcp-title">
      <div>
        <span className="mcp-coordinate">{coordinate}</span>
        <h1>{title}</h1>
        {lead ? <p>{lead}</p> : null}
      </div>
      {actions ? <div className="mcp-title-actions">{actions}</div> : null}
    </div>
  )
}

/** One status word with its dot. Live is the action azure, closed is quiet,
 *  draft is neutral; money states on a claim are yellow (owed) and green (paid). */
export function Pip({ tone, children }: { tone: 'draft' | 'funded' | 'live' | 'closed' | 'owed' | 'paid' | 'bad' | 'ok'; children: ReactNode }) {
  return <span className="mcp-pip" data-tone={tone}><i aria-hidden="true" />{children}</span>
}
