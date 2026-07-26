import { SiteHeader } from '@/components/site-header'
import { SiteFooter, contactUrl } from '@/components/site-footer'
import { BountyAdmin } from '@/components/bounty/bounty-admin'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Bounty admin — MegaChat' }

export default function BountyAdminPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <main className="mx-auto max-w-5xl px-6 py-12">
        <BountyAdmin />
      </main>
      <SiteFooter contactHref={contactUrl()} />
    </div>
  )
}
