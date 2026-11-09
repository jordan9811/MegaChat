import type { Metadata } from 'next'
import { CampaignsShell, PageTitle } from '@/components/campaigns/campaigns-shell'
import { CampaignForm } from '@/components/campaigns/campaign-form'

export const metadata: Metadata = {
  title: 'New campaign — Holler',
  description: 'Set the rules, fund a budget, share one link.',
}

export default function NewCampaignPage() {
  return (
    <CampaignsShell tag="New campaign" open>
      <PageTitle
        coordinate="Reward campaign · new"
        title="If they qualify, they get paid"
        lead={
          <span className="mcp-steps" aria-label="Save, then fund, then open">
            <span data-step="current"><b>Save</b> private</span>
            <i aria-hidden="true">→</i>
            <span><b>Fund</b> from wallet</span>
            <i aria-hidden="true">→</i>
            <span><b>Open</b> public</span>
          </span>
        }
        actions={<a href="/dashboard/campaigns" className="mcp-link">All campaigns</a>}
      />
      <CampaignForm />
    </CampaignsShell>
  )
}
