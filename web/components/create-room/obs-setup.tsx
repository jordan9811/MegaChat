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
        <strong>Get it on your stream</strong>
        <small>Your viewers use the link. Your broadcast needs the overlay in OBS.</small>
      </header>
      <div className="mcc-obs-body">
        <CopyRow label="Viewer" value={viewerLink} />

        {oneClick ? (
          <div className="mcc-obs-reco">
            <strong>Recommended · let MegaChat add it to OBS</strong>
            <small>Connects to OBS over its WebSocket and adds the overlay as a browser source at the right size. Nothing to type.</small>
            <ObsOneClick overlayUrl={obsLink} mode="room" />
          </div>
        ) : null}

        <details className="mcc-obs-manual">
          <summary>{oneClick ? 'Step-by-step OBS walkthrough' : 'Add it to OBS by hand'}<ChevronDown size={14} aria-hidden="true" /></summary>
          <div>
            {/* the one-click box already carries the link and the size; only
                the hand route needs them here */}
            {!oneClick ? <CopyRow label="OBS" value={obsLink} /> : null}
            {room.transport !== 'livekit' ? (
              <CopyRow label="Host cam" value={`https://vdo.ninja/?push=mc-host-${room.id}&webcam&quality=1080&stereo&autostart`} />
            ) : null}
            <ol className="mcc-obs-steps">
              <li><strong>Cameras on your scene.</strong> Add the OBS link as a Browser Source, full canvas size, transparent background.</li>
              <li><strong>Guest audio into your stream.</strong> Enable &ldquo;Control audio via OBS&rdquo; on that source so guest voices and stinger sounds reach your mix.</li>
              <li><strong>Hear guests yourself.</strong> Step 2 routes them into the OBS mixer, which your own ears are not in. On the source&rsquo;s mixer entry, set Audio Monitoring to <strong>Monitor and Output</strong>.</li>
              <li><strong>Smooth video.</strong> In OBS Settings → Advanced, keep &ldquo;Browser Source Hardware Acceleration&rdquo; on.</li>
              <li><strong>Talk back.</strong> Keep this page open while you stream. The co-host booth is what carries your camera and mic to guests.</li>
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
