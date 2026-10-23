'use client'

// Loads the campaign, then hands it to the same form that creates one. Only
// a draft is editable: a live campaign's terms are what people claimed
// against, so its page offers Close, not Edit.

import { useEffect, useState } from 'react'
import { getCampaign, type Campaign, CampaignsApiError } from '@/lib/campaigns-api'
import { CampaignForm } from './campaign-form'
import { PageTitle } from './campaigns-shell'

export function CampaignEdit({ id }: { id: string }) {
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [error, setError] = useState<{ status: number; message: string } | null>(null)

  useEffect(() => {
    getCampaign(id)
      .then((d) => setCampaign(d.campaign))
      .catch((e) => setError({ status: e instanceof CampaignsApiError ? e.status : 0, message: e instanceof Error ? e.message : 'Could not load' }))
  }, [id])

  if (error) {
    return (
      <>
        <PageTitle coordinate="Campaign" title="Not here" actions={<a href="/dashboard/campaigns" className="mcp-btn-ghost">All campaigns</a>} />
        <section className="mcp-card mcp-empty" role="alert">
          <span className="mcp-coordinate">{error.status === 404 ? 'Not found' : 'Could not load'}</span>
          <h2>{error.status === 404 ? 'No campaign at this address' : 'This campaign did not load'}</h2>
          <p>{error.status === 404 ? 'Either it was never saved, or the campaign API is not mounted on this server.' : error.message}</p>
        </section>
      </>
    )
  }
  if (!campaign) return <p className="mcp-hint">Loading…</p>
  if (campaign.status !== 'draft') {
    return (
      <>
        <PageTitle coordinate={`Campaign · ${campaign.status}`} title={campaign.title} actions={<a href={`/dashboard/campaigns/${encodeURIComponent(campaign.id)}`} className="mcp-btn-ghost">Back to the campaign</a>} />
        <section className="mcp-card mcp-empty">
          <span className="mcp-coordinate">Locked</span>
          <h2>A {campaign.status} campaign cannot be edited</h2>
          <p>Its terms are what people claimed against. Close it and start a new one to change the offer.</p>
        </section>
      </>
    )
  }
  return (
    <>
      <PageTitle
        coordinate="Reward campaign · draft"
        title={campaign.title}
        lead="Change anything before going live."
        actions={<a href={`/dashboard/campaigns/${encodeURIComponent(campaign.id)}`} className="mcp-link">Back</a>}
      />
      <CampaignForm campaign={campaign} />
    </>
  )
}
