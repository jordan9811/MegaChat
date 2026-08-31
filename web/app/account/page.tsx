import type { Metadata } from 'next'
import { Plus_Jakarta_Sans } from 'next/font/google'
import { AccountPage } from '@/components/account/account-page'
import './account.css'

export const metadata: Metadata = {
  title: 'Account — MegaChat',
  description: 'Your handle, linked sign-ins, balance and saved room defaults.',
}

// One UI face across the app. Loaded per route — there is no site-wide
// provider for it.
const ui = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-ui',
})

export default function Page() {
  return (
    <div className={`${ui.variable}`}>
      <AccountPage />
    </div>
  )
}
