import type { Metadata } from 'next'
import { BountyProgram } from '@/components/bounty/bounty-program'
import './bounty.css'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Bounties — Holler',
  description:
    'Your favorite streamer doesn’t even know you. Create a bounty they can claim by going live.',
}

export default function BountyPage() {
  return (
    <div>
      <BountyProgram />
    </div>
  )
}
