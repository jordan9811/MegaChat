'use client'

// STREAMER APPROVAL QUEUE — every clip is reviewable before it can air.
// Sorted by moderation grade+confidence so the safe pile clears fast and
// attention lands on the flagged items. Rejection asks WHY, because the
// reason code decides the fan's refund: "not for me" refunds in full with no
// strike; a policy violation runs the graduated policy.

import { useCallback, useEffect, useState } from 'react'
import { Check, X, SkipForward, ShieldAlert } from 'lucide-react'
import { getQueue, approveClip, rejectClip, type QueueClip } from '@/lib/bounty-api'
import { backendHttpUrl } from '@/lib/backend'

const GRADE_CHIP: Record<string, string> = {
  clean: 'border-[var(--neon-lime)]/60 text-[var(--neon-lime)]',
  borderline: 'border-[var(--neon-amber)]/60 text-[var(--neon-amber)]',
  violation: 'border-[var(--neon-magenta)]/60 text-[var(--neon-magenta)]',
}

export function ApprovalQueue({ platform, handle, by }: { platform: string; handle: string; by: string }) {
  const [queue, setQueue] = useState<QueueClip[]>([])
  const [skipped, setSkipped] = useState<string[]>([])
  const [rejecting, setRejecting] = useState<QueueClip | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try { setQueue((await getQueue(platform, handle)).queue) } catch { /* transient */ }
  }, [platform, handle])
  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 8000)
    return () => clearInterval(t)
  }, [refresh])

  const visible = queue.filter((c) => !skipped.includes(c.clipId))

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    try { await fn(); await refresh() } finally { setBusy(false); setRejecting(null) }
  }

  return (
    <div className="rounded-2xl border border-border/70 bg-card/60 p-5">
      <h2 className="font-heading text-lg font-bold text-foreground">
        Review queue <span className="text-sm font-normal text-muted-foreground">({visible.length} waiting)</span>
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Nothing airs without your approval. Safest first — declining a clip you just don&apos;t
        want refunds the fan in full; flag actual rule-breaking so it counts against repeat offenders.
      </p>

      {visible.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">Queue&apos;s clear. 🎉</p>
      ) : (
        <ul className="mt-4 space-y-4">
          {visible.map((c) => (
            <li key={c.clipId} className="rounded-xl border border-border/70 bg-background/40 p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono">{c.durationS}s</span>
                {c.moderation ? (
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${GRADE_CHIP[c.moderation.grade] || 'border-border'}`}>
                    {c.moderation.grade} · {Math.round((c.moderation.confidence || 0) * 100)}%
                    {c.moderation.topCategory ? ` · ${c.moderation.topCategory}` : ''}
                  </span>
                ) : (
                  <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-bold">unmoderated</span>
                )}
                {c.contributor ? <span className="truncate">from {c.contributor}</span> : null}
              </div>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption -- fan-recorded clip */}
              <video src={`${backendHttpUrl()}${c.mediaUrl}`} controls preload="metadata"
                className="mt-2 aspect-video w-full max-w-md rounded-lg border border-border bg-black" />
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" disabled={busy}
                  onClick={() => act(() => approveClip(c.clipId, by))}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[var(--neon-lime)] px-4 py-2 text-xs font-bold text-black disabled:opacity-60">
                  <Check className="size-3.5" /> Approve
                </button>
                <button type="button" disabled={busy}
                  onClick={() => setRejecting(c)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[var(--neon-magenta)]/60 px-4 py-2 text-xs font-bold text-[var(--neon-magenta)] disabled:opacity-60">
                  <X className="size-3.5" /> Reject
                </button>
                <button type="button" disabled={busy}
                  onClick={() => setSkipped((s) => [...s, c.clipId])}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-xs font-bold text-muted-foreground">
                  <SkipForward className="size-3.5" /> Later
                </button>
              </div>

              {rejecting?.clipId === c.clipId ? (
                <div className="mt-2 rounded-lg border border-border bg-card/60 p-3">
                  <p className="text-xs font-bold text-foreground">Why? This decides the fan&apos;s refund.</p>
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <button type="button" disabled={busy}
                      onClick={() => act(() => rejectClip(c.clipId, { by, reasonCode: 'STREAMER_DECLINED', reason: 'streamer passed' }))}
                      className="rounded-lg border border-border px-3 py-2 text-left text-xs text-foreground hover:bg-card">
                      <span className="font-bold">Just not for me</span>
                      <span className="block text-muted-foreground">full refund, no penalty</span>
                    </button>
                    <button type="button" disabled={busy}
                      onClick={() => act(() => rejectClip(c.clipId, { by, reasonCode: 'POLICY_VIOLATION', reason: 'rule-breaking content' }))}
                      className="rounded-lg border border-[var(--neon-magenta)]/50 px-3 py-2 text-left text-xs text-foreground hover:bg-card">
                      <span className="flex items-center gap-1 font-bold"><ShieldAlert className="size-3" /> Breaks the rules</span>
                      <span className="block text-muted-foreground">counts against repeat offenders</span>
                    </button>
                    <button type="button" onClick={() => setRejecting(null)}
                      className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline">cancel</button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
