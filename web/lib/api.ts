// Thin client for the real Express dashboard API (../dashboard-routes.js).
// Mirrors the calls the legacy public/dashboard.html made — same endpoints,
// same X-Room-Password header auth, no payment logic here.

import { backendHttpUrl } from './backend'

export type LettersConfig = {
  enabled: boolean
  maxSeconds: number
  /** null → derived: maxSeconds worth of the live per-second rate. */
  price: string | null
  moderation: 'auto' | 'approve' | string
}

export type RewardsConfig = {
  enabled: boolean
  earnInterval: number
  earnAmount: string
  earnCap: string
  rewardType: 'usdc' | 'token' | 'points' | string
  rewardTokenAddress: string | null
  rewardTokenSymbol?: string | null
  rewardTokenDecimals?: number | null
}

export type Room = {
  id: string
  name: string
  active: boolean
  unlisted: boolean
  tickSeconds: number
  tickPrice: string
  passkeyTickSeconds: number
  passkeyTickPrice: string
  maxSession: string
  maxSeats: number
  paymentTokenAddress: string
  paymentTokenSymbol: string
  paymentTokenDecimals: number
  /** Streamer payout wallet — session settlements pay here (null = platform). */
  payoutAddress: string | null
  /** Twitch login embedded on the join page as the delayed spectate surface. */
  twitchChannel: string | null
  letters: LettersConfig
  rewards: RewardsConfig
}

export type Seat = {
  id: string
  username: string
  live: boolean
  pinned?: boolean
  paymentMode: string
  remaining: string
  spent: string
  viewerAddress: string | null
  joinedAt: number
  liveAt: number | null
  /** Control-WS currently open for this seat. */
  connected?: boolean
  /** 'unstable' = socket down or blipped in the last 2 min; null while queued. */
  quality?: 'good' | 'unstable' | null
}

export type RoomSession = {
  room: Room
  seats: Seat[]
  joinUrl: string
  overlayUrl: string
}

/** Config the dashboard PUTs/POSTs — matches gatherConfig() in the old UI. */
export type RoomConfigPatch = {
  unlisted: boolean
  passkeyTickPrice: string
  passkeyTickSeconds: number
  maxSession: string
  maxSeats: number
  tickPrice: string
  tickSeconds: number
  paymentTokenAddress: string
  payoutAddress: string | null
  twitchChannel: string | null
  letters: {
    enabled: boolean
    maxSeconds: number
    price: string | null
    moderation: string
  }
  rewards: {
    enabled: boolean
    earnInterval: number
    earnAmount: string
    earnCap: string
    rewardType: string
    rewardTokenAddress: string | null
  }
}

class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
export { ApiError }

async function request<T>(
  path: string,
  opts: { method?: string; password?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.password) headers['X-Room-Password'] = opts.password
  const url = path.startsWith('http') ? path : `${backendHttpUrl()}${path}`
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = [data.error || `Request failed (${res.status})`, data.hint]
      .filter(Boolean)
      .join(' — ')
    throw new ApiError(res.status, msg)
  }
  return data as T
}

/** One card in the public browse directory (/api/rooms/public). */
export type PublicRoomCard = {
  id: string
  name: string
  live: number
  waiting: number
  maxSeats: number
  passkeyTickPrice: string
  passkeyTickSeconds: number
  paymentTokenSymbol: string
  rewardsEnabled: boolean
  createdAt: string
}

/** Active, listed rooms sorted hottest first (live count, then waiting). */
export function listPublicRooms() {
  return request<{ rooms: PublicRoomCard[] }>('/api/rooms/public')
}

/** Public room + chain config (also exposes the real Arc USDC address). */
export function getPublicConfig(room = 'default') {
  return request<{ usdcAddress: string; paymentTokenSymbol: string }>(
    `/api/config?room=${encodeURIComponent(room)}`,
  )
}

export function createRoom(name: string, config: RoomConfigPatch, password: string) {
  return request<{ room: Room; joinUrl: string; overlayUrl: string }>(
    '/api/dashboard/create',
    { method: 'POST', body: { name, config, password } },
  )
}

export function unlockRoom(roomId: string, password: string) {
  return request<{ ok: boolean; room: Room; joinUrl: string; overlayUrl: string }>(
    '/api/dashboard/unlock',
    { method: 'POST', body: { roomId, password } },
  )
}

export function getRoomSession(roomId: string, password: string) {
  return request<RoomSession>(
    `/api/dashboard/rooms/${encodeURIComponent(roomId)}`,
    { password },
  )
}

export function updateRoom(
  roomId: string,
  password: string,
  patch: { name?: string; config?: RoomConfigPatch },
) {
  return request<{ room: Room }>(
    `/api/dashboard/rooms/${encodeURIComponent(roomId)}`,
    { method: 'PUT', password, body: patch },
  )
}

export function setRoomActive(roomId: string, password: string, active: boolean) {
  return request<{ room: Room }>(
    `/api/dashboard/rooms/${encodeURIComponent(roomId)}/${active ? 'start' : 'stop'}`,
    { method: 'POST', password },
  )
}

export function kickSeat(roomId: string, password: string, seatId: string) {
  return request<{ success: boolean }>(
    `/api/dashboard/rooms/${encodeURIComponent(roomId)}/kick/${encodeURIComponent(seatId)}`,
    { method: 'POST', password },
  )
}

/** Pin/unpin a seat as free co-host (meter paused while pinned). */
export function pinSeat(roomId: string, password: string, seatId: string, pinned: boolean) {
  return request<{ success: boolean; pinned: boolean }>(
    `/api/dashboard/rooms/${encodeURIComponent(roomId)}/pin/${encodeURIComponent(seatId)}`,
    { method: 'POST', password, body: { pinned } },
  )
}

/** One letter in the moderation/queue list. */
export type LetterAdminItem = {
  id: string
  username: string
  durationS: number
  price: string
  status: 'pending_approval' | 'queued' | 'playing' | string
  uploadedAt: number | null
  mediaUrl: string | null
}

export function listLetters(roomId: string, password: string) {
  return request<{ letters: LetterAdminItem[] }>(
    `/api/dashboard/rooms/${encodeURIComponent(roomId)}/letters`,
    { password },
  )
}

export function approveLetter(roomId: string, password: string, letterId: string) {
  return request<{ success: boolean }>(
    `/api/dashboard/rooms/${encodeURIComponent(roomId)}/letters/${encodeURIComponent(letterId)}/approve`,
    { method: 'POST', password },
  )
}

/** Reject a pending letter — the payer is refunded from the platform wallet. */
export function rejectLetter(roomId: string, password: string, letterId: string) {
  return request<{ success: boolean; refunded: boolean }>(
    `/api/dashboard/rooms/${encodeURIComponent(roomId)}/letters/${encodeURIComponent(letterId)}/reject`,
    { method: 'POST', password },
  )
}
