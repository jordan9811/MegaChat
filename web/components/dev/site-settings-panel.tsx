'use client'

// The site owner's settings (/dev). Three calls the owner makes, each saved on
// its own and live at once — site-settings.js holds them, server.js applies
// them. Every figure on this page comes from the server; nothing here decides.

import { useEffect, useState } from 'react'
import { AccountChip } from '@/components/account-chip'
import { BrandText } from '@/components/brand-text'

type Source = 'saved' | 'env' | 'default'
type Setting<T> = { value: T; source: Source; fallback: T; fallbackSource: 'env' | 'default'; rule: string }

export type SiteSettingsData = {
  settings: {
    bigStreamViewers: Setting<number>
    replayKeepDays: Setting<number>
    recentShowsQuiet: Setting<boolean>
  }
  updatedAt: number | null
  updatedBy: string | null
  history: { at: number; by: string | null; changed: Record<string, { from: unknown; to: unknown; cleared?: boolean }> }[]
  live: { name: string; handle: string | null; channel: string; viewers: number; big: boolean; proven: boolean }[]
  clips: { count: number; bytes: number; clips: { ageMs: number; keepDays: number }[] }
  quiet: { count: number; latestEndedAt: number | null }
}

type Name = keyof SiteSettingsData['settings']

const LABELS: Record<Name, string> = {
  bigStreamViewers: 'Big streamer',
  replayKeepDays: 'MegaChat replays',
  recentShowsQuiet: 'Quiet broadcasts',
}

const ENV_NAMES: Partial<Record<Name, string>> = {
  bigStreamViewers: 'BOARD_BIG_VIEWERS',
  replayKeepDays: 'AIRED_CLIPS',
}

