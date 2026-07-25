'use client'

// belowFold grid — the SHIPPED browse directory reused wholesale (header,
// search with unlisted direct-id lookup, live polling, skeletons, cards).
// Wrapped, never forked: `embedded` only drops the duplicate #browse anchor
// (the deck root owns it). Its own header stands in as the section header —
// stacking a second "Top live" heading above it would be exactly the
// redundancy DESIGN.md bans.

import { BrowseDirectory } from '@/components/browse-directory'
import type { DeckModuleProps } from '../data'

export function RoomGrid({ ctx }: DeckModuleProps) {
  return <BrowseDirectory initialRooms={ctx.initialRooms} embedded />
}
