import Image from 'next/image'
import { Wordmark } from '@/components/wordmark'
import { FooterNav } from '@/components/site-footer'

const STATS = [
  { value: 'Per-second', label: 'USDC settlement' },
  { value: 'One tap', label: 'Passkey to live' },
  { value: '0 risk', label: 'Unused balance refunds' },
  { value: 'On-chain', label: 'Arc network' },
]

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
            <p className="graffiti-tag font-graffiti mt-4 -rotate-3 text-center text-3xl leading-tight md:text-5xl">
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
        </div>

        {/* right visual — crowned glitch mic + GRAB 10 SEC as one unit, sitting on the bg */}
        <div
          className="reveal relative mx-auto flex w-full max-w-md items-center justify-center"
          style={{ ['--reveal-delay' as string]: '0.22s' }}
        >
          <div className="absolute left-1/2 top-1/2 h-3/4 w-3/4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--neon-magenta)] opacity-25 blur-[110px]" />
          <div className="grab-unit animate-float-slow relative z-10 w-full">
            <Image
              src="/megachat-hero.png"
              alt="Crowned glitch microphone with a lime Grab 10 seconds button"
              width={697}
              height={985}
              priority
              className="h-auto w-full drop-shadow-[0_0_60px_oklch(0.68_0.27_340/0.35)]"
            />
            {/* clickable region aligned to the baked-in GRAB 10 SEC pill
                (button art spans ~5-85% x, ~72.5-89.5% y of the PNG) */}
            <a
              href="#browse"
              aria-label="Grab 10 seconds on camera"
              className="grab-hitbox absolute bottom-[10.5%] left-[5%] h-[17%] w-[80%] rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--neon-lime)]"
            />
          </div>
        </div>
      </div>

      {/* IPO-grade trust strip — the numbers that make it look like a company. */}
      <div
        className="reveal relative z-10 border-y border-border/60 bg-background/40 backdrop-blur-sm"
        style={{ ['--reveal-delay' as string]: '0.44s' }}
      >
        <dl className="mx-auto grid max-w-6xl grid-cols-2 divide-x divide-border/40 px-6 sm:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.label} className="flex flex-col gap-0.5 px-4 py-5 first:pl-0">
              <dt className="tabular font-heading text-xl font-bold text-foreground md:text-2xl">
                {s.value}
              </dt>
              <dd className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {s.label}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {/* footer strip — tagline is the standard line bottom-left, nav bottom-right */}
      <div className="relative z-10 border-t border-border/70">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-3 px-6 py-4 text-sm font-semibold text-muted-foreground sm:flex-row sm:items-center">
          <span className="font-heading font-bold italic tracking-wide text-foreground">
            Skip the chat.{' '}
            <span className="text-[var(--neon-magenta)]">Be the stream.</span>
          </span>
          <FooterNav contactHref={contactHref} />
        </div>
      </div>
    </section>
  )
}
