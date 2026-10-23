import type { Metadata } from 'next'
import { CampaignsShell } from '@/components/campaigns/campaigns-shell'
import { CampaignEdit } from '@/components/campaigns/campaign-edit'

export const metadata: Metadata = {
  title: 'Edit campaign — Holler',
}

export default async function EditCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <CampaignsShell tag="Edit campaign">
      <CampaignEdit id={id} />
    </CampaignsShell>
  )
}
