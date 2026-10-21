'use client'

// CONTRIBUTOR STATUS PAGE — one row per contribution, its current state, and
// what happens next. The ladder is the enumerated server one; nothing here is
// invented client-side, and `paid` is shown for what it is: a rung nothing
// reaches until real settlement lands.

import { useCallback, useEffect, useState } from 'react'
import { getMyContributions, type MyContribution } from '@/lib/bounty-api'

// Holler colour roles: money waiting on someone is bounty yellow, a review in
// progress is strap azure, approved / played / paid is the positive
// green, a policy rejection (and a failed load) is the danger orange, and a
// refund is neutral.
const WAITING = 'border-f-bounty-line bg-f-bounty-bg text-f-bounty-ink'
const REVIEWING = 'border-hl-strap-hi/50 bg-hl-strap/10 text-foreground'
const GOOD = 'border-f-rewards-line bg-f-rewards-bg text-f-rewards-ink'

const STATE_LABEL: Record<string, { label: string; cls: string }> = {
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

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground">My bounties</h1>
        <p className="mt-1 text-[15px] text-hl-muted">
          Every Holler you&apos;ve pledged, where it is, and what happens next.
        </p>
      </div>

      {needsAuth ? (
        <p className="text-sm text-muted-foreground">
          Sign in (top right) to see your Hollers — they&apos;re attached to your account, not to a name you type.
        </p>
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
              <li key={r.pledgeId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-bold ${s.cls}`}>{s.label}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold text-foreground">
                    <span className="text-f-bounty-ink">{r.amount}</span> → {r.targets.map((t) => t.split(':')[1]).join(' / ')}
                    {r.targets.length > 1 && r.winner ? ` (won by ${r.winner.split(':')[1]})` : ''}
                  </span>
                  <span className="block text-xs text-muted-foreground">{r.next}</span>
                </span>
                {r.pledgeStatus === 'OPEN' ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    expires {new Date(r.expiresAt).toLocaleDateString()}
                  </span>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
