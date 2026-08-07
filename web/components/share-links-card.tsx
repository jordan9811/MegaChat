'use client'

// Share links — a streamer's two most important URLs (viewer + OBS), promoted
// to their own card at the top of the dashboard's side column. They used to
// live at the BOTTOM of the settings mega-card, under Advanced, styled as an
// afterthought. The OBS how-to is a collapsed guide, not a permanent wall of
// text.

import { useEffect, useState } from 'react'
import { Link2, ChevronDown, BookOpen } from 'lucide-react'
import { GlassCard, CardHeader } from '@/components/glass-card'
import { CopyRow } from '@/components/copy-row'
import { useRoom } from '@/components/room-provider'
import { ObsOneClick } from '@/components/obs/obs-oneclick'

export function ShareLinksCard() {
  const { mode, room, joinUrl, overlayUrl, identityHandle, updateDraft } = useRoom()

  if (mode !== 'managing' || !room || !joinUrl || !overlayUrl) return null

  // The flag rides on the room config route, so an ordinary room can offer
  // this without the bounty feature being on at all.
  const [obsOneClick, setObsOneClick] = useState(false)
  useEffect(() => {
    if (!room?.id) return
    let cancelled = false
    fetch(`/api/config?room=${encodeURIComponent(room.id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => { if (!cancelled && c?.obsOneClick) setObsOneClick(true) })
      .catch(() => { /* button just stays hidden */ })
    return () => { cancelled = true }
  }, [room?.id])

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const viewerLink = origin
    ? room.handle
      ? `${origin}/${room.handle}`
      : `${origin}/join?room=${room.id}`
    : joinUrl
  const obsLink = origin
    ? room.handle
      ? `${origin}/${room.handle}/overlay`
      : `${origin}/overlay?room=${room.id}`
    : overlayUrl

  return (
    <GlassCard id="share-links">
      <CardHeader
        icon={<Link2 className="size-5" />}
        title="Share links"
        description={
          room.active
            ? 'Viewer link goes in chat. OBS link goes in your scene.'
            : 'Room is paused — links keep working when you resume.'
        }
        accent="lime"
      />
      <div className="flex flex-col gap-2 px-5 py-5 sm:px-6">
        <CopyRow label="Viewer" value={viewerLink} />
        <CopyRow label="OBS" value={obsLink} />

        {/* One-click OBS setup, flag-gated. For an ORDINARY room this is a
            convenience sitting next to the copyable link above — not a
            correctness requirement the way it is for a bounty claim, where a
            hand-shrunk source hides the payment badge. Same button, honest
            framing, and the copy row above remains the equal alternative. */}
        {obsOneClick ? (
          <details className="mt-1 rounded-lg border border-border/60 bg-background/30">
            <summary className="cursor-pointer list-none px-3 py-2 text-xs font-semibold text-foreground">
              <span className="inline-flex items-center gap-1.5">
                <ChevronDown className="size-3.5" /> Add it to OBS for me
                <span className="font-normal text-muted-foreground">— or just copy the link above</span>
              </span>
            </summary>
            <div className="px-3 pb-3">
              <ObsOneClick overlayUrl={obsLink} mode="room" />
            </div>
          </details>
        ) : null}
        {room.transport !== 'livekit' ? (
          <CopyRow
            label="Host cam"
            value={`https://vdo.ninja/?push=mc-host-${room.id}&webcam&quality=1080&stereo&autostart`}
          />
        ) : null}

        {!room.handle ? (
          <div className="mt-1 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--neon-lime)]/40 bg-[var(--neon-lime)]/10 px-3 py-2 text-xs text-foreground/90">
            <span className="min-w-0 flex-1 text-pretty">
              Temporary link.{' '}
              {identityHandle
                ? `Claim @${identityHandle} to make it permanent.`
                : 'Set a display name to make it permanent.'}
            </span>
            {identityHandle ? (
              <button
                type="button"
                onClick={() => updateDraft({ handle: identityHandle })}
                className="shrink-0 rounded-full border border-[var(--neon-lime)]/70 bg-[var(--neon-lime)]/15 px-3 py-1.5 font-heading text-xs font-bold uppercase tracking-wide text-[var(--neon-lime)] transition-transform hover:scale-[1.03]"
              >
                Claim /{identityHandle}
              </button>
            ) : null}
          </div>
        ) : null}

        {/* The setup instructions live behind a click — a six-line wall of
            tiny text in permanent view was noise for everyone past day one. */}
        <details className="group mt-1 rounded-lg border border-border/60 bg-input/15">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            <BookOpen className="size-3.5" />
            OBS setup guide
            <ChevronDown className="ml-auto size-3.5 transition-transform group-open:rotate-180" />
          </summary>
          <div className="flex flex-col gap-2 border-t border-border/50 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
            <p className="text-pretty">
              <strong className="text-foreground/90">1 · Cameras on your scene:</strong>{' '}
              add the OBS link as a Browser Source, ~340×620&nbsp;px, transparent
              background.
            </p>
            <p className="text-pretty">
              <strong className="text-foreground/90">2 · Guest audio into your stream:</strong>{' '}
              enable &quot;Control audio via OBS&quot; on that source so guest
              voices and stinger SFX reach your stream mix.
            </p>
            <p className="text-pretty">
              <strong className="text-foreground/90">3 · HEAR guests yourself:</strong>{' '}
              step 2 routes their audio into the OBS mixer — which your own
              ears aren&apos;t in. On the source&apos;s mixer entry (⋮ →
              Advanced Audio Properties), set Audio Monitoring to{' '}
              <strong className="text-foreground/90">Monitor and Output</strong>,
              or they&apos;ll be on your stream but silent to you.
            </p>
            <p className="text-pretty">
              <strong className="text-foreground/90">4 · Smooth video:</strong>{' '}
              in OBS Settings → Advanced, keep &quot;Browser Source Hardware
              Acceleration&quot; ON — without it guest video decodes on the CPU
              your encoder is already using, and tiles get laggy.
            </p>
            <p className="text-pretty">
              <strong className="text-foreground/90">5 · Talk back:</strong>{' '}
              keep this dashboard open while you stream — the Co-host booth is
              the pipe that carries your camera and mic to guests in real time.
            </p>
          </div>
        </details>
      </div>
    </GlassCard>
  )
}
