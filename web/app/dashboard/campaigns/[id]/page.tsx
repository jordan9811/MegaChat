import type { Metadata } from 'next'
import { CampaignsShell } from '@/components/campaigns/campaigns-shell'
import { CampaignDetail } from '@/components/campaigns/campaign-detail'

export const metadata: Metadata = {
  title: 'Campaign — Holler',
}

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <CampaignsShell tag="Campaign">
      <CampaignDetail id={id} />
    </CampaignsShell>
  )
}
