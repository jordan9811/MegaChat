'use client'

// RECORD AND SEND — the fan-facing front door of the bounty mechanic.
//
// Flow, in the approved order:
//   record → preview → re-record if unhappy → amount → expiry → pay → submit
//
// Two rules are load-bearing:
//  - PAY AT SUBMIT, NEVER AT RECORD. Nobody pays for a take they are about to
//    discard, so the pledge (the escrow moment) happens only after the fan has
//    seen their take and set the terms.
//  - Everything that affects the money is DISCLOSED BEFORE the pay step: the
//    minimum duration before recording starts, the rejection policy and the
//    expiry-refund behaviour on the confirm screen. A deduction discovered
//    after the fact is a different class of problem on a payments product.
//
// This is its own recording context on purpose. A MegaChat records INTO a
// room, and an unclaimed streamer has no room — faking one to reuse that path
// would drag in seat auth, meter plumbing and the overlay queue for nothing.
// The recorder here shares the important parts by construction instead: the
// same min-duration config (via /api/bounty/config) and the same moderation
// pipeline server-side.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Circle, Square, RotateCcw, Send, ShieldAlert, Clock } from 'lucide-react'
import {
  createPledge, postFrames, uploadClip,
  type BountyClientConfig, type ProgramPool, type RejectionPolicy,
} from '@/lib/bounty-api'

type Stage = 'idle' | 'recording' | 'preview' | 'terms' | 'sending' | 'done' | 'error'

const EXPIRY_CHOICES = [
  { label: '3 days', ms: 3 * 86_400_000 },
  { label: '1 week', ms: 7 * 86_400_000 },
  { label: '2 weeks', ms: 14 * 86_400_000 },
  { label: '30 days', ms: 30 * 86_400_000 },
]

