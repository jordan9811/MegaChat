'use client'

// The live picture everyone sees for a room — Twitch's own auto-thumbnail for
// the streamer's channel.
//
// This exists because the thumbnail we WANT is not always the thumbnail that
// exists, and Twitch answers both failure modes with HTTP 200 and a valid
// JPEG, so an <img> cannot tell any of them apart:
//
//   1. BLACK. Measured on a channel that was definitely live: 1280x720 came
//      back 200 with a fully black frame (max channel value 41) at the same
//      instant 440x248 had real picture. The large variants populate later.
//   2. THE OFFLINE PLACEHOLDER. For a dark channel Twitch REDIRECTS to
//      ttv-static/404_preview-<size>.jpg — a gray camera glyph — and serves it
//      at 200. It is not black (mean luminance ~85), so a pixel test alone
//      waves it straight through. Measured 2026-09-12, when exactly that got
//      painted onto a room card as if it were the stream.
//
// So each candidate is fetched rather than loaded: the response's final URL
// catches the placeholder, and the decoded pixels catch the black frame. The
// first candidate that survives both is rendered; if none do, this renders
// nothing and the caller's own fallback art shows through.

import { useEffect, useState } from 'react'

// Twitch sends Cache-Control: max-age=300 on these images, so a bucket shorter
// than 5 minutes does not buy fresher pixels from a cold cache — what it buys
// is a new URL, which forces the browser to go ask again instead of pinning
// whatever it got the first time. 2 minutes matches the bucket the rooms board
// already used, and it is the interval on which a channel that was black a
// minute ago gets re-checked and recovers on its own.
const BUCKET_MS = 120000

// Largest-first. 440x248 is last because it is the smallest and softest, not
// because it is trustworthy: it is in fact the ONE variant that does not
// redirect when a channel is dark, which is how a stale frame from it fooled
// the server's liveness probe. The URL check below is what makes it safe.
const SIZES: Record<'hero' | 'card', string[]> = {
  hero: ['1280x720', '640x360', '440x248'],
  card: ['440x248'],
}

// Mean luminance at or below this counts as "no picture yet". The measured
// black frame was 0,0,0 mean with a single stray pixel at 41, so its mean
// luminance rounds to ~0; samples of real picture measured 26, 85 and 89.
// 6 sits in the empty gap, far enough above 0 to absorb JPEG noise in an
// almost-black frame and far enough below 26 that a genuinely dark-but-real
// stream (a horror game, a black desktop) still renders.
const BLANK_LUMA = 6

// Small enough to be free, still 16:9 so the downscale samples the whole frame
// rather than a letterboxed slice.
const PROBE_W = 32
const PROBE_H = 18

function previewUrl(login: string, size: string, bucket: number) {
  return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-${size}.jpg?b=${bucket}`
}

type Verdict = 'ok' | 'reject' | 'unknown'

// 'reject' means we looked and there is nothing worth showing. 'unknown' means
// we could not look at all — a blocked fetch, a browser that refuses the
// canvas read — which is deliberately NOT the same answer, because blanking a
// stream that is genuinely on air is a worse failure than the one this guards.
async function inspect(url: string, signal: AbortSignal): Promise<Verdict> {
  let res: Response
  try {
    // The CDN sends Access-Control-Allow-Origin: *, so this is a normal CORS
    // read and the pixels below are not tainted.
    res = await fetch(url, { mode: 'cors', signal })
  } catch {
    return 'unknown'
  }
  if (!res.ok) return 'reject'
  // The redirect is the only honest signal for a dark channel: the bytes that
  // come back are a real JPEG either way.
  if (/ttv-static|404_preview/i.test(res.url)) return 'reject'
  try {
    const bitmap = await createImageBitmap(await res.blob())
    const canvas = document.createElement('canvas')
    canvas.width = PROBE_W
    canvas.height = PROBE_H
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return 'unknown'
    ctx.drawImage(bitmap, 0, 0, PROBE_W, PROBE_H)
    bitmap.close?.()
    const { data } = ctx.getImageData(0, 0, PROBE_W, PROBE_H)
    let sum = 0
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    }
    return sum / (data.length / 4) <= BLANK_LUMA ? 'reject' : 'ok'
  } catch {
    return 'unknown'
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
  // instead of flashing the fallback every two minutes.
  const [found, setFound] = useState<{ key: string; url: string } | null>(null)

  const key = `${login}|${size}`

  // Tick to the next bucket boundary rather than every BUCKET_MS from mount, so
  // every card on the page refreshes together and a card mounted 10s before a
  // boundary does not sit on a rejected frame for two more minutes. The +250ms
  // clears the boundary so the recomputation below lands in the NEXT bucket
  // instead of racing it and reading the same number back.
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
    const control = new AbortController()
    let cancelled = false

    void (async () => {
      // Remembered so that "we could not look" can fall back to showing
      // something, while "we looked and it was a placeholder" never does.
      let unlooked: string | null = null
      for (const candidate of SIZES[size]) {
        const url = previewUrl(login, candidate, bucket)
        const verdict = await inspect(url, control.signal)
        if (cancelled) return
        if (verdict === 'ok') {
          setFound({ key: `${login}|${size}`, url })
          return
        }
        if (verdict === 'unknown') unlooked = url
      }
      // Every candidate was inspected and rejected: the channel has no picture
      // worth showing, so drop back to the caller's fallback art. Only when we
      // were never able to LOOK do we show something unverified.
      setFound(unlooked ? { key: `${login}|${size}`, url: unlooked } : null)
    })()

    return () => {
      cancelled = true
      control.abort()
    }
  }, [login, live, size, bucket])

  const url = found && found.key === key ? found.url : null
  if (!login || !live || !url) return null

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className}
      src={url}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      // The frame is decorative — both callers render their own live/state
      // badge, so nothing here is the only source of any information. Hiding
      // on error rather than re-probing: a retry here has no new information
      // to act on and only risks a loop, and the bucket tick recovers it.
      onError={() => setFound(null)}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
    />
  )
}
