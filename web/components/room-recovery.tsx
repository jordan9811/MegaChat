'use client'

import { useEffect, useState } from 'react'
import { useRoom } from '@/components/room-provider'
import { ApiError, getPublicConfig } from '@/lib/api'

export function RoomRecovery() {
  const { unlock, myRooms, openOwnedRoom } = useRoom()
  const [open, setOpen] = useState(false)
  const [roomLink, setRoomLink] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

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
        let id = roomLink.trim().replace(/^@/, '')
        if (/^(https?:\/\/|megachat\.fun\/)/i.test(id)) {
          const url = new URL(id.startsWith('http') ? id : `https://${id}`)
          id = url.searchParams.get('room') || url.pathname.replace(/^\/+|\/+$/g, '')
        }
        if (!/^[a-z0-9_-]{1,32}$/i.test(id)) throw new Error('Enter your room handle or room link.')
        const config = await getPublicConfig(id)
        await unlock(config.roomId || id, password)
      }
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? 'That password did not unlock this room. Try again.' : e instanceof Error ? e.message : 'Could not open the room.')
    } finally { setBusy(false) }
  }

  return (
    <details className="mcc-room-recovery" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Manage an existing room</summary>
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
