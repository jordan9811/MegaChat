'use client'

// The step after creating a room: get Holler onto the stream.
//
// THE OBS LINK COMES FIRST (ss-obs-link-buried). Both links open on the card's
// surface, the OBS overlay first and the viewer link second, so a first-timer
// can no longer copy the one visible link (the viewer page) into OBS. The OBS
// WebSocket road is an "Add it for me" button on the overlay row that opens a
// three-step stepper in place (ss-connect-obs-wall); the by-hand instructions
// stay folded. Under the rows: the overlay's own report when its source is not
// 16:9 (ov-source-size), and "Send a test Holler", which draws sample tiles
// through the real overlay so placement is checked before anyone pays
// (ov-no-test-tile).

import { useEffect, useState } from 'react'
import { Check, ChevronDown, MonitorUp, Play } from 'lucide-react'
import { CopyRow } from '@/components/copy-row'
import { ObsOneClick } from '@/components/obs/obs-oneclick'
import { obsOverlayLink, overlayKeyOf, sourceSizeWrong, useOverlayEnv } from '@/components/obs/use-overlay-env'
import { useRoom } from '@/components/room-provider'
import { fetchPublicConfig } from '@/lib/api'

type TestState = { phase: 'idle' | 'busy' | 'sent' | 'error'; note?: string }

