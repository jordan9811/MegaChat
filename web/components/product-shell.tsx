import { AccountChip } from '@/components/account-chip'
import { BrandText } from '@/components/brand-text'
import { docsUrl } from '@/lib/docs-url.mjs'

export function ProductShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mc-product dark min-h-screen">
      <header className="mc-product-header">
        <a href="/?stay=1" className="mc-product-brand"><BrandText /></a>
        <span>{title}</span>
        <nav aria-label="Product navigation">
          <a href="/app">Rooms</a><a href="/bounty">Bounties</a><a href="/how-it-works">How it works</a>
          {docsUrl() ? <a href={docsUrl() as string}>Docs</a> : null}
          <a href="/dashboard" className="mc-product-create">Create room</a>
          <AccountChip accent="#3ae8ff" />
        </nav>
      </header>
      <main className="mc-product-main">{children}</main>
    </div>
  )
}
