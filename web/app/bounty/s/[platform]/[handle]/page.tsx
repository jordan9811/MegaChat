import { ProductShell } from '@/components/product-shell'
import { StreamerBountyPage } from '@/components/bounty/streamer-page'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Streamer bounty - MegaChat' }

export default async function StreamerBounty({
  params,
}: {
  params: Promise<{ platform: string; handle: string }>
}) {
  const { platform, handle } = await params
  return (
    <ProductShell title="Bounty">
        <StreamerBountyPage platform={decodeURIComponent(platform)} handle={decodeURIComponent(handle)} />
    </ProductShell>
  )
}
