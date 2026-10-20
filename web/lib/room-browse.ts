import type { PublicRoomCard } from './api'
import { formatDollars } from './display-format'

/** How many finished broadcasts the board asks for — the SAME number on the
 *  server render and the client poll, or the rail changes a minute after load
 *  with nothing having happened. At most one row of them is ever shown. */
export const BOARD_RECENT_CAP = 6

export function roomPresentation(room: PublicRoomCard) {
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
  // first, call in second. `seats` rides along so the board can draw the
  // room's seats (taken / total) next to the seat price.
  const rates: { label: string; rate: string; seats?: { taken: number; total: number } }[] = []
  if (recording && letterRate != null) rates.push({ label: 'Hollers', rate: label(letterRate) })
  if (mic) rates.push({ label: 'Call in', rate: label(liveRate), seats: { taken: Math.min(room.live, room.maxSeats), total: room.maxSeats } })
  return {
    onAir, demo, full, mic, rates,
    state: demo ? 'Demo' : onAir ? 'On air' : 'No live signal',
    action: demo ? 'Try demo' : full && onAir ? 'Join queue' : recording ? 'Record a Holler' : mic && onAir ? 'Take a seat' : 'Open room',
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
