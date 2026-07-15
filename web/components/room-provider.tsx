'use client'

// Shared room session for the dashboard cards. Owns the create/manage
// lifecycle (per-room password auth), the config draft (autosaved while
// managing, exactly like the legacy dashboard), and live seats fed by the
// backend WebSocket (seat_added / seat_removed / meter_update) with an
// authenticated poll as fallback for pending (paid-but-not-live) seats.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  ApiError,
  createRoom as apiCreateRoom,
  unlockRoom as apiUnlockRoom,
  getRoomSession,
  updateRoom,
  setRoomActive,
  kickSeat as apiKickSeat,
  pinSeat as apiPinSeat,
  getPublicConfig,
  listLetters as apiListLetters,
  approveLetter as apiApproveLetter,
  rejectLetter as apiRejectLetter,
  type LetterAdminItem,
  type Room,
  type Seat,
  type RoomConfigPatch,
} from '@/lib/api'
import { backendWsUrl } from '@/lib/backend'

// Tempo mainnet USDC.e — fallback only; the real value is re-read from
// /api/config on mount.
const USDC_FALLBACK = '0x20c000000000000000000000b9537d11c60e8b50'

export type ConfigDraft = {
  name: string
  handle: string
  unlisted: boolean
  payoutAddress: string
  twitchChannel: string
  passkeyTickPrice: string
  passkeyTickSeconds: string
  maxSession: string
  maxSeats: string
  tickPrice: string
  tickSeconds: string
  tokenPreset: 'usdc' | 'custom'
  customTokenAddress: string
  rewardsEnabled: boolean
  rewardsEarnInterval: string
  rewardsEarnAmount: string
  rewardsEarnCap: string
  rewardsType: string
  rewardsTokenAddress: string
  lettersEnabled: boolean
  lettersMaxSeconds: string
  lettersPrice: string
  lettersModeration: 'auto' | 'approve'
  lettersAiStrictness: 'severe' | 'borderline'
  lettersAutoRefund: boolean
  transport: 'vdo' | 'livekit'
  stingerSounds: boolean
  // per-feature gates: MegaChats own theirs; Join Stream inherits unless overridden
  mcMinWatch: string
  mcFollowersOnly: boolean
  mcSubsOnly: boolean
  joinStreamEnabled: boolean
  jsGatesSame: boolean
  jsMinWatch: string
  jsFollowersOnly: boolean
  jsSubsOnly: boolean
}

// Defaults mirror the legacy dashboard form (backed by env defaults server-side).
const DEFAULT_DRAFT: ConfigDraft = {
  name: '',
  handle: '',
  unlisted: false,
  payoutAddress: '',
  twitchChannel: '',
  passkeyTickPrice: '0.001',
  passkeyTickSeconds: '1',
  maxSession: '2',
  maxSeats: '3',
  tickPrice: '0.1',
  tickSeconds: '10',
  tokenPreset: 'usdc',
  customTokenAddress: '',
  rewardsEnabled: false,
  rewardsEarnInterval: '60',
  rewardsEarnAmount: '0.1',
  rewardsEarnCap: '5',
  rewardsType: 'usdc',
  rewardsTokenAddress: '',
  lettersEnabled: false,
  lettersMaxSeconds: '10',
  lettersPrice: '',
  lettersModeration: 'auto',
  lettersAiStrictness: 'severe',
  lettersAutoRefund: true,
  transport: 'vdo',
  stingerSounds: true,
  mcMinWatch: '0',
  mcFollowersOnly: false,
  mcSubsOnly: false,
  joinStreamEnabled: true,
  jsGatesSame: true,
  jsMinWatch: '0',
  jsFollowersOnly: false,
  jsSubsOnly: false,
}

type RoomContextValue = {
  mode: 'create' | 'managing'
  room: Room | null
  seats: Seat[]
  joinUrl: string | null
  overlayUrl: string | null
  draft: ConfigDraft
  usdcAddress: string
  livekitConfigured: boolean
  updateDraft: (patch: Partial<ConfigDraft>) => void
  create: (password: string) => Promise<void>
  unlock: (roomId: string, password: string) => Promise<void>
  toggleActive: () => Promise<void>
  kick: (seatId: string) => Promise<void>
  pin: (seatId: string, pinned: boolean) => Promise<void>
  switchRoom: () => void
  lettersAdmin: {
    list: () => Promise<LetterAdminItem[]>
    approve: (letterId: string) => Promise<void>
    reject: (letterId: string) => Promise<void>
  }
  /** LiveKit host publish grant (password-gated server-side). */
  hostToken: () => Promise<{ token: string; url: string }>
}