export function ObsSetup() {
  const { room, joinUrl, overlayUrl, identityHandle, updateDraft } = useRoom()
  // The one-click flag rides on the public room config, so an ordinary room
  // can offer it without the bounty feature being on at all.
  const [oneClick, setOneClick] = useState(false)
  const [assist, setAssist] = useState(false)
  useEffect(() => {
    if (!room?.id) return
    let cancelled = false
    setAssist(false)
    // The shared per-page config answer (lib/api.ts), not a request of its own.
    fetchPublicConfig(room.id)
      .then(({ ok, body }) => { if (!cancelled && ok && body.obsOneClick) setOneClick(true) })
      .catch(() => { /* the manual route is always there */ })
    return () => { cancelled = true }
  }, [room?.id])

  // Whether OBS holds the current (keyed) overlay link, from the server's own
  // read of the overlay sockets (liveness route, overlayLink). Replaces the
  // dated "set up OBS before 23 Oct?" sentence with a status.
  const [overlayLink, setOverlayLink] = useState<'keyed' | 'unkeyed' | 'none' | null>(null)
  const [recopied, setRecopied] = useState(false)
  useEffect(() => {
    const key = room?.id
    if (!key) return
    let cancelled = false
    const load = () => fetch(`/api/rooms/${encodeURIComponent(key)}/liveness`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => { if (!cancelled && body) setOverlayLink(body.overlayLink || null) })
      .catch(() => {})
    void load()
    const t = setInterval(load, 30_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [room?.id])

  // The overlay's own size report: a source that is not 16:9 cannot match
  // the preview at any scale, so the card names it (only in that state).
  const env = useOverlayEnv(room?.id)
  const wrongSize = sourceSizeWrong(env)

  const [test, setTest] = useState<TestState>({ phase: 'idle' })
  useEffect(() => { setTest({ phase: 'idle' }) }, [room?.id])

  if (!room || !joinUrl || !overlayUrl) return null

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const viewerLink = origin ? (room.handle ? `${origin}/${room.handle}` : `${origin}/join?room=${room.id}`) : joinUrl
  const obsLink = obsOverlayLink(room, overlayUrl) || overlayUrl

  const sendTest = async () => {
    setTest({ phase: 'busy' })
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(room.id)}/overlay-test`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ k: overlayKeyOf(overlayUrl) }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setTest({ phase: 'error', note: data.error || 'The test did not start' }); return }
      setTest({ phase: 'sent' })
      setTimeout(() => setTest((t) => (t.phase === 'sent' ? { phase: 'idle' } : t)), (Number(data.ms) || 5000) + 800)
    } catch {
      setTest({ phase: 'error', note: 'The test did not start' })
    }
  }

  return (
    <section className="mcc-obs" aria-label="Get Holler on your stream">
      <header>
        <strong>Add it to your stream</strong>
        {overlayLink === 'keyed' ? <span className="mcc-overlay-chip" data-state="keyed"><Check size={12} aria-hidden="true" /> Overlay current</span> : null}
        {overlayLink === 'unkeyed' ? <span className="mcc-overlay-chip" data-state="unkeyed">Old link<button type="button" onClick={() => { void navigator.clipboard?.writeText(obsLink).then(() => { setRecopied(true); setTimeout(() => setRecopied(false), 1800) }).catch(() => {}) }}>{recopied ? 'Copied' : 'Re-copy'}</button></span> : null}
      </header>
      <div className="mcc-obs-body">
        <div className="flex items-center gap-2">
          <CopyRow label="OBS overlay" value={obsLink} className="min-w-0 flex-1" />
          {oneClick ? (
            <button
              type="button"
              aria-expanded={assist}
              onClick={() => setAssist((v) => !v)}
              className="inline-flex h-[38px] shrink-0 items-center gap-1.5 rounded-lg border border-hl-strap bg-hl-strap px-3 text-xs font-bold text-hl-on-strap"
            >
              <MonitorUp className="size-3.5" aria-hidden="true" />
              Add it for me
            </button>
          ) : null}
        </div>
        {oneClick && assist ? (
          // showManual off: the folded Manual setup below IS the manual road.
          <ObsOneClick overlayUrl={obsLink} mode="room" showManual={false} />
        ) : null}
        {wrongSize ? (
          <p role="status" className="text-xs font-semibold text-f-bounty-ink">
            OBS source is {wrongSize.width}×{wrongSize.height} · set it to your canvas size
          </p>
        ) : null}
        <CopyRow label="Viewer link" value={viewerLink} />

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={test.phase === 'busy' || test.phase === 'sent'}
            onClick={() => void sendTest()}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-input/30 px-3 text-xs font-bold text-foreground disabled:opacity-60"
          >
            <Play className="size-3.5" aria-hidden="true" />
            {test.phase === 'busy' ? 'Sending…' : test.phase === 'sent' ? 'Playing in OBS' : 'Send a test Holler'}
          </button>
          {test.phase === 'error' ? <span role="alert" className="text-xs text-f-bounty-ink">{test.note}</span> : null}
        </div>

        <details className="mcc-obs-choice">
          <summary>
            <b>Manual setup</b>
            <em className="any">Works everywhere</em>
            <ChevronDown size={15} aria-hidden="true" />
          </summary>
          <div className="mcc-obs-panel">
            {room.transport !== 'livekit' ? (
              <CopyRow label="Host cam" value={`https://vdo.ninja/?push=mc-host-${room.id}&webcam&quality=1080&stereo&autostart`} />
            ) : null}
            <ol className="mcc-obs-steps">
              <li><strong>Add the overlay.</strong> In OBS add a Browser Source with the OBS overlay link, at your full canvas size, transparent background.</li>
              <li><strong>Let guests be heard.</strong> Tick &ldquo;Control audio via OBS&rdquo; on that source so guest voices and stinger sounds reach your stream.</li>
              <li><strong>Hear them yourself.</strong> Step 2 sends them to the OBS mixer, which your own ears are not in. On that source&rsquo;s mixer entry set Audio Monitoring to <strong>Monitor and Output</strong>.</li>
              <li><strong>Keep video smooth.</strong> In OBS Settings → Advanced, leave &ldquo;Browser Source Hardware Acceleration&rdquo; on.</li>
              <li><strong>Talk back.</strong> Keep this page open while you stream — it carries your camera and mic to guests.</li>
            </ol>
          </div>
        </details>

        {!room.handle ? (
          <div className="mcc-obs-temp">
            <span>Temporary link. {identityHandle ? `Claim @${identityHandle} to make it permanent.` : 'Set a display name to make it permanent.'}</span>
            {identityHandle ? <button type="button" onClick={() => updateDraft({ handle: identityHandle })}>Claim /{identityHandle}</button> : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}
