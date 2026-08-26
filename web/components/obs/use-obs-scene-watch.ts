'use client'

// OBS SCENE WATCH — keep asking OBS whether the overlay is actually on screen.
//
// `verifyOverlayInObs` answers that once, at setup. This keeps asking, because
// the answer changes: scenes get switched, sources get unticked, items get
// dragged. The expensive version of that story is a streamer who set
// everything up correctly, went live, switched to a scene without the overlay
// forty minutes in, and found out at payout.
//
// ── WHAT THIS IS AND IS NOT ────────────────────────────────────────────────
// It runs on the streamer's machine and reports on the streamer's machine, so
// it is CORROBORATION, never proof. It is recorded as evidence and can send a
// verification to a human; it can never, on its own, deny anyone a payout.
//
// A streamer using manual paste has no obs-websocket connection and posts
// nothing at all. That is a completely normal state — NOT_CONNECTED is not a
// warning, is not held against them, and is not even reported. Never let this
// become a soft requirement to connect obs-websocket to get paid.
//
// THE PASSWORD STILL NEVER LEAVES THE BROWSER: this reuses the same local
// connection the one-click flow makes, and posts only the resulting verdict.

import { useEffect, useRef, useState } from 'react'
import { ObsClient } from '@/lib/obs-client.mjs'
import { checkOverlayVisible, SCENE_STATE } from '@/lib/obs-scene-check.mjs'

export type SceneSample = {
  state: string
  visible: boolean
  checked: boolean
  detail?: string
  sceneName?: string
}

/**
 * @param airSessionId  null disables the watch entirely.
 * @param password      obs-websocket password; empty disables the watch.
 */
export function useObsSceneWatch({
  airSessionId,
  password,
  pollMs = 5000,
  enabled = true,
}: {
  airSessionId: string | null
  password: string
  pollMs?: number
  enabled?: boolean
}) {
  const [last, setLast] = useState<SceneSample | null>(null)
  // Held in a ref so a changing sample never restarts the interval — a poll
  // loop that resubscribes on every result is how you get a thundering
  // reconnect against someone's OBS.
  const busy = useRef(false)

  useEffect(() => {
    if (!enabled || !airSessionId || !password) { setLast(null); return }
    let stopped = false

    const tick = async () => {
      if (stopped || busy.current) return
      busy.current = true
      // A fresh short-lived connection per poll, deliberately. At a 5s cadence
      // over loopback that costs nothing, and it means OBS being closed,
      // restarted, or reconfigured mid-broadcast self-heals on the next tick
      // instead of needing a reconnect state machine that could get stuck
      // reporting stale visibility.
      const client = new ObsClient({ password })
      let sample: SceneSample
      try {
        await client.connect()
        sample = (await checkOverlayVisible(client)) as SceneSample
      } catch {
        sample = { state: SCENE_STATE.NO_CONNECTION, visible: false, checked: false }
      } finally {
        try { client.close() } catch { /* already gone */ }
        busy.current = false
      }
      if (stopped) return
      setLast(sample)
      // Only post what we actually LEARNED. "OBS was not reachable" is not an
      // observation about the streamer, and writing it into the evidence chain
      // every five seconds would bury the samples that mean something.
      if (!sample.checked) return
      try {
        await fetch(`/api/bounty/air-session/${encodeURIComponent(airSessionId)}/obs-scene`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ ...sample, at: Date.now() }),
        })
      } catch { /* next tick reports again */ }
    }

    void tick()
    const t = setInterval(() => void tick(), Math.max(2000, pollMs))
    return () => { stopped = true; clearInterval(t) }
  }, [airSessionId, password, pollMs, enabled])

  return last
}
