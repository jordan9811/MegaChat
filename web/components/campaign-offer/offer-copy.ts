// The claimant's words on /c/<slug>, apart from the component so they can be
// checked without a browser. Every sentence here is a claim about what the
// server will do, so each one is gated on what the server has actually said.

import { fmtClock, fmtDayUtc } from '@/components/campaigns/rules'
import type { CampaignClaim } from './types'

export type Kind = 'holler' | 'callin'

/** A date in text the server renders and the browser hydrates (the offer
 *  arrives with the page): en-US and UTC on both sides, never the zone or
 *  locale of whichever machine is rendering. Null when there is none. */
export const fmtDate = (iso: string | null | undefined) => {
  const d = fmtDayUtc(iso)
  return d === '—' ? null : d
}

/** Date and time in the viewer's own zone. Only for the claim, which loads
 *  in the browser after the page, so nothing server-rendered uses it. */
export const fmtDateTime = (iso: string | null | undefined) => {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export type StatusContext = {
  kind: Kind
  /** The campaign is closed (by its creator or by its deadline). */
  closed: boolean
  /** Every failed check is unread X data: nothing has been judged yet. */
  unread: boolean
  claim: CampaignClaim
  /** The room's moderation, when the campaign view carries it. */
  moderation: string | null | undefined
}

/** What the claimant's status line says, per action and per state. The
 *  Holler is sent; a Call in is a live seat, so "send" is wrong for it. */
export function statusCopy({ kind, closed, unread, claim, moderation }: StatusContext): string {
  const act = kind === 'callin' ? 'Call in to claim your place.' : 'Send your Holler to claim your place.'
  const thing = kind === 'callin' ? 'your seat' : 'your Holler'
  const honour = closed && claim.honourUntil ? fmtDateTime(claim.honourUntil) : null
  // N14: it played, through the streamer's OLD overlay link, so the server
  // could not confirm it aired. Not a verdict on the claimant; the fix is on
  // the streamer's side. Said before anything else while it is still waiting,
  // with the time it played when the server recorded one.
  if (claim.playedUnauthed && (claim.status === 'recorded' || claim.status === 'approved')) {
    const at = fmtClock(claim.playedUnauthedAt)
    return `This played${at ? ` at ${at}` : ''}, but through an overlay link that can’t confirm it aired. The streamer needs to update their OBS overlay link before it can count.${honour ? ` It still counts if it airs before ${honour}.` : ''}`
  }
  // A Call in seen on camera while the room was off air: the server stopped
  // (or never started) the clock, so "Stay on to count" would be untrue.
  if (kind === 'callin' && claim.offAir) {
    return 'The stream is off air, so your time on camera is not counting. It starts again when the stream is back on air.'
  }
  switch (claim.status) {
    case 'ineligible': return unread ? 'We couldn’t read your X account yet.' : 'You do not qualify for this one.'
    case 'eligible': return `You qualify. ${act}`
    case 'recorded':
      if (honour) return `This campaign has closed, but ${thing} still counts if it ${kind === 'callin' ? 'goes on air' : 'airs'} before ${honour}.`
      return kind === 'callin' ? 'Your seat is reserved. Waiting for it to count.' : 'Sent. Waiting for it to count.'
    case 'approved': {
      // An auto-moderated room "approves" with nobody looking, so "Cleared"
      // is the honest word; "Approved by the stream" only when a person did.
      const auto = claim.autoModerated === true || moderation === 'auto'
      const manual = claim.autoModerated === false || moderation === 'approve'
      const cleared = auto ? 'Cleared for the stream.' : manual ? 'Approved by the stream.' : 'Cleared.'
      if (honour) return `${cleared} This campaign has closed, but ${thing} still counts if it airs before ${honour}.`
      return `${cleared} It counts once it airs.`
    }
    case 'aired': return 'It aired. Your reward is being lined up.'
    case 'joined':
      if (honour) return `You are on camera. This campaign has closed, but your seat still counts if it reaches the minimum before ${honour}.`
      return 'You are on camera. Stay on to count.'
    case 'owed': return 'You earned it. Your reward is owed to you.'
    case 'releasing':
      if (claim.payoutsEnabled === false) return 'Reward recorded. Payouts are queued on this server and will be sent when they’re switched on.'
      if (claim.payoutsEnabled === true) return 'Reward recorded. It’s being sent from the Holler wallet; you’ll see the transaction here.'
      return 'Reward recorded. You’ll see the transaction here once it’s sent.'
    case 'paid': return 'Paid.'
    case 'failed': return 'The payment did not go through. The creator has been told.'
    case 'rejected': return 'The stream turned this one down.'
    case 'expired': return 'The campaign closed before this counted.'
    default: return claim.status
  }
}
