'use client'

// CONTRIBUTOR STATUS PAGE — one row per contribution, its current state, and
// what happens next. The ladder is the enumerated server one; nothing here is
// invented client-side, and `paid` is shown for what it is: a rung nothing
// reaches until real settlement lands.

import { useCallback, useEffect, useState } from 'react'
import { getMyContributions, type MyContribution } from '@/lib/bounty-api'
import { formatDollars } from '@/lib/display-format'

const STATE_LABEL: Record<string, { label: string; cls: string }> = {
  pending_upload: { label: 'Waiting for upload', cls: 'border-[var(--neon-amber)]/60 text-[var(--neon-amber)]' },
  pending_moderation: { label: 'In review', cls: 'border-[var(--neon-cyan)]/60 text-[var(--neon-cyan)]' },
  awaiting_claim: { label: 'Awaiting claim', cls: 'border-[var(--neon-violet)]/60 text-[var(--neon-violet)]' },
  claimed_pending_review: { label: 'Streamer reviewing', cls: 'border-[var(--neon-cyan)]/60 text-[var(--neon-cyan)]' },
  approved: { label: 'Approved', cls: 'border-[var(--neon-lime)]/60 text-[var(--neon-lime)]' },
  played: { label: 'Played on stream 🎉', cls: 'border-[var(--neon-lime)]/60 text-[var(--neon-lime)]' },
  paid: { label: 'Paid', cls: 'border-[var(--neon-lime)]/60 text-[var(--neon-lime)]' },
  expired_refunded: { label: 'Expired — refunded', cls: 'border-border text-muted-foreground' },
  declined_refunded: { label: 'Declined — refunded in full', cls: 'border-border text-muted-foreground' },
  rejected_policy: { label: 'Rejected (policy)', cls: 'border-[var(--neon-magenta)]/60 text-[var(--neon-magenta)]' },
  refunded: { label: 'Refunded', cls: 'border-border text-muted-foreground' },
}

export function MyPledges({ initialMe }: { initialMe?: string }) {
  const [me, setMe] = useState(initialMe || '')
  const [rows, setRows] = useState<MyContribution[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (who: string) => {
    if (!who.trim()) return
    try {
      setError(null)
      setRows((await getMyContributions(who.trim())).contributions)
      try { localStorage.setItem('mc-bounty-contributor', who.trim()) } catch { /* private mode */ }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lookup failed')
    }
  }, [])

  useEffect(() => {
    let who = initialMe
    if (!who) {
      try { who = localStorage.getItem('mc-bounty-contributor') || '' } catch { /* private mode */ }
    }
    if (who) { setMe(who); void load(who) }
  }, [initialMe, load])

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground">My bounties</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every MegaChat you&apos;ve pledged, where it is, and what happens next.
        </p>
      </div>

      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void load(me) }}>
        <input aria-label="Contribution account" value={me} onChange={(e) => setMe(e.target.value)}
          placeholder="0x… or the account you pledged with"
          className="w-full max-w-md rounded-xl border border-border bg-input/30 px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground" />
        <button type="submit" className="rounded-full border border-border px-4 py-2 text-sm font-bold text-foreground">
          Look up
        </button>
      </form>
      {error ? <p className="text-sm text-[var(--neon-magenta)]">{error}</p> : null}

      {rows && rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing yet under that account. <a href="/bounty" className="text-[var(--neon-cyan)] underline-offset-2 hover:underline">Find a streamer to back →</a>
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
                    {formatDollars(r.amount)} → {r.targets.map((t) => t.split(':')[1]).join(' / ')}
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
