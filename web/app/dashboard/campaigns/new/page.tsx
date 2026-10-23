import type { Metadata } from 'next'
import { CampaignsShell, PageTitle } from '@/components/campaigns/campaigns-shell'
import { CampaignForm } from '@/components/campaigns/campaign-form'

export const metadata: Metadata = {
  title: 'New campaign — Holler',
  description: 'Set the rules, fund a budget, share one link.',
}

export default function NewCampaignPage() {
  return (
    <CampaignsShell tag="New campaign">
      <PageTitle
        coordinate="Reward campaign · new"
        title="If they qualify, they get paid"
        lead="Pick the reward, the budget and the rules. Save keeps it private; Fund pulls the budget from your wallet, and Open puts the public page up."
        actions={<a href="/dashboard/campaigns" className="mcp-link">All campaigns</a>}
      />
      <CampaignForm />
    </CampaignsShell>
  )
}
