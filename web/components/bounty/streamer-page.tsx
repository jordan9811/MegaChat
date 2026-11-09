'use client'

// ONE STREAMER'S BOUNTY PAGE.
//
// Identity up top (handle, platform, live/claimed state), then the pool with
// GUARANTEED money leading and contested money second, explicitly labelled
// with how many rivals are racing for it. The headline number is never a
// blend: a streamer who claims and watches "their" pool shrink learns about
// restaking from the worst possible teacher, so the page teaches it first.
//
// Primary CTA for fans: record a Holler. For the claimed streamer: the
// approval queue (also reachable from the booth).

import { useCallback, useEffect, useRef, useState } from 'react'
import { Radio, Users, CircleCheck, Swords, Mic, LockKeyhole } from 'lucide-react'
import {
  getBountyConfig, getPoolView, getProgram,
  type BountyClientConfig, type PoolView, type ProgramPool, type PoolLiveness,
} from '@/lib/bounty-api'
import { bountyKey } from '@/lib/bounty-examples'
import { FeatureTag } from '@/components/feature-tag'
import { LivenessBadge } from '@/components/liveness-badge'
import { RecordFlow } from './record-flow'
import { ApprovalQueue } from './approval-queue'
import { ClaimFlow } from './claim-flow'

// The locked/contested key, the board's own (bounty.css --mcb-locked, owner
// 2026-10-23): solid green is money locked to this name, the yellow hatch is
// money rivals can also take (UX sweep bo-vocab). The hairline in the ink
// keeps each swatch visible on a light ground.
const LOCKED_SWATCH = {
  background: 'var(--f-rewards)',
  boxShadow: 'inset 0 0 0 1px var(--f-rewards-ink)',
}
const CONTESTED_SWATCH = {
  backgroundImage: 'repeating-linear-gradient(135deg, var(--f-bounty) 0 3px, transparent 3px 6px)',
  boxShadow: 'inset 0 0 0 1px var(--f-bounty-ink)',
}

/** No money on this name at all: nothing held, nothing contested, no open pledge. */
function isUnbacked(v: PoolView): boolean {
  return v.contributionCount === 0 && v.contestedTotal === 0 && v.openPledges === 0
}

/** One card's money by the tier it releases at, in the card's own unit. */
function TierLine({ tiers, currency }: { tiers: { greenOnly: number; yellowOk: number }; currency: string }) {
  return (
    <p className="mt-1.5 text-[11px] text-muted-foreground" title="Backers choose when their pledge pays: Green only pays for badge-verified airtime; Yellow ok also releases a slice after a broadcast that kept the keyed overlay up.">
      <span className="lv lv--green" aria-hidden="true"><span className="lv-dot" />Green only</span> {tiers.greenOnly.toLocaleString()}
      {' · '}
      <span className="lv lv--yellow" aria-hidden="true"><span className="lv-dot" />Yellow ok</span> {tiers.yellowOk.toLocaleString()} {currency}
    </p>
  )
}