const DAY = 86_400_000
const n = (v: number) => v.toLocaleString('en-US')
const mb = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`)
const days = (d: number) => (d <= 0 ? 'off' : `${d} day${d === 1 ? '' : 's'}`)

function show(name: Name, v: unknown): string {
  if (name === 'replayKeepDays') return days(Number(v))
  if (name === 'recentShowsQuiet') return v ? 'shown' : 'hidden'
  return `${n(Number(v))} viewers`
}

function when(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function sourceText(name: Name, s: Setting<unknown>): string {
  if (s.source === 'saved') return 'Set here'
  if (s.source === 'env') return `From Railway (${ENV_NAMES[name]})`
  return 'Default'
}

export function SiteSettingsPanel({ initial }: { initial: SiteSettingsData }) {
  const [data, setData] = useState(initial)
  const [busy, setBusy] = useState<Name | null>(null)
  const [note, setNote] = useState<Partial<Record<Name, { ok: boolean; text: string }>>>({})
  const s = data.settings

  const [viewers, setViewers] = useState(String(s.bigStreamViewers.value))
  const [keep, setKeep] = useState(String(s.replayKeepDays.value))
  // When the figures below were read: clip ages grow while the page is open.
  const [loadedAt, setLoadedAt] = useState(() => Date.now())
  // Times are the owner's local time, drawn after mount — the server renders
  // in its own zone, and the two would disagree.
  const [local, setLocal] = useState(false)

  useEffect(() => {
    document.title = 'Site settings — MegaChat'
    setLocal(true)
  }, [])
  const at = (ms: number) => (local ? when(ms) : '')

  async function save(name: Name, value: number | boolean | null) {
    if (busy) return
    setBusy(name)
    setNote((m) => ({ ...m, [name]: undefined }))
    try {
      const res = await fetch('/api/site-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ settings: { [name]: value } }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.settings) {
        setNote((m) => ({ ...m, [name]: { ok: false, text: body?.error || `Not saved (${res.status})` } }))
        return
      }
      const next = body as SiteSettingsData
      setData(next)
      setLoadedAt(Date.now())
      // Only the field that was saved: an unsaved edit in another card stays.
      if (name === 'bigStreamViewers') setViewers(String(next.settings.bigStreamViewers.value))
      if (name === 'replayKeepDays') setKeep(String(next.settings.replayKeepDays.value))
      setNote((m) => ({ ...m, [name]: { ok: true, text: value === null ? 'Back to the default. Live now.' : 'Saved. Live now.' } }))
    } catch {
      setNote((m) => ({ ...m, [name]: { ok: false, text: 'Not saved — the server did not answer' } }))
    } finally {
      setBusy(null)
    }
  }

  // ── big streamer ──
  // A blank field is not 0.
  const viewersNum = viewers.trim() === '' ? NaN : Number(viewers)
  const viewersValid = Number.isInteger(viewersNum) && viewersNum >= 1 && viewersNum <= 1_000_000
  const viewersDirty = viewersValid && viewersNum !== s.bigStreamViewers.value

  // ── replays ──
  const keepNum = keep.trim() === '' ? NaN : Number(keep)
  const keepValid = Number.isInteger(keepNum) && keepNum >= 0 && keepNum <= 90
  const keepDirty = keepValid && keepNum !== s.replayKeepDays.value
  // What a limit of `d` days would delete now: every kept clip past it (a clip
  // is kept for the days its fan was told, or the setting if shorter —
  // aired-clips.js keepMsFor), its age counted to this moment.
  const deletedAt = (d: number, now = Date.now()) =>
    data.clips.clips.filter((c) => {
      const limit = Math.min(c.keepDays, d) * DAY
      return limit <= 0 || c.ageMs + (now - loadedAt) > limit
    }).length
  const wouldDelete = keepValid ? deletedAt(keepNum) : 0

  // Deleting is the one thing here that cannot be undone: ask, every time.
  function confirmKeep(d: number): boolean {
    const lost = deletedAt(d)
    if (lost <= 0) return true
    const what = d === 0 ? 'Turning keeping off' : `Keeping clips for ${days(d)}`
    return window.confirm(`${what} deletes ${lost} kept clip${lost === 1 ? '' : 's'} now. They cannot be brought back. Go ahead?`)
  }

  function saveKeep() {
    if (!keepDirty || !confirmKeep(keepNum)) return
    void save('replayKeepDays', keepNum)
  }

  const quietOn = s.recentShowsQuiet.value

  const Reset = ({ name }: { name: Name }) =>
    s[name].source === 'saved' ? (
      <button
        type="button"
        className="mcd-link"
        disabled={!!busy}
        onClick={() => {
          if (name === 'replayKeepDays' && !confirmKeep(Number(s.replayKeepDays.fallback))) return
          void save(name, null)
        }}
      >
        Reset to {show(name, s[name].fallback)}
        {s[name].fallbackSource === 'env' ? ' (Railway)' : ''}
      </button>
    ) : null

  const Note = ({ name }: { name: Name }) =>
    note[name] ? (
      <p role="status" className={note[name]!.ok ? 'mcd-note is-ok' : 'mcd-note is-bad'}>
        {note[name]!.text}
      </p>
    ) : null

  return (
    <div className="mc-account mc-dev dark min-h-screen">
      <header className="mcc-product-header">
        <div>
          <span className="mcc-product-brand">
            <a href="/?stay=1" className="bc"><BrandText /></a>
            <i aria-hidden="true" />
            <span>Site settings</span>
          </span>
          <nav aria-label="Product navigation">
            <a href="/app">Rooms</a>
            <a href="/account">Account</a>
          </nav>
          <span className="mcc-product-actions">
            <AccountChip accent="var(--mcc-accent)" />
          </span>
        </div>
      </header>

      <main className="mcd-shell">
        <div className="mcd-intro">
          <span className="mcc-coordinate">Owner only · not linked anywhere</span>
          <h1>Site settings</h1>
          <p>
            Each change is live the moment you save it. No redeploy. Only your account can open this page;
            for anyone else it does not exist.
          </p>
        </div>

        <section className="mcd-card" aria-labelledby="big-h" data-setting="bigStreamViewers">
          <header>
            <span className="mcc-coordinate">Board · featured tier</span>
            <small>{sourceText('bigStreamViewers', s.bigStreamViewers)}</small>
          </header>
          <h2 id="big-h">A big streamer has at least</h2>
          <div className="mcd-row">
            <input
              id="bigStreamViewers"
              type="number"
              inputMode="numeric"
              min={1}
              max={1_000_000}
              step={1}
              value={viewers}
              onChange={(e) => setViewers(e.target.value)}
              aria-invalid={!viewersValid}
              aria-describedby="big-d"
            />
            <span>viewers live on Twitch</span>
          </div>
          <p id="big-d" className="mcd-desc">
            A big streamer gets the big featured card on the board, and two share the top when both are live.
            They keep it until their count drops below 80% of this number. Only a room whose owner has proved the
            Twitch channel can be featured.
          </p>
          <div className="mcd-live">
            <span className="mcd-live-h">Live now</span>
            {data.live.length ? (
              <ul>
                {data.live.map((r) => {
                  // Unedited: what the board shows now (the server's flag,
                  // with its 80% hold). Edited: what the new number would do.
                  const would = r.proven && viewersValid
                    && (viewersNum === s.bigStreamViewers.value ? r.big : r.viewers >= viewersNum)
                  return (
                    <li key={`${r.channel}-${r.name}`}>
                      <span>{r.name}</span>
                      <span className="mcd-mono">{n(r.viewers)}</span>
                      <em className={!r.proven ? 'is-dim' : would ? 'is-yes' : ''}>
                        {!r.proven ? 'channel not proved' : would ? 'featured' : 'normal card'}
                      </em>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="mcd-desc">No room that follows a Twitch channel is live right now.</p>
            )}
          </div>
          <footer>
            <button
              type="button"
              className="mcd-save"
              disabled={!viewersDirty || !!busy}
              onClick={() => void save('bigStreamViewers', viewersNum)}
            >
              {busy === 'bigStreamViewers' ? 'Saving…' : 'Save'}
            </button>
            {!viewersValid ? <p className="mcd-note is-bad">{s.bigStreamViewers.rule}</p> : null}
            <Reset name="bigStreamViewers" />
            <Note name="bigStreamViewers" />
          </footer>
        </section>

        <section className="mcd-card" aria-labelledby="keep-h" data-setting="replayKeepDays">
          <header>
            <span className="mcc-coordinate">Replays · MegaChat clips</span>
            <small>{sourceText('replayKeepDays', s.replayKeepDays)}</small>
          </header>
          <h2 id="keep-h">Keep each aired MegaChat for</h2>
          <div className="mcd-row">
            <div className="mcd-chips" role="group" aria-label="Quick choices">
              {[0, 7, 14, 30].map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={keepNum === d}
                  onClick={() => setKeep(String(d))}
                >
                  {d === 0 ? 'Off' : `${d} days`}
                </button>
              ))}
            </div>
            <input
              id="replayKeepDays"
              type="number"
              inputMode="numeric"
              min={0}
              max={90}
              step={1}
              value={keep}
              onChange={(e) => setKeep(e.target.value)}
              aria-invalid={!keepValid}
              aria-describedby="keep-d"
            />
            <span>days</span>
          </div>
          <p id="keep-d" className="mcd-desc">
            A copy of each MegaChat, so a broadcast&apos;s replay can still show it after Twitch&apos;s recording is gone.
            Fans see this number before they send, and no clip is ever kept longer than its fan was told. A shorter
            time, or off, applies to every clip already kept.
          </p>
          <div className="mcd-stats">
            <span>
              <b className="mcd-mono">{n(data.clips.count)}</b> kept
            </span>
            <span>
              <b className="mcd-mono">{mb(data.clips.bytes)}</b> on disk
            </span>
            {keepDirty && wouldDelete > 0 ? (
              <span className="is-warn">
                Saving deletes <b className="mcd-mono">{n(wouldDelete)}</b> now
              </span>
            ) : null}
          </div>
          <footer>
            <button type="button" className="mcd-save" disabled={!keepDirty || !!busy} onClick={saveKeep}>
              {busy === 'replayKeepDays' ? 'Saving…' : 'Save'}
            </button>
            {!keepValid ? <p className="mcd-note is-bad">{s.replayKeepDays.rule}</p> : null}
            <Reset name="replayKeepDays" />
            <Note name="replayKeepDays" />
          </footer>
        </section>

        <section className="mcd-card" aria-labelledby="quiet-h" data-setting="recentShowsQuiet">
          <header>
            <span className="mcc-coordinate">Board · Recently aired</span>
            <small>{sourceText('recentShowsQuiet', s.recentShowsQuiet)}</small>
          </header>
          <div className="mcd-switch-row">
            <h2 id="quiet-h">Show broadcasts where nothing happened</h2>
            <button
              id="recentShowsQuiet"
              type="button"
              role="switch"
              aria-checked={quietOn}
              aria-labelledby="quiet-h"
              className="mcd-switch"
              disabled={!!busy}
              onClick={() => void save('recentShowsQuiet', !quietOn)}
            >
              <span aria-hidden="true" />
            </button>
          </div>
          <p className="mcd-desc">
            {quietOn
              ? 'On: a broadcast of five minutes or more where nobody took a seat and no MegaChat played also gets a Recently aired card, opening at the start of its recording. Only on a channel its room’s owner has proved, and only once the recording is found.'
              : 'Off: a broadcast gets a Recently aired card only when someone took a seat or a MegaChat played.'}
          </p>
          <div className="mcd-stats">
            <span>
              <b className="mcd-mono">{n(data.quiet.count)}</b> finished broadcast{data.quiet.count === 1 ? '' : 's'} with neither, on proved channels
              {data.quiet.latestEndedAt && local ? `, the latest ${at(data.quiet.latestEndedAt)}` : ''}
            </span>
          </div>
          <footer>
            <Reset name="recentShowsQuiet" />
            <Note name="recentShowsQuiet" />
          </footer>
        </section>

        <section className="mcd-history" aria-labelledby="hist-h">
          <h2 id="hist-h">Changes</h2>
          {data.history.length ? (
            <ol>
              {data.history.map((h, i) => (
                <li key={`${h.at}-${i}`}>
                  <span className="mcd-mono">{at(h.at)}</span>
                  <span>{h.by || 'unknown'}</span>
                  <span>
                    {Object.entries(h.changed)
                      .map(([k, c]) => `${LABELS[k as Name] || k}: ${show(k as Name, c.from)} → ${show(k as Name, c.to)}${c.cleared ? ' (default)' : ''}`)
                      .join(' · ')}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mcd-desc">Nothing changed here yet. Every value above is still its default or Railway&apos;s.</p>
          )}
        </section>
      </main>
    </div>
  )
}
