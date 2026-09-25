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
import { Radio, RefreshCw, VideoOff } from 'lucide-react'
import { GlassCard, CardHeader } from '@/components/glass-card'
import { useRoom } from '@/components/room-provider'
import type { Room as LiveKitRoom, RemoteParticipant, RemoteTrack } from 'livekit-client'

// Falling-edge grace: a guest reconnect (or a back-to-back second guest)
// must not churn the camera off/on.
const OFF_AIR_DEBOUNCE_MS = 5000
// How often to ask for a camera that something else is holding. 6s is short
// enough that the operator sees it recover while they are still looking at
// the booth, and getUserMedia on a busy device fails fast and cheaply.
const CAM_RETRY_MS = 6000

// "ON AIR" only ever proved a video track was PUBLISHED — not that it carried
// a person. OBS Virtual Camera, selected here but never started in OBS, emits
// OBS's own placeholder (logo + crossed-out camera) as an ordinary, healthy
// 30fps track: the booth said "they see you in real time" while every guest
// stared at a logo. So no picture is SHOWN — not in this self-view, not on the
// guest's page — until the booth has confirmed it moves; until then, and
// whenever it stops, both sides get a designed state and the voice carries on.
// A real camera never produces two byte-identical frames (sensor noise alone
// moves some pixel), so identical samples mean a still image is going out.
const PICTURE_SAMPLE_MS = 500
const LIVE_AFTER = 2 // consecutive differing samples before the picture is shown (~1s)
const STILL_AFTER = 4 // consecutive identical samples before it is taken away (~2s)
const OBS_AFTER = 2 // consecutive samples that ARE OBS's placeholder (~1s)
type Picture = 'checking' | 'live' | 'obs' | 'still'
/** Flat regions of data/obs-plugins/win-dshow/placeholder.png on a 16×9 grid,
 *  with their colours. Flat so the browser's downscale filter cannot move
 *  them; mirroring is irrelevant because the canvas reads the raw frame. */
