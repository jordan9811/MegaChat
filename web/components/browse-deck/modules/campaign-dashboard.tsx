'use client'

// leftRail slot — campaignDashboard. The creator-bounty board: pool header
// (placeholder figures, explicit testnet chip), claimed count, live countdown,
// then one row per target creator. Clicking a row opens the claim drawer with
// a clip placeholder and a STUBBED claim CTA.
//
// TODO(claim-flow): the Claim CTA routes to /dashboard — there is no bounty
// claim backend. When one exists, replace the CTA href with the real claim
// call and drop the stub note in the drawer.

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
// lucide-react v1 ships no brand marks (and Kick's are off-limits anyway) —
// platforms get neutral glyphs: Tv=twitch, Video=youtube, AtSign=x.
import { Trophy, Clock, X, Play, Tv, Video, AtSign, ArrowRight } from 'lucide-react'
import { deckConfig } from '../browse-deck.config'
import {
  getCampaignTargets,
  type CampaignPlatform,
  type CampaignStatus,
  type CampaignTarget,
  type DeckModuleProps,
} from '../data'
import { DeckPanel, DemoTag, AnimatedThumb, accentFor } from '../deck-bits'

const STATUS: Record<CampaignStatus, { label: string; cls: string; pulse?: boolean }> = {
  recorded: { label: 'Recorded', cls: 'border-[var(--neon-violet)]/50 text-[var(--neon-violet)]' },
  sent: { label: 'Sent', cls: 'border-[var(--neon-cyan)]/50 text-[var(--neon-cyan)]' },
  claimable: { label: 'Claimable', cls: 'border-[var(--neon-lime)]/60 text-[var(--neon-lime)]', pulse: true },
  claimed: { label: 'Claimed', cls: 'border-border text-muted-foreground' },
  live: { label: 'Live', cls: 'border-[var(--neon-magenta)]/60 text-[var(--neon-magenta)]', pulse: true },
}

function PlatformIcon({ platform }: { platform: CampaignPlatform }) {
  const cls = 'size-3.5 text-muted-foreground'
  if (platform === 'twitch') return <Tv className={cls} />
  if (platform === 'youtube') return <Video className={cls} />
  return <AtSign className={cls} />
}

function useCountdown(toIso: string) {
  const [left, setLeft] = useState('')
  useEffect(() => {
    const tick = () => {
      const ms = new Date(toIso).getTime() - Date.now()
      if (ms <= 0) return setLeft('ended')
      const d = Math.floor(ms / 86_400_000)
      const h = Math.floor((ms % 86_400_000) / 3_600_000)
      const m = Math.floor((ms % 3_600_000) / 60_000)
      setLeft(`${d}d ${h}h ${m}m`)
    }
    tick()
    const t = setInterval(tick, 30_000)
    return () => clearInterval(t)
  }, [toIso])
  return left
}

