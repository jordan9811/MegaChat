import { SiteHeader } from '@/components/site-header'
import { SiteFooter, contactUrl } from '@/components/site-footer'
import { MyPledges } from '@/components/bounty/my-pledges'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'My bounties — MegaChat' }

export default async function MinePage({
  searchParams,
}: {
  searchParams: Promise<{ me?: string }>
}) {
  const { me } = await searchParams
  const contactHref = contactUrl()
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <main className="mx-auto max-w-4xl px-6 py-12 md:py-16">
        <MyPledges initialMe={me} />
      </main>
      <SiteFooter contactHref={contactHref} />
    </div>
  )
}
