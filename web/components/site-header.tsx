import { Wordmark } from '@/components/wordmark'
import { ThemeToggle } from '@/components/theme-toggle'
import { HeaderAuth } from '@/components/header-auth'

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-background/70 backdrop-blur-md">
      {/* neon hairline under the bar */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-[var(--neon-magenta)]/60 to-transparent"
      />
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <a href="/" aria-label="MegaChat home" className="transition-opacity hover:opacity-90">
          <Wordmark size="sm" />
        </a>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          {/* Go live moved into the hero funnels (Start a room); the header
              slot now serves identity — useful since OAuth is live. */}
          <HeaderAuth />
        </div>
      </div>
    </header>
  )
}
