import type { Metadata } from 'next'
import { Plus_Jakarta_Sans } from 'next/font/google'
import { AccountChip } from '@/components/account-chip'
import { JoinClient } from '@/components/join/join-client'
import './join.css'

// One UI face across the app, loaded per route — there is no site-wide
// provider. Same call as the room board and the create page.
const ui = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-ui',
})

export const metadata: Metadata = {
  title: 'Join on camera — MegaChat',
  description: 'Pay by the second to put your camera on a live stream.',
}

export default function JoinPage() {
  return (
    <div className={`${ui.variable} mc-join dark min-h-screen`}>
      {/* the only chrome: one thin bar, same as the room board */}
      <header className="border-b border-[#1a1a1f]">
        <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center justify-between gap-3 px-5 py-3">
          <span className="flex flex-wrap items-baseline gap-3.5">
            <a
              href="/app"
              aria-label="MegaChat home"
              className="bc text-[18px] font-bold tracking-[0.1em] text-[var(--mcj-fg)]"
            >
              MEGACHAT
            </a>
            <span className="text-[13px] font-semibold text-[var(--mcj-dim)]">Join on camera</span>
          </span>
          {/* Identity + balance + sign out, the same control the board uses. */}
          <AccountChip accent="var(--mcj-accent)" />
        </div>
      </header>
      <JoinClient />
    </div>
  )
}
