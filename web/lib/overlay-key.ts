// The overlay key (OPEN-ISSUES N14). The server puts it on the overlayUrl it
// hands the room's manager (`&k=`); the dashboard shows prettier links built
// from window.location, so the key is copied across onto whichever link is
// shown. Without it the overlay still renders, it just cannot make a campaign
// Holler count as aired.
export function withOverlayKey(link: string, serverOverlayUrl: string | null | undefined): string {
  if (!serverOverlayUrl) return link
  try {
    const k = new URL(serverOverlayUrl).searchParams.get('k')
    if (!k) return link
    const u = new URL(link)
    u.searchParams.set('k', k)
    return u.toString()
  } catch {
    return link
  }
}
