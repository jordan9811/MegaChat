'use client'

// The step after creating a room: get MegaChat onto the stream. Two things a
// streamer needs — the link their viewers use, and the overlay inside OBS.
// The OBS WebSocket path is recommended because it adds the browser source
// at full-canvas size itself, so nobody types pixel dimensions; the manual
// route (copy the link, follow the steps) sits behind a dropdown for people
// who would rather do it by hand or can't enable the WebSocket server.

import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { CopyRow } from '@/components/copy-row'
import { ObsOneClick } from '@/components/obs/obs-oneclick'
import { useRoom } from '@/components/room-provider'

export function ObsSetup() {
  const { room, joinUrl, overlayUrl, identityHandle, updateDraft } = useRoom()
  // The one-click flag rides on the public room config, so an ordinary room
  // can offer it without the bounty feature being on at all.
  const [oneClick, setOneClick] = useState(false)
  useEffect(() => {
    if (!room?.id) return
    let cancelled = false
    fetch(`/api/config?room=${encodeURIComponent(room.id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => { if (!cancelled && c?.obsOneClick) setOneClick(true) })
      .catch(() => { /* the manual route is always there */ })
    return () => { cancelled = true }
  }, [room?.id])

  if (!room || !joinUrl || !overlayUrl) return null

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const viewerLink = origin ? (room.handle ? `${origin}/${room.handle}` : `${origin}/join?room=${room.id}`) : joinUrl
  const obsLink = origin ? (room.handle ? `${origin}/${room.handle}/overlay` : `${origin}/overlay?room=${room.id}`) : overlayUrl

  return (
    <section className="mcc-obs" aria-label="Get MegaChat on your stream">
      <header>
        <strong>Add it to your stream</strong>
        <small>Your viewers use the link. Your broadcast needs the overlay in OBS.</small>
      </header>
      <div className="mcc-obs-body">
        <CopyRow label="Viewer" value={viewerLink} />

        {/* Two ways in, both folded shut. Expanded, either one is a wall of
            instructions, and showing both at once is how a first-time
            streamer stalls out. */}
        {oneClick ? (
          <details className="mcc-obs-choice">
            <summary>
              <span className="mcc-obs-num">1</span>
              <b>Connect OBS</b>
              <em className="reco">Recommended</em>
              <ChevronDown size={15} aria-hidden="true" />
            </summary>
            <div className="mcc-obs-panel">
              <p>MegaChat talks to OBS and adds the overlay itself, sized correctly. Nothing to type.</p>
              {/* showManual off: choice 2 below IS the manual road, and this
                  component renders its own copy of it by default. */}
              <ObsOneClick overlayUrl={obsLink} mode="room" showManual={false} />
              <p className="mcc-obs-note">Not working? Open <strong>Manual setup</strong> below — it works everywhere.</p>
            </div>
          </details>
        ) : null}

        <details className="mcc-obs-choice">
          <summary>
            {oneClick ? <span className="mcc-obs-num">2</span> : null}
            <b>Manual setup</b>
            <em className="any">Works everywhere</em>
            <ChevronDown size={15} aria-hidden="true" />
          </summary>
          <div className="mcc-obs-panel">
            <CopyRow label="OBS" value={obsLink} />
            {room.transport !== 'livekit' ? (
              <CopyRow label="Host cam" value={`https://vdo.ninja/?push=mc-host-${room.id}&webcam&quality=1080&stereo&autostart`} />
            ) : null}
            <ol className="mcc-obs-steps">
              <li><strong>Add the overlay.</strong> In OBS add a Browser Source with the link above, at your full canvas size, transparent background.</li>
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
