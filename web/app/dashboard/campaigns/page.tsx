import type { Metadata } from 'next'
import { CampaignsShell } from '@/components/campaigns/campaigns-shell'
import { CampaignList } from '@/components/campaigns/campaign-list'

export const metadata: Metadata = {
  title: 'Campaigns — Holler',
  description: 'Pay people who meet your rules to send a Holler or call in on your stream.',
}

export default function CampaignsPage() {
  return (
    <CampaignsShell>
      <CampaignList />
    </CampaignsShell>
  )
}
