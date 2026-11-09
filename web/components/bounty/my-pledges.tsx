'use client'

// CONTRIBUTOR STATUS PAGE — one row per contribution, its current state, and
// what happens next. The ladder is the enumerated server one; nothing here is
// invented client-side, and `paid` is shown for what it is: a rung nothing
// reaches until real settlement lands.

import { useCallback, useEffect, useState } from 'react'
import { getMyContributions, type MyContribution } from '@/lib/bounty-api'
import { useAccount } from '@/lib/use-account'

// Holler colour roles: money waiting on someone is bounty yellow, a review in
// progress is strap azure, approved / played / paid is the positive
// green, a policy rejection (and a failed load) is the danger orange, and a
// refund is neutral.
const WAITING = 'border-f-bounty-line bg-f-bounty-bg text-f-bounty-ink'
const REVIEWING = 'border-hl-strap-hi/50 bg-hl-strap/10 text-foreground'
const GOOD = 'border-f-rewards-line bg-f-rewards-bg text-f-rewards-ink'

// The unit is printed on every amount: this page is the fan's only receipt.
const UNIT = 'USDC'

/** "Nov 14", with the year only when it is not this year. */
function shortDate(ms: number): string {
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

const STATE_LABEL: Record<string, { label: string; cls: string }> = {
  // Real money: before the wallet funds the pledge, nothing is charged.
  unfunded: { label: 'Not funded', cls: WAITING },
  funding_pending: { label: 'Funding — confirming', cls: REVIEWING },
  funding_needs_person: { label: 'Funding — being checked', cls: REVIEWING },
  abandoned: { label: 'Not funded — closed', cls: 'border-border text-muted-foreground' },
  pending_upload: { label: 'Waiting for upload', cls: WAITING },
  pending_moderation: { label: 'In review', cls: REVIEWING },
  awaiting_claim: { label: 'Awaiting claim', cls: WAITING },
  claimed_pending_review: { label: 'Streamer reviewing', cls: REVIEWING },
  approved: { label: 'Approved', cls: GOOD },
  played: { label: 'Played on stream 🎉', cls: GOOD },
  paid: { label: 'Paid', cls: GOOD },
  expired_refunded: { label: 'Expired — refunded', cls: 'border-border text-muted-foreground' },
  declined_refunded: { label: 'Declined — refunded in full', cls: 'border-border text-muted-foreground' },
  rejected_policy: { label: 'Rejected (policy)', cls: 'border-hl-danger/50 bg-hl-danger/10 text-hl-danger' },
  refunded: { label: 'Refunded', cls: 'border-border text-muted-foreground' },
}

// The old signature took a contributor string; the server has ignored it
// since contributions became account-keyed (the query param was an
// enumeration hole as well as broken). The page half-kept the old model:
// it would not even FETCH until you typed a string the server then threw
// away — so a signed-in fan with no localStorage saw an empty lookup form
// forever. The session decides now, on both ends.
export function MyPledges({ initialMe: _ignored }: { initialMe?: string }) {
  const [rows, setRows] = useState<MyContribution[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [needsAuth, setNeedsAuth] = useState(false)
  const { signedIn, openSignIn } = useAccount()

  const load = useCallback(async () => {
    try {
      setError(null)
      setNeedsAuth(false)
      setRows((await getMyContributions()).contributions)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Lookup failed'
      if (/sign in/i.test(msg)) setNeedsAuth(true)
      else setError(msg)
    }
  }, [])

  useEffect(() => { void load() }, [load])
  // Signing in from the button below reloads the list in place.
  useEffect(() => { if (signedIn && needsAuth) void load() }, [signedIn, needsAuth, load])

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground">My bounties</h1>
        <p className="mt-1 text-[15px] text-hl-muted">
          Every Holler you&apos;ve pledged, where it is, and what happens next.
        </p>
      </div>

      {needsAuth ? (
        <div>
          <button type="button" className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-bold text-primary-foreground transition-transform active:scale-[.97]" onClick={openSignIn}>Sign in to see My bounties</button>
        </div>
      ) : null}
      {error ? <p className="text-sm text-hl-danger">{error}</p> : null}

      {rows && rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing yet. <a href="/bounty" className="font-semibold text-foreground underline decoration-hl-strap-hi decoration-2 underline-offset-4">Find a streamer to back →</a>
        </p>
      ) : null}

      {rows && rows.length > 0 ? (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70 bg-card/40">
          {rows.map((r) => {
            const s = STATE_LABEL[r.state] || { label: r.state, cls: 'border-border text-muted-foreground' }
            return (
              // At 480px and under each row stacks (UX sweep bo-mine-row):
              // amount and streamer, then status and expiry, then what
              // happens next. The streamer's name is never cut.
              <li key={r.pledgeId}
                className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 px-4 py-3 [grid-template-areas:'title_title'_'pill_meta'_'next_next'] min-[481px]:grid-cols-[auto_minmax(0,1fr)_auto] min-[481px]:gap-y-0.5 min-[481px]:[grid-template-areas:'pill_title_meta'_'pill_next_meta']">
                <span className={`justify-self-start rounded-full border px-2.5 py-1 text-[10px] font-bold [grid-area:pill] ${s.cls}`}>{s.label}</span>
                <span className="break-words text-sm font-bold text-foreground [grid-area:title]">
                  <span className="text-f-bounty-ink tabular">{r.amount} {UNIT}</span> → {r.targets.map((t) => t.split(':')[1]).join(' / ')}
                  {r.targets.length > 1 && r.winner ? ` (won by ${r.winner.split(':')[1]})` : ''}
                </span>
                <span className="text-xs text-muted-foreground [grid-area:next]">
                  {r.next}
                  {r.refund === 'paid' ? ' Refund sent.' : r.refund === 'pending' ? ' Refund on its way.' : r.refund === 'failed' ? ' The refund transfer failed; a person is on it.' : ''}
                </span>
                <span className="text-[11px] text-muted-foreground [grid-area:meta] min-[481px]:text-right">
                  {r.pledgeStatus === 'OPEN' ? `expires ${shortDate(r.expiresAt)}` : null}
                  {r.from ? <span className="block">from {r.from}</span> : null}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
