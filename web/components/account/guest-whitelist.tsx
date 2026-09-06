'use client'

// The streamer's standing free list. Per account, not per room — so it lives
// on /account rather than in a room's settings, and adding someone here lets
// them walk into every room this streamer opens.

import { useCallback, useEffect, useState } from 'react'
import {
  addGuest,
  getGuestWhitelist,
  removeGuest,
  setGuestWhitelistEnabled,
  type GuestEntry,
  type GuestList,
} from '@/lib/api'

function when(iso: string | null): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return 'never'
  const mins = Math.floor((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

export function GuestWhitelist({ myHandle }: { myHandle: string | null }) {
  const [list, setList] = useState<GuestList | null>(null)
  const [handle, setHandle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    getGuestWhitelist().then(setList).catch(() => setList(null))
  }, [])

  const run = useCallback(async (work: () => Promise<GuestList>, done?: string) => {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      setList(await work())
      if (done) setNote(done)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work — try again.')
    } finally {
      setBusy(false)
    }
  }, [])

  const submit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    const wanted = handle.trim().replace(/^@/, '')
    if (!wanted) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const next = await addGuest(wanted)
      setList(next)
      setHandle('')
      // Adding yourself comes back 200 with a note rather than an error — it is
      // a harmless thing to try, and a red banner would imply it broke.
      setNote(next.skipped === 'self' ? next.message ?? null : `@${wanted} can now join free.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add that handle.')
    } finally {
      setBusy(false)
    }
  }, [handle])

  const entries: GuestEntry[] = list?.entries ?? []
  const full = !!list && entries.length >= list.max
  // The state that costs a streamer an hour of confusion: guests on the list,
  // switch off, everyone quietly paying. It gets its own banner, not a subtle
  // toggle colour.
  const silentlyOff = !!list && !list.enabled && entries.length > 0

  return (
    <section className="mcc-settings-zone mcc-guests">
      <header>
        <div>
          <span className="mcc-coordinate">Guest list</span>
          <h2>Let your regulars walk in.</h2>
          <p>
            Anyone here joins any of your rooms free — no per-second charge, no
            waiting for a seat. It applies to every room you open, not just one.
          </p>
        </div>
        {list ? (
          <button
            type="button"
            className={list.enabled ? 'mcc-guests-switch is-on' : 'mcc-guests-switch'}
            role="switch"
            aria-checked={list.enabled}
            disabled={busy}
            onClick={() => void run(
              () => setGuestWhitelistEnabled(!list.enabled),
              list.enabled ? 'Guest list off — everyone pays normally.' : 'Guest list on.',
            )}
          >
            <i aria-hidden="true" />
            {list.enabled ? 'On' : 'Off'}
          </button>
        ) : null}
      </header>

      {silentlyOff ? (
        <p className="mcc-guests-alarm" role="status">
          Your guest list is <strong>off</strong>. {entries.length} {entries.length === 1 ? 'guest is' : 'guests are'} being
          charged like any other viewer right now. Nobody has been removed — turn it back on to restore them.
        </p>
      ) : null}

      <form className="mcc-guests-add" onSubmit={(e) => void submit(e)}>
        <label htmlFor="guest-handle">Add by MegaChat handle</label>
        <div>
          <span className="mcc-guests-at">@</span>
          <input
            id="guest-handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="theirhandle"
            autoComplete="off"
            spellCheck={false}
            disabled={busy || full}
          />
          <button type="submit" className="btn" disabled={busy || full || !handle.trim()}>
            {busy ? 'Working…' : 'Add guest'}
          </button>
        </div>
        <small>
          {list ? `${entries.length} of ${list.max} used.` : 'Loading…'}
          {full ? ' Remove someone to add another.' : ''}
        </small>
      </form>

      {error ? <p className="mcc-guests-error" role="alert">{error}</p> : null}
      {note ? <p className="hint">{note}</p> : null}

      {list == null ? (
        <p className="hint">Loading your guest list…</p>
      ) : entries.length === 0 ? (
        <p className="hint">
          Nobody on the list yet. Add a co-host or a regular and they can join without paying.
        </p>
      ) : (
        <ul className="mcc-guests-list">
          {entries.map((g) => (
            <li key={g.handle}>
              <span className="mcc-guests-who">
                <strong>@{g.handle}</strong>
                {myHandle && g.handle === myHandle ? <em>you</em> : null}
              </span>
              <span className="mcc-guests-meta">
                <small>Added {when(g.addedAt)}</small>
                <small>Last joined {when(g.lastJoinedAt)}</small>
              </span>
              <button
                type="button"
                className="btn-ghost"
                disabled={busy}
                onClick={() => void run(() => removeGuest(g.handle), `@${g.handle} removed.`)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mcc-guests-foot">
        Removing someone never interrupts them: if they are live when you take
        them off, that session finishes and the change applies next time.
      </p>
    </section>
  )
}
