'use client'

// Claim → setup walkthrough → live status.
//
// The walkthrough copy is load-bearing, not decoration: the badge-visibility
// rule is how this pays out, so it is stated plainly and early rather than
// buried. A streamer who shrinks or crops the badge earns nothing, and they
// must learn that here, not from an unpaid bounty.

import { useCallback, useEffect, useState } from 'react'
import { CircleCheck, CircleAlert, Copy, Radio, Clock } from 'lucide-react'
import {
  startClaim, getClaim, startAirSession,
  type BountyPool, type BountyClientConfig,
} from '@/lib/bounty-api'
import { ObsOneClick } from '@/components/obs/obs-oneclick'
import { formatDollars } from '@/lib/display-format'
import { useAccount } from '@/lib/use-account'

type Stage = 'idle' | 'claiming' | 'setup' | 'live' | 'error'

export function ClaimFlow({
  pool,
  config,
  onClose,
  canClaim = true,
}: {
  pool: BountyPool
  config: BountyClientConfig
  onClose: () => void
  canClaim?: boolean
}) {
  const { identity, wallet, signedIn, openSignIn, authError } = useAccount()
  const [stage, setStage] = useState<Stage>('idle')
  const [claimant, setClaimant] = useState('')
  const [claimId, setClaimId] = useState<string | null>(null)
  const [overlayUrl, setOverlayUrl] = useState<string | null>(null)
  const [airSessionId, setAirSessionId] = useState<string | null>(null)
  const [status, setStatus] = useState<Awaited<ReturnType<typeof getClaim>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => { setClaimant((current) => current || wallet.address || identity?.handle || '') }, [wallet.address, identity?.handle])

  const refresh = useCallback(async (id: string) => {
    try { setStatus(await getClaim(id)) } catch { /* transient */ }
  }, [])

  useEffect(() => {
    if (!claimId || stage === 'idle') return
    void refresh(claimId)
    const t = setInterval(() => void refresh(claimId), 5000)
    return () => clearInterval(t)
  }, [claimId, stage, refresh])

  async function doClaim() {
    if (!canClaim) { setError('No bounty has been created for this name yet. Display examples cannot be claimed.'); return }
    if (!pool.platform || !pool.handle) { setError('The streamer could not be identified. Return to Bounties and reopen this page.'); return }
    if (!signedIn) { openSignIn(); return }
    if (!claimant.trim()) { setError('Enter the wallet or account that should receive the bounty'); return }
    setStage('claiming'); setError(null)
    try {
      let id = claimId
      if (!id) {
        const r = await startClaim(pool.platform, pool.handle, claimant.trim())
        if (!r.identity.approved) { setError('Identity check did not approve this claim.'); setStage('error'); return }
        id = r.claim.id
        setClaimId(id)
      }
      const s = await startAirSession(id, pool.platform)
      setAirSessionId(s.airSession.id)
      setOverlayUrl(`${window.location.origin}/overlay?bounty=${encodeURIComponent(s.airSession.id)}`)
      setStage('setup')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Claim failed')
      setStage('error')
    }
  }

  const verifiedClips = status?.verifiedClips ?? 0
  const released = status?.pool.releasedContributor ?? 0
  const match = status?.pool.releasedPlatformMatch ?? 0
  const disputeEnds = status?.disputeWindowEndsAt ?? null
  const underReview = status?.underReview ?? false
  const quality = status?.quality ?? null
  // Prefer what the server resolved for this claim; fall back to the config
  // map so the platform notice is up BEFORE the first status poll returns.
  const profile = status?.platformProfile
    ?? (pool.platform ? config.platformProfiles?.[pool.platform] ?? null : null)

  return (
    <div className="rounded-2xl border border-border/70 bg-card/60 p-5 backdrop-blur-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-heading text-lg font-bold text-foreground">
            Claim the {pool.handle} bounty
          </h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {pool.contributionCount} MegaChat{pool.contributionCount === 1 ? '' : 's'} waiting ·{' '}
            <span className="font-semibold text-foreground">
              {formatDollars(pool.remaining)}
            </span>{' '}
            in the pool
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={stage === 'claiming'}
          className="shrink-0 text-sm text-muted-foreground underline-offset-2 hover:underline"
        >
          Close
        </button>
      </div>

      {stage === 'idle' || stage === 'claiming' || stage === 'error' ? (
        <div className="mt-4">
          <label htmlFor="bounty-claimant" className="block text-sm font-medium text-foreground">
            Payout account
          </label>
          <input
            id="bounty-claimant"
            value={claimant}
            onChange={(e) => setClaimant(e.target.value)}
            placeholder="0x… or your MegaChat account"
            className="mt-1.5 w-full rounded-xl border border-border bg-input/30 px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-[var(--neon-lime)]/70 focus:outline-none"
          />
          <p className="mt-2 rounded-lg border border-[var(--neon-amber)]/40 bg-[var(--neon-amber)]/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            <strong className="text-[var(--neon-amber)]">Identity check is stubbed in this build.</strong>{' '}
            It auto-approves and is recorded as <code>STUBBED_APPROVAL</code>. Connecting a real
            platform account comes next — nothing here moves real funds.
          </p>
          {!canClaim && <p className="mt-3 text-sm text-muted-foreground">This is an unfunded example. Create a real bounty before claiming; the setup preview is available here.</p>}
          {error || authError ? <p role="alert" className="mt-2 text-sm text-[#ffbbb3]">{error || authError}</p> : null}
          <button
            type="button"
            disabled={stage === 'claiming' || !canClaim}
            onClick={doClaim}
            className="mt-3 rounded-full bg-[var(--neon-lime)] px-5 py-2.5 text-sm font-bold text-black transition-transform hover:scale-[1.02] disabled:opacity-60"
          >
            {stage === 'claiming' ? 'Checking…' : !canClaim ? 'No funded bounty to claim' : !signedIn ? 'Sign in to claim' : 'Claim this handle'}
          </button>
        </div>
      ) : null}

      {stage === 'setup' || stage === 'live' ? (
        <div className="mt-4 space-y-4">
          <div className="rounded-xl border border-[var(--neon-lime)]/40 bg-[var(--neon-lime)]/5 p-3">
            <p className="flex items-center gap-1.5 text-sm font-bold text-[var(--neon-lime)]">
              <CircleCheck className="size-4" /> Handle claimed
            </p>
          </div>

          <div>
            <p className="text-sm font-semibold text-foreground">1. Add the overlay to OBS</p>
            {config.obsOneClick && overlayUrl ? (
              // One-click path (flag-gated). Its manual fallback is built in,
              // so this replaces the bare URL row rather than stacking on it.
              <div className="mt-1.5">
                <ObsOneClick
                  overlayUrl={overlayUrl}
                  badgeMinHeightPx={config.badgeMinHeightPx}
                  badgeCssPx={config.badgeCssPx ?? 28}
                  airSessionId={airSessionId}
                  scenePollMs={config.obsScenePollMs}
                />
              </div>
            ) : (
              <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-border bg-input/30 px-3 py-2">
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{overlayUrl}</code>
                <button
                  type="button"
                  onClick={() => {
                    if (overlayUrl) void navigator.clipboard.writeText(overlayUrl)
                    setCopied(true); setTimeout(() => setCopied(false), 1500)
                  }}
                  className="inline-flex shrink-0 items-center gap-1 text-xs font-bold text-[var(--neon-cyan)]"
                >
                  <Copy className="size-3.5" /> {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            )}
          </div>

          {/* The rule that decides whether they get paid. Stated plainly. */}
          <div className="rounded-xl border border-[var(--neon-amber)]/50 bg-[var(--neon-amber)]/5 p-3">
            <p className="flex items-center gap-1.5 text-sm font-bold text-[var(--neon-amber)]">
              <CircleAlert className="size-4" /> Keep the badge visible and readable
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              While a MegaChat is playing, the overlay shows a short code tied to that
              specific clip, changing every {Math.round(config.codeRotateMs / 1000)}s. We
              check your public stream for those codes — that is how we confirm the clips
              actually aired. <strong className="text-foreground">If the badge is cropped,
              covered, or scaled down until it can&apos;t be read in your stream, the bounty
              does not pay</strong> — there is nothing to verify. It only needs a small
              corner of your layout.
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              Clips shorter than {config.minClipSeconds}s can&apos;t be reliably checked and
              don&apos;t count toward the bounty.
            </p>
            {/* The quality floor, said UP FRONT. Below it the badge lands on
                the edge of what the reader can resolve, and the failure mode
                is a quiet shortfall rather than a rejection — so a streamer
                has to hear the number before they go live, not after. The
                number itself comes from config; restating it here is how the
                two drift apart. */}
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              <strong className="text-foreground">
                Stream at {config.minVerifiableHeightPx}p or better.
              </strong>{' '}
              Below that the badge gets small enough that reads start to fail — at 480p
              we measured about 1 clip in 12 going unread. You are never rejected for it,
              and we&apos;ll say so on the check rather than just paying less.
            </p>
          </div>

          {/* Kick has no VOD, so it has no retry. A materially different
              bargain, said before they rely on it. */}
          {profile && !profile.vodRetry ? (
            <div className="rounded-xl border border-[var(--neon-cyan)]/40 bg-[var(--neon-cyan)]/5 p-3">
              <p className="text-sm font-bold text-[var(--neon-cyan)]">
                On {profile.platform}, the live check is the only check
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{profile.notice}</p>
            </div>
          ) : null}

          {/* Measured on THEIR broadcast: named, with the number, so a
              shortfall can never pass for ordinary partial verification. */}
          {quality && quality.belowFloorClips > 0 ? (
            <div className="rounded-xl border border-[var(--neon-amber)]/50 bg-[var(--neon-amber)]/5 p-3">
              <p className="flex items-center gap-1.5 text-sm font-bold text-[var(--neon-amber)]">
                <CircleAlert className="size-4" /> Your badge is reading small
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                On {quality.belowFloorClips} clip{quality.belowFloorClips === 1 ? '' : 's'} the
                code measured{' '}
                {quality.smallestBadgePx ? `${Math.round(quality.smallestBadgePx)}px` : 'near'} tall
                against a {quality.floorPx}px floor — readable, but with little margin. Raise
                your output to {quality.minVerifiableHeightPx}p or give the badge more room, and
                the checks get comfortable. <strong className="text-foreground">This is a
                warning, not a deduction</strong>; anything inconclusive goes to a person.
              </p>
            </div>
          ) : null}

          <div>
            <p className="text-sm font-semibold text-foreground">2. Go live and play the MegaChats</p>
            <p className="mt-1 text-xs text-muted-foreground">
              You earn per <strong className="text-foreground">verified MegaChat played</strong>,
              released as the checks come back — not in one lump at the end. Simply having the
              overlay open earns nothing; the clips have to actually air. Each release then has
              a {Math.round(config.disputeWindowMs / 3_600_000)}h dispute window before
              it&apos;s final.
            </p>
          </div>

          {/* An ambiguous check must never look like silence or a denial —
              the streamer needs to know a person is on it. */}
          {underReview ? (
            <div className="rounded-xl border border-[var(--neon-violet)]/50 bg-[var(--neon-violet)]/5 p-3">
              <p className="text-sm font-bold text-[var(--neon-violet)]">Under review</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Our automatic check couldn&apos;t say for sure whether your clips aired, so a
                person is looking at it. Nothing is denied — payout is paused until they
                finish.
              </p>
            </div>
          ) : null}

          <div className="grid grid-cols-3 gap-3 rounded-xl border border-border/70 bg-background/40 p-3 text-center">
            <div>
              <p className="flex items-center justify-center gap-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                <Radio className="size-3" /> Verified
              </p>
              <p className="mt-0.5 font-heading text-lg font-bold text-foreground tabular">
                {verifiedClips}
              </p>
              <p className="text-[10px] text-muted-foreground">
                clip{verifiedClips === 1 ? '' : 's'} aired
              </p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Released</p>
              <p className="mt-0.5 font-heading text-lg font-bold text-[var(--neon-lime)] tabular">
                {formatDollars(released)}
              </p>
              {match > 0 ? (
                <p className="text-[10px] text-muted-foreground tabular">+{formatDollars(match)} match</p>
              ) : null}
            </div>
            <div>
              <p className="flex items-center justify-center gap-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                <Clock className="size-3" /> Remaining
              </p>
              <p className="mt-0.5 font-heading text-lg font-bold text-foreground tabular">
                {formatDollars(status?.pool.remaining ?? pool.remaining)}
              </p>
            </div>
          </div>

          {disputeEnds ? (
            <p className="text-center text-xs text-muted-foreground">
              Latest release is final on {new Date(disputeEnds).toLocaleString()}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
