'use client'

// Overlay health — the streamer's answer to "is my OBS source actually going
// to show a guest when someone pays?"
//
// This matters specifically BECAUSE of lazy connect. The old overlay was
// always connected, so it could never fail to show a guest — it just billed
// forever (see LIVEKIT-AUDIT.md). Lazy connect trades that cost for a new
// failure mode: signal dies → guest pays → nobody appears → refund on a live
// broadcast. This card is how the streamer sees that BEFORE it happens.

import { useEffect, useState } from 'react'
import { Radio, CircleAlert, CircleCheck, Moon, EyeOff } from 'lucide-react'
import { useRoom } from '@/components/room-provider'
import { useOverlayVisibility, VISIBILITY_POLL_MS } from '@/components/obs/use-overlay-visibility'

/** The obs-websocket password the one-click flow stored. It never leaves this
 *  browser — read here only to open the same local connection. */
const LS_OBS_PASSWORD = 'mc_obs_ws_password'

/** Plain-English cause, in the streamer's terms, not OBS's. */
const HIDDEN_COPY: Record<string, string> = {
  scene: 'the overlay is not in the scene you are broadcasting',
  disabled: 'the overlay source is switched off (the eye is unticked)',
  offcanvas: 'the overlay is off the canvas, or sized to nothing',
  covered: 'another source is sitting on top of the overlay',
}

type Health = {
  present: boolean
  healthy: boolean
  lkState: string
  activityState: string
  lastBeatMsAgo: number | null
  seats: number
  pendingPrewarms: number
}

const POLL_MS = 5000

export function OverlayHealthCard() {
  const { room, mode } = useRoom()
  const [health, setHealth] = useState<Health | null>(null)
  const [obsPassword, setObsPassword] = useState<string | null>(null)

  useEffect(() => {
    try { setObsPassword(localStorage.getItem(LS_OBS_PASSWORD) || null) } catch { /* private mode */ }
  }, [])

  // Accident detection, for ANY live room. A manual-paste streamer has no
  // password stored, so this never runs and never reports for them — silence
  // is the correct output, not a warning.
  const visibility = useOverlayVisibility({
    roomId: room?.id ?? null,
    password: obsPassword,
    enabled: mode === 'managing' && !!room?.active,
  })

  useEffect(() => {
    if (!room?.id || mode !== 'managing') return
    let stop = false
    const load = () =>
      fetch(`/api/livekit/overlay/health?room=${encodeURIComponent(room.id)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (!stop && d) setHealth(d) })
        .catch(() => { /* transient — next poll retries */ })
    void load()
    const t = setInterval(load, POLL_MS)
    return () => { stop = true; clearInterval(t) }
  }, [room?.id, mode])

  // The visibility banner stands on its own: it is about the OBS scene, not
  // about LiveKit, so it must render even for a vdo room or before the health
  // endpoint has answered — the two failures are unrelated and a streamer
  // whose overlay is buried needs telling either way.
  const hidden = visibility?.signal === 'overlay_hidden'
  const scaled = visibility?.signal === 'overlay_scaled_below_floor'
  const banner = (hidden || scaled) ? (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-2xl border border-border/70 bg-card/60 p-4 backdrop-blur-sm"
    >
      <EyeOff className="mt-0.5 size-4 shrink-0" style={{ color: 'var(--neon-magenta)' }} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">
          {hidden ? 'Your overlay is not on screen' : 'Your overlay is too small to be read'}
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {hidden ? (
            <>
              OBS says {HIDDEN_COPY[visibility?.reason ?? ''] ?? 'the overlay is not visible'}.
              Guests and MegaChats are not reaching your broadcast.
            </>
          ) : (
            <>
              The overlay source is scaled down, which shrinks the verification
              badge with it. A MegaChat that plays now may not be provable.
              Set the source back to 100%.
            </>
          )}
        </p>
      </div>
      <span className="mt-1 size-2 shrink-0 rounded-full" style={{ backgroundColor: 'var(--neon-magenta)', animation: 'pulse 2s ease-in-out infinite' }} />
    </div>
  ) : null

  if (mode !== 'managing' || room?.transport !== 'livekit' || !health) return banner

  // Three states worth distinguishing, and only one is bad.
  const connected = health.lkState === 'live'
  const bad = health.present && !health.healthy

  const tone = !health.present
    ? { icon: CircleAlert, color: 'var(--neon-amber)', label: 'Overlay not open' }
    : bad
      ? { icon: CircleAlert, color: 'var(--neon-magenta)', label: 'Overlay not responding' }
      : connected
        ? { icon: Radio, color: 'var(--neon-lime)', label: 'On air — guest connected' }
        : { icon: Moon, color: 'var(--neon-cyan)', label: 'Ready — sleeping until a guest joins' }

  const Icon = tone.icon

  return (
    <>
    {banner}
    <div className="flex items-start gap-3 rounded-2xl border border-border/70 bg-card/60 p-4 backdrop-blur-sm">
      <Icon className="mt-0.5 size-4 shrink-0" style={{ color: tone.color }} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">{tone.label}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {!health.present ? (
            <>
              Add the overlay browser source in OBS. Until it&apos;s open, a paying
              guest won&apos;t appear on your broadcast.
            </>
          ) : bad ? (
            <>
              The overlay stopped checking in
              {health.lastBeatMsAgo != null
                ? ` ${Math.round(health.lastBeatMsAgo / 1000)}s ago`
                : ''}
              . Refresh the browser source in OBS before taking a paid guest.
            </>
          ) : connected ? (
            <>
              {health.seats > 0
                ? `${health.seats} on camera.`
                : 'Holding the connection for an incoming guest.'}
            </>
          ) : (
            <>
              Idle costs nothing — the connection opens the moment someone starts
              buying a seat, and closes again after they leave.
            </>
          )}
        </p>
      </div>
      <span
        className="mt-1 size-2 shrink-0 rounded-full"
        style={{
          backgroundColor: tone.color,
          animation: connected || bad ? 'pulse 2s ease-in-out infinite' : undefined,
        }}
      />
    </div>
    </>
  )
}
