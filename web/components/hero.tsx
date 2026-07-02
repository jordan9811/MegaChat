import Image from 'next/image'
import { Wordmark } from '@/components/wordmark'

const FEATURES = [
  { top: 'TURN CHAT', bottom: 'INTO CONTENT' },
  { top: '10 SEC CLIPS', bottom: 'THAT POP' },
  { top: 'BUILT FOR', bottom: 'GO VIRAL' },
]

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="relative z-10 mx-auto grid max-w-6xl grid-cols-1 items-center gap-8 px-6 pt-16 pb-14 md:pt-24 md:pb-20 lg:grid-cols-[1.15fr_0.85fr]">
        {/* left copy */}
        <div className="flex flex-col items-start">
          <span className="dashed-neon mb-6 inline-block -rotate-2 rounded-md bg-[var(--neon-lime)] px-3 py-1 text-xs font-bold uppercase tracking-wide text-[oklch(0.2_0.06_140)]">
            For creators. By creators.
          </span>

          <h1 className="sr-only">MegaChat — Skip the chat. Be the stream.</h1>
          <Wordmark />

          <p className="chromatic mt-5 font-heading text-2xl font-bold italic leading-tight text-[var(--neon-magenta)] md:text-4xl">
            Skip the chat.
            <br />
            Be the stream.
          </p>

          <p className="mt-5 max-w-md text-pretty text-base leading-relaxed text-foreground/80">
            Viewers pay per-second in USDC to put their camera on your live
            broadcast. You keep the mic, they get the moment.
          </p>

          <ul className="mt-9 flex flex-wrap items-center gap-x-5 gap-y-3">
            {FEATURES.map((f, i) => (
              <li key={f.top} className="flex items-center gap-5">
                {i > 0 ? (
                  <span className="h-8 w-px bg-border" aria-hidden="true" />
                ) : null}
                <span className="font-heading text-sm font-bold uppercase leading-tight tracking-wide text-foreground">
                  {f.top}
                  <br />
                  {f.bottom}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* right visual — crowned glitch mic + GRAB 10 SEC as one unit, sitting on the bg */}
        <div className="relative mx-auto flex w-full max-w-md items-center justify-center">
          <div className="absolute left-1/2 top-1/2 h-3/4 w-3/4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--neon-magenta)] opacity-25 blur-[110px]" />
          <div className="animate-float-slow relative z-10 w-full">
            <Image
              src="/megachat-hero.png"
              alt="Crowned glitch microphone with a lime Grab 10 seconds button"
              width={697}
              height={985}
              priority
              className="h-auto w-full drop-shadow-[0_0_60px_oklch(0.68_0.27_340/0.35)]"
            />
            {/* clickable region over the baked-in GRAB 10 SEC button */}
            <a
              href="#browse"
              aria-label="Grab 10 seconds on camera"
              className="absolute bottom-[3%] left-[3%] h-[16%] w-[80%] rounded-full transition-transform hover:scale-[1.02] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--neon-lime)]"
            />
          </div>
        </div>
      </div>

      {/* footer strip */}
      <div className="relative z-10 border-t border-border/70">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-3 px-6 py-4 text-sm font-semibold text-muted-foreground sm:flex-row sm:items-center">
          <nav className="flex items-center gap-6">
            <a href="/dashboard" className="transition-colors hover:text-foreground">
              Dashboard
            </a>
            <a href="#" className="transition-colors hover:text-foreground">
              Pricing
            </a>
            <a href="#" className="transition-colors hover:text-foreground">
              Docs
            </a>
          </nav>
          <span className="text-xs uppercase tracking-wide text-foreground/70">
            Level up your stream. Own your audience.
          </span>
        </div>
      </div>
    </section>
  )
}
