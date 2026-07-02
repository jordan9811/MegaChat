import { SiteHeader } from '@/components/site-header'
import { GlitchBackground } from '@/components/glitch-background'
import { Hero } from '@/components/hero'
import { BrowseDirectory } from '@/components/browse-directory'

export default function Page() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />

      {/* Hero with loud brand energy — always dark backdrop */}
      <div className="dark relative bg-background text-foreground">
        <GlitchBackground />
        <Hero />
      </div>

      {/* Public browse directory — active rooms, hottest first */}
      <main>
        <BrowseDirectory />
      </main>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-2 px-6 py-6 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:flex-row sm:items-center">
          <span>MegaChat — Skip the chat. Be the stream.</span>
          <span>Level up your stream. Own your audience.</span>
        </div>
      </footer>
    </div>
  )
}
