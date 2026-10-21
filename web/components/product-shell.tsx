import { AccountChip } from '@/components/account-chip'
import { BrandText } from '@/components/brand-text'
import { ThemeToggle } from '@/components/theme-toggle'
import { docsUrl } from '@/lib/docs-url.mjs'

// The generic product frame. Nothing mounts it today: the two bounty pages
// that used it moved to bounty/bounty-shell.tsx, which is this same frame with
// the bounty tag as its title. Kept on the Holler tokens so it is on brand if
// anything picks it up again: no forced `dark` (every .mc-product value is a
// token, so it follows the theme), the theme toggle in the header, and the
// account chip on its default strap-azure accent.
export function ProductShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mc-product min-h-screen">
      <header className="mc-product-header">
        <a href="/?stay=1" className="mc-product-brand" aria-label="Holler home"><BrandText /></a>
        <span>{title}</span>
        <nav aria-label="Product navigation">
          <a href="/app">Rooms</a><a href="/bounty">Bounties</a><a href="/how-it-works">How it works</a>
          {docsUrl() ? <a href={docsUrl() as string}>Docs</a> : null}
          <a href="/dashboard" className="mc-product-create">Create room</a>
          <ThemeToggle />
          <AccountChip />
        </nav>
      </header>
      <main className="mc-product-main">{children}</main>
    </div>
  )
}
