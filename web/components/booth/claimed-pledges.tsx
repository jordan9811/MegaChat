'use client'

// CLAIMED PLEDGES — broadcasts on which a streamer played the clips fans
// pledged to them (/api/rooms/claimed). A section like Recently aired and
// Rooms, under the rooms: its heading, then its cards. Empty, it is the
// heading alone, with no row held open for cards that are not there (owner,
// 2026-11-10).
//
// A card is a Recently aired card (recent-rail.tsx) whose link adds
// &only=bounty: the room page's replay then opens at the first pledged clip,
// with a button for each of the others, in the order they aired.

import type { ClaimedAiring } from '@/lib/api'
import { RecentCard } from './recent-rail'

export function ClaimedPledges({ airings }: { airings: ClaimedAiring[] }) {
  return (
    <section className="mcr-claimed" aria-label="Claimed pledges">
      <h2 className="mcr-sec-h">Claimed pledges</h2>
      {airings.length ? (
        <div className="mcr-recent-grid">
          {airings.map((a) => (
            <RecentCard key={a.airingId} a={a} claimed={a} />
          ))}
        </div>
      ) : null}
    </section>
  )
}
