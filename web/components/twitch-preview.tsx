'use client'

// The live picture everyone sees for a room — Twitch's own auto-thumbnail for
// the streamer's channel.
//
// This exists because the thumbnail we WANT is not always the thumbnail that
// exists. The server proves a channel is live by probing the 440x248 variant
// (server.js refreshTwitchLive), but the hero card wants 1280x720, and Twitch
// populates the larger variants later than the small one: measured on a
// channel that was definitely live, 1280x720 came back HTTP 200 with a fully
// black frame (max channel value 41) at the same instant 440x248 had real
// picture. A 200 with a black body is indistinguishable from a good frame to
// an <img>, so the only way to tell is to look at the pixels.
//
// So: walk candidate sizes largest-first, measure each one on a canvas, and
// use the first that actually has picture in it. If none do, render nothing
// and let the caller's own fallback art show through.

import { useEffect, useState } from 'react'

// Twitch sends Cache-Control: max-age=300 on these images, so a bucket shorter
// than 5 minutes does not actually buy fresher pixels from a cold cache — what
// it buys is a new URL, which forces the browser to go ask again instead of
// pinning whatever it got the first time. 2 minutes matches the bucket the
// rooms board already used, and it is the interval on which a channel that was
// black a minute ago gets re-checked and recovers on its own.
const BUCKET_MS = 120000

// Largest-first. 440x248 is always last because it is the exact variant the
// server already proved is live — if even that one is blank the channel truly
// has nothing to show yet, and guessing another size will not help.
const SIZES: Record<'hero' | 'card', string[]> = {
  hero: ['1280x720', '640x360', '440x248'],
  card: ['440x248'],
}

// Mean luminance at or below this counts as "no picture yet". The measured
// black frame was 0,0,0 mean with a single stray pixel at 41, so its mean
// luminance rounds to ~0; two samples of real picture measured ~28 and ~80.
// 6 sits in the empty gap between those, far enough above 0 to absorb the
// JPEG noise in an almost-black frame and far enough below 28 that a genuinely
// dark-but-real stream (a horror game, a black desktop) still renders.
const BLANK_LUMA = 6

// Small enough to be free, still 16:9 so the downscale samples the whole frame
// rather than a letterboxed slice.
const PROBE_W = 32
const PROBE_H = 18

