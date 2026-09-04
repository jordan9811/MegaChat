import { ProductShell } from '@/components/product-shell'
import { MyPledges } from '@/components/bounty/my-pledges'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'My bounties — MegaChat' }

export default async function MinePage({
  searchParams,
}: {
  searchParams: Promise<{ me?: string }>
}) {
  const { me } = await searchParams
  return (
    <ProductShell title="My bounties">
        <MyPledges initialMe={me} />
    </ProductShell>
  )
}
