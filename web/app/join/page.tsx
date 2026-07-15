import type { Metadata } from 'next'
import { GlitchBackground } from '@/components/glitch-background'
import { Wordmark } from '@/components/wordmark'
import { ModeToggle } from '@/components/mode-toggle'
import { JoinClient } from '@/components/join/join-client'
import { TempoWalletProvider } from '@/components/providers/tempo-wallet'
import './join.css'

export const metadata: Metadata = {
  title: 'Join on camera — MegaChat',
  description: 'Pay by the second to put your camera on a live stream.',
}

export default function JoinPage() {
  return (
    <div className="dark relative min-h-screen bg-noir text-foreground">
      <GlitchBackground />
      <div className="relative z-10">
        <header className="mx-auto flex w-full max-w-xl items-center justify-between px-6 py-4">
          <a href="/" aria-label="MegaChat home" className="transition-opacity hover:opacity-90">
            <Wordmark size="sm" />
          </a>
          {/* Simple/Advanced matters most right here — the paying surface. */}
          <ModeToggle />
        </header>
        <TempoWalletProvider>
          <JoinClient />
        </TempoWalletProvider>
      </div>
    </div>
  )
}