function previewUrl(login: string, size: string, bucket: number) {
  return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-${size}.jpg?b=${bucket}`
}

// Returns mean luminance 0-255, or null when the pixels could not be read at
// all (a browser that blocks canvas reads, say). The CDN sends
// Access-Control-Allow-Origin: *, so with crossOrigin='anonymous' the canvas
// is NOT tainted and this normally just works.
function meanLuma(img: HTMLImageElement): number | null {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = PROBE_W
    canvas.height = PROBE_H
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, PROBE_W, PROBE_H)
    const { data } = ctx.getImageData(0, 0, PROBE_W, PROBE_H)
    let sum = 0
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    }
    return sum / (data.length / 4)
  } catch {
    return null
  }
}

export function TwitchPreview({
  channel,
  live,
  size = 'card',
  className,
}: {
  channel: string | null | undefined
  live: boolean
  size?: 'hero' | 'card'
  className?: string
}) {
  // Rooms store the channel however the owner typed it — '@Name', 'NAME', with
  // stray spaces. The CDN path is lowercase login only.
  const login = String(channel || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()

  const [bucket, setBucket] = useState(() => Math.floor(Date.now() / BUCKET_MS))
  // Keyed by channel+size so a stale result from the previous channel can never
  // paint over the new one, and so the old frame survives a bucket refresh
  // instead of flashing the fallback every two minutes. `cors` is false for a
  // frame we are showing UNMEASURED — see the fail-open path below.
  const [found, setFound] = useState<{ key: string; url: string; cors: boolean } | null>(null)
  // Bumped to re-run detection out of band: the rendered frame failing is the
  // one signal that arrives after detection has already finished.
  const [retry, setRetry] = useState(0)

  const key = `${login}|${size}`

  // Tick to the next bucket boundary rather than every BUCKET_MS from mount, so
  // every card on the page refreshes together and a card mounted 10s before a
  // boundary does not sit on a black frame for two more minutes.
  useEffect(() => {
    if (!login || !live) return
    const delay = BUCKET_MS - (Date.now() % BUCKET_MS) + 250
    const t = setTimeout(() => setBucket(Math.floor(Date.now() / BUCKET_MS)), delay)
    return () => clearTimeout(t)
  }, [login, live, bucket])

  // Detection. Re-runs from the FIRST candidate whenever the channel, the size
  // or the bucket changes — a channel that was blank a minute ago usually has
  // picture now, and it has to recover without a page reload.
  useEffect(() => {
    if (!login || !live) {
      setFound(null)
      return
    }
    const candidates = SIZES[size]
    let cancelled = false
    let probe: HTMLImageElement | null = null
    // Did any candidate decode at all? Distinguishes "Twitch has no picture
    // yet" (loaded, measured blank) from "we could not look" (never loaded).
    let anyLoaded = false

    const attempt = (i: number) => {
      if (cancelled) return
      if (i >= candidates.length) {
        if (!anyLoaded) {
          // Nothing decoded, so nothing was ever MEASURED. The usual cause is
          // the CORS request failing — a proxy that strips the CDN's
          // Access-Control-Allow-Origin, an extension, an offline cache — and
          // that must not blank a channel the server has already proved is on
          // air. Fail OPEN: show the last candidate with no crossOrigin and no
          // measurement. Blanking a working stream is a worse bug than the
          // black frame this component exists to catch.
          setFound({ key: `${login}|${size}`, url: previewUrl(login, candidates[candidates.length - 1], bucket), cors: false })
          return
        }
        // Every variant decoded and every one was blank: the channel genuinely
        // has no picture yet, so drop back to the caller's fallback art.
        setFound(null)
        return
      }
      const url = previewUrl(login, candidates[i], bucket)
      const img = new Image()
      probe = img
      // Must be set before .src or the request goes out without CORS and the
      // canvas read below throws.
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        if (cancelled) return
        anyLoaded = true
        const luma = meanLuma(img)
        // If we could not measure at all, only the last candidate is
        // trustworthy — it is the one the server already proved live, so show
        // it rather than blanking a channel that is genuinely on air.
        const blank = luma === null ? i < candidates.length - 1 : luma <= BLANK_LUMA
        if (blank) {
          attempt(i + 1)
          return
        }
        setFound({ key: `${login}|${size}`, url, cors: true })
      }
      // A 404 (variant not generated yet) is the same situation as a black
      // frame: nothing to show at this size, try the next one down.
      img.onerror = () => attempt(i + 1)
      img.src = url
    }

    attempt(0)

    // Strict mode mounts effects twice and callers unmount cards while images
    // are still in flight. Detach the handlers and blank the src so the
    // in-flight load cannot resolve into setState on a dead component.
    return () => {
      cancelled = true
      if (probe) {
        probe.onload = null
        probe.onerror = null
        probe.src = ''
        probe = null
      }
    }
  }, [login, live, size, bucket, retry])

  const url = found && found.key === key ? found.url : null
  if (!login || !live || !url) return null

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className}
      src={url}
      // Same crossOrigin the probe used so the browser reuses that cache entry
      // — except on the fail-open path, where the probe never got a CORS
      // response and asking for one again would fail the same way.
      crossOrigin={found && found.cors ? 'anonymous' : undefined}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      // The frame is decorative — both callers render their own live/state
      // badge, so nothing here is the only source of any information.
      // Re-probe rather than just blanking: without the bump nothing in the
      // detection effect's deps changes, so a single failed paint would hold
      // the fallback until the next bucket tick two minutes away.
      onError={() => {
        setFound(null)
        setRetry((n) => n + 1)
      }}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
    />
  )
}
