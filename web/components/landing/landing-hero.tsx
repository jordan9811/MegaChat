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

export function LandingHero() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [ended, setEnded] = useState(false)
  const [playing, setPlaying] = useState(false)
  // Someone who asked their OS for less motion should not be handed a
  // 10-second autoplaying film; they get the poster and an explicit play.
  const [reduced, setReduced] = useState(false)
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

  // The film autoplays muted (browsers allow nothing else); this is the
  // visitor's own switch for its sound. The video's volumechange keeps the
  // icon honest whatever changed it.
  const [muted, setMuted] = useState(true)
  const toggleSound = useCallback(() => {
    const v = videoRef.current
    if (v) v.muted = !v.muted
  }, [])

  // "Watch the film" is the theater, not a second replay button (owner,
  // 2026-11-10): the 1080p cut, large, with sound and the browser's own
  // controls. It loads only when opened. The hero film waits behind it and
  // carries on when it closes.
  const theaterRef = useRef<HTMLDialogElement | null>(null)
  const filmRef = useRef<HTMLVideoElement | null>(null)
  const heroWasPlaying = useRef(false)
  const openTheater = useCallback(() => {
    const d = theaterRef.current
    const f = filmRef.current
    if (!d || !f) return
    const v = videoRef.current
    heroWasPlaying.current = !!v && !v.paused && !v.ended
    v?.pause()
    if (!d.open) d.showModal()
    f.currentTime = 0
    f.muted = false
    void f.play().catch(() => {})
  }, [])
  const onTheaterClose = useCallback(() => {
    filmRef.current?.pause()
    if (heroWasPlaying.current) void videoRef.current?.play().catch(() => {})
  }, [])

  return (
    <section className="mcl-hero">
      {/* .dark keeps the film framed in black in both themes: it is a video */}
      <div className="mcl-film dark">
        <img src="/launch-film-poster.jpg" alt="" className="mcl-film-media" />
        <video
          ref={videoRef}
          src="/launch-film.mp4"
          poster="/launch-film-poster.jpg"
          autoPlay
          muted
          playsInline
          preload="auto"
          aria-label="The Holler launch film: a viewer is pulled off his couch and into the stream"
          onEnded={() => {
            setEnded(true)
            setPlaying(false)
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
          onTimeUpdate={(e) => {
            const v = e.currentTarget
            setProgress(v.duration > 0 ? v.currentTime / v.duration : 0)
          }}
          className="mcl-film-media"
        />
        <div aria-hidden="true" className="mcl-film-hold" style={{ opacity: ended ? 0.22 : 0 }} />
        <div aria-hidden="true" className="mcl-film-shade" />
        <div className="mcl-film-ctl">
          {/* The owner's call (2026-11-10): no pause button, only replay and
              sound, plus "Watch the film" in the panel. The old pause vanished
              once pressed and the remaining button restarted the film, so a
              paused film could not be resumed. Note: an autoplaying video over
              5 s with no pause control is a WCAG 2.2.2 gap. */}
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
          <button
            type="button"
            onClick={toggleSound}
            title={muted ? 'Turn the sound on' : 'Turn the sound off'}
            aria-label={muted ? 'Turn the sound on' : 'Turn the sound off'}
            aria-pressed={!muted}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              {muted ? (
                <>
                  <line x1="22" y1="9" x2="16" y2="15" />
                  <line x1="16" y1="9" x2="22" y2="15" />
                </>
              ) : (
                <>
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </>
              )}
            </svg>
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
        <p className="mcl-sub mcl-r3">Camera seats on live broadcasts, billed by the second.</p>
        <div className="mcl-ctas mcl-r3">
          <Link href="/app" className="mcl-btn-primary">Enter Holler</Link>
          <button type="button" onClick={openTheater} className="mcl-btn-ghost" aria-haspopup="dialog">
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

      <dialog
        ref={theaterRef}
        className="mcl-theater"
        aria-label="The Holler launch film"
        onClose={onTheaterClose}
        onClick={(e) => { if (e.target === e.currentTarget) e.currentTarget.close() }}
      >
        <video
          ref={filmRef}
          src="/launch-film-1080.mp4"
          poster="/launch-film-poster.jpg"
          controls
          playsInline
          preload="none"
          className="mcl-theater-film"
        />
        <button type="button" className="mcl-theater-close" onClick={() => theaterRef.current?.close()} aria-label="Close the film">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
      </dialog>
    </section>
  )
}
