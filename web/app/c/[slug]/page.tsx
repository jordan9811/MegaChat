import type { Metadata } from 'next'
import { CampaignsHeader } from '@/components/campaigns/campaigns-shell'
import { SiteFooter, contactUrl } from '@/components/site-footer'
import { CampaignOffer } from '@/components/campaign-offer/campaign-offer'
import type { PublicCampaign } from '@/components/campaign-offer/types'
import { rewardLabel } from '@/components/campaigns/rules'

// /c/<slug> — a targeted reward campaign's public offer: what it pays, for
// which Holler or Call in, who qualifies (read from X, never an action on X),
// and the frozen-list fingerprint. Shared on X, so the metadata matters.
// It wears the shared product header (the bar every product page uses).

export const dynamic = 'force-dynamic'

function backendBase(): string {
  const port = process.env.PORT || '3000'
  return (process.env.BASE_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '')
}

async function loadCampaign(slug: string): Promise<PublicCampaign | null> {
  try {
    const r = await fetch(`${backendBase()}/api/campaigns/${encodeURIComponent(slug)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    })
    if (!r.ok) return null
    const d = (await r.json()) as { campaign?: PublicCampaign }
    return d.campaign ?? null
  } catch {
    return null
  }
}

function actionWords(c: PublicCampaign) {
  return c.action.kind === 'callin' ? 'Call in' : 'Holler'
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const c = await loadCampaign(slug)
  if (!c) return { title: 'Campaign — Holler' }
  // "$5 for a Holler": the symbol only when it is not USDC (rewardLabel).
  const title = `${rewardLabel(c.reward.amount, c.reward.symbol)} for a ${actionWords(c)} on @${c.action.roomHandle}'s stream`
  const description = c.blurb || `${c.title}. Check if you qualify with your X account; paid for the ${actionWords(c)} only.`
  const url = `/c/${encodeURIComponent(c.slug)}`
  return {
    title: `${c.title} — Holler`,
    description,
    alternates: { canonical: url },
    openGraph: { type: 'website', url, siteName: 'Holler', title, description, images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Holler' }] },
    twitter: { card: 'summary_large_image', title, description, images: ['/og.png'] },
  }
}

export default async function CampaignPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const initial = await loadCampaign(slug)
  return (
    <div className="min-h-screen bg-background text-foreground">
      <CampaignsHeader tag="Campaign" current={false} />
      <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
        <CampaignOffer slug={slug} initial={initial} />
      </main>
      <SiteFooter contactHref={contactUrl()} />
    </div>
  )
}
