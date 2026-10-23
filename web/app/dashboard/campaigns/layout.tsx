import { Plus_Jakarta_Sans } from 'next/font/google'
import './campaigns.css'

// One UI face across the app, loaded per route like /account and
// /how-it-works — there is no site-wide provider for it.
const ui = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-ui',
})

export default function CampaignsLayout({ children }: { children: React.ReactNode }) {
  return <div className={ui.variable}>{children}</div>
}