function StatusChip({ status }: { status: CampaignStatus }) {
  const s = STATUS[status]
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-bold ${s.cls}`}
    >
      {s.pulse ? <span className="size-1 animate-pulse rounded-full bg-current" /> : null}
      {s.label}
    </span>
  )
}

function ClaimDrawer({ target, onClose }: { target: CampaignTarget; onClose: () => void }) {
  // Esc closes; body scroll parks while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  // Portaled to <body>: the sticky rail + backdrop-blur panels form stacking
  // and containing contexts that would trap a fixed overlay (the right panel
  // painted OVER the drawer until this).
  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={`${target.name} bounty`}>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
      />
      <div className="absolute inset-y-0 right-0 flex w-[min(420px,100vw)] flex-col overflow-y-auto border-l border-border bg-card p-5 shadow-2xl">
        <div className="flex items-center gap-3">
          <span
            className="grid size-10 shrink-0 place-items-center rounded-full border-2 font-heading text-sm font-black"
            style={{ borderColor: accentFor(target.name), color: accentFor(target.name) }}
          >
            {target.name.slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-heading text-base font-bold text-foreground">{target.name}</p>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <PlatformIcon platform={target.platform} /> {target.followers} followers
            </p>
          </div>
          <button
            type="button"
            aria-label="Close drawer"
            onClick={onClose}
            className="grid size-8 place-items-center rounded-full border border-border/70 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* clip placeholder — no clip storage exists in the repo (DECISIONS.md) */}
        <div className="relative mt-4 aspect-video overflow-hidden rounded-xl border border-border/70">
          <AnimatedThumb accent="violet" label={target.name} />
          <div className="absolute inset-0 grid place-items-center">
            <span className="grid size-12 place-items-center rounded-full bg-black/60 text-white backdrop-blur-sm">
              <Play className="size-5 translate-x-0.5" />
            </span>
          </div>
          <span className="absolute bottom-2 right-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white/80">
            clip placeholder
          </span>
        </div>

        <div className="mt-4 flex items-center justify-between rounded-xl border border-border/70 bg-background/50 px-4 py-3">
          <span className="text-sm text-muted-foreground">Bounty</span>
          <span className="font-heading text-lg font-bold text-[var(--neon-lime)]">
            {target.bounty}
            <span className="ml-1.5 align-middle text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              testnet
            </span>
          </span>
        </div>

        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          Go live on MegaChat with your room link in the title, keep the broadcast up for
          the campaign minimum, and the bounty unlocks for claim — paid out on testnet
          while the campaign runs.
        </p>

        {/* TODO(claim-flow): stub — routes to the dashboard until a claim backend exists */}
        <a
          href="/dashboard"
          className="mt-5 inline-flex items-center justify-center gap-1.5 rounded-full bg-[var(--neon-lime)] px-5 py-2.5 text-sm font-bold text-black transition-transform hover:scale-[1.02]"
        >
          Claim this bounty <ArrowRight className="size-4" />
        </a>
        <p className="mt-2 text-center text-[11px] text-muted-foreground">
          Claim flow is a stub — this opens the room dashboard for now.
        </p>
      </div>
    </div>,
    document.body,
  )
}

export function CampaignDashboard(_props: DeckModuleProps) {
  const targets = useMemo(() => getCampaignTargets(), [])
  const [open, setOpen] = useState<CampaignTarget | null>(null)
  const c = deckConfig.campaign
  const left = useCountdown(c.endsAt)
  const claimed = targets.filter((t) => t.status === 'claimed').length
  const claimable = targets.filter((t) => t.status === 'claimable').length

  return (
    <>
      <DeckPanel
        id="bounty-board"
        title={c.title}
        icon={<Trophy className="size-4 text-[var(--neon-lime)]" />}
        tag={<DemoTag />}
        bodyClassName="max-h-[calc(100vh-12rem)] overflow-y-auto"
      >
        {/* pool header */}
        <div className="border-b border-border/60 px-4 py-3">
          <p className="font-heading text-2xl font-black text-foreground">
            {c.pool}
            <span className="ml-2 align-middle rounded-full border border-[var(--neon-amber)]/50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--neon-amber)]">
              {c.poolNote}
            </span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            <span className="tabular">{claimed}</span> of {c.targetCount} claimed ·{' '}
            <span className="text-[var(--neon-lime)]">
              <span className="tabular">{claimable}</span> claimable now
            </span>
          </p>
          <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="size-3.5" /> ends in <span className="tabular">{left}</span>
          </p>
        </div>

        {/* target rows */}
        <ul>
          {targets.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => setOpen(t)}
                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-foreground/5"
              >
                <span
                  className="grid size-8 shrink-0 place-items-center rounded-full border font-heading text-[11px] font-black"
                  style={{ borderColor: accentFor(t.name), color: accentFor(t.name) }}
                >
                  {t.name.slice(0, 2).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-semibold text-foreground">{t.name}</span>
                    <PlatformIcon platform={t.platform} />
                  </span>
                  <StatusChip status={t.status} />
                </span>
                <span className="shrink-0 text-sm font-bold text-foreground/90 tabular">
                  {t.bounty}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </DeckPanel>

      {open ? <ClaimDrawer target={open} onClose={() => setOpen(null)} /> : null}
    </>
  )
}
