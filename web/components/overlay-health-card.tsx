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
import { Radio, CircleAlert, CircleCheck, Moon } from 'lucide-react'
import { useRoom } from '@/components/room-provider'

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

  if (mode !== 'managing' || room?.transport !== 'livekit' || !health) return null

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
  )
}