const RoomContext = createContext<RoomContextValue | null>(null)

export function useRoom() {
  const ctx = useContext(RoomContext)
  if (!ctx) throw new Error('useRoom must be used inside <RoomProvider>')
  return ctx
}

function draftToConfig(draft: ConfigDraft, usdcAddress: string): RoomConfigPatch {
  const paymentTokenAddress =
    draft.tokenPreset === 'custom' && draft.customTokenAddress.trim()
      ? draft.customTokenAddress.trim()
      : usdcAddress
  return {
    unlisted: draft.unlisted,
    payoutAddress: draft.payoutAddress.trim() || null,
    twitchChannel: draft.twitchChannel.trim().replace(/^@/, '') || null,
    passkeyTickPrice: draft.passkeyTickPrice,
    passkeyTickSeconds: Number(draft.passkeyTickSeconds) || 1,
    maxSession: draft.maxSession,
    maxSeats: Number(draft.maxSeats) || 3,
    tickPrice: draft.tickPrice,
    tickSeconds: Number(draft.tickSeconds) || 10,
    paymentTokenAddress,
    transport: draft.transport,
    stingerSounds: draft.stingerSounds,
    letters: {
      enabled: draft.lettersEnabled,
      maxSeconds: Number(draft.lettersMaxSeconds) || 10,
      price: draft.lettersPrice.trim() || null,
      moderation: draft.lettersModeration,
      aiStrictness: draft.lettersAiStrictness,
      autoRefundOnReject: draft.lettersAutoRefund,
      gates: {
        minWatchSeconds: Number(draft.mcMinWatch) || 0,
        followersOnly: draft.mcFollowersOnly,
        subsOnly: draft.mcSubsOnly,
      },
    },
    joinStream: {
      enabled: draft.joinStreamEnabled,
      gatesSameAsMegaChat: draft.jsGatesSame,
      gates: {
        minWatchSeconds: Number(draft.jsMinWatch) || 0,
        followersOnly: draft.jsFollowersOnly,
        subsOnly: draft.jsSubsOnly,
      },
    },
    rewards: {
      enabled: draft.rewardsEnabled,
      earnInterval: Number(draft.rewardsEarnInterval) || 60,
      earnAmount: draft.rewardsEarnAmount,
      earnCap: draft.rewardsEarnCap,
      rewardType: draft.rewardsType,
      rewardTokenAddress: draft.rewardsTokenAddress.trim() || null,
    },
  }
}

function roomToDraft(room: Room, usdcAddress: string): ConfigDraft {
  const isUsdc =
    !room.paymentTokenAddress ||
    room.paymentTokenAddress.toLowerCase() === usdcAddress.toLowerCase()
  const rw = room.rewards || ({} as Room['rewards'])
  return {
    name: room.name,
    handle: room.handle || '',
    unlisted: !!room.unlisted,
    payoutAddress: room.payoutAddress || '',
    twitchChannel: room.twitchChannel || '',
    passkeyTickPrice: String(room.passkeyTickPrice),
    passkeyTickSeconds: String(room.passkeyTickSeconds),
    maxSession: String(room.maxSession),
    maxSeats: String(room.maxSeats),
    tickPrice: String(room.tickPrice),
    tickSeconds: String(room.tickSeconds),
    tokenPreset: isUsdc ? 'usdc' : 'custom',
    customTokenAddress: isUsdc ? '' : room.paymentTokenAddress,
    rewardsEnabled: !!rw.enabled,
    rewardsEarnInterval: String(rw.earnInterval ?? 60),
    rewardsEarnAmount: String(rw.earnAmount ?? '0.1'),
    rewardsEarnCap: String(rw.earnCap ?? '5'),
    rewardsType: rw.rewardType || 'usdc',
    rewardsTokenAddress: rw.rewardTokenAddress || '',
    lettersEnabled: !!room.letters?.enabled,
    lettersMaxSeconds: String(room.letters?.maxSeconds ?? 10),
    lettersPrice: room.letters?.price || '',
    lettersModeration: room.letters?.moderation === 'approve' ? 'approve' : 'auto',
    lettersAiStrictness: room.letters?.aiStrictness === 'borderline' ? 'borderline' : 'severe',
    lettersAutoRefund: room.letters ? room.letters.autoRefundOnReject !== false : true,
    transport: room.transport === 'livekit' ? 'livekit' : 'vdo',
    stingerSounds: room.stingerSounds !== false,
    mcMinWatch: String(room.letters?.gates?.minWatchSeconds ?? 0),
    mcFollowersOnly: !!room.letters?.gates?.followersOnly,
    mcSubsOnly: !!room.letters?.gates?.subsOnly,
    joinStreamEnabled: room.joinStream ? room.joinStream.enabled !== false : true,
    jsGatesSame: room.joinStream ? room.joinStream.gatesSameAsMegaChat !== false : true,
    jsMinWatch: String(room.joinStream?.gates?.minWatchSeconds ?? 0),
    jsFollowersOnly: !!room.joinStream?.gates?.followersOnly,
    jsSubsOnly: !!room.joinStream?.gates?.subsOnly,
  }
}

