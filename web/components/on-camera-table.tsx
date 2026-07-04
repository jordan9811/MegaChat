'use client'

import { useEffect, useState } from 'react'
import { Video, Circle, X, Pin, PinOff } from 'lucide-react'
import { GlassCard, CardHeader } from '@/components/glass-card'
import { useRoom } from '@/components/room-provider'

function shortAddress(addr: string | null) {
  if (!addr) return '—'
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`
}

function elapsedSince(liveAt: number | null, now: number) {
  if (!liveAt) return '—'
  const s = Math.max(0, Math.floor((now - liveAt) / 1000))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function OnCameraTable() {
  const { mode, room, seats, kick, pin } = useRoom()
  const [now, setNow] = useState(() => Date.now())

  // Tick the "On for" column while anyone is live.
  useEffect(() => {
    if (!seats.some((s) => s.live)) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [seats])

  const liveCount = seats.filter((s) => s.live).length
  const tokenSymbol = room?.paymentTokenSymbol || 'USDC'

  return (
    <GlassCard>
      <CardHeader
        icon={<Video className="size-5" />}
        title="On camera"
        description="Viewers currently paying to be on stream."
        accent="cyan"
        action={
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-input/30 px-3 py-1 text-xs font-medium text-foreground">
            <Circle
              className={
                liveCount > 0
                  ? 'size-2 animate-neon-pulse fill-[var(--neon-magenta)] text-[var(--neon-magenta)]'
                  : 'size-2 fill-muted-foreground/40 text-muted-foreground/40'
              }
            />
            {liveCount} live
          </span>
        }
      />
      {mode !== 'managing' ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground sm:px-6">
          Create or unlock a room to see who&apos;s on camera.
        </p>
      ) : seats.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground sm:px-6">
          No one on camera yet. Share your viewer link to fill the seats.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-border/70 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-3 font-medium sm:px-6">Viewer</th>
                <th className="px-3 py-3 font-medium">Wallet</th>
                <th className="px-3 py-3 font-medium">On for</th>
                <th className="px-3 py-3 font-medium">Spent</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-5 py-3 sm:px-6">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {seats.map((s) => (
                <tr
                  key={s.id}
                  className="border-b border-border/40 last:border-0 transition-colors hover:bg-input/20"
                >
                  <td className="px-5 py-3 font-medium text-foreground sm:px-6">
                    {s.username}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-muted-foreground">
                    {shortAddress(s.viewerAddress)}
                  </td>
                  <td className="px-3 py-3 font-mono text-foreground/90">
                    {elapsedSince(s.liveAt, now)}
                  </td>
                  <td className="px-3 py-3 font-mono text-foreground/90">
                    {s.spent} {tokenSymbol}
                  </td>
                  <td className="px-3 py-3">
                    {s.pinned ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--neon-lime)]/15 px-2.5 py-1 text-xs font-semibold text-[var(--neon-lime)]">
                        <Pin className="size-3" />
                        PINNED / CO-HOST
                      </span>
                    ) : s.live ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--neon-magenta)]/15 px-2.5 py-1 text-xs font-semibold text-[var(--neon-magenta)]">
                        <span className="size-1.5 rounded-full bg-[var(--neon-magenta)]" />
                        Live
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-input/50 px-2.5 py-1 text-xs font-semibold text-muted-foreground">
                        Queued
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right sm:px-6">
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void pin(s.id, !s.pinned)}
                        aria-label={s.pinned ? `Unpin ${s.username}` : `Pin ${s.username} as co-host`}
                        title={s.pinned ? 'Unpin (resume metering)' : 'Pin as free co-host (pause meter)'}
                        className={
                          s.pinned
                            ? 'inline-flex size-7 items-center justify-center rounded-md border border-[var(--neon-lime)]/60 bg-[var(--neon-lime)]/15 text-[var(--neon-lime)] transition-colors hover:bg-[var(--neon-lime)]/25'
                            : 'inline-flex size-7 items-center justify-center rounded-md border border-border bg-input/30 text-muted-foreground transition-colors hover:border-[var(--neon-lime)]/60 hover:text-[var(--neon-lime)]'
                        }
                      >
                        {s.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => void kick(s.id)}
                        aria-label={`Kick ${s.username}`}
                        title="Kick"
                        className="inline-flex size-7 items-center justify-center rounded-md border border-border bg-input/30 text-muted-foreground transition-colors hover:border-[var(--neon-magenta)]/60 hover:text-[var(--neon-magenta)]"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </GlassCard>
  )
}
