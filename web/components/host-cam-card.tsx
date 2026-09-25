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
import type {
  AudioCaptureOptions,
  DisconnectReason,
  LocalAudioTrack,
  Room as LiveKitRoom,
  RemoteParticipant,
  RemoteTrack,
} from 'livekit-client'

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

// ECHO CANCELLATION — how the streamer hears guests, and how guests are kept
// from hearing themselves.
//  'tab' (the default): the booth plays the guests, so the ordinary canceller
//    has its reference; the overlay mutes exactly those guests
//    (mc.guestAudioSeats) and their voices reach the stream once, through OBS
//    Desktop Audio. Discord's arrangement. Works on speakers and headphones.
//  'phones': the overlay plays the guests to OBS, as before 2026-09-24, and the
//    booth plays nobody. The ordinary canceller has nothing to cancel because
//    headphones do not reach the mic — on speakers, guests hear themselves.
//  'system': as 'phones', but the mic asks Chrome 154 for
//    echoCancellation:'all', which cancels EVERYTHING this PC plays, so
//    speakers are fine (_probe-aec-loopback.mjs: another app's playback cut by
//    50 dB, where `true` managed 1 dB). The price, measured on the operator's
//    machine (_probe-aec-doubletalk.mjs): while the PC plays something loud
//    the canceller gates the streamer's voice for guests — 10% of speech
//    knocked down >10 dB on headphones, 24% with the game as loud as the
//    voice — plus ~170ms on the voice (Chromium's fixed capture delay).
//    Falls back to 'tab' whenever Chrome will not grant 'all' — the page
//    checks what it got, every time, because a field trial, an older Chrome
//    or Windows 10 can refuse it.
type AecMode = 'pending' | 'tab' | 'phones' | 'system'
type AecPref = Exclude<AecMode, 'pending'>
const AEC_PREFS: AecPref[] = ['tab', 'phones', 'system']
const AEC_LABEL: Record<AecPref, string> = { tab: 'This tab', phones: 'OBS · headphones', system: 'OBS · speakers' }
// Passed whole on every (re)start: restartTrack() does not merge LiveKit's
// defaults, so leaving these out would silently drop noise suppression too.
const MIC_TAB = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceIsolation: true }
const MIC_SYSTEM = { ...MIC_TAB, echoCancellation: 'all' } as unknown as AudioCaptureOptions
const MIC_DEAD = 'Your microphone stopped and could not be restarted. Reload this tab to get it back.'