export function RoomProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<'create' | 'managing'>('create')
  const [room, setRoom] = useState<Room | null>(null)
  const [seats, setSeats] = useState<Seat[]>([])
  const [joinUrl, setJoinUrl] = useState<string | null>(null)
  const [overlayUrl, setOverlayUrl] = useState<string | null>(null)
  const [draft, setDraft] = useState<ConfigDraft>(DEFAULT_DRAFT)
  const [usdcAddress, setUsdcAddress] = useState(USDC_FALLBACK)
  const [livekitConfigured, setLivekitConfigured] = useState(false)

  const passwordRef = useRef('')
  const roomIdRef = useRef<string | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const skipNextAutosaveRef = useRef(true)

  useEffect(() => {
    getPublicConfig()
      .then((cfg) => {
        if (cfg.usdcAddress) setUsdcAddress(cfg.usdcAddress)
        setLivekitConfigured(!!cfg.livekitConfigured)
        // LiveKit is the default transport when configured; flip the still-
        // pristine create-form draft to match (server applies the same rule
        // for any room saved without an explicit transport choice).
        if (cfg.livekitConfigured) {
          setDraft((d) => (d.transport === 'vdo' ? { ...d, transport: 'livekit' } : d))
        }
      })
      .catch(() => {})
    // Streamers signed in via Twitch/X get their reserved handle prefilled
    // for the /r/<handle> room claim (identity-only integration).
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((me) => {
        if (me?.identity?.handle) {
          setDraft((d) => (d.handle ? d : { ...d, handle: me.identity.handle }))
        }
      })
      .catch(() => {})
  }, [])

  const switchRoom = useCallback(() => {
    passwordRef.current = ''
    roomIdRef.current = null
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    setMode('create')
    setRoom(null)
    setSeats([])
    setJoinUrl(null)
    setOverlayUrl(null)
  }, [])

  const refresh = useCallback(async () => {
    const roomId = roomIdRef.current
    if (!roomId) return
    try {
      const data = await getRoomSession(roomId, passwordRef.current)
      setRoom(data.room)
      setSeats(data.seats)
      setJoinUrl(data.joinUrl)
      setOverlayUrl(data.overlayUrl)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) switchRoom()
    }
  }, [switchRoom])

  const enterManaged = useCallback(
    (r: Room, password: string, join: string, overlay: string) => {
      passwordRef.current = password
      roomIdRef.current = r.id
      skipNextAutosaveRef.current = true
      setRoom(r)
      setDraft(roomToDraft(r, usdcAddress))
      setJoinUrl(join)
      setOverlayUrl(overlay)
      setMode('managing')
      void refresh()
    },
    [usdcAddress, refresh],
  )

  const create = useCallback(
    async (password: string) => {
      const name = draft.name.trim() || 'My Stream'
      const data = await apiCreateRoom(
        name,
        draftToConfig(draft, usdcAddress),
        password,
        draft.handle.trim() || null,
      )
      enterManaged(data.room, password, data.joinUrl, data.overlayUrl)
    },
    [draft, usdcAddress, enterManaged],
  )

  const unlock = useCallback(
    async (roomId: string, password: string) => {
      const data = await apiUnlockRoom(roomId.trim(), password)
      enterManaged(data.room, password, data.joinUrl, data.overlayUrl)
    },
    [enterManaged],
  )

  const updateDraft = useCallback((patch: Partial<ConfigDraft>) => {
    setDraft((d) => ({ ...d, ...patch }))
  }, [])

  // Autosave while managing (debounced, same cadence as the legacy dashboard).
  useEffect(() => {
    if (mode !== 'managing' || !roomIdRef.current) return
    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false
      return
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      const roomId = roomIdRef.current
      if (!roomId) return
      try {
        const data = await updateRoom(roomId, passwordRef.current, {
          name: draft.name.trim() || undefined,
          handle: draft.handle.trim() || null,
          config: draftToConfig(draft, usdcAddress),
        })
        setRoom(data.room)
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) switchRoom()
      }
    }, 900)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [draft, mode, usdcAddress, switchRoom])

  const toggleActive = useCallback(async () => {
    const roomId = roomIdRef.current
    if (!roomId || !room) return
    try {
      const data = await setRoomActive(roomId, passwordRef.current, !room.active)
      setRoom(data.room)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) switchRoom()
    }
  }, [room, switchRoom])

  const kick = useCallback(
    async (seatId: string) => {
      const roomId = roomIdRef.current
      if (!roomId) return
      try {
        await apiKickSeat(roomId, passwordRef.current, seatId)
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          switchRoom()
          return
        }
      }
      void refresh()
    },
    [refresh, switchRoom],
  )

  const pin = useCallback(
    async (seatId: string, pinned: boolean) => {
      const roomId = roomIdRef.current
      if (!roomId) return
      try {
        await apiPinSeat(roomId, passwordRef.current, seatId, pinned)
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          switchRoom()
          return
        }
      }
      void refresh()
    },
    [refresh, switchRoom],
  )

  // Live seats: subscribe to the backend WebSocket for this room. seat_added /
  // seat_removed trigger an authenticated refresh (WS payloads don't carry
  // spent/remaining for other viewers); meter_update patches rows in place.
  useEffect(() => {
    if (mode !== 'managing' || !room?.id) return
    let ws: WebSocket | null = null
    let closed = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    function connect() {
      ws = new WebSocket(backendWsUrl())
      ws.onopen = () => {
        ws?.send(JSON.stringify({ type: 'subscribe_room', room: room!.id }))
      }
      ws.onmessage = (event) => {
        let msg: any
        try {
          msg = JSON.parse(event.data)
        } catch {
          return
        }
        if (msg.type === 'seat_added' || msg.type === 'seat_removed') {
          void refresh()
        } else if (msg.type === 'meter_update' && msg.seatId) {
          setSeats((prev) =>
            prev.map((s) =>
              s.id === msg.seatId
                ? { ...s, remaining: msg.remaining, spent: msg.spent }
                : s,
            ),
          )
        }
      }
      ws.onclose = () => {
        if (!closed) reconnectTimer = setTimeout(connect, 3000)
      }
    }
    connect()

    // Poll fallback also surfaces pending (paid, camera-not-live) seats.
    const poll = setInterval(() => void refresh(), 5000)

    return () => {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      clearInterval(poll)
      ws?.close()
    }
  }, [mode, room?.id, refresh])

  const hostToken = useCallback(async () => {
    const roomId = roomIdRef.current
    if (!roomId) throw new Error('No room')
    const res = await fetch('/api/livekit/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Room-Password': passwordRef.current },
      body: JSON.stringify({ room: roomId, role: 'host' }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.token) throw new Error(data.error || 'Host token failed')
    return { token: data.token as string, url: data.url as string }
  }, [])

  const lettersAdmin = useMemo(
    () => ({
      list: async () => {
        const roomId = roomIdRef.current
        if (!roomId) return []
        const data = await apiListLetters(roomId, passwordRef.current)
        return data.letters
      },
      approve: async (letterId: string) => {
        const roomId = roomIdRef.current
        if (roomId) await apiApproveLetter(roomId, passwordRef.current, letterId)
      },
      reject: async (letterId: string) => {
        const roomId = roomIdRef.current
        if (roomId) await apiRejectLetter(roomId, passwordRef.current, letterId)
      },
    }),
    [],
  )

  const value = useMemo<RoomContextValue>(
    () => ({
      mode,
      room,
      seats,
      joinUrl,
      overlayUrl,
      draft,
      usdcAddress,
      livekitConfigured,
      updateDraft,
      create,
      unlock,
      toggleActive,
      kick,
      pin,
      switchRoom,
      lettersAdmin,
      hostToken,
    }),
    [mode, room, seats, joinUrl, overlayUrl, draft, usdcAddress, livekitConfigured, updateDraft, create, unlock, toggleActive, kick, pin, switchRoom, lettersAdmin, hostToken],
  )

  return <RoomContext.Provider value={value}>{children}</RoomContext.Provider>
}
