import { BrandText } from '@/components/brand-text'
import { ThemeToggle } from '@/components/theme-toggle'
import { HeaderAuth } from '@/components/header-auth'
import { ModeToggle } from '@/components/mode-toggle'

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-hl-line bg-[var(--hl-bar)] backdrop-blur-md">
      {/* strap-violet hairline under the bar */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-hl-strap-hi/60 to-transparent"
      />
      {/* px-3 below sm: mark + mode switch + theme + login chip all share
          a 375px row once someone is signed in. 60px bar and an 18px mark,
          the same as every other page header. */}
      <div className="mx-auto flex h-[59px] max-w-6xl items-center justify-between gap-2 px-3 sm:px-6">
        <a
          href="/"
          aria-label="Holler home"
          className="flex shrink-0 items-center text-[18px] transition-opacity hover:opacity-90"
        >
          <BrandText />
        </a>
        <div className="flex items-center gap-1.5 sm:gap-2">
          <ModeToggle />
          <ThemeToggle />
          {/* Go live moved into the hero funnels (Start a room); the header
              slot now serves identity — useful since OAuth is live. */}
          <HeaderAuth />
        </div>
      </div>
    </header>
  )
}
