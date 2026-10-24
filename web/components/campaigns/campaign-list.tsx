'use client'

// /dashboard/campaigns — every campaign the signed-in creator owns, with the
// numbers that matter at a glance: status, reward, budget used/left, claims,
// deadline. Money is bounty yellow; the one action is azure.

import { useEffect, useState } from 'react'
import { listMyCampaigns, type Campaign, CampaignsApiError } from '@/lib/campaigns-api'
import { FeatureTag } from '@/components/feature-tag'
import { PageTitle, Pip } from './campaigns-shell'
import { budgetFigures, budgetRowText, fmtDate, offerSentence, placesTaken, rewardLabel } from './rules'

const STATUS_LABEL: Record<Campaign['status'], string> = { draft: 'Draft', funding_pending: 'Confirming', funded: 'Funded', live: 'Live', closed: 'Closed' }

export function CampaignList() {
  const [rows, setRows] = useState<Campaign[] | null>(null)
  const [error, setError] = useState<{ status: number; message: string } | null>(null)

  useEffect(() => {
    listMyCampaigns()
      .then((d) => setRows(d.campaigns))
      .catch((e) => setError({ status: e instanceof CampaignsApiError ? e.status : 0, message: e instanceof Error ? e.message : 'Could not load' }))
  }, [])

  return (
    <>
      <PageTitle
        coordinate="Reward campaigns"
        title="Pay people to show up"
        lead="Set the rules, fund a budget, share one link. Whoever qualifies and does the action on your stream gets paid on their own."
        actions={<a href="/dashboard/campaigns/new" className="mcp-btn">New campaign</a>}
      />

      {error ? (
        <section className="mcp-card mcp-empty" role="alert">
          <span className="mcp-coordinate">{error.status === 404 ? 'Not on this server yet' : 'Could not load'}</span>
          <h2>{error.status === 404 ? 'Campaigns are not switched on here' : 'Your campaigns did not load'}</h2>
          <p>{error.status === 404 ? 'The campaign API is not mounted on this server, so there is nothing to list. The form still opens; saving needs the API.' : error.message}</p>
        </section>
      ) : rows == null ? (
        <p className="mcp-hint">Loading…</p>
      ) : rows.length === 0 ? (
        <section className="mcp-card mcp-empty">
          <span className="mcp-coordinate">Nothing yet</span>
          <h2>Your first campaign is one form away</h2>
          <p>Pick a reward, a budget and the rules. Nothing moves until you fund it.</p>
          <a href="/dashboard/campaigns/new" className="mcp-btn">New campaign</a>
        </section>
      ) : (
        <div className="mcp-table" role="table" aria-label="Your campaigns">
          <div className="mcp-tr mcp-th" role="row">
            <span role="columnheader">Campaign</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Reward</span>
            <span role="columnheader">Budget</span>
            <span role="columnheader">Places</span>
            <span role="columnheader">Deadline</span>
          </div>
          {rows.map((c) => {
            const b = budgetFigures(c)
            const sym = c.token?.symbol || 'USDC'
            return (
              <a key={c.id} href={`/dashboard/campaigns/${encodeURIComponent(c.id)}`} className="mcp-tr" role="row">
                <span role="cell" className="mcp-td-title">
                  <FeatureTag kind={c.action.kind} />
                  <strong>{c.title}</strong>
                  <small>{c.blurb || offerSentence(c)}</small>
                </span>
                <span role="cell"><Pip tone={c.status === 'funding_pending' ? 'draft' : c.status}>{STATUS_LABEL[c.status] || String(c.status)}</Pip></span>
                <span role="cell" className="mcp-money">{rewardLabel(c.reward.amount, sym)}</span>
                <span role="cell" className="mcp-td-budget">
                  <span className="mcp-bar" aria-hidden="true"><i style={{ width: `${b.usedPct}%` }} /></span>
                  {/* "owed", not "paid": released counts every payout intent,
                      queued ones included; "left" is the server's remaining. */}
                  <small>{budgetRowText(c)}</small>
                </span>
                <span role="cell" className="mcp-td-claims"><strong>{placesTaken(c)} of {c.maxClaims}</strong><small>{c.claims?.paid ?? 0} paid</small></span>
                <span role="cell" className="mcp-td-date">{fmtDate(c.deadline)}</span>
              </a>
            )
          })}
        </div>
      )}
    </>
  )
}
