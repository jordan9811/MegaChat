'use client'

// "Go on air" — the streamer's camera for LiveKit rooms, published straight
// from the dashboard (which already holds the room password). Viewers in a
// live slot receive this feed sub-second. vdo rooms keep their copy-link
// flow; this card only renders for transport === 'livekit'.

import { useEffect, useRef, useState } from 'react'
import { Radio, RefreshCw } from 'lucide-react'
import { GlassCard, CardHeader } from '@/components/glass-card'
import { useRoom } from '@/components/room-provider'
import type { Room as LiveKitRoom } from 'livekit-client'

export function HostCamCard() {
  const { mode, room, hostToken } = useRoom()
  const [onAir, setOnAir] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lkRef = useRef<LiveKitRoom | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  const active = mode === 'managing' && room?.transport === 'livekit'

  useEffect(() => {
    return () => {
      lkRef.current?.disconnect()
      lkRef.current = null
    }
  }, [])

  if (!active) return null

  async function toggle() {
    setError(null)
    setBusy(true)
    try {
      if (onAir) {
        lkRef.current?.disconnect()
        lkRef.current = null
        setOnAir(false)
        return
      }
      const grant = await hostToken()
      const lk = await import('livekit-client')
      const lkRoom = new lk.Room({ publishDefaults: { simulcast: true } })
      await lkRoom.connect(grant.url, grant.token)
      await lkRoom.localParticipant.enableCameraAndMicrophone()
      const pub = [...lkRoom.localParticipant.videoTrackPublications.values()][0]
      if (pub?.track && videoRef.current) pub.track.attach(videoRef.current)
      lkRef.current = lkRoom
      setOnAir(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not go on air')
    } finally {
      setBusy(false)
    }
  }

  return (
    <GlassCard>
      <CardHeader
        icon={<Radio className="size-5" />}
        title="Host camera"
        description="Viewers who go live see and hear this feed in real time (the public broadcast runs ~15s behind; this pipe doesn't)."
        accent="lime"
      />
      <div className="flex flex-col gap-3 px-5 py-5 sm:px-6">
        <div
          className="relative overflow-hidden rounded-xl border border-border bg-black"
          style={{ aspectRatio: '16 / 9', maxHeight: 200 }}
        >
          {/* mirrored self-view */}
          <video
            ref={videoRef}
            muted
            playsInline
            className="absolute inset-0 size-full object-cover"
            style={{ transform: 'scaleX(-1)', display: onAir ? undefined : 'none' }}
          />
          {!onAir ? (
            <p className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
              Off air — viewers in a live slot see a waiting screen
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={busy}
          className={
            onAir
              ? 'flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-input/30 px-4 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-input/50 disabled:opacity-60'
              : 'glow-magenta flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 font-heading text-sm font-bold uppercase tracking-wide text-primary-foreground transition-transform hover:scale-[1.01] disabled:opacity-60'
          }
        >
          {busy ? <RefreshCw className="size-4 animate-spin" /> : <Radio className="size-4" />}
          {onAir ? 'Go off air' : 'Go on air'}
        </button>
        {error ? <p className="text-xs text-[var(--neon-magenta)]">{error}</p> : null}
      </div>
    </GlassCard>
  )
}
