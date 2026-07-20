'use client'

// "Co-host booth" — the streamer's auto-armed return camera for LiveKit
// rooms. The arm toggle's click is the user gesture that clears the
// browser's camera/mic permission up front (prophylactic getUserMedia; the
// tracks are stopped straight after, so no camera LED while idle). Once
// armed, the camera publishes itself the moment a guest's seat goes live
// and hangs up shortly after the last guest leaves — no per-guest button
// pushing. Viewers in a live slot receive this feed sub-second. vdo rooms
// keep their copy-link flow; this card only renders for
// transport === 'livekit'.

import { useEffect, useRef, useState } from 'react'
import { Radio, RefreshCw } from 'lucide-react'
import { GlassCard, CardHeader } from '@/components/glass-card'
import { useRoom } from '@/components/room-provider'
import type { Room as LiveKitRoom } from 'livekit-client'

// Falling-edge grace: a guest reconnect (or a back-to-back second guest)
// must not churn the camera off/on.
const OFF_AIR_DEBOUNCE_MS = 5000

function isDenied(e: unknown) {
  return (
    e instanceof DOMException &&
    (e.name === 'NotAllowedError' || e.name === 'SecurityError')
  )
}

export function HostCamCard() {
  const { mode, room, seats, hostToken } = useRoom()
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false) // permission preflight in flight
  const [connecting, setConnecting] = useState(false)
  const [onAir, setOnAir] = useState(false)
  const [micOnly, setMicOnly] = useState(false)
  const [camBusyHint, setCamBusyHint] = useState(false) // preflight found the camera held elsewhere
  const [error, setError] = useState<string | null>(null)

  const lkRef = useRef<LiveKitRoom | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const connectingRef = useRef(false)
  const offTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retriedRef = useRef(false)
  // read inside async work without re-binding it
  const armedRef = useRef(false)
  armedRef.current = armed
  const liveCount = seats.filter((s) => s.live).length
  const liveCountRef = useRef(0)
  liveCountRef.current = liveCount

  const active = mode === 'managing' && room?.transport === 'livekit'
  const storageKey = room ? `mc-booth-armed:${room.id}` : null

  function teardown() {
    if (offTimerRef.current) {
      clearTimeout(offTimerRef.current)
      offTimerRef.current = null
    }
    const r = lkRef.current
    lkRef.current = null
    if (r) {
      try {
        for (const pub of r.localParticipant.trackPublications.values()) pub.track?.stop()
      } catch {
        /* already stopped */
      }
      void r.disconnect()
    }
    setOnAir(false)
    setConnecting(false)
    setMicOnly(false)
  }

  function scheduleOff() {
    if (offTimerRef.current) return
    offTimerRef.current = setTimeout(() => {
      offTimerRef.current = null
      if (liveCountRef.current === 0) teardown()
    }, OFF_AIR_DEBOUNCE_MS)
  }

  async function publish() {
    if (connectingRef.current || lkRef.current) return
    connectingRef.current = true
    setConnecting(true)
    setError(null)
    try {
      const grant = await hostToken()
      const lk = await import('livekit-client')
      const lkRoom = new lk.Room({ publishDefaults: { simulcast: true } })
      await lkRoom.connect(grant.url, grant.token)
      if (!armedRef.current) {
        // disarmed mid-connect — hang up before publishing anything
        void lkRoom.disconnect()
        return
      }
      let camOk = true
      try {
        await lkRoom.localParticipant.enableCameraAndMicrophone()
      } catch {
        // camera unreadable (e.g. OBS holds it) → degrade to mic-only
        camOk = false
        await lkRoom.localParticipant.setMicrophoneEnabled(true)
      }
      if (camOk) {
        const pub = [...lkRoom.localParticipant.videoTrackPublications.values()][0]
        if (pub?.track && videoRef.current) pub.track.attach(videoRef.current)
      }
      lkRef.current = lkRoom
      setMicOnly(!camOk)
      setOnAir(true)
      // guests may all have left while we connected — let the grace timer run
      if (liveCountRef.current === 0) scheduleOff()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not go on air')
      // one spaced retry per guest-arrival (covers a cold token/SFU hiccup)
      if (!retriedRef.current) {
        retriedRef.current = true
        setTimeout(() => {
          if (armedRef.current && liveCountRef.current > 0 && !lkRef.current) void publish()
        }, 4000)
      }
    } finally {
      connectingRef.current = false
      setConnecting(false)
    }
  }

  // Autopilot: guest presence drives the publish. Rising edge (0 → >0)
  // connects; falling edge starts the grace timer instead of hanging up
  // immediately.
  useEffect(() => {
    if (!active || !armed) return
    if (liveCount > 0) {
      if (offTimerRef.current) {
        clearTimeout(offTimerRef.current)
        offTimerRef.current = null
      }
      if (!lkRef.current && !connectingRef.current) void publish()
    } else {
      retriedRef.current = false
      if (lkRef.current || connectingRef.current) scheduleOff()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, armed, liveCount])

  // Re-arm silently across reloads — only when the browser still remembers
  // the grant (a prompt is impossible without a fresh user gesture).
  useEffect(() => {
    if (!active || !storageKey) return
    if (localStorage.getItem(storageKey) !== '1') return
    if (!navigator.permissions?.query) return
    let stale = false
    navigator.permissions
      .query({ name: 'camera' as PermissionName })
      .then((st) => {
        if (stale) return
        if (st.state === 'granted') setArmed(true)
        else localStorage.removeItem(storageKey)
      })
      .catch(() => {
        /* can't verify — stay disarmed until the next toggle click */
      })
    return () => {
      stale = true
    }
  }, [active, storageKey])

  // Switching rooms (or leaving managing mode) always hangs up and disarms;
  // the re-arm effect above decides the next room's state from its own flag.
  useEffect(() => {
    return () => {
      teardown()
      setArmed(false)
      setCamBusyHint(false)
      setError(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id])

  // While actually publishing, this tab IS the camera pipe — warn on close.
  useEffect(() => {
    if (!onAir) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [onAir])

  if (!active) return null

  async function onToggle(next: boolean) {
    setError(null)
    if (!next) {
      teardown()
      setArmed(false)
      setCamBusyHint(false)
      if (storageKey) localStorage.removeItem(storageKey)
      return
    }
    // Arming — THIS click is the user gesture: request camera+mic now so
    // the permission is settled long before any guest arrives.
    setBusy(true)
    try {
      let stream: MediaStream
      let camOk = true
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      } catch (e) {
        if (isDenied(e)) {
          setError(
            'Camera blocked — click the camera icon in your browser address bar, allow it, then arm again.',
          )
          return
        }
        // camera missing or held by another app → the mic at least must work
        camOk = false
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        } catch (e2) {
          setError(
            isDenied(e2)
              ? 'Microphone blocked — click the camera icon in your browser address bar, allow it, then arm again.'
              : 'No usable camera or microphone found.',
          )
          return
        }
      }
      stream.getTracks().forEach((t) => t.stop()) // grant is stored; LED off until a guest arrives
      setCamBusyHint(!camOk)
      setArmed(true)
      if (storageKey) localStorage.setItem(storageKey, '1')
    } finally {
      setBusy(false)
    }
  }

  const guestNoun = `${liveCount} guest${liveCount === 1 ? '' : 's'}`
  const status = !armed
    ? 'Booth off — guests see a waiting screen'
    : connecting
      ? 'Guest is live — going on air…'
      : onAir
        ? micOnly
          ? `🔴 ON AIR to ${guestNoun} (mic only — your camera is busy in another app)`
          : `🔴 ON AIR to ${guestNoun} — they see you in real time`
        : camBusyHint
          ? 'Armed, mic-only (camera busy in another app) — goes on air when a guest joins'
          : 'Armed — camera goes on air the moment a guest joins'

  return (
    <GlassCard>
      <CardHeader
        icon={<Radio className="size-5" />}
        title="Co-host booth"
        description="Arm once. Your camera goes on air to live guests automatically and hangs up when they leave — they see you sub-second (the public broadcast runs ~15s behind)."
        accent="lime"
      />
      <div className="flex flex-col gap-3 px-5 py-5 sm:px-6">
        <label
          htmlFor="cohost-booth"
          className={
            'flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition-colors ' +
            (armed
              ? 'border-[var(--neon-lime)]/60 bg-[var(--neon-lime)]/10'
              : 'border-border bg-input/20')
          }
        >
          <input
            type="checkbox"
            id="cohost-booth"
            className="size-4 accent-[var(--neon-lime)]"
            checked={armed}
            disabled={busy}
            onChange={(e) => void onToggle(e.target.checked)}
          />
          <span className="flex-1 text-sm font-semibold">
            {busy ? 'Requesting camera…' : armed ? 'Booth armed' : 'Arm the booth'}
          </span>
          {busy ? <RefreshCw className="size-4 animate-spin text-muted-foreground" /> : null}
        </label>

        <p id="boothStatus" aria-live="polite" className="text-xs text-muted-foreground">
          {status}
        </p>

        {/* mirrored self-view — only while the camera is actually publishing */}
        <div
          className="relative overflow-hidden rounded-xl border border-border bg-black"
          style={{
            aspectRatio: '16 / 9',
            maxHeight: 200,
            display: onAir && !micOnly ? undefined : 'none',
          }}
        >
          <video
            ref={videoRef}
            muted
            playsInline
            className="absolute inset-0 size-full object-cover"
            style={{ transform: 'scaleX(-1)' }}
          />
        </div>

        {error ? (
          <p id="boothError" className="text-xs text-[var(--neon-magenta)]">
            {error}
          </p>
        ) : null}
        {onAir ? (
          <p className="text-xs text-muted-foreground">
            Keep this tab open while streaming — it carries your camera. Headphones on:
            guests hear your mic.
          </p>
        ) : null}
      </div>
    </GlassCard>
  )
}
