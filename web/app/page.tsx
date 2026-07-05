import { SiteHeader } from '@/components/site-header'
import { GlitchBackground } from '@/components/glitch-background'
import { Hero } from '@/components/hero'
import { BrowseDirectory } from '@/components/browse-directory'
import { SiteFooter, contactUrl } from '@/components/site-footer'
import type { PublicRoomCard } from '@/lib/api'

export const dynamic = 'force-dynamic'

async function loadInitialRooms(): Promise<PublicRoomCard[]> {
  const port = process.env.PORT || '3000'
  const base = process.env.BASE_URL || `http://127.0.0.1:${port}`
  try {
    const res = await fetch(`${base}/api/rooms/public`, { cache: 'no-store' })
    if (!res.ok) return []
    const data = (await res.json()) as { rooms?: PublicRoomCard[] }
    return data.rooms ?? []
  } catch {
    return []
  }
}

export default async function Page() {
  const initialRooms = await loadInitialRooms()
  const contactHref = contactUrl()

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />

      {/* Hero with loud brand energy — follows the theme toggle (the old
          `dark` lock kept the body noir while the header went light). */}
      <div className="relative bg-background text-foreground">
        <GlitchBackground />
        <Hero contactHref={contactHref} />
      </div>

      {/* Public browse directory — active rooms, hottest first */}
      <main>
        <BrowseDirectory initialRooms={initialRooms} />
      </main>

      <SiteFooter contactHref={contactHref} />
    </div>
  )
}
