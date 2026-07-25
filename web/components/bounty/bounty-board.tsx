'use client'

// Public bounty board — reserved handles with real pool sizes.
//
// Reuses the browse-deck rail chrome (DeckPanel, accentFor, DemoTag) rather
// than forking a second visual language for the same concept. The deck's
// campaign rail shows SEEDED targets; this shows the real ledger-derived
// pools once BOUNTY_CLAIM is on.

import { useEffect, useState } from 'react'
import { Trophy, Tv, Video, AtSign, ArrowRight } from 'lucide-react'
import { DeckPanel, accentFor } from '@/components/browse-deck/deck-bits'
import { listBountyPools, type BountyPool, type BountyClientConfig } from '@/lib/bounty-api'

function PlatformIcon({ platform }: { platform: string | null }) {
  const cls = 'size-3.5 text-muted-foreground'
  if (platform === 'twitch') return <Tv className={cls} />
  if (platform === 'youtube') return <Video className={cls} />
  return <AtSign className={cls} />
}

const STATUS_TONE: Record<string, string> = {
  ACCUMULATING: 'border-[var(--neon-cyan)]/50 text-[var(--neon-cyan)]',
  RESERVED: 'border-[var(--neon-cyan)]/50 text-[var(--neon-cyan)]',
  CLAIM_PENDING: 'border-[var(--neon-amber)]/50 text-[var(--neon-amber)]',
  CLAIM_VERIFIED: 'border-[var(--neon-lime)]/50 text-[var(--neon-lime)]',
  AWAITING_AIRTIME: 'border-[var(--neon-lime)]/60 text-[var(--neon-lime)]',
  VERIFYING: 'border-[var(--neon-violet)]/50 text-[var(--neon-violet)]',
  PARTIALLY_RELEASED: 'border-[var(--neon-lime)]/60 text-[var(--neon-lime)]',
  RELEASED: 'border-border text-muted-foreground',
  EXPIRED: 'border-border text-muted-foreground',
  REFUNDED: 'border-border text-muted-foreground',
  DISPUTED: 'border-[var(--neon-magenta)]/60 text-[var(--neon-magenta)]',
  VOID: 'border-border text-muted-foreground',
}

export function BountyBoard({
  config,
  onClaim,
}: {
  config: BountyClientConfig
  onClaim: (pool: BountyPool) => void
}) {
  const [pools, setPools] = useState<BountyPool[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stop = false
    const load = () =>
      listBountyPools()
        .then((d) => { if (!stop) { setPools(d.pools); setError(null) } })
        .catch((e) => { if (!stop) setError(e instanceof Error ? e.message : 'Could not load bounties') })
    void load()
    const t = setInterval(load, 10_000)
    return () => { stop = true; clearInterval(t) }
  }, [])

  if (error) {
    return <p className="text-sm text-[var(--neon-magenta)]">{error}</p>
  }

  if (pools && pools.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border/70 bg-card/40 px-6 py-10 text-center">
        <p className="font-heading text-lg font-bold text-foreground">No bounties yet.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Record a MegaChat addressed to a streamer who isn&apos;t here yet — it starts
          their bounty pool.
        </p>
      </div>
    )
  }

  return (
    <DeckPanel title="Creator bounties" icon={<Trophy className="size-4 text-[var(--neon-lime)]" />}>
      {pools === null ? (
        <div className="space-y-2 p-4" aria-hidden="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-foreground/10" />
          ))}
        </div>
      ) : (
        <ul>
          {pools.map((p) => {
            const claimable = p.status === 'ACCUMULATING' || p.status === 'RESERVED'
            return (
              <li key={p.handleKey}>
                <div className="flex items-center gap-2.5 border-b border-border/40 px-4 py-3 last:border-b-0">
                  <span
                    className="grid size-8 shrink-0 place-items-center rounded-full border font-heading text-[11px] font-black"
                    style={{ borderColor: accentFor(p.handle || ''), color: accentFor(p.handle || '') }}
                  >
                    {(p.handle || '??').slice(0, 2).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold text-foreground">{p.handle}</span>
                      <PlatformIcon platform={p.platform} />
                    </span>
                    <span
                      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-bold ${
                        STATUS_TONE[p.status || ''] || 'border-border text-muted-foreground'
                      }`}
                    >
                      {(p.status || 'UNKNOWN').replace(/_/g, ' ').toLowerCase()}
                    </span>
                    <span className="ml-2 text-[11px] text-muted-foreground">
                      {p.contributionCount} MegaChat{p.contributionCount === 1 ? '' : 's'} waiting
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-sm font-bold text-foreground tabular">
                      {p.remaining.toLocaleString()} {config.currency}
                    </span>
                    {p.releasedContributor > 0 ? (
                      <span className="block text-[10px] text-[var(--neon-lime)] tabular">
                        {p.releasedContributor.toLocaleString()} released
                      </span>
                    ) : null}
                  </span>
                  {claimable ? (
                    <button
                      type="button"
                      onClick={() => onClaim(p)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--neon-lime)] px-3 py-1.5 text-xs font-bold text-black transition-transform hover:scale-[1.04]"
                    >
                      This is me <ArrowRight className="size-3" />
                    </button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </DeckPanel>
  )
}
