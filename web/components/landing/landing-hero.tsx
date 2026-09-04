'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { PLATFORMS, PlatformMark } from './landing-platforms'

// megachat.fun IS the landing page. There used to be a returning-visitor
// bypass here that forwarded anyone with the mc-entered flag straight to
// /app — which meant that once you had opened the app even once, you could
// never see the front door again without knowing to add ?stay=1. A marketing
// page you cannot reach is not a marketing page.

// The hero is a split, the way a game's key art sits next to its title: the
// film fills its own column edge to edge and autoplays, and the words live in
// a panel beside it, never on top of it. The column keeps the 16:9 film close
// to its own shape, so nothing important is cropped off the top — the old
// full-bleed hero lost a quarter of the frame on a wide monitor.

// The meter over the film reads the film's own clock at a nominal rate, so
// the number the page makes its promise with is a number you watch tick.
const METER_RATE = 0.0033

function clock(t: number): string {
  const s = Math.max(0, Math.floor(t))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function LandingHero() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [ended, setEnded] = useState(false)
  const [playing, setPlaying] = useState(false)
  // Someone who asked their OS for less motion should not be handed a
  // 10-second autoplaying film; they get the poster and an explicit play.
  const [reduced, setReduced] = useState(false)
  const [time, setTime] = useState(0)
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    if (mq.matches) {
      const v = videoRef.current
      if (v) {
        v.pause()
        v.currentTime = 0
      }
    }
  }, [])

  const replay = useCallback(() => {
    const v = videoRef.current
    if (v) {
      v.currentTime = 0
      // play() reports failure through its promise, not a throw — a bare
      // try/catch would let the rejection escape as an unhandled error.
      void v.play().catch(() => setPlaying(false))
    }
    setEnded(false)
  }, [])

  const toggle = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play().catch(() => setPlaying(false))
    else v.pause()
  }, [])

  return (
    <section className="mcl-hero">
      <div className="mcl-film">
        <img src="/launch-film-poster.jpg" alt="" className="mcl-film-media" />
        <video
          ref={videoRef}
          src="/launch-film.mp4"
          poster="/launch-film-poster.jpg"
          autoPlay
          muted
          playsInline
          preload="auto"
          aria-label="The MegaChat launch film: a viewer is pulled off his couch and into the stream"
          onEnded={() => {
            setEnded(true)
            setPlaying(false)
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => {
            const v = e.currentTarget
            setTime(v.currentTime)
            setProgress(v.duration > 0 ? v.currentTime / v.duration : 0)
          }}
          className="mcl-film-media"
        />
        <div aria-hidden="true" className="mcl-film-hold" style={{ opacity: ended ? 0.22 : 0 }} />
        <div aria-hidden="true" className="mcl-film-shade" />
        <span className="mcl-chip"><i aria-hidden="true" />Launch film</span>
        <div className="mcl-meter" aria-hidden="true">
          <span>{clock(time)}</span>
          <b>${(time * METER_RATE).toFixed(2)}</b>
          <small>per-second</small>
        </div>
        <div className="mcl-film-ctl">
          {/* pause exists whenever the film is running: an autoplaying video
              with no stop control is a WCAG 2.2.2 failure */}
          {playing ? (
            <button type="button" onClick={toggle} title="Pause the film" aria-label="Pause the film">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="9" y1="4" x2="9" y2="20" />
                <line x1="15" y1="4" x2="15" y2="20" />
              </svg>
            </button>
          ) : null}
          <button
            type="button"
            onClick={replay}
            title={ended || !playing ? 'Play the film' : 'Replay the film'}
            aria-label={ended || !playing ? 'Play the film' : 'Replay the film'}
          >
            {reduced && !playing && !ended ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polygon points="6 3 20 12 6 21 6 3" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
            )}
          </button>
        </div>
        <div className="mcl-film-progress" aria-hidden="true">
          <i style={{ width: `${Math.round(progress * 1000) / 10}%` }} />
        </div>
      </div>

      <div className="mcl-panel">
        <h1 className="mcl-h1">
          <span className="mcl-r1">SKIP THE CHAT.</span>
          <span className="mcl-r2 mcl-neon">BE THE STREAM.</span>
        </h1>
        <div className="mcl-arewe mcl-r2">
          <span className="mcl-lbl">Are you a</span>
          <span className="mcl-tag mcl-tag-watch">Watcher</span>
          <span className="mcl-or">or</span>
          <span className="mcl-tag mcl-tag-play">Player</span>
        </div>
        <p className="mcl-sub mcl-r3">Camera seats on live broadcasts, billed by the second.</p>
        <div className="mcl-ctas mcl-r3">
          <Link href="/app" className="mcl-btn-primary">Enter MegaChat</Link>
          <button type="button" onClick={replay} className="mcl-btn-ghost">
            Watch the film
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <polygon points="6 3 20 12 6 21 6 3" />
            </svg>
          </button>
        </div>
        <div className="mcl-compat mcl-r4">
          <span>Compatible with</span>
          <div>{PLATFORMS.map((p) => <PlatformMark key={p.name} p={p} />)}</div>
        </div>
      </div>
    </section>
  )
}
