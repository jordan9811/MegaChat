import { Landing } from '@/components/landing/landing'
import { LegacyHome } from '@/components/legacy-home'
import { contactUrl } from '@/components/site-footer'
import { loadBountyPools, loadInitialRooms } from '@/lib/rooms-server'

export const dynamic = 'force-dynamic'

export default async function Page() {
  // UI overhaul (feat/ui-overhaul) — set UI_OVERHAUL=0 in the env to restore
  // the previous home page exactly. The old page also stays reachable at
  // /legacy regardless of the flag. This conditional is the whole swap.
  if (process.env.UI_OVERHAUL === '0') {
    const initialRooms = await loadInitialRooms()
    return <LegacyHome initialRooms={initialRooms} contactHref={contactUrl()} />
  }

  const [rooms, pools] = await Promise.all([loadInitialRooms(), loadBountyPools()])
  return <Landing rooms={rooms} pools={pools} contactHref={contactUrl()} />
}