const OBS_PLACEHOLDER: [number, number, [number, number, number]][] = [
  [14, 0, [33, 41, 84]], // navy, top right
  [15, 2, [33, 41, 84]],
  [2, 3, [35, 48, 108]], // blue band, left
  [0, 8, [24, 26, 48]], // dark band, bottom
  [13, 8, [24, 26, 48]],
]

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
  // What the outgoing picture is, as far as the booth can prove. Only 'live'
  // is ever shown; everything else is a designed state on both sides.
  const [picture, setPicture] = useState<Picture>('checking')
  // Bumped on every camera change, so a new camera starts at 'checking' too.
  const [pictureEpoch, setPictureEpoch] = useState(0)
  // ECHO CANCELLATION. The browser's canceller (on by default for every mic
  // here) can only subtract what THIS page played. Guests used to reach the
  // streamer through OBS monitoring the overlay, the booth mic heard them in
  // the room, and guests heard themselves — while Discord, which plays AND
  // records in one app, had no echo. So the booth plays the guests itself:
  // the canceller gets its reference, and their voices reach the stream through
  // OBS Desktop Audio, exactly as a Discord call does. While it does, the
  // overlay mutes guest voices (overlay.html, mc.guestAudio) so they are never
  // on stream twice. On by default; off hands guest voices back to the overlay.
  const [hearHere, setHearHere] = useState<boolean>(() => {
    try {
      return localStorage.getItem('mc-booth-hear') !== '0'
    } catch {
      return true
    }
  })
  const hearHereRef = useRef(hearHere)
  hearHereRef.current = hearHere
  // True only while a guest's voice is ACTUALLY playing in this tab. The
  // overlay mutes guests on this claim alone, so it must never run ahead of
  // playback — a blocked autoplay would otherwise silence guests on stream.
  const [carrying, setCarrying] = useState(false)
  const [audioBlocked, setAudioBlocked] = useState(false)
  const guestAudioBoxRef = useRef<HTMLDivElement>(null)
  const guestAudioRef = useRef(new Map<string, { track: RemoteTrack; el: HTMLMediaElement }>())
  // Camera choice. The default cam is usually the one OBS already owns —
  // a picker turns "camera busy" from a dead end into a choice, and
  // selecting "OBS Virtual Camera" pipes the WHOLE OBS scene to guests.
  const [cams, setCams] = useState<{ id: string; label: string }[]>([])
  const [camId, setCamId] = useState<string>(() => {
    try {
      return localStorage.getItem('mc-booth-cam') || ''
    } catch {
      return ''
    }
  })
  const camIdRef = useRef(camId)
  camIdRef.current = camId
  const micOnlyRef = useRef(false)
  micOnlyRef.current = micOnly

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

  function recomputeCarrying() {
    const r = lkRef.current
    const els = [...guestAudioRef.current.values()].map((g) => g.el)
    const allowed = !!r && r.canPlaybackAudio
    setCarrying(hearHereRef.current && allowed && els.some((el) => !el.paused && !el.ended))
    setAudioBlocked(hearHereRef.current && !!r && !allowed && els.length > 0)
  }

  // Seats only: the overlay never publishes, and nobody else is in the room.
  function attachGuestAudio(track: RemoteTrack, participant: RemoteParticipant) {
    if (!hearHereRef.current || track.kind !== 'audio' || !participant.identity.startsWith('seat:')) return
    const key = `${participant.identity}/${track.sid}`
    if (guestAudioRef.current.has(key)) return
    const el = track.attach()
    el.addEventListener('playing', recomputeCarrying)
    el.addEventListener('pause', recomputeCarrying)
    guestAudioBoxRef.current?.appendChild(el)
    guestAudioRef.current.set(key, { track, el })
    recomputeCarrying()
  }

  function attachAllGuestAudio(r: LiveKitRoom) {
    for (const p of r.remoteParticipants.values()) {
      for (const pub of p.audioTrackPublications.values()) {
        if (pub.track) attachGuestAudio(pub.track, p)
      }
    }
    recomputeCarrying()
  }

  function detachGuestAudio(match?: (key: string) => boolean) {
    for (const [key, g] of guestAudioRef.current) {
      if (match && !match(key)) continue
      g.track.detach(g.el)
      g.el.remove()
      guestAudioRef.current.delete(key)
    }
    recomputeCarrying()
  }

  function teardown() {
    if (offTimerRef.current) {
      clearTimeout(offTimerRef.current)
      offTimerRef.current = null
    }
    const r = lkRef.current
    lkRef.current = null
    detachGuestAudio()
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
      const lkRoom = new lk.Room({
        dynacast: true,
        publishDefaults: { simulcast: true },
      })
      await lkRoom.connect(grant.url, grant.token)
      if (!armedRef.current) {
        // disarmed mid-connect — hang up before publishing anything
        void lkRoom.disconnect()
        return
      }
      // Guests hear "checking" BEFORE anything is published: their page holds
      // the host's picture back until this booth says it is really a person.
      await lkRoom.localParticipant
        .setAttributes({ 'mc.picture': 'checking', 'mc.guestAudio': 'overlay' })
        .catch(() => {})
      lkRoom.on(lk.RoomEvent.TrackSubscribed, (track, _pub, participant) => attachGuestAudio(track, participant))
      lkRoom.on(lk.RoomEvent.TrackUnsubscribed, (track, _pub, participant) =>
        detachGuestAudio((k) => k === `${participant.identity}/${track.sid}`))
      lkRoom.on(lk.RoomEvent.ParticipantDisconnected, (participant) =>
        detachGuestAudio((k) => k.startsWith(`${participant.identity}/`)))
      lkRoom.on(lk.RoomEvent.AudioPlaybackStatusChanged, recomputeCarrying)
      // MIC FIRST, on its own — the old enableCameraAndMicrophone() asked
      // for both in ONE getUserMedia, so an OBS-held webcam failed the
      // whole call and the "mic-only" fallback was doing all the work
      // (guests heard the streamer but never saw them).
      await lkRoom.localParticipant.setMicrophoneEnabled(true)
      let camOk = true
      try {
        await lkRoom.localParticipant.setCameraEnabled(
          true,
          camIdRef.current ? { deviceId: camIdRef.current } : undefined,
        )
      } catch (chosenErr) {
        // chosen device gone/busy → try the default before giving up
        try {
          await lkRoom.localParticipant.setCameraEnabled(true)
        } catch (defaultErr) {
          camOk = false // truly no camera available (OBS holds the only one)
          // Both catches used to be empty, so a session that went out audio
          // only left nothing behind to look at — the operator found out from
          // a guest saying "I can hear you but I can't see you", twice.
          console.warn('[booth] camera failed, going on air MIC ONLY', chosenErr, defaultErr)
        }
      }
      if (camOk) {
        const pub = [...lkRoom.localParticipant.videoTrackPublications.values()][0]
        if (pub?.track && videoRef.current) pub.track.attach(videoRef.current)
      }
      lkRef.current = lkRoom
      attachAllGuestAudio(lkRoom) // guests already here when we connected
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

  // Stuck mic-only while on air: keep asking for the camera back. The device
  // that beat us is almost always OBS, which releases it when the operator
  // stops a capture or starts the virtual cam — and neither of those changes
  // the device LIST, so the devicechange-driven retry in refreshCams() never
  // hears about it. A timer is the only thing that notices. tryEnableCamera
  // attaches and clears micOnly itself, so success ends this on its own.
  useEffect(() => {
    if (!onAir || !micOnly) return
    const t = setInterval(() => {
      if (!lkRef.current || !micOnlyRef.current) return
      void tryEnableCamera(camIdRef.current)
    }, CAM_RETRY_MS)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onAir, micOnly])

  // The picture watch. Restarts at 'checking' whenever the camera goes on air
  // or changes, and only ever moves to 'live' on proof that the picture moves.
  useEffect(() => {
    if (!onAir || micOnly) return
    setPicture('checking')
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 36
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    ctx.imageSmoothingQuality = 'high'
    let prev: Uint8ClampedArray | null = null
    let same = 0
    let moved = 0
    let obsRun = 0
    let verdict: Picture = 'checking'
    const t = setInterval(() => {
      const v = videoRef.current
      // A hidden tab stops painting video, and an unpainted frame compares
      // equal to the last one — it would read as frozen. Judge only what is
      // actually being drawn; keep the last verdict meanwhile.
      if (!v || document.visibilityState === 'hidden' || v.paused || v.readyState < 2 || !v.videoWidth) {
        prev = null
        same = 0
        moved = 0
        obsRun = 0
        return
      }
      ctx.drawImage(v, 0, 0, 64, 36)
      const px = ctx.getImageData(0, 0, 64, 36).data
      const at = (x: number, y: number) => {
        const i = ((y * 4 + 2) * 64 + (x * 4 + 2)) * 4
        return [px[i], px[i + 1], px[i + 2]]
      }
      const obs = OBS_PLACEHOLDER.every(([x, y, rgb]) => at(x, y).every((c, k) => Math.abs(c - rgb[k]) <= 20))
      obsRun = obs ? obsRun + 1 : 0
      const last = prev
      if (last) {
        const identical = last.length === px.length && px.every((b, i) => b === last[i])
        same = identical ? same + 1 : 0
        moved = identical ? 0 : moved + 1
      }
      prev = px
      const next: Picture = obsRun >= OBS_AFTER
        ? 'obs'
        : same >= STILL_AFTER
          ? 'still'
          : moved >= LIVE_AFTER && !obs
            ? 'live'
            : verdict
      if (next !== verdict) {
        verdict = next
        setPicture(next)
      }
    }, PICTURE_SAMPLE_MS)
    return () => clearInterval(t)
  }, [onAir, micOnly, pictureEpoch])

  // Who carries guest voices. 'booth' only while they are really playing here.
  const guestAudio = !onAir ? null : carrying ? 'booth' : 'overlay'
  useEffect(() => {
    const r = lkRef.current
    if (!r || !guestAudio) return
    r.localParticipant.setAttributes({ 'mc.guestAudio': guestAudio }).catch(() => {})
  }, [guestAudio])

  useEffect(() => {
    try {
      localStorage.setItem('mc-booth-hear', hearHere ? '1' : '0')
    } catch {
      /* preference just won't persist */
    }
    const r = lkRef.current
    if (!r) return
    if (hearHere) attachAllGuestAudio(r)
    else detachGuestAudio()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hearHere])

  // What guests are told. Mic-only counts as "still": there is no picture.
  const guestPicture = !onAir ? null : micOnly ? 'still' : picture === 'obs' ? 'still' : picture
  useEffect(() => {
    const r = lkRef.current
    if (!r || !guestPicture) return
    r.localParticipant.setAttributes({ 'mc.picture': guestPicture }).catch(() => {
      /* a token without the grant: guests fall back to showing what arrives */
    })
  }, [guestPicture])

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
        if (st.state === 'granted') {
          setArmed(true)
          void refreshCams()
        } else localStorage.removeItem(storageKey)
      })
      .catch(() => {
        /* can't verify — stay disarmed until the next toggle click */
      })
    return () => {
      stale = true
    }
  }, [active, storageKey])

  // OBS Virtual Camera (or any camera) appearing/disappearing AFTER arm —
  // e.g. arm once, then each session start OBS and click "Start Virtual
  // Camera" — must show up in the picker without re-arming.
  useEffect(() => {
    if (!active || !armed) return
    navigator.mediaDevices.addEventListener('devicechange', refreshCams)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refreshCams)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, armed])

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
      void refreshCams() // labels are readable now that a grant exists
    } finally {
      setBusy(false)
    }
  }

  // Try (or retry) publishing camera `id` while already on air. Shared by
  // the manual picker AND the auto-upgrade below — same recovery either way.
  // OBS Virtual Camera registers as an ordinary system camera; the OS label
  // is how we recognise it. It emits the streamer's produced 1080p scene, so
  // capturing it at LiveKit's 720p default would down-res the one source that
  // is deliberately full-canvas.
  const isObsVirtualCam = (id: string) =>
    /obs.*virtual/i.test(cams.find((c) => c.id === id)?.label || '')

  async function tryEnableCamera(id: string) {
    const r = lkRef.current
    if (!r) return false
    try {
      const opts = id
        ? {
          deviceId: id,
          ...(isObsVirtualCam(id)
            ? { resolution: { width: 1920, height: 1080, frameRate: 30 } }
            : {}),
        }
        : undefined
      await r.localParticipant.setCameraEnabled(true, opts)
      const pub = [...r.localParticipant.videoTrackPublications.values()][0]
      if (pub?.track && videoRef.current) pub.track.attach(videoRef.current)
      setMicOnly(false)
      setPictureEpoch((n) => n + 1)
      return true
    } catch {
      return false
    }
  }

  // Camera inventory for the picker. Runs after arm (and on re-arm) — device
  // labels only populate once a media permission is granted. Also drives the
  // auto-upgrade: if you're stuck mic-only and your CHOSEN camera (e.g. OBS
  // Virtual Camera, started mid-broadcast) just showed up, retry it without
  // waiting for a manual reselect.
  async function refreshCams() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const list = devices
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }))
      setCams(list)
      if (micOnlyRef.current && camIdRef.current && list.some((c) => c.id === camIdRef.current)) {
        void tryEnableCamera(camIdRef.current)
      }
    } catch {
      /* picker just stays hidden */
    }
  }

  async function onPickCam(id: string) {
    setCamId(id)
    try {
      localStorage.setItem('mc-booth-cam', id)
    } catch {
      /* preference just won't persist */
    }
    // already on air → switch live, and if we were mic-only give the camera
    // another shot with the newly chosen device
    const r = lkRef.current
    if (!r) return
    setError(null)
    try {
      if (micOnly) {
        await tryEnableCamera(id)
      } else if (id && isObsVirtualCam(id)) {
        // switchActiveDevice keeps the old capture constraints, which would
        // pin the virtual cam at the previous camera's 720p. Re-open the
        // track with 1080p constraints instead; the brief gap is the normal
        // cost of a resolution change.
        await r.localParticipant.setCameraEnabled(false)
        await tryEnableCamera(id)
      } else if (id) {
        await r.switchActiveDevice('videoinput', id)
        setPictureEpoch((n) => n + 1)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not switch camera')
    }
  }

  const guestNoun = `${liveCount} guest${liveCount === 1 ? '' : 's'}`
  const status = !armed
    ? 'Booth off — guests see a waiting screen'
    : connecting
      ? 'Guest is live — going on air…'
      : onAir
        ? micOnly
          ? `🔴 ON AIR to ${guestNoun} — MIC ONLY. Your camera is held by another app (OBS?). Pick a different camera below; OBS Virtual Camera works great.`
          : picture === 'live'
            ? `🔴 ON AIR to ${guestNoun} — they see you in real time`
            : picture === 'checking'
              ? `🔴 ON AIR to ${guestNoun}`
              : `🔴 ON AIR to ${guestNoun} — voice only`
        : camBusyHint
          ? 'Armed, mic-only — your camera is held by another app (OBS?). Pick a different one below; OBS Virtual Camera works great.'
          : 'Armed — camera goes on air the moment a guest joins'

  return (
    <GlassCard>
      <CardHeader
        icon={<Radio className="size-5" />}
        title="Co-host booth"
        description="Arm once. Your camera goes on air to live guests automatically and hangs up when they leave — they see you sub-second (the public broadcast runs on a slight delay)."
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

        {armed ? (
          <label
            htmlFor="booth-hear"
            className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-input/20 px-4 py-3"
          >
            <input
              type="checkbox"
              id="booth-hear"
              className="mt-0.5 size-4 accent-[var(--neon-lime)]"
              checked={hearHere}
              onChange={(e) => setHearHere(e.target.checked)}
            />
            <span className="flex-1">
              <span className="block text-sm font-semibold">Echo cancellation</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                Your guests play in this tab, so your mic cancels them out, like Discord. They
                reach your stream through OBS Desktop Audio.
              </span>
            </span>
          </label>
        ) : null}

        {/* Camera picker — the default cam is usually the one OBS already
            owns. Choosing "OBS Virtual Camera" here sends the FULL OBS scene
            to guests. Switches live mid-broadcast. */}
        {armed && cams.length > 0 ? (
          <label className="flex items-center gap-2.5 text-sm" htmlFor="booth-cam">
            <span className="shrink-0 font-medium text-foreground/90">Camera</span>
            <select
              id="booth-cam"
              value={camId}
              onChange={(e) => void onPickCam(e.target.value)}
              className="h-9 w-full min-w-0 flex-1 appearance-none rounded-lg border border-border bg-input/40 px-3 text-sm text-foreground outline-none focus-visible:border-primary/70 [&>option]:bg-popover [&>option]:text-popover-foreground"
            >
              <option value="">System default</option>
              {cams.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {armed && camId && isObsVirtualCam(camId) ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            <strong className="text-foreground">OBS Virtual Camera carries no audio</strong> — your
            booth mic stays the mic; scene audio from OBS won&apos;t reach the room. And if your OBS
            scene contains this room&apos;s overlay <em>and</em> you also join as a guest with this
            camera, you&apos;d be broadcasting your own broadcast — keep the overlay out of the scene
            you send here.
          </p>
        ) : null}

        {/* Going out with sound and no picture is the one failure the operator
            cannot see from inside the booth — the self-view is hidden in this
            state, so the card looks calm while guests stare at a black frame.
            It has now cost two live sessions, so it gets an alert rather than
            a clause in the status line. */}
        {onAir && micOnly ? (
          <div
            role="alert"
            className="rounded-xl border border-[var(--neon-magenta)]/60 bg-[var(--neon-magenta)]/10 p-3"
          >
            <strong className="block text-sm font-bold text-[var(--neon-magenta)]">
              Your camera isn&#39;t working — {guestNoun} can hear you but cannot see you
            </strong>
            <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
              You are still ON AIR with sound. Another app is holding the camera, almost
              always OBS. Retrying every {Math.round(CAM_RETRY_MS / 1000)}s — the picture
              comes back on its own the moment the camera is free. Picking OBS Virtual
              Camera below fixes it immediately.
            </span>
            <button
              type="button"
              onClick={() => void tryEnableCamera(camIdRef.current)}
              className="mt-2 h-8 rounded-lg border border-[var(--neon-magenta)]/70 px-3 text-xs font-bold text-[var(--neon-magenta)]"
            >
              Try the camera now
            </button>
          </div>
        ) : null}

        {onAir && audioBlocked ? (
          <button
            type="button"
            id="boothHearGuests"
            onClick={() => void lkRef.current?.startAudio().then(recomputeCarrying)}
            className="h-9 rounded-lg border border-[var(--neon-lime)]/60 bg-[var(--neon-lime)]/10 px-3 text-sm font-bold text-[var(--neon-lime)] transition-colors hover:bg-[var(--neon-lime)]/20"
          >
            Click to hear your guests
          </button>
        ) : null}

        <p id="boothStatus" aria-live="polite" className="text-xs text-muted-foreground">
          {status}
        </p>

        {/* Self-view — only while the camera is publishing, and the PICTURE
            only once it is proven to move. The tile sits over the video
            rather than hiding it, so the watch keeps reading real frames. */}
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
            // A webcam self-view is mirrored like a selfie; an OBS scene is a
            // produced picture — mirroring it reverses every word in it.
            style={{ transform: camId && isObsVirtualCam(camId) ? undefined : 'scaleX(-1)' }}
          />
          {picture !== 'live' ? (
            <div
              id="boothPictureHeld"
              data-state={picture}
              className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-[#07090d] px-6 text-center"
            >
              {picture === 'checking' ? (
                <RefreshCw className="size-4 animate-spin text-muted-foreground" />
              ) : (
                <VideoOff className="size-5 text-[var(--neon-magenta)]" />
              )}
              <p className="text-sm font-semibold text-foreground">
                {picture === 'checking' ? 'Checking your camera' : 'Guests can’t see you'}
              </p>
              <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
                {picture === 'checking'
                  ? 'Guests see you the moment your picture comes through.'
                  : picture === 'obs'
                    ? 'OBS Virtual Camera isn’t started. In OBS, click Start Virtual Camera.'
                    : 'Your camera stopped sending a picture. Pick another one above.'}
              </p>
            </div>
          ) : null}
        </div>

        {error ? (
          <p id="boothError" className="text-xs text-[var(--neon-magenta)]">
            {error}
          </p>
        ) : null}
        {onAir ? (
          <p className="text-xs text-muted-foreground">
            {hearHere
              ? 'Keep this tab open while streaming — it carries your camera and your guests’ voices.'
              : 'Keep this tab open while streaming — it carries your camera. Headphones on: guests hear your mic.'}
          </p>
        ) : null}
        <div ref={guestAudioBoxRef} data-guest-audio hidden />
      </div>
    </GlassCard>
  )
}
