import Link from 'next/link'
import { SiteHeader } from '@/components/site-header'
import { GlitchBackground } from '@/components/glitch-background'

export default function NotFound() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <div className="dark relative flex min-h-[calc(100vh-61px)] items-center justify-center overflow-hidden bg-background px-6 text-foreground">
        <GlitchBackground />
        <div className="relative z-10 flex flex-col items-center text-center">
          <span
            className="chromatic font-heading text-7xl font-black leading-none text-[var(--neon-magenta)] md:text-9xl"
            aria-hidden="true"
          >
            404
          </span>
          <h1 className="reveal mt-6 font-heading text-2xl font-bold text-foreground md:text-3xl">
            This scene went off-air.
          </h1>
          <p
            className="reveal mt-3 max-w-sm text-pretty text-sm leading-relaxed text-muted-foreground"
            style={{ ['--reveal-delay' as string]: '0.1s' }}
          >
            The room you&apos;re looking for isn&apos;t live — it may have ended
            or the link is off by a character.
          </p>
          <div
            className="reveal mt-8 flex flex-wrap items-center justify-center gap-3"
            style={{ ['--reveal-delay' as string]: '0.2s' }}
          >
            <Link
              href="/"
              className="glow-magenta rounded-full bg-primary px-5 py-2.5 text-sm font-bold uppercase tracking-wide text-primary-foreground transition-transform hover:scale-[1.03]"
            >
              Browse live rooms
            </Link>
            <Link
              href="/dashboard"
              className="rounded-full border border-border bg-input/30 px-5 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-input/50"
            >
              Start your own
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
