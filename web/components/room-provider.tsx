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
  listMyRooms,
  getAccountDefaults,
  saveAccountDefaults,
  listLinkedAccounts,
  listLetters as apiListLetters,
  approveLetter as apiApproveLetter,
  rejectLetter as apiRejectLetter,
  forcePlayLetter as apiForcePlayLetter,
  type LetterAdminItem,
  type MyRoomCard,
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
  twitchAuto: boolean
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
  twitchAuto: true,
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
  lettersEnabled: true, // the hero feature — on by default
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
  // Open mic is OPT-IN on a new room. MegaChats need nothing from the
  // streamer once configured; live camera seats put a stranger on the
  // broadcast, which is a bigger ask to have switched on by default.
  joinStreamEnabled: false,
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
  /** Handle reserved by the signed-in OAuth identity — null when signed out.
   *  The dashboard uses it to say "this name is already yours". */
  identityHandle: string | null
  /** True only when the SERVER has a minted identity cookie (the thing that
   *  authorizes owner actions) — distinct from the Privy display-name fallback. */
  hasIdentity: boolean
  /** Rooms owned by the signed-in identity, for the "your rooms" list. */
  myRooms: MyRoomCard[]
  /** Owner's linked Twitch login, or null. Drives the auto-adopt UI. */
  linkedTwitch: string | null
  refreshMyRooms: () => Promise<void>
  /** Saved per-identity room defaults (Account → Defaults section). */
  accountDefaults: Record<string, unknown> | null
  /** Snapshot the current create-form as this identity's defaults. */
  saveDefaultsFromDraft: () => Promise<void>
  clearDefaults: () => Promise<void>
  /** Open a room you OWN with no password (identity cookie authorizes it). */
  openOwnedRoom: (roomId: string) => Promise<void>
  updateDraft: (patch: Partial<ConfigDraft>) => void
  create: (password?: string) => Promise<void>
  unlock: (roomId: string, password: string) => Promise<void>
  toggleActive: () => Promise<void>
  kick: (seatId: string) => Promise<void>
  pin: (seatId: string, pinned: boolean) => Promise<void>
  switchRoom: () => void
  lettersAdmin: {
    list: () => Promise<{ letters: LetterAdminItem[]; overlayLive: boolean }>
    approve: (letterId: string) => Promise<void>
    reject: (letterId: string) => Promise<void>
    playNow: (letterId: string) => Promise<void>
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
    twitchAuto: draft.twitchAuto,
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
    twitchAuto: room.twitchAuto !== false,
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
  const [identityHandle, setIdentityHandle] = useState<string | null>(null)
  const [hasIdentity, setHasIdentity] = useState(false)
  const [myRooms, setMyRooms] = useState<MyRoomCard[]>([])
  const [linkedTwitch, setLinkedTwitch] = useState<string | null>(null)
  const [accountDefaults, setAccountDefaults] = useState<Record<string, unknown> | null>(null)
  // read inside listeners without re-subscribing them on every change
  const identityHandleRef = useRef<string | null>(null)
  identityHandleRef.current = identityHandle
  // Defaults prefill must NEVER clobber a form the user already touched.
  const draftTouchedRef = useRef(false)
  // Auto-open your room once per page load (see loadMine).
  const autoOpenedRef = useRef(false)

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
    // Signing in reserves your name — prefill it so the room gets a real link
    // instead of hex. Falls back to the Privy session's own name if the
    // server-side mint isn't available, so the field is never blank for a
    // signed-in streamer.
    const applyName = (name?: string | null) => {
      if (!name) return
      setIdentityHandle(name)
      setDraft((d) => (d.handle ? d : { ...d, handle: name }))
    }
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((me) => {
        if (me?.identity?.handle) {
          setHasIdentity(true)
          applyName(me.identity.handle)
        } else applyName(window.MegaWallet?.displayName)
      })
      .catch(() => applyName(window.MegaWallet?.displayName))

    // Load "your rooms" now and whenever identity changes (sign-in mints it).
    // If you own rooms, LAND IN ONE — showing a picker (or worse, a create
    // form) when there's an obvious room to manage was a click for nothing.
    // Fires at most once per page load, so "Switch room" isn't instantly undone.
    const loadMine = () =>
      listMyRooms()
        .then((d) => {
          setMyRooms(d.rooms)
          if (!autoOpenedRef.current && d.rooms.length > 0 && !roomIdRef.current) {
            autoOpenedRef.current = true
            void openOwnedRoom(d.rooms[0].id).catch(() => {})
          }
        })
        .catch(() => {})
    void loadMine()

    // Saved room defaults: creating a room starts from these instead of
    // blank. Prefill only a pristine create form — a touched draft (or an
    // open room) is the user's, not ours.
    const loadDefaults = () =>
      getAccountDefaults()
        .then(({ defaults }) => {
          setAccountDefaults(defaults)
          if (defaults && !draftTouchedRef.current && !roomIdRef.current) {
            setDraft((d) => {
              const out = { ...d }
              for (const [k, v] of Object.entries(defaults)) {
                if (k === 'name' || k === 'handle') continue
                if (k in out && typeof v === typeof out[k as keyof ConfigDraft]) {
                  ;(out as Record<string, unknown>)[k] = v
                }
              }
              return out
            })
          }
        })
        .catch(() => {}) // signed out — no defaults to load
    void loadDefaults()

    // Twitch channel: if a Twitch account is actually linked, that's the
    // real answer — prefill it, overriding a stale saved-default guess.
    // Pristine create form only (same guard as defaults); never touches an
    // open/managing room's already-loaded config.
    const loadTwitchPrefill = () =>
      listLinkedAccounts()
        .then(({ accounts }) => {
          const twitch = accounts.find((a) => a.type === 'twitch' && a.name)
          setLinkedTwitch(twitch?.name ?? null)
          // Adopt the linked account by default — for a NEW room draft AND for
          // an existing room that simply has no channel set yet. Connecting
          // Twitch is itself the opt-in; making someone re-enter their own
          // handle in an Advanced panel is the bug being fixed here.
          // `twitchAuto === false` is the explicit opt-out and is respected.
          if (twitch && !draftTouchedRef.current) {
            setDraft((d) => (
              d.twitchAuto === false || d.twitchChannel === twitch.name
                ? d
                : { ...d, twitchChannel: twitch.name! }
            ))
          }
        })
        .catch(() => {}) // signed out, or nothing linked — leave the field alone
    void loadTwitchPrefill()

    const onWallet = () => {
      if (!identityHandleRef.current) applyName(window.MegaWallet?.displayName)
    }
    const onIdentity = () => {
      fetch('/api/auth/me')
        .then((r) => r.json())
        .then((me) => {
          if (me?.identity?.handle) {
            setHasIdentity(true)
            applyName(me.identity.handle)
          }
        })
        .catch(() => {})
      void loadMine()
      void loadDefaults()
      void loadTwitchPrefill()
    }
    window.addEventListener('megawallet:changed', onWallet)
    window.addEventListener('megachat:identity', onIdentity)
    return () => {
      window.removeEventListener('megawallet:changed', onWallet)
      window.removeEventListener('megachat:identity', onIdentity)
    }
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

  const refreshMyRooms = useCallback(async () => {
    try {
      const d = await listMyRooms()
      setMyRooms(d.rooms)
    } catch {
      /* signed out or offline — leave the list as-is */
    }
  }, [])

  const create = useCallback(
    async (password?: string) => {
      const name = draft.name.trim() || 'My Stream'
      const data = await apiCreateRoom(
        name,
        draftToConfig(draft, usdcAddress),
        password || null,
        draft.handle.trim() || null,
      )
      // Owner rooms need no stored password for management (cookie authorizes).
      enterManaged(data.room, data.owned ? '' : password || '', data.joinUrl, data.overlayUrl)
      void refreshMyRooms()
    },
    [draft, usdcAddress, enterManaged, refreshMyRooms],
  )

  const unlock = useCallback(
    async (roomId: string, password: string) => {
      const data = await apiUnlockRoom(roomId.trim(), password)
      enterManaged(data.room, password, data.joinUrl, data.overlayUrl)
    },
    [enterManaged],
  )

  // Open a room you OWN — no password, the identity cookie authorizes the
  // session request. This is what "your rooms → Manage" uses.
  const openOwnedRoom = useCallback(
    async (roomId: string) => {
      const data = await getRoomSession(roomId)
      enterManaged(data.room, '', data.joinUrl, data.overlayUrl)
    },
    [enterManaged],
  )

  const updateDraft = useCallback((patch: Partial<ConfigDraft>) => {
    draftTouchedRef.current = true
    setDraft((d) => ({ ...d, ...patch }))
  }, [])

  // ── Account → Defaults: snapshot / clear the create-form prefill ──────────
  const saveDefaultsFromDraft = useCallback(async () => {
    // name + handle stay per-room; everything else is a reusable preference
    const { name: _n, handle: _h, ...rest } = draft
    const data = await saveAccountDefaults(rest as unknown as Record<string, unknown>)
    setAccountDefaults(data.defaults)
  }, [draft])

  const clearDefaults = useCallback(async () => {
    await saveAccountDefaults(null)
    setAccountDefaults(null)
  }, [])

  // Autosave while managing (debounced, same cadence as the legacy dashboard).
  useEffect(() => {
    if (mode !== 'managing' || !roomIdRef.current) return
    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false
      return
    }
    // Mid-edit guard: a backspaced-to-empty (or garbled) price is INVALID,
    // not "free" — never autosave it over a live room's real price. '0' is
    // legit (the Free room switch writes it explicitly).
    const p = draft.passkeyTickPrice.trim()
    if (p === '' || !isFinite(parseFloat(p)) || parseFloat(p) < 0) return
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
        if (!roomId) return { letters: [], overlayLive: true }
        const data = await apiListLetters(roomId, passwordRef.current)
        return { letters: data.letters, overlayLive: data.overlayLive !== false }
      },
      approve: async (letterId: string) => {
        const roomId = roomIdRef.current
        if (roomId) await apiApproveLetter(roomId, passwordRef.current, letterId)
      },
      reject: async (letterId: string) => {
        const roomId = roomIdRef.current
        if (roomId) await apiRejectLetter(roomId, passwordRef.current, letterId)
      },
      playNow: async (letterId: string) => {
        const roomId = roomIdRef.current
        if (roomId) await apiForcePlayLetter(roomId, passwordRef.current, letterId)
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
      identityHandle,
      hasIdentity,
      myRooms,
      linkedTwitch,
      refreshMyRooms,
      accountDefaults,
      saveDefaultsFromDraft,
      clearDefaults,
      openOwnedRoom,
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
    [mode, room, seats, joinUrl, overlayUrl, draft, usdcAddress, livekitConfigured, identityHandle, hasIdentity, myRooms, linkedTwitch, refreshMyRooms, accountDefaults, saveDefaultsFromDraft, clearDefaults, openOwnedRoom, updateDraft, create, unlock, toggleActive, kick, pin, switchRoom, lettersAdmin, hostToken],
  )

  return <RoomContext.Provider value={value}>{children}</RoomContext.Provider>
}
