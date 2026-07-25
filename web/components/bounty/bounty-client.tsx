'use client'

// Bounty page shell. Renders NOTHING feature-specific until /api/bounty/config
// confirms the flag is on — with BOUNTY_CLAIM off that route 404s, so this
// degrades to a plain "not available" page and no bounty surface exists.

import { useEffect, useState } from 'react'
import { getBountyConfig, type BountyClientConfig, type BountyPool } from '@/lib/bounty-api'
import { BountyBoard } from './bounty-board'
import { ClaimFlow } from './claim-flow'

export function BountyClient() {
  const [config, setConfig] = useState<BountyClientConfig | null | 'loading'>('loading')
  const [claiming, setClaiming] = useState<BountyPool | null>(null)

  useEffect(() => {
    void getBountyConfig().then(setConfig)
  }, [])

  if (config === 'loading') {
    return <div className="h-40 animate-pulse rounded-2xl bg-card/40" aria-hidden="true" />
  }

  // Flag off (or backend unreachable): no bounty surface at all.
  if (!config || !config.enabled) {
    return (
      <div className="rounded-2xl border border-dashed border-border/70 bg-card/40 px-6 py-12 text-center">
        <h1 className="font-heading text-2xl font-bold text-foreground">Creator bounties</h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
          Not available yet. Recorded MegaChats will be able to stack up against a
          streamer who isn&apos;t on MegaChat, and pay out when they claim their handle
          and play them on stream.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <span className="text-xs font-bold uppercase tracking-widest text-[var(--neon-lime)]">
          Creator bounty
        </span>
        <h1 className="mt-1 font-heading text-3xl font-bold text-foreground">
          MegaChats waiting for their streamer
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Fans record MegaChats for streamers who aren&apos;t here yet. Those stack up
          against the streamer&apos;s handle. Claim yours, play them on your broadcast,
          and the pool pays out per verified on-air minute — MegaChat matches part of it.
        </p>
        <p className="mt-2 max-w-2xl rounded-lg border border-[var(--neon-amber)]/40 bg-[var(--neon-amber)]/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <strong className="text-[var(--neon-amber)]">Preview build.</strong> Escrow is
          tracked as a ledger and settlement is not connected — no funds move yet.
        </p>
      </div>

      {claiming ? (
        <ClaimFlow pool={claiming} config={config} onClose={() => setClaiming(null)} />
      ) : null}

      <BountyBoard config={config} onClaim={setClaiming} />
    </div>
  )
}
