import { cn } from '@/lib/utils'

// One nav, everywhere: hero strip, page footer, and the standalone pages.
// Contact points at an X/Twitter URL read from CONTACT_URL at request time
// (landing is force-dynamic), so it can change without a code edit.
const NAV_LINKS = [
  { label: 'Browse rooms', href: '/#browse' },
  { label: 'Bounties', href: '/bounty' },
  { label: 'Dashboard', href: '/dashboard' },
  { label: 'How it works', href: '/how-it-works' },
  { label: 'Roadmap', href: '/roadmap' },
  { label: 'FAQ', href: '/how-it-works#faq' },
]

export function contactUrl() {
  return process.env.CONTACT_URL || 'https://x.com/megachat'
}

export function FooterNav({
  contactHref,
  className,
}: {
  contactHref: string
  className?: string
}) {
  return (
    <nav className={cn('flex flex-wrap items-center gap-x-6 gap-y-2', className)}>
      {NAV_LINKS.map((l) => (
        <a key={l.href} href={l.href} className="transition-colors hover:text-foreground">
          {l.label}
        </a>
      ))}
      <a
        href={contactHref}
        target="_blank"
        rel="noopener noreferrer"
        className="transition-colors hover:text-foreground"
      >
        Contact
      </a>
    </nav>
  )
}

// Brand name left, nav right. The tagline appears exactly once in the app —
// under the hero wordmark — so it deliberately does NOT repeat here.
export function SiteFooter({ contactHref }: { contactHref: string }) {
  return (
    <footer className="border-t border-border/60">
      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-3 px-6 py-6 text-sm font-semibold text-muted-foreground sm:flex-row sm:items-center">
        <span className="font-heading font-bold tracking-wide text-foreground">MegaChat</span>
        <FooterNav contactHref={contactHref} />
      </div>
    </footer>
  )
}
