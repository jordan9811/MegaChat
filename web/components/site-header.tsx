import { Wordmark } from '@/components/wordmark'
import { ThemeToggle } from '@/components/theme-toggle'

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-background/70 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <Wordmark size="sm" />
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <a
            href="/dashboard"
            className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-transform hover:scale-[1.03]"
          >
            Go live
          </a>
        </div>
      </div>
    </header>
  )
}
