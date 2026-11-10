import type { Metadata } from 'next'
import { AccountPage } from '@/components/account/account-page'
import { SiteTour } from '@/components/site-tour'
import './account.css'

export const metadata: Metadata = {
  title: 'Account — Holler',
  description: 'Your handle, linked sign-ins, balance and saved room defaults.',
}

export default function Page() {
  return (
    <div>
      <AccountPage />
      <SiteTour chapter="account" />
    </div>
  )
}
