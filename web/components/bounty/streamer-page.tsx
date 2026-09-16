'use client'

// ONE STREAMER'S BOUNTY PAGE.
//
// Identity up top (handle, platform, live/claimed state), then the pool with
// GUARANTEED money leading and contested money second, explicitly labelled
// with how many rivals are racing for it. The headline number is never a
// blend: a streamer who claims and watches "their" pool shrink learns about
// restaking from the worst possible teacher, so the page teaches it first.
//
// Primary CTA for fans: record a MegaChat. For the claimed streamer: the
// approval queue (also reachable from the booth).

import { useCallback, useEffect, useState } from 'react'
import { Radio, Users, CircleCheck, Swords } from 'lucide-react'
import {
  getBountyConfig, getPoolView, getProgram,
  type BountyClientConfig, type PoolView, type ProgramPool,
} from '@/lib/bounty-api'
import { RecordFlow } from './record-flow'
import { ApprovalQueue } from './approval-queue'
import { ClaimFlow } from './claim-flow'

export function StreamerBountyPage({ platform, handle }: { platform: string; handle: string }) {
  const [config, setConfig] = useState<BountyClientConfig | null | 'loading'>('loading')
  const [view, setView] = useState<PoolView | null>(null)
  const [claimedBy, setClaimedBy] = useState<string | null>(null)
  const [clipCount, setClipCount] = useState(0)
  const [others, setOthers] = useState<ProgramPool[]>([])
  const [twitchLive, setTwitchLive] = useState<boolean | null>(null)
  const [recording, setRecording] = useState(false)
  const [claiming, setClaiming] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const v = await getPoolView(platform, handle)
      setView(v.view)
      setClaimedBy(v.reserved?.claimedBy ?? null)
      setClipCount(v.clips)
    } catch { /* transient */ }
  }, [platform, handle])

  useEffect(() => {
    void getBountyConfig().then(async (cfg) => {
      setConfig(cfg)
      if (!cfg?.enabled) return
      await refresh()
      try { setOthers((await getProgram()).pools) } catch { /* optional */ }
      // Live status: reuse the same public-rooms signal the browse grid uses
      // (server-side Twitch check) — only meaningful for twitch handles.
      if (platform === 'twitch') {
        try {
          const rooms = await fetch('/api/rooms/public').then((r) => r.json())
          const room = (rooms.rooms || rooms).find(
            (r: { twitchChannel?: string | null }) => (r.twitchChannel || '').toLowerCase() === handle.toLowerCase(),
          )
          setTwitchLive(room ? !!room.twitchLive : null)
        } catch { setTwitchLive(null) }
      }
    })
    const t = setInterval(() => void refresh(), 10_000)
    return () => clearInterval(t)
  }, [platform, handle, refresh])

  if (config === 'loading') return <div className="h-40 animate-pulse rounded-2xl bg-card/40" aria-hidden="true" />
  if (!config || !config.enabled) {
    return (
      <div className="rounded-2xl border border-dashed border-border/70 bg-card/40 px-6 py-12 text-center">
        <p className="text-sm text-muted-foreground">The bounty program isn&apos;t open yet.</p>
      </div>
    )
  }

  const currency = config.currency

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-4">
        <span className="grid size-14 shrink-0 place-items-center rounded-full border border-border bg-card/60 font-heading text-lg font-bold text-foreground">
          {handle.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 font-heading text-2xl font-bold text-foreground">
            {handle}
            <span className="text-xs font-normal uppercase tracking-wide text-muted-foreground">{platform}</span>
            {claimedBy ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-[var(--neon-lime)]/50 px-2 py-0.5 text-[10px] font-bold text-[var(--neon-lime)]">
                <CircleCheck className="size-3" /> claimed
              </span>
            ) : (
              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
                not on MegaChat yet
              </span>
            )}
            {twitchLive === true ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-[var(--neon-magenta)]/60 px-2 py-0.5 text-[10px] font-bold text-[var(--neon-magenta)]">
                <Radio className="size-3 animate-pulse" /> live now
              </span>
            ) : null}
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {claimedBy
              ? twitchLive === false ? 'Claimed, currently offline.' : 'Claimed — clips can air on their next broadcast.'
              : 'Everything on this page is waiting for them the day they claim this handle.'}
          </p>
        </div>
      </div>

      {view ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {/* GUARANTEED leads. Always. */}
          <div className="rounded-2xl border border-[var(--neon-lime)]/40 bg-[var(--neon-lime)]/5 p-4">
            <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Guaranteed to {handle}</p>
            <p className="mt-1 font-heading text-2xl font-bold text-foreground tabular">
              {view.guaranteed.toLocaleString()} <span className="text-sm">{currency}</span>
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">theirs alone the moment they claim</p>
          </div>
          <div className="rounded-2xl border border-border/70 bg-card/50 p-4">
            <p className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              <Swords className="size-3" /> Contested
            </p>
            <p className="mt-1 font-heading text-2xl font-bold text-foreground tabular">
              {view.contestedTotal.toLocaleString()} <span className="text-sm">{currency}</span>
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {view.contested.length
                ? `offered to ${handle} AND ${Math.max(...view.contested.map((c) => c.rivals))} other${Math.max(...view.contested.map((c) => c.rivals)) === 1 ? '' : 's'} — first to claim takes it`
                : 'nothing contested right now'}
            </p>
          </div>
          <div className="rounded-2xl border border-border/70 bg-card/50 p-4">
            <p className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              <Users className="size-3" /> Backers
            </p>
            <p className="mt-1 font-heading text-2xl font-bold text-foreground tabular">{view.contributionCount}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{clipCount} clip{clipCount === 1 ? '' : 's'} ready to air</p>
          </div>
        </div>
      ) : null}

      {!recording ? (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => setRecording(true)}
            className="rounded-full bg-[var(--neon-magenta)] px-6 py-3 text-sm font-bold text-white transition-transform hover:scale-[1.02]">
            🎙 Record a MegaChat for {handle}
          </button>
          {!claimedBy ? (
            <button type="button" onClick={() => setClaiming(true)}
              className="rounded-full border border-[var(--neon-lime)]/60 px-5 py-3 text-sm font-bold text-[var(--neon-lime)] transition-colors hover:bg-[var(--neon-lime)]/10">
              I am {handle} — claim this
            </button>
          ) : null}
        </div>
      ) : null}

      {recording ? (
        <RecordFlow
          target={{ platform, handle }}
          config={config}
          otherPools={others}
          onDone={() => { window.location.href = '/bounty/mine' }}
        />
      ) : null}

      {claiming && view ? (
        <ClaimFlow pool={view} config={config} onClose={() => { setClaiming(false); void refresh() }} />
      ) : null}

      {/* The claimed streamer's working surface, right where their fans look. */}
      {claimedBy ? <ApprovalQueue platform={platform} handle={handle} by={claimedBy} /> : null}
    </div>
  )
}