// Whole PC is offered only where it is measured: Chrome on Windows (11+; on
// Windows 10 Chrome declines 'all' and the booth falls back by itself). On a Mac
// Chrome grants 'all' too, but nobody has measured that it cancels anything.
function wholePcSupported() {
  if (typeof navigator === 'undefined') return false
  // userAgentData where Chrome fills it in; the UA string otherwise (headless
  // and some embedded Chromes leave the platform empty). Firefox on Windows
  // passes here, asks for 'all', is not granted it, and falls back by itself.
  const platform = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform
  return platform ? platform === 'Windows' : /Windows/.test(navigator.userAgent)
}
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
  // Echo cancellation (see AecMode): what the streamer chose, and what Chrome
  // actually granted for the session on air.
  const [aecPref, setAecPref] = useState<AecPref>(() => {
    try {
      const v = localStorage.getItem('mc-booth-aec')
      return v === 'phones' || v === 'system' ? v : 'tab'
    } catch {
      return 'tab'
    }
  })
  const aecPrefRef = useRef(aecPref)
  aecPrefRef.current = aecPref
  const [aecMode, setAecMode] = useState<AecMode>('pending')
  const aecModeRef = useRef<AecMode>('pending')
  const reapplyingRef = useRef(false)
  // The seats whose voice is ACTUALLY playing in this tab. The overlay mutes
  // exactly these — so the claim can never run ahead of playback, and a second
  // guest this tab is not playing stays on stream.
  const [playingSeats, setPlayingSeats] = useState<string[]>([])
  const [audioBlocked, setAudioBlocked] = useState(false)
  const [boothNote, setBoothNote] = useState<string | null>(null)
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
  // The seats that are LIVE, as LiveKit identities. Only these are ever played
  // here: a guest still at "Camera ready — hit GO LIVE" is not on the show.
  const liveSeatKey = seats
    .filter((s) => s.live)
    .map((s) => `seat:${s.id}`)
    .sort()
    .join(',')
  const liveSeatsRef = useRef(new Set<string>())
  liveSeatsRef.current = new Set(liveSeatKey ? liveSeatKey.split(',') : [])
  // The room from the moment it exists until teardown — lkRef is only set once
  // fully on air, so a start in progress is visible here, and nowhere else.
  const sessionRef = useRef<LiveKitRoom | null>(null)
  const [session, setSession] = useState<LiveKitRoom | null>(null)
  // The mic OBJECT for the session (see micTrack).
  const micRef = useRef<LocalAudioTrack | null>(null)
  // Bumped by teardown and by each start: a start whose number is no longer
  // current is stale and hangs itself up.
  const genRef = useRef(0)
  // Everything this booth has told the room, so a reconnect can say it again.
  const attrsRef = useRef<Record<string, string>>({})

  const active = mode === 'managing' && room?.transport === 'livekit'
  const storageKey = room ? `mc-booth-armed:${room.id}` : null

  function applyMode(m: AecMode) {
    aecModeRef.current = m
    setAecMode(m)
  }

  function setAttrs(r: LiveKitRoom, attrs: Record<string, string>) {
    Object.assign(attrsRef.current, attrs)
    return r.localParticipant.setAttributes(attrs).catch(() => {
      /* a token without the grant: the room falls back to showing what arrives */
    })
  }

  // The seats whose voice is really playing in this tab, as the claim string.
  function playingNow(): string[] {
    const s = new Set<string>()
    for (const [key, g] of guestAudioRef.current) {
      if (!g.el.paused && !g.el.ended) s.add(key.split('/')[0])
    }
    return [...s].sort()
  }
  function sendClaim(r: LiveKitRoom) {
    const seats = playingNow().join(',') || '-'
    return setAttrs(r, { 'mc.guestAudioSeats': seats, 'mc.guestAudio': seats === '-' ? 'overlay' : 'booth' })
  }

  function recomputePlaying() {
    const r = sessionRef.current
    const next = playingNow()
    setPlayingSeats((prev) => (prev.join(',') === next.join(',') ? prev : next))
    setAudioBlocked(aecModeRef.current === 'tab' && !!r && !r.canPlaybackAudio && guestAudioRef.current.size > 0)
  }

  // Seat AUDIO is subscribed only while this tab plays it ('tab'), and only for
  // seats that are LIVE — playing a guest who has not gone live yet would put
  // their mic test on stream through Desktop Audio. Seat VIDEO is never
  // subscribed: the booth never shows it, and decoding a guest's 720p only to
  // throw it away is CPU the streamer's game and OBS need.
  function syncSubscriptions(r: LiveKitRoom) {
    const wantAudio = aecModeRef.current === 'tab'
    for (const p of r.remoteParticipants.values()) {
      if (!p.identity.startsWith('seat:')) continue
      const live = liveSeatsRef.current.has(p.identity)
      for (const pub of p.trackPublications.values()) {
        const want = pub.kind === 'audio' && wantAudio && live
        if (pub.isSubscribed !== want) pub.setSubscribed(want)
      }
    }
  }

  // The mic OBJECT, not the publication map: a full reconnect unpublishes the
  // mic, restarts it (keeping 'all', and emitting Restarted) and republishes it
  // only after a round trip — the map is empty in between, the object is not.
  function micTrack(r: LiveKitRoom) {
    const published = [...r.localParticipant.audioTrackPublications.values()][0]?.track as
      | LocalAudioTrack
      | undefined
    return published ?? (sessionRef.current === r ? micRef.current ?? undefined : undefined)
  }
  function micEcho(r: LiveKitRoom): unknown {
    try {
      return (micTrack(r)?.mediaStreamTrack.getSettings() as { echoCancellation?: unknown } | undefined)
        ?.echoCancellation
    } catch {
      return undefined
    }
  }
  function micLive(r: LiveKitRoom) {
    const t = micTrack(r)?.mediaStreamTrack
    return !!t && t.readyState === 'live'
  }

  // Every mic restart goes through here. LiveKit's restart() stops the running
  // mic BEFORE it asks for the new one and restores nothing if that throws: the
  // sender is left on a dead track while LiveKit still reports it unmuted. So
  // check the mic is live afterwards and, if not, bring back a plain one —
  // echo-safe, because the caller then hands the guests to this tab. False only
  // if even that failed.
  async function restartMic(r: LiveKitRoom, opts: AudioCaptureOptions): Promise<boolean> {
    const t = micTrack(r)
    if (!t) return false
    reapplyingRef.current = true
    try {
      try {
        await t.restartTrack(opts)
      } catch (e) {
        console.warn('[booth] mic restart failed', e)
      }
      if (micLive(r)) return true
      try {
        await t.restartTrack(MIC_TAB)
      } catch (e) {
        console.warn('[booth] plain mic restart failed too', e)
      }
      return micLive(r)
    } finally {
      reapplyingRef.current = false
    }
  }

  // Asks for whole-PC cancellation when preferred (and offered here) and reports
  // what Chrome actually granted. Never gives up a working mic for it.
  async function enableMic(r: LiveKitRoom, pref: AecPref): Promise<AecPref> {
    if (pref === 'system' && wholePcSupported()) {
      try {
        await r.localParticipant.setMicrophoneEnabled(true, MIC_SYSTEM)
        return micEcho(r) === 'all' ? 'system' : 'tab'
      } catch (e) {
        console.warn('[booth] whole-PC echo cancellation refused — this tab will play the guests', e)
      }
    }
    await r.localParticipant.setMicrophoneEnabled(true)
    return pref === 'phones' ? 'phones' : 'tab'
  }

  // Move the session to whatever the streamer picked now. Called when the pick
  // changes, and by a switch that finds the pick changed while it worked.
  function reconcile(r: LiveKitRoom) {
    if (sessionRef.current !== r || aecModeRef.current === 'pending') return
    const pref = aecPrefRef.current
    if (pref === 'tab') {
      if (aecModeRef.current !== 'tab') void switchToTabByChoice(r)
    } else if (aecModeRef.current !== pref) {
      void switchToOverlay(r, pref)
    }
  }

  function switchToTab(r: LiveKitRoom) {
    applyMode('tab')
    syncSubscriptions(r)
    attachAllGuestAudio(r)
  }

  // Through OBS (Headphones or Whole PC): get the mic right FIRST — 'all' for
  // Whole PC, the ordinary canceller for Headphones (restarted only if it is
  // not that already: a restart is an audible blip). Only then hand the guests
  // to the overlay — withdraw the claim and wait for the SFU to confirm it,
  // THEN stop playing them here — so no guest is ever played by neither side.
  async function switchToOverlay(r: LiveKitRoom, target: 'phones' | 'system') {
    const wantAll = target === 'system'
    if (wantAll && !wholePcSupported()) {
      if (aecModeRef.current !== 'tab') switchToTab(r) // not offered here: this tab, as the card says
      return
    }
    if (wantAll ? micEcho(r) !== 'all' : micEcho(r) === 'all') {
      const alive = await restartMic(r, wantAll ? MIC_SYSTEM : MIC_TAB)
      if (sessionRef.current !== r) return
      if (!alive) {
        switchToTab(r)
        setError(MIC_DEAD)
        return
      }
    }
    if (aecPrefRef.current !== target) return reconcile(r) // re-picked while Chrome reopened the mic
    if (wantAll && micEcho(r) !== 'all') {
      // Refused: this tab carries the guests (safe on speakers), and the card says why.
      if (aecModeRef.current !== 'tab') switchToTab(r)
      return
    }
    await setAttrs(r, { 'mc.guestAudioSeats': '-', 'mc.guestAudio': 'overlay' })
    if (sessionRef.current !== r) return
    if (aecPrefRef.current !== target) {
      void sendClaim(r) // changed our mind mid-handover: claim what is still playing here
      return reconcile(r)
    }
    applyMode(target)
    detachGuestAudio()
    syncSubscriptions(r)
  }

  // This tab, by choice: play the guests here first, then — coming from Whole
  // PC — drop the 170ms by going back to the ordinary canceller (which cancels
  // what this tab plays).
  async function switchToTabByChoice(r: LiveKitRoom) {
    switchToTab(r)
    if (micEcho(r) === 'all') {
      const alive = await restartMic(r, MIC_TAB)
      if (sessionRef.current !== r) return
      if (!alive) {
        setError(MIC_DEAD)
        return
      }
    }
    if (aecPrefRef.current !== 'tab') reconcile(r) // clicked away meanwhile
  }

  // LiveKit's own recovery restarts a mic that dropped out (USB hiccup, audio
  // engine restart) with ONLY { deviceId: 'default' }, which silently loses
  // 'all' — guests would get their echo back while the card still said "Whole
  // PC". Put 'all' back; if Chrome will not, hand the guests to this tab.
  async function onMicRestarted(r: LiveKitRoom) {
    if (sessionRef.current !== r || reapplyingRef.current) return
    if (aecModeRef.current !== 'system') return
    const echo = micEcho(r)
    if (echo === 'all' || echo === undefined) return // fine, or nothing to judge yet
    const alive = await restartMic(r, MIC_SYSTEM)
    if (sessionRef.current !== r) return
    if (!alive) {
      switchToTab(r)
      setError(MIC_DEAD)
    } else if (micEcho(r) !== 'all') {
      switchToTab(r)
      setBoothNote('Your mic restarted without whole-PC echo cancellation, so your guests now play in this tab.')
    }
  }

  // Seats only (the overlay never publishes), live seats only, This tab only.
  function attachGuestAudio(track: RemoteTrack, participant: RemoteParticipant) {
    if (aecModeRef.current !== 'tab' || track.kind !== 'audio' || !participant.identity.startsWith('seat:')) return
    if (!liveSeatsRef.current.has(participant.identity)) return
    const key = `${participant.identity}/${track.sid}`
    if (guestAudioRef.current.has(key)) return
    const el = track.attach()
    el.dataset.seat = participant.identity // which guest this is, for the claim and for tests
    el.addEventListener('playing', recomputePlaying)
    el.addEventListener('pause', recomputePlaying)
    guestAudioBoxRef.current?.appendChild(el)
    guestAudioRef.current.set(key, { track, el })
    recomputePlaying()
  }

  function attachAllGuestAudio(r: LiveKitRoom) {
    for (const p of r.remoteParticipants.values()) {
      for (const pub of p.audioTrackPublications.values()) {
        if (pub.track) attachGuestAudio(pub.track, p)
      }
    }
    recomputePlaying()
  }

  function detachGuestAudio(match?: (key: string) => boolean) {
    for (const [key, g] of guestAudioRef.current) {
      if (match && !match(key)) continue
      g.track.detach(g.el)
      g.el.remove()
      guestAudioRef.current.delete(key)
    }
    recomputePlaying()
  }

  function teardown() {
    genRef.current++ // a start still in flight is now stale and hangs itself up
    if (offTimerRef.current) {
      clearTimeout(offTimerRef.current)
      offTimerRef.current = null
    }
    const r = lkRef.current ?? sessionRef.current
    lkRef.current = null
    sessionRef.current = null
    micRef.current = null
    attrsRef.current = {}
    setSession(null)
    detachGuestAudio()
    if (r) {
      try {
        for (const pub of r.localParticipant.trackPublications.values()) pub.track?.stop()
      } catch {
        /* already stopped */
      }
      void r.disconnect()
    }
    connectingRef.current = false
    applyMode('pending')
    setOnAir(false)
    setConnecting(false)
    setMicOnly(false)
    setPicture('checking') // a new session starts unproven, not with the last one's 'live'
    setBoothNote(null)
  }

  function scheduleOff() {
    if (offTimerRef.current) return
    offTimerRef.current = setTimeout(() => {
      offTimerRef.current = null
      if (liveCountRef.current === 0) teardown()
    }, OFF_AIR_DEBOUNCE_MS)
  }

  async function publish() {
    if (connectingRef.current || lkRef.current || sessionRef.current) return
    connectingRef.current = true
    const gen = ++genRef.current
    // A disarm, a replaced tab or a hang-up during the start bumps genRef; this
    // start is then stale and must leave the room itself.
    const stale = () => gen !== genRef.current || !armedRef.current
    setConnecting(true)
    setError(null)
    setBoothNote(null)
    let started: LiveKitRoom | null = null
    const bail = () => {
      const r = started
      if (!r) return
      if (sessionRef.current === r) {
        sessionRef.current = null
        micRef.current = null
        setSession(null)
      }
      if (lkRef.current !== r) {
        try {
          for (const pub of r.localParticipant.trackPublications.values()) pub.track?.stop()
        } catch {
          /* already stopped */
        }
        void r.disconnect()
      }
    }
    try {
      const grant = await hostToken()
      if (stale()) return
      const lk = await import('livekit-client')
      if (stale()) return
      const lkRoom = new lk.Room({
        dynacast: true,
        publishDefaults: { simulcast: true },
      })
      started = lkRoom
      sessionRef.current = lkRoom
      lkRoom.on(lk.RoomEvent.TrackSubscribed, (track, _pub, participant) => attachGuestAudio(track, participant))
      lkRoom.on(lk.RoomEvent.TrackUnsubscribed, (track, _pub, participant) =>
        detachGuestAudio((k) => k === `${participant.identity}/${track.sid}`))
      lkRoom.on(lk.RoomEvent.ParticipantDisconnected, (participant) =>
        detachGuestAudio((k) => k.startsWith(`${participant.identity}/`)))
      lkRoom.on(lk.RoomEvent.TrackPublished, () => syncSubscriptions(lkRoom))
      lkRoom.on(lk.RoomEvent.ParticipantConnected, () => syncSubscriptions(lkRoom))
      lkRoom.on(lk.RoomEvent.AudioPlaybackStatusChanged, recomputePlaying)
      lkRoom.on(lk.RoomEvent.Reconnected, () => {
        if (sessionRef.current !== lkRoom) return
        // A full reconnect rejoins with the token alone: say everything again,
        // and re-check the mic (it was restarted on the way).
        void lkRoom.localParticipant.setAttributes({ ...attrsRef.current }).catch(() => {})
        syncSubscriptions(lkRoom)
        void onMicRestarted(lkRoom)
      })
      lkRoom.on(lk.RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (sessionRef.current !== lkRoom) return // our own hang-up, or a stale start
        teardown()
        if (reason === lk.DisconnectReason.DUPLICATE_IDENTITY) {
          // Another tab armed this booth and took the host seat. Reconnecting
          // would evict it, and it would evict us, on every guest. Stand down.
          setArmed(false)
          setBoothNote('Your booth is running in another tab, so this one stepped aside.')
        } else if (armedRef.current && liveCountRef.current > 0) {
          setTimeout(() => {
            if (armedRef.current && liveCountRef.current > 0 && !sessionRef.current) void publish()
          }, 2000)
        }
      })
      // Subscriptions are chosen per mode (syncSubscriptions), never automatic.
      await lkRoom.connect(grant.url, grant.token, { autoSubscribe: false })
      if (stale()) return bail()
      // Guests hear "checking" BEFORE anything is published: their page holds
      // the host's picture back until this booth says it is really a person.
      await setAttrs(lkRoom, {
        'mc.picture': 'checking',
        'mc.guestAudio': 'overlay',
        'mc.guestAudioSeats': '-',
        'mc.aec': 'pending',
      })
      if (stale()) return bail()
      setSession(lkRoom)
      // MIC FIRST, on its own — the old enableCameraAndMicrophone() asked
      // for both in ONE getUserMedia, so an OBS-held webcam failed the
      // whole call and the "mic-only" fallback was doing all the work
      // (guests heard the streamer but never saw them).
      const requested = aecPrefRef.current
      const granted = await enableMic(lkRoom, requested)
      if (stale()) return bail()
      micRef.current = micTrack(lkRoom) ?? null
      micRef.current?.on(lk.TrackEvent.Restarted, () => void onMicRestarted(lkRoom))
      applyMode(granted)
      syncSubscriptions(lkRoom)
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
      if (stale()) return bail()
      if (camOk) {
        const pub = [...lkRoom.localParticipant.videoTrackPublications.values()][0]
        if (pub?.track && videoRef.current) pub.track.attach(videoRef.current)
      }
      lkRef.current = lkRoom
      attachAllGuestAudio(lkRoom) // guests already here when we connected
      setMicOnly(!camOk)
      setOnAir(true)
      // The setting may have been flipped before the mode was known, when the
      // effect that applies it had nothing to act on. Catch up now — but never
      // retry 'all' straight after Chrome refused it (the pick is unchanged).
      if (aecPrefRef.current !== requested) reconcile(lkRoom)
      // guests may all have left while we connected — let the grace timer run
      if (liveCountRef.current === 0) scheduleOff()
    } catch (e) {
      // A start that failed after connecting must not stay in the room as the
      // host — it would sit there until the retry's join evicted it.
      bail()
      if (gen !== genRef.current) return // torn down meanwhile: nothing to report
      applyMode('pending')
      setError(e instanceof Error ? e.message : 'Could not go on air')
      // one spaced retry per guest-arrival (covers a cold token/SFU hiccup)
      if (!retriedRef.current) {
        retriedRef.current = true
        setTimeout(() => {
          if (armedRef.current && liveCountRef.current > 0 && !sessionRef.current) void publish()
        }, 4000)
      }
    } finally {
      if (gen === genRef.current) {
        connectingRef.current = false
        setConnecting(false)
      }
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

  // Which seats this tab is really playing — the overlay mutes exactly these.
  // Sent from the moment the booth is connected, not from "on air": in This tab
  // mode guests start playing while the camera is still opening, and the claim
  // must never lag behind them. '-' means none (an empty value is never sent);
  // mc.guestAudio is kept for overlays loaded before per-seat claims existed.
  const seatsClaim = !session ? null : playingSeats.join(',') || '-'
  useEffect(() => {
    const r = sessionRef.current
    if (!r || !seatsClaim) return
    void setAttrs(r, { 'mc.guestAudioSeats': seatsClaim, 'mc.guestAudio': seatsClaim === '-' ? 'overlay' : 'booth' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seatsClaim, session])

  // The effective mode, for the overlay's logs and for anyone diagnosing a call.
  useEffect(() => {
    const r = sessionRef.current
    if (!r || aecMode === 'pending') return
    void setAttrs(r, { 'mc.aec': aecMode })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aecMode, session])

  // Seats going live or leaving: follow them (subscribe, play, stop).
  useEffect(() => {
    const r = sessionRef.current
    if (!r) return
    syncSubscriptions(r)
    detachGuestAudio((k) => !liveSeatsRef.current.has(k.split('/')[0]))
    attachAllGuestAudio(r)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSeatKey])

  useEffect(() => {
    try {
      localStorage.setItem('mc-booth-aec', aecPref)
    } catch {
      /* preference just won't persist */
    }
    const r = sessionRef.current
    if (r) reconcile(r)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aecPref])

  // What guests are told. Mic-only counts as "still": there is no picture.
  const guestPicture = !onAir ? null : micOnly ? 'still' : picture === 'obs' ? 'still' : picture
  useEffect(() => {
    const r = lkRef.current
    if (!r || !guestPicture) return
    void setAttrs(r, { 'mc.picture': guestPicture })
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
          <div className="flex flex-col gap-2 rounded-xl border border-border bg-input/20 px-4 py-3">
            <span className="text-sm font-semibold">Where you hear guests</span>
            <div
              role="radiogroup"
              aria-label="Where you hear guests"
              className="flex rounded-lg border border-border bg-input/40 p-0.5 text-xs font-semibold"
            >
              {AEC_PREFS.map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  id={`booth-aec-${v}`}
                  aria-checked={aecPref === v}
                  onClick={() => setAecPref(v)}
                  className={
                    'flex-1 rounded-md px-2 py-1 transition-colors ' +
                    (aecPref === v
                      ? 'bg-[var(--neon-lime)]/15 text-[var(--neon-lime)]'
                      : 'text-muted-foreground hover:text-foreground')
                  }
                >
                  {AEC_LABEL[v]}
                </button>
              ))}
            </div>
            <p id="boothAecNote" data-mode={aecMode} className="text-xs leading-relaxed text-muted-foreground">
              {aecPref === 'tab'
                ? 'Your guests play in this tab and your mic cancels them, like Discord. They reach your stream once, through OBS Desktop Audio. Fine on speakers or headphones.'
                : aecPref === 'phones'
                  ? 'You hear guests through OBS — the MegaChat overlay in your live scene — as before. Headphones only: on speakers your mic picks them up and they hear themselves.'
                  : !wholePcSupported()
                    ? 'Cancelling everything this PC plays needs Chrome on Windows, so your guests play in this tab and your mic cancels them.'
                    : aecMode === 'tab'
                      ? 'Chrome didn’t allow cancelling everything this PC plays, so your guests play in this tab and your mic cancels them.'
                      : 'You hear guests through OBS, and your mic cancels everything this PC plays, so speakers are fine. While your game is loud your voice can cut out for guests, and it reaches them about 0.2s later.'}
              {aecPref !== 'tab' && aecMode !== 'tab'
                ? ' Needs OBS 32 or newer — older versions can put your guests on stream twice.'
                : null}
            </p>
          </div>
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
            onClick={() => void lkRef.current?.startAudio().then(recomputePlaying)}
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
        {boothNote ? (
          <p id="boothNote" className="text-xs text-muted-foreground">
            {boothNote}
          </p>
        ) : null}
        {onAir ? (
          <p className="text-xs text-muted-foreground">
            {aecMode === 'tab'
              ? 'Keep this tab open while streaming — it carries your camera and your guests’ voices.'
              : 'Keep this tab open while streaming — it carries your camera and your mic.'}
          </p>
        ) : null}
        <div ref={guestAudioBoxRef} data-guest-audio hidden />
      </div>
    </GlassCard>
  )
}
