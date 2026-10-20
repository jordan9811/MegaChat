import { BountyShell } from '@/components/bounty/bounty-shell'
import { StreamerBountyPage } from '@/components/bounty/streamer-page'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Streamer bounty - Holler' }

export default async function StreamerBounty({
  params,
}: {
  params: Promise<{ platform: string; handle: string }>
}) {
  const { platform, handle } = await params
  return (
    <BountyShell title="Bounty">
        <StreamerBountyPage platform={decodeURIComponent(platform)} handle={decodeURIComponent(handle)} />
    </BountyShell>
  )
}
