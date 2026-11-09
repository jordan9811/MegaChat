'use client'

import { useEffect, useState } from 'react'
import { useRoom } from '@/components/room-provider'
import { useAccount } from '@/lib/use-account'
import { ApiError, getPublicConfig } from '@/lib/api'

/**
 * A handle out of whatever the streamer pasted: a bare handle, or any link
 * with or without scheme or www (hollertv.com/x, megachat.fun/x,
 * https://…/join?room=y). Anything holding a "/" is read as a link and the
 * ?room= or last path segment is taken (ss-recovery-link-rejected).
 */
export function recoveryHandle(raw: string) {
  const text = raw.trim().replace(/^@/, '')
  if (!text.includes('/')) return text
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
    const fromQuery = url.searchParams.get('room')
    if (fromQuery) return fromQuery.trim()
    const segments = url.pathname.split('/').filter(Boolean)
    return (segments[segments.length - 1] || '').replace(/^@/, '')
  } catch { return text }
}

export function RoomRecovery() {
  const { unlock, myRooms, openOwnedRoom, room } = useRoom()
  const { openSignIn } = useAccount()
  const [open, setOpen] = useState(false)
  const [roomLink, setRoomLink] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // After a successful unlock the panel folds to one line instead of staying
  // open, filled in, over the room it just opened (ss-recovery-stays-open).
  const [unlocked, setUnlocked] = useState<{ id: string; label: string } | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    try {
      const saved = JSON.parse(localStorage.getItem('mc-last-room') || 'null')
      const id = params.get('room') || saved?.handle || saved?.id || ''
      setRoomLink(id)
      setOpen(!!id && params.get('new') !== '1')
    } catch { /* storage optional */ }
  }, [])

  async function manage(ownedId?: string) {
    setBusy(true)
    setError('')
    try {
      if (ownedId) await openOwnedRoom(ownedId)
      else {
        const id = recoveryHandle(roomLink)
        if (!/^[a-z0-9_-]{1,32}$/i.test(id)) throw new Error('Enter your room handle or room link.')
        const config = await getPublicConfig(id)
        const roomId = config.roomId || id
        await unlock(roomId, password)
        setPassword('')
        setUnlocked({ id: roomId, label: id })
      }
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? 'That password did not unlock this room. Try again.' : e instanceof Error ? e.message : 'Could not open the room.')
    } finally { setBusy(false) }
  }

  // Shown only while that room is the one open: leave or end it and the
  // recovery form is back.
  if (unlocked && room && (room.id === unlocked.id || room.handle === unlocked.label)) {
    return (
      <p className="mcc-room-recovery mcc-recovered" role="status">
        Unlocked {room.handle || unlocked.label} · <button type="button" onClick={openSignIn}>Sign in to skip the password</button>
      </p>
    )
  }

  return (
    <details className="mcc-room-recovery" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Recover a room with password</summary>
      {myRooms.length > 0 && <div className="mcc-owned-rooms">{myRooms.map((room) => (
        <button key={room.id} type="button" disabled={busy} onClick={() => void manage(room.id)}>{room.name} <span>Manage</span></button>
      ))}</div>}
      <form onSubmit={(e) => { e.preventDefault(); void manage() }}>
        <label>Room handle or link<input value={roomLink} onChange={(e) => setRoomLink(e.target.value)} autoComplete="off" required /></label>
        <label>Existing room password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
        <button type="submit" disabled={busy}>{busy ? 'Opening...' : 'Unlock room'}</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </details>
  )
}
