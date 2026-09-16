import type { Metadata } from 'next'
import { Plus_Jakarta_Sans } from 'next/font/google'
import { BountyProgram } from '@/components/bounty/bounty-program'
import './bounty.css'

export const dynamic = 'force-dynamic'

// One UI face across the app, loaded per route — there is no site-wide
// provider, so every app surface asks for it itself.
const ui = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-ui',
})

export const metadata: Metadata = {
  title: 'Bounties — MegaChat',
  description:
    'Your favorite streamer doesn’t even know you. Create a bounty they can claim by going live.',
}

export default function BountyPage() {
  return (
    <div className={ui.variable}>
      <BountyProgram />
    </div>
  )
}
