'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

// Returning visitors skip the pitch: /app sets mc-entered on mount, and the
// next bare visit to / forwards straight into the app (hyperliquid-style).
// Any link that deliberately returns to the landing carries ?stay=1.
export function ReturningVisitorRedirect() {
  const router = useRouter()
  const params = useSearchParams()
  useEffect(() => {
    if (params.get('stay')) return
    try {
      if (window.localStorage.getItem('mc-entered') === '1') router.replace('/app')
    } catch {
      // storage blocked — first-visit behavior is the right fallback
    }
  }, [params, router])
  return null
}

// The film hero: plays the launch film once, holds its final frame under a
// soft dim, and offers a subtle replay control. The poster frame sits
// underneath as the no-video fallback.
export function LandingHero() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [ended, setEnded] = useState(false)

  const replay = useCallback(() => {
    const v = videoRef.current
    if (v) {
      try {
        v.currentTime = 0
        void v.play()
      } catch {
        /* ignore */
      }
    }
    setEnded(false)
  }, [])

  return (
    <div className="relative h-[560px] w-full overflow-hidden md:h-[720px]">
      <img
        src="/launch-film-poster.jpg"
        alt=""
        className="absolute inset-0 size-full object-cover"
      />
      <video
        ref={videoRef}
        src="/launch-film.mp4"
        poster="/launch-film-poster.jpg"
        autoPlay
        muted
        playsInline
        preload="auto"
        onEnded={() => setEnded(true)}
        className="absolute inset-0 size-full object-cover"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[#04070a] transition-opacity duration-[1600ms] ease-out"
        style={{ opacity: ended ? 0.26 : 0 }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'linear-gradient(to bottom, rgba(4,7,10,0.66) 0%, rgba(4,7,10,0.06) 32%, rgba(4,7,10,0.1) 55%, rgba(4,7,10,0.94) 100%)',
        }}
      />

      <button
        type="button"
        onClick={replay}
        title="Replay the film"
        aria-label="Replay the film"
        className="absolute bottom-6 right-6 z-10 grid size-11 place-items-center rounded-full border border-white/30 bg-[#04070a]/50 text-[var(--mcl-fg)] transition-colors hover:border-white/60"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="1 4 1 10 7 10" />
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
        </svg>
      </button>

      <div className="absolute inset-x-6 bottom-10 z-10 flex max-w-[880px] flex-col gap-5 md:inset-x-16 md:bottom-14">
        <div className="mcl-r1 flex items-center gap-2.5 text-[12px] tracking-[0.24em] text-[var(--mcl-mint)]">
          <span className="inline-block size-[7px] rounded-full bg-[var(--mcl-live)]" aria-hidden="true" />
          FREE TO WATCH · PAY TO APPEAR ON CAMERA
        </div>
        <h1 className="flex flex-col font-[800] leading-[0.98] tracking-[-0.01em] text-[44px] md:text-[72px]">
          <span className="mcl-r2">SKIP THE CHAT.</span>
          <span className="mcl-r3 flex flex-col gap-3">
            BE THE STREAM.
            <span className="mcl-sweep block h-1.5 w-[180px] bg-[var(--mcl-mint)] md:w-[240px]" aria-hidden="true" />
          </span>
        </h1>
        <p className="mcl-r4 text-[16px] leading-relaxed text-[var(--mcl-muted)] md:text-[17px]">
          Camera seats on live broadcasts, billed by the second.
        </p>
        <div className="mcl-r4 flex flex-wrap items-center gap-5 pt-1">
          <Link
            href="/app"
            className="bg-[var(--mcl-mint)] px-8 py-4 text-[14px] font-[800] tracking-[0.14em] text-[var(--mcl-mint-ink)] transition-opacity hover:opacity-90"
          >
            ENTER MEGACHAT
          </Link>
          <button
            type="button"
            onClick={replay}
            className="flex items-center gap-2.5 text-[13px] tracking-[0.14em] text-[var(--mcl-muted)] transition-colors hover:text-white"
          >
            WATCH THE FILM
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polygon points="6 3 20 12 6 21 6 3" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
