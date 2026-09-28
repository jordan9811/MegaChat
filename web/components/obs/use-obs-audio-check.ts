'use client'

// Runs lib/obs-audio-check.mjs against the streamer's OBS while the booth is
// on air: at once, whenever the way guests are heard changes, and every 15s.
// Only with a stored OBS password (from "Add to OBS"); without one there is
// nothing to ask and nothing is said. A fix is sent only on the streamer's
// click, and checked again at once. THE PASSWORD NEVER LEAVES THE BROWSER.
//
// Latest wins: a check started for the old mode never publishes after a mode
// change, and a check asked for while one runs is run as soon as it finishes
// (never dropped).

import { useCallback, useEffect, useRef, useState } from 'react'
import { ObsClient } from '@/lib/obs-client.mjs'
import { checkObsAudio } from '@/lib/obs-audio-check.mjs'

export type ObsAudioProblem = {
  id: string
  code: string
  text: string
  fix: null | { label: string; requestType: string; requestData: Record<string, unknown> }
}

const LS_PASSWORD = 'mc_obs_ws_password'
const POLL_MS = 15_000

function password() {
  try {
    return localStorage.getItem(LS_PASSWORD) || null
  } catch {
    return null
  }
}

export function useObsAudioCheck({
  enabled,
  mode,
  roomId,
  handle,
}: {
  enabled: boolean
  mode: 'tab' | 'system' | null
  roomId: string | null
  handle: string | null
}) {
  const [problems, setProblems] = useState<ObsAudioProblem[]>([])
  const key = `${enabled}|${mode}|${roomId}|${handle}`
  const keyRef = useRef(key)
  keyRef.current = key
  const busy = useRef(false)
  const again = useRef(false)
  const runRef = useRef<() => Promise<void>>(async () => {})

  const run = useCallback(async () => {
    const pw = password()
    if (!enabled || !mode || !roomId || !pw) {
      setProblems([])
      return
    }
    if (busy.current) {
      again.current = true
      return
    }
    const mine = `${enabled}|${mode}|${roomId}|${handle}`
    busy.current = true
    let c: ObsClient | null = null
    try {
      c = await new ObsClient({ password: pw }).connect()
      const client = c
      const found = (await checkObsAudio(
        (t: string, d?: object) => client.request(t, d as Record<string, unknown> | undefined),
        { mode, roomId, handle },
      )) as ObsAudioProblem[]
      if (mine === keyRef.current) setProblems((prev) => (JSON.stringify(prev) === JSON.stringify(found) ? prev : found))
    } catch {
      // OBS closed, or the password changed: say nothing rather than guess.
      if (mine === keyRef.current) setProblems([])
    } finally {
      try { c?.close() } catch { /* already closed */ }
      busy.current = false
      if (again.current) {
        again.current = false
        void runRef.current()
      }
    }
  }, [enabled, mode, roomId, handle])
  runRef.current = run

  useEffect(() => {
    if (!enabled) {
      setProblems([])
      return
    }
    void run()
    const t = setInterval(() => void runRef.current(), POLL_MS)
    return () => clearInterval(t)
  }, [enabled, key, run])

  /** Send a problem's one fixing request; true when OBS accepted it. */
  const fix = useCallback(async (p: ObsAudioProblem) => {
    const pw = password()
    if (!p.fix || !pw) return false
    let c: ObsClient | null = null
    let ok = false
    try {
      c = await new ObsClient({ password: pw }).connect()
      await c.request(p.fix.requestType, p.fix.requestData)
      ok = true
    } catch {
      ok = false
    } finally {
      try { c?.close() } catch { /* already closed */ }
    }
    await runRef.current()
    return ok
  }, [])

  return { problems, fix }
}
