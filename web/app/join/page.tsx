import type { Metadata } from 'next'
import { GlitchBackground } from '@/components/glitch-background'
import { Wordmark } from '@/components/wordmark'
import { ModeToggle } from '@/components/mode-toggle'
import { HeaderAuth } from '@/components/header-auth'
import { JoinClient } from '@/components/join/join-client'
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
        {/* Tight paddings/gaps on purpose: wordmark + mode pill + login must
            all fit a 375px viewport without wrapping. */}
        <header className="mx-auto flex w-full max-w-xl items-center justify-between gap-2 px-3 py-4 sm:px-6">
          <a href="/" aria-label="MegaChat home" className="shrink-0 transition-opacity hover:opacity-90">
            <Wordmark size="sm" />
          </a>
          <div className="flex items-center gap-1.5">
            {/* Simple/Advanced matters most right here — the paying surface. */}
            <ModeToggle />
            {/* Identity + balance, top right, same as every other page. */}
            <HeaderAuth />
          </div>
        </header>
        <JoinClient />
      </div>
    </div>
  )
}
