'use client'

// THE BOUNTY PROGRAM PAGE — what it is, how a fan takes part, what a streamer
// gets, how claiming works, what happens if nobody claims. Plain language,
// product voice. Below the fold: every bountied streamer, sorted by pool
// size, guaranteed-first numbers, promotional entries visibly labelled.

import { useEffect, useState } from 'react'
import { Mic, Trophy, ShieldCheck, Clock, Megaphone } from 'lucide-react'
import { getBountyConfig, getProgram, type BountyClientConfig, type ProgramPool } from '@/lib/bounty-api'

const HOW = [
  {
    icon: Mic,
    title: 'Fans record now',
    body: 'Pick a streamer who isn’t on MegaChat yet, record a MegaChat for them, and put money behind it. Your recording is stored safely until they arrive.',
  },
  {
    icon: Trophy,
    title: 'The streamer claims',
    body: 'When that streamer claims their handle, everything waiting for them is theirs: the recordings, and the bounty pool that grew while fans stacked up.',
  },
  {
    icon: ShieldCheck,
    title: 'They stay in control',
    body: 'Nothing airs without their say-so. Every clip goes through their approval queue first — they play what they like, decline what they don’t, and declined clips refund the fan in full.',
  },
  {
    icon: Clock,
    title: 'Nobody waits forever',
    body: 'You set an expiry on your bounty — about a week by default. If nobody claims in time, the whole thing refunds automatically. Money is never locked indefinitely.',
  },
]

export function BountyProgram() {
  const [config, setConfig] = useState<BountyClientConfig | null | 'loading'>('loading')
  const [pools, setPools] = useState<ProgramPool[]>([])
  const [totals, setTotals] = useState<{ realValue: number; displayedTotal: number } | null>(null)
  const [currency, setCurrency] = useState('USDC')

  useEffect(() => {
    void getBountyConfig().then(async (cfg) => {
      setConfig(cfg)
      if (cfg?.enabled) {
        try {
          const p = await getProgram()
          setPools(p.pools)
          setTotals(p.totals)
          setCurrency(p.currency)
        } catch { /* renders empty-state */ }
      }
    })
  }, [])

  if (config === 'loading') {
    return <div className="h-40 animate-pulse rounded-2xl bg-card/40" aria-hidden="true" />
  }
  if (!config || !config.enabled) {
    return (
      <div className="rounded-2xl border border-dashed border-border/70 bg-card/40 px-6 py-12 text-center">
        <h1 className="font-heading text-2xl font-bold text-foreground">Creator bounties</h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
          Not open yet. Soon, recorded MegaChats will stack up against streamers who
          aren&apos;t here, and pay out when they claim their handle and play them on stream.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <span className="text-xs font-bold uppercase tracking-widest text-[var(--neon-lime)]">
          Bounty program
        </span>
        <h1 className="mt-1 font-heading text-3xl font-bold text-foreground sm:text-4xl">
          Put a MegaChat on their stream before they even get here
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Some streamers aren&apos;t on MegaChat yet. Their fans can go first: record the
          MegaChat now, put a bounty behind it, and the moment that streamer claims their
          handle it&apos;s all waiting for them — clips to play on air, and a pool that pays
          them for playing.
        </p>
        {totals ? (
          <p className="mt-3 inline-flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border/70 bg-card/50 px-4 py-2 text-xs text-muted-foreground">
            <span>
              <strong className="font-heading text-base text-foreground tabular">{totals.realValue.toLocaleString()}</strong>{' '}
              {currency} escrowed
            </span>
            <span className="text-border">|</span>
            <span>
              <strong className="text-foreground tabular">{totals.displayedTotal.toLocaleString()}</strong>{' '}
              {currency} across all pools
              <span className="ml-1 opacity-80">(a bounty offered to several streamers shows in each of their pools — first claim takes it)</span>
            </span>
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {HOW.map((h) => (
          <div key={h.title} className="rounded-2xl border border-border/70 bg-card/50 p-4">
            <h.icon className="size-5 text-[var(--neon-cyan)]" />
            <h3 className="mt-2 font-heading text-sm font-bold text-foreground">{h.title}</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{h.body}</p>
          </div>
        ))}
      </div>

      <p className="max-w-2xl rounded-lg border border-[var(--neon-amber)]/40 bg-[var(--neon-amber)]/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        <strong className="text-[var(--neon-amber)]">Preview build.</strong> Escrow is tracked
        as a ledger and settlement is not connected — no real funds move yet.
      </p>

      <div>
        <h2 className="font-heading text-xl font-bold text-foreground">Streamers with bounties waiting</h2>
        {pools.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            None yet — be the first: any streamer&apos;s handle can start a pool.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70 bg-card/40">
            {pools.map((p) => (
              <li key={p.handleKey}>
                <a
                  href={`/bounty/s/${encodeURIComponent(p.platform || 'twitch')}/${encodeURIComponent(p.handle || '')}`}
                  className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-card/70"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-full border border-border bg-background/60 font-heading text-sm font-bold text-foreground">
                    {(p.handle || '?').slice(0, 2).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-heading text-sm font-bold text-foreground">{p.handle}</span>
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{p.platform}</span>
                      {p.claimed ? (
                        <span className="rounded-full border border-[var(--neon-lime)]/50 px-2 py-0.5 text-[10px] font-bold text-[var(--neon-lime)]">claimed</span>
                      ) : null}
                      {p.promotional ? (
                        // A pool with no fan pledges behind it is an invitation,
                        // not a promise — and it says so.
                        <span className="inline-flex items-center gap-1 rounded-full border border-[var(--neon-violet)]/50 px-2 py-0.5 text-[10px] font-bold text-[var(--neon-violet)]">
                          <Megaphone className="size-2.5" /> promo — no pledges yet
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {p.clipsWaiting} clip{p.clipsWaiting === 1 ? '' : 's'} waiting · {p.contributionCount} pledge{p.contributionCount === 1 ? '' : 's'}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-heading text-base font-bold text-foreground tabular">
                      {p.guaranteed.toLocaleString()} {currency}
                    </span>
                    <span className="block text-[10px] text-muted-foreground">
                      guaranteed{p.contestedTotal > 0 ? ` · +${p.contestedTotal.toLocaleString()} contested` : ''}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
