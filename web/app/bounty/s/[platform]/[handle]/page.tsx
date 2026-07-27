import { SiteHeader } from '@/components/site-header'
import { SiteFooter, contactUrl } from '@/components/site-footer'
import { StreamerBountyPage } from '@/components/bounty/streamer-page'

export const dynamic = 'force-dynamic'

export default async function StreamerBounty({
  params,
}: {
  params: Promise<{ platform: string; handle: string }>
}) {
  const { platform, handle } = await params
  const contactHref = contactUrl()
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <main className="mx-auto max-w-4xl px-6 py-12 md:py-16">
        <StreamerBountyPage platform={decodeURIComponent(platform)} handle={decodeURIComponent(handle)} />
      </main>
      <SiteFooter contactHref={contactHref} />
    </div>
  )
}
