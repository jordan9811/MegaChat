import type { Metadata } from 'next'
import { GlitchBackground } from '@/components/glitch-background'
import { Wordmark } from '@/components/wordmark'
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
        <header className="mx-auto flex w-full max-w-xl items-center justify-between px-6 py-4">
          <Wordmark size="sm" />
        </header>
        <JoinClient />
      </div>
    </div>
  )
}
