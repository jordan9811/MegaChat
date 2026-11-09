'use client'

// What the room's OBS overlay says about itself, and the one link OBS needs.
//
// The overlay reports its own browser-source size and whether its bounty
// badge is too small to read (overlay_env over its socket; server.js keeps
// the latest per room). The OBS card reads the size to say "OBS source is
// 800×600 · set it to your canvas size" (ov-source-size); the overlay health
// card reads the badge flag to raise "Your overlay is too small to be read"
// for every room, not only one whose OBS password this browser holds
// (ov-too-small-on-air).

import { useEffect, useState } from 'react'
import { withOverlayKey } from '@/lib/overlay-key'

export type OverlayEnv = {
  /** Overlays connected to the room right now. */
  overlays: number
  env: { width: number; height: number; badgeTooSmall: boolean | null } | null
}

const POLL_MS = 10_000

export function useOverlayEnv(roomId: string | null | undefined, enabled = true): OverlayEnv | null {
  const [state, setState] = useState<OverlayEnv | null>(null)
  useEffect(() => {
    setState(null)
    if (!roomId || !enabled) return
    let stop = false
    const load = () =>
      fetch(`/api/rooms/${encodeURIComponent(roomId)}/overlay-env`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (!stop && d) setState({ overlays: Number(d.overlays) || 0, env: d.env ?? null }) })
        .catch(() => { /* transient — next poll retries */ })
    void load()
    const t = setInterval(load, POLL_MS)
    return () => { stop = true; clearInterval(t) }
  }, [roomId, enabled])
  return state
}

/** A source that is not 16:9 cannot match the 1920×1080 preview at any scale. */
export function sourceSizeWrong(env: OverlayEnv | null): { width: number; height: number } | null {
  const e = env?.env
  if (!e || !e.width || !e.height) return null
  return Math.abs(e.width / e.height - 16 / 9) > 0.02 ? { width: e.width, height: e.height } : null
}

/**
 * The overlay link the dashboard hands OBS: the pretty /<handle>/overlay when
 * the room has a handle, else /overlay?room=<id>, carrying the room's overlay
 * key either way.
 */
export function obsOverlayLink(room: { id: string; handle?: string | null } | null, overlayUrl: string | null): string | null {
  if (!room || !overlayUrl) return null
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  if (!origin) return overlayUrl
  return withOverlayKey(room.handle ? `${origin}/${room.handle}/overlay` : `${origin}/overlay?room=${room.id}`, overlayUrl)
}

/** The room's overlay key, from the server's overlayUrl (`&k=`), or ''. */
export function overlayKeyOf(overlayUrl: string | null): string {
  if (!overlayUrl) return ''
  try { return new URL(overlayUrl).searchParams.get('k') || '' } catch { return '' }
}
