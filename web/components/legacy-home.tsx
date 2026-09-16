import { SiteHeader } from '@/components/site-header'
import { GlitchBackground } from '@/components/glitch-background'
import { Hero } from '@/components/hero'
import { BrowseDirectory } from '@/components/browse-directory'
import { BrowseDeck } from '@/components/browse-deck/browse-deck'
import { SiteFooter } from '@/components/site-footer'
import type { PublicRoomCard } from '@/lib/api'

// The pre-overhaul home page, extracted verbatim from app/page.tsx when the
// landing/app split shipped. It renders at /legacy permanently (for
// comparison) and at / when UI_OVERHAUL=0.
export function LegacyHome({
  initialRooms,
  contactHref,
}: {
  initialRooms: PublicRoomCard[]
  contactHref: string
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />

      {/* Hero with loud brand energy — follows the theme toggle (the old
          `dark` lock kept the body noir while the header went light). */}
      <div className="relative bg-background text-foreground">
        <GlitchBackground />
        <Hero contactHref={contactHref} />
      </div>

      {/* Browse deck (feat/browse-deck) — set BROWSE_DECK=0 in the env to
          restore the classic directory exactly. This line is the whole swap. */}
      <main>
        {process.env.BROWSE_DECK === '0' ? (
          <BrowseDirectory initialRooms={initialRooms} />
        ) : (
          <BrowseDeck initialRooms={initialRooms} />
        )}
      </main>

      <SiteFooter contactHref={contactHref} />
    </div>
  )
}
