import Image from 'next/image'
import { Wordmark } from '@/components/wordmark'
import { FooterNav } from '@/components/site-footer'

// The hero funnels: what this is (copy above), where viewers go (Browse
// rooms + the mic's GRAB button), where streamers go (Start a room).

export function Hero({ contactHref }: { contactHref: string }) {
  return (
    <section className="relative overflow-hidden">
      <div className="relative z-10 mx-auto grid max-w-6xl grid-cols-1 items-center gap-8 px-6 pt-16 pb-14 md:pt-24 md:pb-20 lg:grid-cols-[1.15fr_0.85fr]">
        {/* left copy — minimal on purpose: ticket, mark, tagline, ONE line.
            The longer product copy lives on /how-it-works now. */}
        <div className="flex flex-col items-start">
          {/* admission-ticket chip — copy pulled from the app's own lines */}
          <span
            className="reveal ticket mb-6 -rotate-2 text-xs font-bold uppercase tracking-wide"
            style={{ ['--reveal-delay' as string]: '0.05s' }}
          >
            <span className="ticket-stub">ADMIT 1</span>
            <span className="ticket-body">Turn chat into content</span>
          </span>

          <h1 className="sr-only">MegaChat — Skip the chat. Be the stream.</h1>
          {/* wordmark + tagline as one centered unit */}
          <div
            className="reveal flex flex-col items-center"
            style={{ ['--reveal-delay' as string]: '0.12s' }}
          >
            <Wordmark animated />
            <p className="graffiti-tag font-graffiti mt-4 -rotate-3 text-center text-4xl leading-snug md:text-5xl md:leading-snug">
              Skip the chat.
              <br />
              Be the stream.
            </p>
          </div>

          <p
            className="reveal mt-7 max-w-md text-pretty text-base leading-relaxed text-foreground/80"
            style={{ ['--reveal-delay' as string]: '0.28s' }}
          >
            Viewers pay per-second in USDC to put their camera on your live
            broadcast.
          </p>

          <div
            className="reveal mt-9 flex flex-wrap gap-3"
            style={{ ['--reveal-delay' as string]: '0.36s' }}
          >
            <a
              href="#browse"
              className="glow-magenta rounded-full bg-primary px-6 py-3 text-sm font-bold uppercase tracking-wide text-primary-foreground transition-transform hover:scale-[1.03]"
            >
              Browse rooms
            </a>
            <a
              href="/dashboard"
              className="rounded-full border border-[var(--neon-lime)]/60 bg-[var(--neon-lime)]/10 px-6 py-3 text-sm font-bold uppercase tracking-wide text-[var(--neon-lime)] transition-transform hover:scale-[1.03]"
            >
              Start a room
            </a>
          </div>
        </div>

        {/* right visual — crowned glitch mic + GRAB 10 SEC as one unit, sitting on the bg */}
        <div
          className="reveal relative mx-auto flex w-full max-w-md items-center justify-center"
          style={{ ['--reveal-delay' as string]: '0.22s' }}
        >
          <div className="absolute left-1/2 top-1/2 h-3/4 w-3/4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--neon-magenta)] opacity-25 blur-[110px]" />
          {/* The hero art is sliced at the banner's top edge (y=719 of 1008)
              so the GRAB 10 SEC pill can tilt/rattle on its own — the mic
              stays still. Pixels are identical to the original PNG. */}
          <div className="grab-unit animate-float-slow relative z-10 w-full">
            <Image
              src="/megachat-hero-mic.png"
              alt="Crowned glitch microphone"
              width={698}
              height={719}
              priority
              className="h-auto w-full drop-shadow-[0_0_60px_oklch(0.68_0.27_340/0.35)]"
            />
            <div className="grab-banner relative">
              <Image
                src="/megachat-hero-grab.png"
                alt=""
                aria-hidden
                width={698}
                height={289}
                priority
                className="h-auto w-full drop-shadow-[0_0_60px_oklch(0.68_0.27_340/0.35)]"
              />
              {/* clickable region aligned to the pill inside the banner slice
                  (pill spans ~5-85% x, top ~0-64% y of this part) */}
              <a
                href="#browse"
                aria-label="Grab 10 seconds on camera"
                className="grab-hitbox absolute left-[5%] top-0 h-[64%] w-[80%] rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--neon-lime)]"
              />
            </div>
          </div>
        </div>
      </div>

      {/* footer strip — nav only, bottom-right. The ONE tagline lives under
          the wordmark; no duplicates down here. */}
      <div className="relative z-10 border-t border-border/70">
        <div className="mx-auto flex max-w-6xl justify-end px-6 py-4 text-sm font-semibold text-muted-foreground">
          <FooterNav contactHref={contactHref} />
        </div>
      </div>
    </section>
  )
}
