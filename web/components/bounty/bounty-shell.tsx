import { AccountChip } from '@/components/account-chip'
import { BrandText } from '@/components/brand-text'
import { FeatureTag } from '@/components/feature-tag'
import { ThemeToggle } from '@/components/theme-toggle'
import { docsUrl } from '@/lib/docs-url.mjs'

// The frame for /bounty/mine and /bounty/s/<platform>/<handle>. Same markup
// and product.css classes as components/product-shell.tsx (which only these
// two pages used), minus its forced `dark` class: every .mc-product value is
// a Holler token, so the frame follows the light/dark theme. The page title
// is the bounty feature tag, and the header carries the theme toggle.
export function BountyShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mc-product min-h-screen">
      <header className="mc-product-header">
        <a href="/?stay=1" className="mc-product-brand" aria-label="Holler home"><BrandText /></a>
        <span><FeatureTag kind="bounty">{title}</FeatureTag></span>
        <nav aria-label="Product navigation">
          <a href="/app">Rooms</a><a href="/bounty">Bounties</a><a href="/how-it-works">How it works</a>
          {docsUrl() ? <a href={docsUrl() as string}>Docs</a> : null}
          <a href="/dashboard" className="mc-product-create">Create room</a>
          <ThemeToggle />
          <AccountChip accent="var(--f-bounty-solid)" />
        </nav>
      </header>
      <main className="mc-product-main">{children}</main>
    </div>
  )
}
