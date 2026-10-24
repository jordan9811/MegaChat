import type { Metadata } from 'next'
import { AccountChip } from '@/components/account-chip'
import { JoinClient } from '@/components/join/join-client'
import { ThemeToggle } from '@/components/theme-toggle'
import './join.css'
import { BrandText } from '@/components/brand-text'
import { docsUrl } from '@/lib/docs-url.mjs'

export const metadata: Metadata = {
  title: 'Join on camera — Holler',
  description: 'Pay by the second to put your camera on a live stream.',
}

// No forced theme on the root: next-themes puts light or dark on <html>, and
// join.css maps the page's --mcj-* onto the Holler tokens. Only the broadcast
// stage and the camera frames pin themselves dark (join-client.tsx).
export default function JoinPage() {
  return (
    <div className="mc-join min-h-screen">
      <header className="mcj-product-header">
        <div>
          <span className="mcj-product-brand">
            <a
              href="/app"
              aria-label="Holler home"
              className="bc"
            >
              <BrandText />
            </a>
            <i aria-hidden="true" />
            <span>Join room</span>
          </span>
          <nav aria-label="Product navigation">
            <a href="/app">Rooms</a>
            <a href="/bounty">Bounties</a>
            <a href="/how-it-works">How it works</a>
            {docsUrl() ? <a href={docsUrl() as string}>Docs</a> : null}
          </nav>
          <span className="mcj-product-actions">
            <a href="/dashboard">Create room</a>
            <ThemeToggle />
            <AccountChip accent="var(--hl-strap)" />
          </span>
        </div>
      </header>
      <JoinClient />
    </div>
  )
}
