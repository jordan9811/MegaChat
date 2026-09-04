import type { Metadata } from 'next'
import { Plus_Jakarta_Sans } from 'next/font/google'
import { AccountChip } from '@/components/account-chip'
import { JoinClient } from '@/components/join/join-client'
import './join.css'
import { BrandText } from '@/components/brand-text'

// One UI face across the app, loaded per route — there is no site-wide
// provider. Same call as the room board and the create page.
const ui = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-ui',
})

export const metadata: Metadata = {
  title: 'Join on camera — MegaChat',
  description: 'Pay by the second to put your camera on a live stream.',
}

export default function JoinPage() {
  return (
    <div className={`${ui.variable} mc-join dark min-h-screen`}>
      <header className="mcj-product-header">
        <div>
          <span className="mcj-product-brand">
            <a
              href="/app"
              aria-label="MegaChat home"
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
          </nav>
          <span className="mcj-product-actions">
            <a href="/dashboard?new=1">Create room</a>
            <AccountChip accent="var(--mcj-accent)" />
          </span>
        </div>
      </header>
      <JoinClient />
    </div>
  )
}
