import { Plus_Jakarta_Sans } from 'next/font/google'
import '../dashboard/campaigns/campaigns.css'

// The public offer page wears the shared product header (the same bar as
// /dashboard/campaigns, /account and /join), whose styles live with the
// campaign dashboard. One UI face, loaded per route like every product page.
const ui = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-ui',
})

export default function CampaignOfferLayout({ children }: { children: React.ReactNode }) {
  return <div className={ui.variable}>{children}</div>
}
