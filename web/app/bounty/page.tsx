import { SiteHeader } from '@/components/site-header'
import { SiteFooter, contactUrl } from '@/components/site-footer'
import { BountyClient } from '@/components/bounty/bounty-client'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Creator bounties — MegaChat',
  description: 'Recorded MegaChats waiting for streamers who have not claimed their handle yet.',
}

export default function BountyPage() {
  const contactHref = contactUrl()
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <main className="mx-auto max-w-4xl px-6 py-12 md:py-16">
        <BountyClient />
      </main>
      <SiteFooter contactHref={contactHref} />
    </div>
  )
}
