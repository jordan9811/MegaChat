import { BountyShell } from '@/components/bounty/bounty-shell'
import { MyPledges } from '@/components/bounty/my-pledges'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'My bounties — Holler' }

export default async function MinePage({
  searchParams,
}: {
  searchParams: Promise<{ me?: string }>
}) {
  const { me } = await searchParams
  return (
    <BountyShell title="My bounties">
        <MyPledges initialMe={me} />
    </BountyShell>
  )
}
