'use client'

// Admin: air sessions with verification results, confidence, badge violations,
// and manual override. The override REASON is required and is written to the
// append-only ledger — an unexplained state change is exactly what an escrow
// audit trail exists to prevent.

import { useCallback, useEffect, useState } from 'react'
import { CircleAlert, ShieldAlert } from 'lucide-react'
import {
  listAdminSessions, adminOverride, getBountyConfig,
  type AirSession, type BountyClaim, type BountyClientConfig,
} from '@/lib/bounty-api'

type Row = AirSession & {
  verifications: { result?: string; confidence?: number; verifiedMinutes?: number; checkedAt?: number }[]
  claim: BountyClaim | null
}

const RESULT_TONE: Record<string, string> = {
  PASS: 'text-[var(--neon-lime)]',
  PARTIAL: 'text-[var(--neon-amber)]',
  AMBIGUOUS: 'text-[var(--neon-amber)]',
  FAIL: 'text-[var(--neon-magenta)]',
  NO_FRAMES: 'text-muted-foreground',
  NO_CODES: 'text-muted-foreground',
}

export function BountyAdmin() {
  const [config, setConfig] = useState<BountyClientConfig | null | 'loading'>('loading')
  const [rows, setRows] = useState<Row[]>([])
  const [intents, setIntents] = useState<{ kind: string; amount: string; bucket: string }[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    listAdminSessions()
      .then((d) => { setRows(d.sessions as Row[]); setIntents(d.settlementIntents) })
      .catch((e) => setErr(e instanceof Error ? e.message : 'Load failed'))
  }, [])

  useEffect(() => { void getBountyConfig().then(setConfig) }, [])
  useEffect(() => {
    if (!config || config === 'loading' || !config.enabled) return
    load()
    const t = setInterval(load, 8000)
    return () => clearInterval(t)
  }, [config, load])

  if (config === 'loading') return <div className="h-40 animate-pulse rounded-2xl bg-card/40" />
  if (!config || !config.enabled) {
    return <p className="text-sm text-muted-foreground">Creator bounty is not enabled.</p>
  }

  async function override(row: Row) {
    const key = row.claim?.handleKey || ''
    const [platform, handle] = key.split(':')
    const to = window.prompt('Override to which state? (e.g. DISPUTED, VOID, AWAITING_AIRTIME)')
    if (!to) return
    const reason = window.prompt('Reason (required — written to the ledger):')
    if (!reason || !reason.trim()) { setErr('An override without a reason is not allowed.'); return }
    setBusy(row.id); setErr(null)
    try {
      await adminOverride(platform, handle, to.trim().toUpperCase(), reason.trim())
      load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Override failed')
    } finally { setBusy(null) }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground">Bounty admin</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Air sessions, verification results, and badge violations.
        </p>
      </div>

      <div className="rounded-xl border border-[var(--neon-amber)]/50 bg-[var(--neon-amber)]/5 px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-bold text-[var(--neon-amber)]">
          <ShieldAlert className="size-4" /> Settlement is stubbed
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {intents.length} payout intent{intents.length === 1 ? '' : 's'} recorded. Nothing has
          been transferred — these are ledger entries describing what a real settlement would do.
        </p>
      </div>

      {err ? <p className="text-sm text-[var(--neon-magenta)]">{err}</p> : null}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No air sessions yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border/70">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-border/70 bg-card/60 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Handle</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Codes</th>
                <th className="px-4 py-3">Result</th>
                <th className="px-4 py-3">Confidence</th>
                <th className="px-4 py-3">Verified</th>
                <th className="px-4 py-3">Flags</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const last = r.verifications[r.verifications.length - 1]
                const violations = r.violations?.length || 0
                return (
                  <tr key={r.id} className="border-b border-border/40 last:border-b-0">
                    <td className="px-4 py-3 font-mono text-xs text-foreground">
                      {r.claim?.handleKey || '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{r.status}</td>
                    <td className="px-4 py-3 tabular text-xs">{r.codes?.length ?? 0}</td>
                    <td className={`px-4 py-3 text-xs font-bold ${RESULT_TONE[last?.result || ''] || 'text-muted-foreground'}`}>
                      {last?.result || '—'}
                    </td>
                    <td className="px-4 py-3 tabular text-xs">
                      {last?.confidence != null ? last.confidence.toFixed(2) : '—'}
                      {last?.result === 'AMBIGUOUS' ? (
                        <span className="ml-1 text-[10px] text-[var(--neon-amber)]">review</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 tabular text-xs">{(r.verifiedMinutes || 0).toFixed(2)}m</td>
                    <td className="px-4 py-3 text-xs">
                      {violations > 0 ? (
                        <span className="inline-flex items-center gap-1 text-[var(--neon-magenta)]">
                          <CircleAlert className="size-3.5" /> badge ×{violations}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        disabled={busy === r.id}
                        onClick={() => void override(r)}
                        className="rounded-full border border-border px-3 py-1 text-xs font-bold text-foreground transition-colors hover:border-[var(--neon-magenta)]/60 disabled:opacity-50"
                      >
                        {busy === r.id ? '…' : 'Override'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
