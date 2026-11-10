'use client'

// CLAIMED PLEDGES — broadcasts on which a streamer played the clips fans
// pledged to them (/api/rooms/claimed). The owner, 2026-11-09: "have it empty
// almost like a collapsed dropdown ... like in case a streamer had 5 and they
// did it one by one across an hour long vod."
//
// CLOSED BY DEFAULT, and closed it costs the board no height where height is
// short: the board holds the first room above the fold (_gate-board-fold F4),
// and on a busy quiet night there were 4px to spare under Recently aired. So
// when Recently aired is stacked above the rooms, the closed control rides on
// the end of ITS heading line (`docked`), and the cards, once opened, drop in
// between Recently aired and the rooms. Anywhere else it is its own heading
// row. Opened and empty, it says nothing exists yet; closed, the count is all.
//
// A card is a Recently aired card (recent-rail.tsx) whose link adds
// &only=bounty: the room page's replay then opens at the first pledged clip,
// with a button for each of the others, in the order they aired.

import type { ClaimedAiring } from '@/lib/api'
import { RecentCard } from './recent-rail'

export const CLAIMED_BODY_ID = 'mcr-claimed-body'

export function ClaimedToggle({ n, open, onToggle, docked }: { n: number; open: boolean; onToggle: () => void; docked?: boolean }) {
  return (
    <button
      type="button"
      className={`mcr-claimed-toggle${docked ? ' is-docked' : ''}`}
      aria-expanded={open}
      aria-controls={CLAIMED_BODY_ID}
      onClick={onToggle}
    >
      Claimed pledges
      <span className="mcr-claimed-count">{n}</span>
      <svg className="mcr-claimed-chev" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

/** `docked`: the toggle is on Recently aired's heading line, so this is only
 *  the opened cards. Otherwise it carries its own heading row. */
export function ClaimedPledges({
  airings,
  open,
  onToggle,
  docked,
}: {
  airings: ClaimedAiring[]
  open: boolean
  onToggle: () => void
  docked?: boolean
}) {
  const n = airings.length
  const body = (
    <div id={CLAIMED_BODY_ID} className="mcr-claimed-body" hidden={!open}>
      {open ? (
        n ? (
          <div className="mcr-recent-grid">
            {airings.map((a) => (
              <RecentCard key={a.airingId} a={a} claimed={a} />
            ))}
          </div>
        ) : (
          <p className="mcr-claimed-empty">No claimed pledges have aired yet.</p>
        )
      ) : null}
    </div>
  )
  return (
    <section className={`mcr-claimed${docked ? ' is-docked' : ''}`} aria-label="Claimed pledges">
      {docked ? null : (
        <h2 className="mcr-sec-h mcr-claimed-h">
          <ClaimedToggle n={n} open={open} onToggle={onToggle} />
        </h2>
      )}
      {body}
    </section>
  )
}
