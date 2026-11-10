'use client'

// /account → Rewards (rw-no-trail): what this account has earned watching,
// room by room. Before this, earnings existed only as a counter inside one
// room's page, and only while a wallet was registered there; a Cash transfer
// left no receipt anywhere a viewer could open.
//
// Read-only, from GET /api/account/rewards (rewards.js summaryFor): earned to
// date from the rewards ledger (it survives a restart), the seat credit still
// spendable (held in memory on the server), the room's cap as it stands now,
// and each Cash transfer with its status at the settlement door and, once it
// is sent, a link to the transaction.

import { useEffect, useState } from 'react'
import { backendHttpUrl } from '@/lib/backend'
import { explorerTxUrl, getChainInfo } from '@/lib/campaigns-api'
import { rewardLabel } from '@/components/campaigns/rules'

type Transfer = { ref: string; at: number | null; amount: string; to: string | null; status: string | null; txHash: string | null }
type RoomRewards = {
  roomId: string
  name: string | null
  handle: string | null
  symbol: string
  earned: string
  cash: string
  credit: string
  spendableCredit: string
  cap: string | null
  capReached: boolean
  transfers: Transfer[]
}
type RewardsAnswer = { rooms: RoomRewards[]; available: boolean }

/** The settlement door's word for a transfer, in a viewer's. */
function transferWord(status: string | null) {
  switch (String(status || '').toUpperCase()) {
    case 'DONE': return 'Sent'
    case 'SENT': return 'Sending'
    case 'PENDING': return 'Queued'
    case 'FAILED': return 'Failed'
    case 'VOIDED': return 'Cancelled'
    default: return 'Recorded'
  }
}

function when(ms: number | null) {
  if (!ms) return ''
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function AccountRewards() {
  const [data, setData] = useState<RewardsAnswer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [explorerUrl, setExplorerUrl] = useState('https://explore.tempo.xyz')

  const load = () => {
    setError(null)
    fetch(`${backendHttpUrl()}/api/account/rewards`, { credentials: 'same-origin' })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error((d as { error?: string }).error || `Request failed (${r.status})`)
        setData(d as RewardsAnswer)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load'))
  }

  useEffect(() => {
    load()
    getChainInfo().then((c) => setExplorerUrl(c.explorerUrl)).catch(() => {})
  }, [])

  return (
    <section className="mcc-settings-zone mcc-rewards" id="rewards">
      <header>
        <div><h2>What you have earned watching.</h2><p>Every room that has paid you, with what is still yours to spend and every transfer that went out.</p></div>
      </header>
      {error ? (
        <p className="hint" role="alert">Couldn’t load your rewards. <button type="button" className="mcc-inline-link" onClick={load}>Retry</button></p>
      ) : !data ? (
        <p className="hint">Loading…</p>
      ) : data.rooms.length === 0 ? (
        <p className="hint">{data.available ? 'Nothing earned yet. When a room pays you for watching, it shows here.' : 'Rewards are not running on this server, so there is nothing to show.'}</p>
      ) : (
        <ul className="mcc-rewards-list">
          {data.rooms.map((r) => {
            const sym = r.symbol || 'USDC'
            const credit = Number(r.credit) > 0
            return (
              <li key={r.roomId}>
                <div className="mcc-rewards-head">
                  <strong>{r.name || r.handle || r.roomId}</strong>
                  {r.handle ? <a href={`/${r.handle}`}>@{r.handle}</a> : null}
                </div>
                <dl className="mcc-rewards-figures">
                  <div><dt>Earned to date</dt><dd>{rewardLabel(r.earned, sym)}</dd></div>
                  {credit ? <div><dt>Credit to spend</dt><dd>{rewardLabel(r.spendableCredit, sym)}</dd></div> : null}
                  <div><dt>Cap</dt><dd>{r.cap == null ? 'None set now' : r.capReached ? `Reached (${rewardLabel(r.cap, sym)})` : `${rewardLabel(r.earned, sym)} of ${rewardLabel(r.cap, sym)}`}</dd></div>
                </dl>
                {credit ? <p className="hint">Credit pays for seats in this room only, and is not yet kept across a Holler restart; what you earned still counts toward the cap.</p> : null}
                {r.transfers.length > 0 ? (
                  <ul className="mcc-rewards-transfers" aria-label={`Cash transfers from ${r.name || r.handle || 'this room'}`}>
                    {r.transfers.map((t) => (
                      <li key={t.ref}>
                        <span>{rewardLabel(t.amount, sym)}</span>
                        <span data-status={String(t.status || '').toLowerCase()}>{transferWord(t.status)}</span>
                        <small>{when(t.at)}</small>
                        {t.txHash ? <a href={explorerTxUrl(explorerUrl, t.txHash)} target="_blank" rel="noopener">Receipt</a> : <small>{t.status === 'PENDING' ? 'receipt once sent' : ''}</small>}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
