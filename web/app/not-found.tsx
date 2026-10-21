import Link from 'next/link'
import { SiteHeader } from '@/components/site-header'
import { GlitchBackground } from '@/components/glitch-background'

export default function NotFound() {
  return (
    <div className="min-h-screen bg-hl-bg text-hl-fg">
      <SiteHeader />
      <div className="relative flex min-h-[calc(100vh-61px)] items-center justify-center overflow-hidden bg-hl-bg px-6 text-hl-fg">
        <GlitchBackground />
        <div className="relative z-10 flex flex-col items-center text-center">
          {/* The 0 is the Holler record button, switched off: the ring is
              there, the light is not. */}
          <span
            className="inline-flex items-center gap-[0.06em] font-heading text-7xl font-black leading-none text-hl-strap-hi md:text-9xl"
            aria-hidden="true"
          >
            4
            <span
              className="inline-block size-[0.68em] rounded-full"
              style={{
                boxShadow: 'inset 0 0 0 0.08em var(--hl-record)',
                background:
                  'radial-gradient(circle closest-side, color-mix(in srgb, var(--hl-record) 22%, transparent) 0 56%, transparent 58%)',
              }}
            />
            4
          </span>
          <h1 className="reveal mt-6 font-[family-name:var(--font-display)] text-2xl font-[800] tracking-[-0.02em] text-hl-fg md:text-3xl">
            This scene went off-air.
          </h1>
          <p
            className="reveal mt-3 max-w-sm text-pretty text-sm leading-relaxed text-hl-muted"
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
              className="rounded-[2px] bg-hl-strap px-5 py-2.5 text-sm font-bold text-hl-on-strap transition-transform duration-150 ease-[cubic-bezier(.23,1,.32,1)] hover:bg-hl-strap-hover active:scale-[0.97]"
            >
              Browse live rooms
            </Link>
            <Link
              href="/dashboard"
              className="rounded-[2px] border border-hl-line-2 bg-hl-panel/70 px-5 py-2.5 text-sm font-semibold text-hl-fg transition-colors hover:bg-hl-panel-2"
            >
              Start your own
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