export function StreamerBountyPage({ platform, handle }: { platform: string; handle: string }) {
  const [config, setConfig] = useState<BountyClientConfig | null | 'loading'>('loading')
  const [view, setView] = useState<PoolView | null>(null)
  const [claimedBy, setClaimedBy] = useState<string | null>(null)
  const [liveness, setLiveness] = useState<PoolLiveness | null>(null)
  const [clipCount, setClipCount] = useState(0)
  const [others, setOthers] = useState<ProgramPool[]>([])
  const [twitchLive, setTwitchLive] = useState<boolean | null>(null)
  const [recording, setRecording] = useState(false)
  const [claiming, setClaiming] = useState(false)
  const [avatarBroken, setAvatarBroken] = useState(false)
  // The money row's load (UX sweep js-pool-fail-silent): a failed FIRST load
  // says so, with Retry, instead of reading as an empty pool. A poll that
  // fails after a good load keeps the last figures (transient).
  const [loadFailed, setLoadFailed] = useState(false)
  // ?claim=1 (the board's "Claim this bounty") opens the claim form once the
  // pool has loaded (UX sweep bo-panel-ctas).
  const [wantClaim, setWantClaim] = useState(false)
  const claimRef = useRef<HTMLDivElement>(null)
  const loadedOnce = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const v = await getPoolView(platform, handle)
      setView(v.view)
      setClaimedBy(v.reserved?.claimedBy ?? null)
      setLiveness(v.liveness ?? null)
      setClipCount(v.clips)
      setLoadFailed(false)
      loadedOnce.current = true
    } catch {
      if (!loadedOnce.current) setLoadFailed(true)
    }
  }, [platform, handle])

  useEffect(() => {
    try { if (new URLSearchParams(window.location.search).get('claim') === '1') setWantClaim(true) } catch { /* no query */ }
  }, [])

  // ?claim=1 lands on the open claim form, scrolled into view, once the pool
  // has loaded and there is something to claim.
  useEffect(() => {
    if (!wantClaim || !view || claimedBy || isUnbacked(view)) return
    setWantClaim(false)
    setClaiming(true)
    setTimeout(() => claimRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0)
  }, [wantClaim, view, claimedBy])

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
  // Nobody has backed this name yet (UX sweep bo-claim-unbacked): the page
  // asks for the first Holler, and there is nothing to claim.
  const unbacked = !!view && !claimedBy && isUnbacked(view)
  const cardTiers = view?.cardTiers
  // The photo the board already shows for this name, from the same
  // getProgram() call. Initials only when there is none or it fails to load.
  const poolKey = bountyKey(platform, handle)
  const avatarUrl = others.find((p) => p.platform && p.handle && bountyKey(p.platform, p.handle) === poolKey)?.avatarUrl || null

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-4">
        <span className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-full border border-border bg-card/60 font-heading text-lg font-bold text-foreground">
          {avatarUrl && !avatarBroken ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              alt=""
              width={56}
              height={56}
              onError={() => setAvatarBroken(true)}
              className="size-full object-cover"
            />
          ) : handle.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-baseline gap-2 font-heading text-2xl font-bold text-foreground">
            {handle}
            <span className="text-xs font-normal uppercase tracking-wide text-muted-foreground">{platform}</span>
            {claimedBy ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-f-rewards-line bg-f-rewards-bg px-2 py-0.5 text-[10px] font-bold tracking-normal text-f-rewards-ink">
                <CircleCheck className="size-3" /> claimed
              </span>
            ) : (
              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-bold tracking-normal text-muted-foreground">
                not on Holler yet
              </span>
            )}
            {/* Which check stands behind the money right now, once claimed. */}
            {claimedBy && liveness ? <LivenessBadge liveness={liveness} showOff /> : null}
            {/* On air: the solid record magenta with white ink (SPEC §3). */}
            {twitchLive === true ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-f-holler-solid px-2 py-0.5 text-[10px] font-bold tracking-normal text-f-holler-on">
                <Radio className="size-3 animate-pulse" /> live now
              </span>
            ) : null}
          </h1>
          <p className="mt-0.5 text-[15px] text-hl-muted">
            {claimedBy
              ? twitchLive === false ? 'Claimed, currently offline.' : 'Claimed — clips can air on their next broadcast.'
              : unbacked
                ? `No one has backed ${handle} yet.`
                : 'Everything on this page is waiting for them the day they claim this handle.'}
          </p>
        </div>
      </div>

      {/* The money row is reserved from the first frame, so Record never
          moves; a failed first load says so and offers Retry. */}
      {loadFailed && !view ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-2xl border border-hl-danger/40 bg-hl-danger/5 px-4 py-3">
          <p className="text-sm font-medium text-foreground">Couldn&apos;t load this pool.</p>
          <button type="button" onClick={() => { setLoadFailed(false); void refresh() }}
            className="inline-flex h-11 items-center rounded-lg border border-border px-4 text-sm font-bold text-foreground">
            Retry
          </button>
        </div>
      ) : !view ? (
        <div className="grid gap-3 sm:grid-cols-3" aria-busy="true" aria-label="Loading this pool">
          {[0, 1, 2].map((i) => (
            <div key={i} aria-hidden="true" className="animate-pulse rounded-2xl border border-border/70 bg-card/50 p-4">
              <div className="h-[15px] w-24 rounded bg-muted" />
              <div className="mt-1 h-8 w-20 rounded bg-muted" />
              <div className="mt-1.5 h-5 w-32 rounded bg-muted" />
            </div>
          ))}
        </div>
      ) : unbacked ? null : (
        <div className="grid gap-3 sm:grid-cols-3">
          {/* LOCKED leads. Always. Solid green swatch = locked to this name;
              the yellow hatch beside Contested = may go to a rival. */}
          <div className="rounded-2xl border border-f-bounty-line bg-f-bounty-bg p-4">
            <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              <span aria-hidden="true" className="h-2 w-3.5 shrink-0" style={LOCKED_SWATCH} />
              Locked to {handle}
              <span title="Theirs alone the moment they claim" aria-label="Locked to this name" className="inline-flex"><LockKeyhole className="size-3" aria-hidden="true" /></span>
            </p>
            <p className="mt-1 font-heading text-2xl font-bold text-f-bounty-ink tabular">
              {view.guaranteed.toLocaleString()} <span className="text-sm">{currency}</span>
            </p>
            {cardTiers ? <TierLine tiers={cardTiers.locked} currency={currency} /> : null}
          </div>
          <div className="rounded-2xl border border-border/70 bg-card/50 p-4">
            <p className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              <span aria-hidden="true" className="mr-0.5 h-2 w-3.5 shrink-0" style={CONTESTED_SWATCH} />
              <Swords className="size-3" /> Contested
            </p>
            <p className="mt-1 font-heading text-2xl font-bold text-f-bounty-ink tabular">
              {view.contestedTotal.toLocaleString()} <span className="text-sm">{currency}</span>
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {view.contested.length
                ? `offered to ${handle} AND ${Math.max(...view.contested.map((c) => c.rivals))} other${Math.max(...view.contested.map((c) => c.rivals)) === 1 ? '' : 's'} — first to claim takes it`
                : 'nothing contested right now'}
            </p>
            {cardTiers && view.contestedTotal > 0 ? <TierLine tiers={cardTiers.contested} currency={currency} /> : null}
          </div>
          <div className="rounded-2xl border border-border/70 bg-card/50 p-4">
            <p className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              <Users className="size-3" /> Backers
            </p>
            <p className="mt-1 font-heading text-2xl font-bold text-foreground tabular">{view.contributionCount}</p>
            {/* A recorded clip is a Holler — labelled in the holler magenta. */}
            <FeatureTag kind="holler" className="mt-1.5">{clipCount} clip{clipCount === 1 ? '' : 's'} ready to air</FeatureTag>
          </div>
        </div>
      )}

      {!recording ? (
        <div className="flex flex-wrap items-center gap-3">
          {/* Recording a clip is the holler magenta; claiming the money is
              bounty. The shared 8px corner at 44px (UX sweep js-pill-buttons).
              Held until the pool has loaded once: a fan does not start a paid
              flow against a pool the page could not read. */}
          <button type="button" onClick={() => setRecording(true)} disabled={!view}
            className="inline-flex h-11 items-center gap-2 rounded-lg bg-f-holler-solid px-6 text-sm font-bold text-f-holler-on transition-transform duration-150 ease-[cubic-bezier(.23,1,.32,1)] active:scale-[.97] disabled:opacity-50">
            <Mic className="size-4" aria-hidden="true" />
            {unbacked ? 'Record the first Holler' : `Record a Holler for ${handle}`}
          </button>
          {!claimedBy && view && !unbacked ? (
            <button type="button" onClick={() => setClaiming(true)}
              className="inline-flex h-11 items-center rounded-lg border border-f-bounty-line px-5 text-sm font-bold text-f-bounty-ink transition-colors duration-150 hover:bg-f-bounty-bg active:scale-[.97]">
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
        <div ref={claimRef} className="scroll-mt-20">
          <ClaimFlow pool={view} config={config} onClose={() => { setClaiming(false); void refresh() }} />
        </div>
      ) : null}

      {/* The claimed streamer's working surface, right where their fans look. */}
      {claimedBy ? <ApprovalQueue platform={platform} handle={handle} by={claimedBy} /> : null}
    </div>
  )
}
