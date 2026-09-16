import type { PublicRoomCard } from './api'
import { formatDollars } from './display-format'

export function roomPresentation(room: PublicRoomCard) {
  const onAir = room.live > 0 || room.twitchLive
  const demo = room.isDemo || room.handle === 'demo'
  const mic = room.joinStream?.enabled === true
  const recording = room.letters?.enabled === true
  const full = mic && room.live >= room.maxSeats
  const liveRate = Number(room.passkeyTickPrice) / Math.max(1, room.passkeyTickSeconds)
  const rate = recording
    ? room.letters!.price == null ? liveRate : Number(room.letters!.price) / Math.max(1, room.letters!.maxSeconds)
    : mic ? liveRate : null
  return {
    onAir, demo, full,
    state: demo ? 'Demo' : onAir ? 'On air' : 'No live signal',
    action: demo ? 'Try demo' : full && onAir ? 'Join queue' : recording ? 'Record a MegaChat' : mic && onAir ? 'Take a seat' : 'Open room',
    rate: rate == null ? 'View rates' : rate === 0 ? 'Free' : `${formatDollars(rate)} /second`,
    capabilities: [recording && 'MegaChats', mic && 'Live seats', room.rewardsEnabled && 'Drops'].filter(Boolean).join(' · ') || 'View room details',
  }
}
