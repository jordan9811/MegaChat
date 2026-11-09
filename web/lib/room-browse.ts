import type { PublicRoomCard, RewardsConfig } from './api'
import { formatDollars } from './display-format'

/** How many finished broadcasts the board asks for — the SAME number on the
 *  server render and the client poll, or the rail changes a minute after load
 *  with nothing having happened. At most one row of them is ever shown. */
export const BOARD_RECENT_CAP = 6

/** A room's reward as viewers are offered it: the stored terms. */
export type RewardTerms = Pick<RewardsConfig, 'rewardType' | 'earnAmount' | 'earnInterval' | 'earnCap'> & { rewardTokenSymbol?: string | null }

function everyLabel(seconds: number) {
  const s = Number(seconds) > 0 ? Number(seconds) : 60
  if (s === 1) return 'a second'
  if (s === 60) return 'a minute'
  if (s === 3600) return 'an hour'
  if (s % 60 === 0) return `every ${s / 60} min`
  return `every ${s} s`
}

/** The full terms on one line, the same words on the board card and in the
 *  create page's preview: "$0.01 a minute, up to $0.10" (cash), "1 credit
 *  every 30 s, up to 50" (credit), "5 TOKEN a minute, up to 50 TOKEN". */
export function rewardTerms(terms: RewardTerms) {
  const amount = Number(terms.earnAmount)
  const cap = Number(terms.earnCap)
  const every = everyLabel(terms.earnInterval)
  if (terms.rewardType === 'points') return `${amount} ${amount === 1 ? 'credit' : 'credits'} ${every}, up to ${cap}`
  if (terms.rewardType === 'token') {
    const symbol = (terms.rewardTokenSymbol || 'TOKEN').toUpperCase()
    return `${amount} ${symbol} ${every}, up to ${cap} ${symbol}`
  }
  return `${formatDollars(amount)} ${every}, up to ${formatDollars(cap)}`
}

export function roomPresentation(room: PublicRoomCard & { rewards?: RewardTerms | null }) {
  const onAir = room.live > 0 || room.twitchLive
  const demo = room.isDemo || room.handle === 'demo'
  const mic = room.joinStream?.enabled === true
  const recording = room.letters?.enabled === true
  const full = mic && room.live >= room.maxSeats
  const liveRate = Number(room.passkeyTickPrice) / Math.max(1, room.passkeyTickSeconds)
  const letterRate = recording
    ? room.letters!.price == null ? liveRate : Number(room.letters!.price) / Math.max(1, room.letters!.maxSeconds)
    : null
  const rate = recording ? letterRate : mic ? liveRate : null
  const label = (r: number) => (r === 0 ? 'Free' : `${formatDollars(r)} /second`)
  // One line per way in, in the order the product sells them: Hollers
  // first, call in second, then what watching earns (once the room's terms
  // are known). `seats` rides along so the board can draw the room's seats
  // (taken / total) next to the seat price.
  const rates: { kind: RoomFeature; label: string; rate: string; seats?: { taken: number; total: number } }[] = []
  if (recording && letterRate != null) rates.push({ kind: 'holler', label: 'Hollers', rate: label(letterRate) })
  if (mic) rates.push({ kind: 'callin', label: 'Call in', rate: label(liveRate), seats: { taken: Math.min(room.live, room.maxSeats), total: room.maxSeats } })
  if (room.rewardsEnabled && room.rewards) rates.push({ kind: 'rewards', label: 'Watching', rate: rewardTerms(room.rewards) })
  return {
    onAir, demo, full, mic, rates,
    state: demo ? 'Demo' : onAir ? 'On air' : 'No live signal',
    action: demo ? 'Try demo' : full && onAir ? 'Join queue' : recording ? 'Record a Holler' : mic && onAir ? 'Take a seat' : 'Join',
    rate: rate == null ? 'View rates' : label(rate),
    capabilities: [recording && 'Hollers', mic && 'Call in', room.rewardsEnabled && 'Rewards'].filter(Boolean).join(' · ') || 'View room details',
  }
}

/** The feature tags a room earns, in the order the product sells them — the
 *  same three flags roomPresentation reads: recording = a Holler, a live seat
 *  = Call in, rewards on = Rewards. Feed each to <FeatureTag kind={…} />. */
export type RoomFeature = 'holler' | 'callin' | 'rewards'

export function featureKinds(room: PublicRoomCard): RoomFeature[] {
  const kinds: RoomFeature[] = []
  if (room.letters?.enabled === true) kinds.push('holler')
  if (room.joinStream?.enabled === true) kinds.push('callin')
  if (room.rewardsEnabled) kinds.push('rewards')
  return kinds
}