export function RecordFlow({
  target,
  config,
  otherPools,
  onDone,
}: {
  target: { platform: string; handle: string }
  config: BountyClientConfig
  /** Other unclaimed pools this pledge could ALSO back (restaking). */
  otherPools: ProgramPool[]
  onDone: (contributor: string) => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const recRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const framesRef = useRef<string[]>([])
  const frameTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startedAtRef = useRef(0)

  const [stage, setStage] = useState<Stage>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [durationS, setDurationS] = useState(0)
  const [amount, setAmount] = useState('5')
  const [expiryMs, setExpiryMs] = useState(EXPIRY_CHOICES[1].ms)
  const [contributor, setContributor] = useState('')
  const [extraTargets, setExtraTargets] = useState<string[]>([]) // "platform:handle"
  const [policy, setPolicy] = useState<RejectionPolicy | null>(null)
  const [error, setError] = useState<string | null>(null)
  // null = still checking / unknown · false = anonymous · true = signed in
  const [signedIn, setSignedIn] = useState<boolean | null>(null)

  // The pledge route is FAN-tier, so an anonymous fan's submit would die with
  // a 401 AFTER they recorded and filled the form. Ask who they are when the
  // terms open and say so on the pay button instead of failing late. Unknown
  // (fetch failed) deliberately does NOT disable — the server still decides.
  useEffect(() => {
    if (stage !== 'terms') return
    let gone = false
    fetch('/api/auth/me', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => { if (!gone) setSignedIn(!!d.identity) })
      .catch(() => { if (!gone) setSignedIn(null) })
    return () => { gone = true }
  }, [stage])

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])
  useEffect(() => () => {
    stopTracks()
    if (frameTimerRef.current) clearInterval(frameTimerRef.current)
  }, [stopTracks])

  async function startRecording() {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      streamRef.current = stream
      const v = videoRef.current!
      v.srcObject = stream
      v.muted = true
      void v.play()

      chunksRef.current = []
      framesRef.current = []
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm' })
      recRef.current = rec
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data) }
      rec.onstop = () => {
        const dur = Math.max(1, Math.ceil((Date.now() - startedAtRef.current) / 1000))
        setDurationS(dur)
        const b = new Blob(chunksRef.current, { type: 'video/webm' })
        setBlob(b)
        stopTracks()
        if (frameTimerRef.current) clearInterval(frameTimerRef.current)
        const vv = videoRef.current!
        vv.srcObject = null
        vv.src = URL.createObjectURL(b)
        vv.muted = false
        vv.controls = true
        // Too short to verify on stream → never offer to pay for it.
        if (dur < config.minClipSeconds) {
          setError(`That take was ${dur}s — it needs at least ${config.minClipSeconds}s to be verifiable on stream. Nothing was charged. Go again.`)
          setStage('idle')
          return
        }
        setStage('preview')
      }

      // Frame sampling density SCALES WITH LENGTH: one frame roughly every 4s
      // of recording, capped at 12 — a 30s clip sends ~8 frames where a 6s
      // clip sends 2, instead of a fixed count either starving long clips or
      // spamming short ones.
      startedAtRef.current = Date.now()
      frameTimerRef.current = setInterval(() => {
        try {
          if (framesRef.current.length >= 12 || !v.videoWidth) return
          const c = document.createElement('canvas')
          c.width = 320
          c.height = Math.round(320 * (v.videoHeight / v.videoWidth)) || 180
          c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height)
          framesRef.current.push(c.toDataURL('image/jpeg', 0.6))
        } catch { /* best-effort */ }
      }, 4000)

      rec.start()
      setStage('recording')
      setElapsed(0)
      const tick = setInterval(() => {
        const s = Math.floor((Date.now() - startedAtRef.current) / 1000)
        setElapsed(s)
        if (recRef.current?.state !== 'recording') clearInterval(tick)
      }, 500)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Camera unavailable')
    }
  }

  function stopRecording() {
    try { recRef.current?.stop() } catch { /* already stopped */ }
  }

  function redo() {
    setBlob(null)
    setStage('idle')
    setError(null)
    const v = videoRef.current
    if (v) { v.src = ''; v.controls = false }
  }

  async function paySubmit() {
    if (!blob) return
    if (!(parseFloat(amount) > 0)) { setError('Enter a positive amount'); return }
    setStage('sending')
    setError(null)
    try {
      const targets = [
        target,
        ...extraTargets.map((k) => {
          const [platform, handle] = k.split(':')
          return { platform, handle }
        }),
      ]
      // THE pay moment — escrow is written here, after preview and terms.
      const pledge = await createPledge({
        targets, contributor: contributor.trim(), amount, expiresInMs: expiryMs,
      })
      setPolicy(pledge.rejectionPolicy)
      // Frames ride ahead so moderation has them when the media lands.
      if (framesRef.current.length) {
        await postFrames(pledge.uploadUrl, framesRef.current).catch(() => { /* fail-open */ })
      }
      await uploadClip(pledge.uploadUrl, blob, durationS)
      setStage('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Submit failed')
      setStage('error')
    }
  }

  const unclaimedOthers = otherPools
    .filter((p) => !p.claimed && !(p.platform === target.platform && p.handle === target.handle))
    .slice(0, 8)

  return (
    <div className="rounded-2xl border border-border/70 bg-card/60 p-5 backdrop-blur-sm">
      <h3 className="font-heading text-lg font-bold text-foreground">
        Record a MegaChat for {target.handle}
      </h3>
      {/* The requirement, BEFORE recording starts — not after a failed take. */}
      <p className="mt-0.5 text-xs text-muted-foreground">
        {config.minClipSeconds}s minimum (shorter can&apos;t be verified on stream, so it&apos;s never charged) ·
        plays on their broadcast if they claim · refunds automatically if nobody claims before your expiry.
      </p>

      <div className="relative mt-3 overflow-hidden rounded-xl border border-border bg-black">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- live cam preview */}
        <video ref={videoRef} playsInline className="aspect-video w-full" />
        {stage === 'recording' ? (
          <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs font-bold text-[var(--neon-magenta)]">
            <span className="size-2 animate-pulse rounded-full bg-[var(--neon-magenta)]" /> REC {elapsed}s
          </span>
        ) : null}
      </div>

      {error ? <p className="mt-2 text-sm text-[var(--neon-magenta)]">{error}</p> : null}

      {stage === 'idle' ? (
        <button type="button" onClick={startRecording}
          className="mt-3 inline-flex items-center gap-2 rounded-full bg-[var(--neon-magenta)] px-5 py-2.5 text-sm font-bold text-white transition-transform hover:scale-[1.02]">
          <Circle className="size-4" /> Record
        </button>
      ) : null}
      {stage === 'recording' ? (
        <button type="button" onClick={stopRecording}
          className="mt-3 inline-flex items-center gap-2 rounded-full bg-foreground px-5 py-2.5 text-sm font-bold text-background">
          <Square className="size-4" /> Stop
        </button>
      ) : null}

      {stage === 'preview' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={redo}
            className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-bold text-foreground">
            <RotateCcw className="size-4" /> Re-record
          </button>
          <button type="button" onClick={() => setStage('terms')}
            className="inline-flex items-center gap-2 rounded-full bg-[var(--neon-lime)] px-5 py-2.5 text-sm font-bold text-black">
            Looks good — set the bounty
          </button>
          <span className="text-xs text-muted-foreground">{durationS}s take</span>
        </div>
      ) : null}

      {stage === 'terms' || stage === 'sending' || stage === 'error' ? (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm font-medium text-foreground">Bounty amount ({config.currency})</span>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal"
                className="mt-1 w-full rounded-xl border border-border bg-input/30 px-3.5 py-2.5 text-sm text-foreground" />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-foreground">Display name <span className="font-normal text-muted-foreground">(optional)</span></span>
              <input value={contributor} onChange={(e) => setContributor(e.target.value)}
                placeholder="Shown beside your bounty"
                className="mt-1 w-full rounded-xl border border-border bg-input/30 px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground" />
              {/* The money keys to the signed-in ACCOUNT, not to this string —
                  saying otherwise here would misstate where a refund goes, on
                  the exact screen where someone decides to pay. */}
              <span className="mt-1 block text-xs text-muted-foreground">Refunds go to the account you&apos;re signed in with.</span>
            </label>
          </div>

          <div>
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <Clock className="size-4 text-muted-foreground" /> Offer expires after
            </span>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {EXPIRY_CHOICES.map((c) => (
                <button key={c.ms} type="button" onClick={() => setExpiryMs(c.ms)}
                  className={`rounded-full border px-3.5 py-1.5 text-xs font-bold ${expiryMs === c.ms
                    ? 'border-[var(--neon-cyan)] text-[var(--neon-cyan)]'
                    : 'border-border text-muted-foreground'}`}>
                  {c.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              If {target.handle} hasn&apos;t claimed by then, your full amount refunds automatically. Nothing is ever locked forever.
            </p>
          </div>

          {unclaimedOthers.length ? (
            <div>
              <span className="text-sm font-medium text-foreground">
                Also offer this to… <span className="text-xs font-normal text-muted-foreground">(optional, max 2 more — first to claim takes the whole bounty)</span>
              </span>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {unclaimedOthers.map((p) => {
                  const k = `${p.platform}:${p.handle}`
                  const on = extraTargets.includes(k)
                  return (
                    <button key={k} type="button"
                      onClick={() => setExtraTargets((cur) => on
                        ? cur.filter((x) => x !== k)
                        : cur.length >= 2 ? cur : [...cur, k])}
                      className={`rounded-full border px-3 py-1.5 text-xs font-bold ${on
                        ? 'border-[var(--neon-violet)] text-[var(--neon-violet)]'
                        : 'border-border text-muted-foreground'}`}>
                      {p.handle}
                    </button>
                  )
                })}
              </div>
              {extraTargets.length ? (
                <p className="mt-1 text-xs text-[var(--neon-amber)]">
                  Heads up: one bounty, {extraTargets.length + 1} doors. Whoever claims first gets it — the others will see it leave their pool.
                </p>
              ) : null}
            </div>
          ) : null}

          {/* The rejection policy, BEFORE the pay button. */}
          <div className="rounded-xl border border-[var(--neon-amber)]/50 bg-[var(--neon-amber)]/5 p-3">
            <p className="flex items-center gap-1.5 text-sm font-bold text-[var(--neon-amber)]">
              <ShieldAlert className="size-4" /> Before you pay
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs leading-relaxed text-muted-foreground">
              <li>The streamer reviews every clip before it airs. If they simply pass on yours, you get a <strong className="text-foreground">full refund</strong>.</li>
              <li>If a clip breaks the content rules: first time is a full refund with a warning on your account; after that, rejected clips refund at <strong className="text-foreground">50%</strong>, and the rest goes to the streamer&apos;s bounty pool — not to us.</li>
              <li>No real money moves in this preview build — the escrow is a ledger and payouts are recorded, not sent.</li>
            </ul>
          </div>

          <button type="button" disabled={stage === 'sending' || signedIn === false} onClick={paySubmit}
            className="inline-flex items-center gap-2 rounded-full bg-[var(--neon-lime)] px-5 py-2.5 text-sm font-bold text-black transition-transform hover:scale-[1.02] disabled:opacity-60">
            <Send className="size-4" />
            {stage === 'sending' ? 'Sending…' : `Pay ${amount} ${config.currency} & send`}
          </button>
          {signedIn === false ? (
            <p className="text-xs text-[var(--neon-amber)]">
              Sign in first (top right) — the bounty and any refund attach to your account.
              Your recording stays right here while you do.
            </p>
          ) : null}
        </div>
      ) : null}

      {stage === 'done' ? (
        <div className="mt-4 rounded-xl border border-[var(--neon-lime)]/50 bg-[var(--neon-lime)]/5 p-4">
          <p className="font-heading text-sm font-bold text-[var(--neon-lime)]">Sent 🎉</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Your MegaChat is in {target.handle}&apos;s bounty{extraTargets.length ? ` (and ${extraTargets.length} more)` : ''}.
            {policy ? ' The review policy you saw applies from here.' : ''} Track every step on your status page.
          </p>
          <button type="button" onClick={() => onDone(contributor.trim())}
            className="mt-2 text-sm font-bold text-[var(--neon-cyan)] underline-offset-2 hover:underline">
            View my contributions →
          </button>
        </div>
      ) : null}
    </div>
  )
}
