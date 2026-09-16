'use client'

// OVERLAY VISIBILITY WATCH — for any live room, not just a bounty claim.
//
// `useObsSceneWatch` does this for an air session: it only runs under
// `isBounty && phase === 'verified'`, keys everything to an airSessionId, and
// posts to a route that mounts only when BOUNTY_CLAIM=1. A streamer running an
// ordinary MegaChat room gets nothing from it — and they are exactly the person
// who switches scenes and finds out later.
//
// So this watches the ROOM. It starts when the room is live and an OBS password
// is present, stops when either goes away, and posts transitions to
// /api/rooms/:roomId/overlay-visibility.
//
// ── WHAT IT IS ─────────────────────────────────────────────────────────────
// Accident detection. It runs in the streamer's browser against the streamer's
// OBS, so it is corroboration and never proof. Broadcast capture stays the
// payout authority — nothing here gates a payout on its own. A manual-paste
// streamer has no obs-websocket and posts NOTHING; that silence is normal and
// is never held against them. Do not let this become a soft requirement to
// connect obs-websocket in order to be paid.
//
// THE PASSWORD NEVER LEAVES THE BROWSER. Same local connection the one-click
// flow makes; only the resulting verdict is posted.

import { useEffect, useRef, useState } from 'react'
import { ObsClient } from '@/lib/obs-client.mjs'
import { checkOverlayVisibility, VISIBILITY } from '@/lib/obs-visibility.mjs'

export type VisibilitySample = {
  signal: string
  reason: string | null
  detail?: string | null
  checked: boolean
  visible: boolean
  rect?: { x: number; y: number; width: number; height: number } | null
  scale?: { scaleX: number | null; scaleY: number | null; sourceWidth: number | null; sourceHeight: number | null } | null
  occlusion?: { checked: boolean; covered: boolean; by: string | null; fraction: number } | null
}

/**
 * Five seconds, and the reasoning rather than the number.
 *
 * The streamer-facing requirement is that a hidden overlay shows up within one
 * poll, so the interval IS the worst-case blindness the dashboard can have. It
 * also sets how much airtime a later pass could attribute to a bury, so it
 * wants to be short. Against that: each tick opens and closes a loopback
 * connection and now issues six requests instead of five, and obs-client's
 * connect timeout is 6s — a cadence below the tick duration silently becomes
 * the tick duration. Five seconds is the same number the air-session watch has
 * used since it shipped, which keeps one cadence to reason about rather than
 * two, and leaves headroom over the measured tick cost.
 */
export const VISIBILITY_POLL_MS = 5000

export function useOverlayVisibility({
  roomId,
  password,
  enabled,
  sessionKey = null,
  pollMs = VISIBILITY_POLL_MS,
}: {
  roomId: string | null
  password: string | null
  enabled: boolean
  sessionKey?: string | null
  pollMs?: number
}) {
  const [last, setLast] = useState<VisibilitySample | null>(null)
  const busy = useRef(false)
  // Post only on CHANGE. The store refuses repeats anyway, but a request every
  // five seconds for four hours to be told "no change" is noise on both ends.
  const lastPosted = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled || !roomId || !password) {
      setLast(null)
      lastPosted.current = null
      return
    }
    let stopped = false

    const tick = async () => {
      if (stopped || busy.current) return
      busy.current = true
      // A fresh short-lived connection per poll, deliberately — OBS being
      // closed, restarted or reconfigured mid-broadcast then self-heals on the
      // next tick instead of needing a reconnect state machine that can get
      // stuck reporting stale visibility.
      const client = new ObsClient({ password })
      let sample: VisibilitySample
      try {
        await client.connect()
        sample = (await checkOverlayVisibility(client)) as VisibilitySample
      } catch {
        sample = { signal: VISIBILITY.DISCONNECTED, reason: null, checked: false, visible: false }
      } finally {
        try { client.close() } catch { /* already gone */ }
        busy.current = false
      }
      if (stopped) return
      setLast(sample)

      // "We could not reach OBS" is not an observation about the streamer. It
      // is shown locally so they know the check is blind, and deliberately not
      // written to the room's chain every five seconds.
      if (!sample.checked) return

      const key = `${sample.signal}:${sample.reason ?? ''}`
      if (key === lastPosted.current) return
      try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/overlay-visibility`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            signal: sample.signal,
            reason: sample.reason,
            detail: sample.detail ?? null,
            rect: sample.rect ?? null,
            scale: sample.scale ?? null,
            occlusion: sample.occlusion ?? null,
            sessionKey,
          }),
        })
        // Only remember it as posted if it landed; a failed post must retry.
        if (res.ok) lastPosted.current = key
      } catch { /* next tick reports again */ }
    }

    void tick()
    const id = setInterval(() => { void tick() }, pollMs)
    return () => { stopped = true; clearInterval(id) }
  }, [enabled, roomId, password, sessionKey, pollMs])

  return last
}
