'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPledge, postFrames, uploadClip, type BountyClientConfig, type ProgramPool } from '@/lib/bounty-api'
import { formatDollars, guestName } from '@/lib/display-format'
import { useAccount } from '@/lib/use-account'

type Stage = 'terms' | 'idle' | 'requesting' | 'recording' | 'preview' | 'sending' | 'done'
const EXPIRIES = [
  { label: '3 days', ms: 3 * 86_400_000 },
  { label: '1 week', ms: 7 * 86_400_000 },
  { label: '2 weeks', ms: 14 * 86_400_000 },
  { label: '30 days', ms: 30 * 86_400_000 },
]
const TARGET_PLATFORMS = ['twitch', 'kick', 'x', 'rumble', 'youtube', 'pumpfun'] as const

export function RecordFlow({ target, config, otherPools, onDone, onCancel }: {
  target: { platform: string; handle: string }
  config: BountyClientConfig
  otherPools: ProgramPool[]
  onDone: (contributor: string) => void
  onCancel: () => void
}) {
  const { identity, signedIn, openSignIn, authError } = useAccount()
  const [stage, setStage] = useState<Stage>('terms')
  const [amount, setAmount] = useState('5')
  const [expiryMs, setExpiryMs] = useState(EXPIRIES[1].ms)
  const [name, setName] = useState('')
  const nameEdited = useRef(false)
  const [extraTargets, setExtraTargets] = useState<string[]>([])
  const [newTargetPlatform, setNewTargetPlatform] = useState<(typeof TARGET_PLATFORMS)[number]>('twitch')
  const [newTargetHandle, setNewTargetHandle] = useState('')
  const [targetError, setTargetError] = useState('')
  const [blob, setBlob] = useState<Blob | null>(null)
  const [duration, setDuration] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')
  const [uploadPending, setUploadPending] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const frames = useRef<string[]>([])
  const requestId = useRef(0)
  const pendingPledge = useRef<Awaited<ReturnType<typeof createPledge>> | null>(null)
  const submitInFlight = useRef(false)

  useEffect(() => {
    if (!nameEdited.current) setName(identity?.handle || guestName())
  }, [identity?.handle])

  const stopMedia = useCallback(() => {
    stream.current?.getTracks().forEach((track) => track.stop())
    stream.current = null
    if (timer.current) clearInterval(timer.current)
    timer.current = null
  }, [])

  useEffect(() => () => {
    requestId.current++
    if (recorder.current) {
      recorder.current.onstop = null
      if (recorder.current.state !== 'inactive') recorder.current.stop()
    }
    stopMedia()
  }, [stopMedia])

  useEffect(() => {
    if (!blob || !video.current) return
    const url = URL.createObjectURL(blob)
    video.current.srcObject = null
    video.current.src = url
    video.current.controls = true
    video.current.muted = false
    return () => URL.revokeObjectURL(url)
  }, [blob])

  function validTerms() {
    if (!/^\d+(\.\d{1,6})?$/.test(amount) || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      setError('Enter an amount greater than $0, with up to six decimal places.')
      return false
    }
    setError('')
    return true
  }

  function addTarget() {
    const raw = newTargetHandle.trim().replace(/^@/, '')
    const handle = newTargetPlatform === 'pumpfun' ? raw : raw.toLowerCase()
    const valid = newTargetPlatform === 'pumpfun'
      ? /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(handle)
      : /^[a-z0-9_.-]{1,40}$/.test(handle)
    const key = `${newTargetPlatform}:${handle}`
    if (!valid) { setTargetError('Enter a valid streamer handle.'); return }
    if (key === `${target.platform}:${target.handle}` || extraTargets.includes(key)) { setTargetError('That streamer is already included.'); return }
    if (extraTargets.length >= 2) { setTargetError('You can add up to two other streamers.'); return }
    setExtraTargets((prev) => [...prev, key])
    setNewTargetHandle('')
    setTargetError('')
  }

  async function record() {
    if (stage !== 'idle') return
    const id = ++requestId.current
    setStage('requesting')
    setError('')
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('Recording is unavailable in this browser. Try Chrome or Edge on localhost or HTTPS.')
      }
      const capture = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      if (id !== requestId.current) { capture.getTracks().forEach((track) => track.stop()); return }
      stream.current = capture
      const v = video.current!
      v.removeAttribute('src')
      v.srcObject = capture
      v.muted = true
      v.controls = false
      await v.play()
      if (id !== requestId.current) { capture.getTracks().forEach((track) => track.stop()); return }
      const mime = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((type) => MediaRecorder.isTypeSupported(type))
      const rec = new MediaRecorder(capture, mime ? { mimeType: mime } : undefined)
      recorder.current = rec
      const chunks: Blob[] = []
      frames.current = []
      const start = Date.now()
      rec.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
      rec.onerror = () => {
        rec.onstop = null
        stopMedia()
        setError('Recording stopped unexpectedly. Nothing was submitted; try another take.')
        setStage('idle')
      }
      rec.onstop = () => {
        stopMedia()
        if (id !== requestId.current) return
        const seconds = Math.floor((Date.now() - start) / 1000)
        if (seconds < config.minClipSeconds) {
          setError(`Record at least ${config.minClipSeconds} seconds. This take was not submitted.`)
          setStage('idle')
          return
        }
        setDuration(seconds)
        setBlob(new Blob(chunks, { type: rec.mimeType || 'video/webm' }))
        setStage('preview')
      }
      rec.start()
      setElapsed(0)
      setStage('recording')
      let lastSample = 0
      timer.current = setInterval(() => {
        const seconds = Math.floor((Date.now() - start) / 1000)
        setElapsed(seconds)
        if (seconds - lastSample < 4 || frames.current.length >= 12 || !v.videoWidth) return
        lastSample = seconds
        const canvas = document.createElement('canvas')
        canvas.width = 320
        canvas.height = Math.round(320 * v.videoHeight / v.videoWidth)
        const context = canvas.getContext('2d')
        if (context) { context.drawImage(v, 0, 0, canvas.width, canvas.height); frames.current.push(canvas.toDataURL('image/jpeg', .6)) }
      }, 500)
    } catch (e) {
      if (id !== requestId.current) return
      stopMedia()
      setStage('idle')
      setError(e instanceof DOMException && e.name === 'NotAllowedError'
        ? 'Camera or microphone permission was denied. Allow both in your browser, then retry. Your bounty settings are saved here.'
        : e instanceof DOMException && e.name === 'NotFoundError'
          ? 'No camera or microphone was found. Connect one, then retry.'
          : e instanceof Error ? e.message : 'Camera unavailable. Check permissions and retry.')
    }
  }

  function cancelCamera() {
    requestId.current++
    stopMedia()
    setStage('idle')
  }

  async function submit() {
    if (!blob || submitInFlight.current || !validTerms()) return
    if (!signedIn) { openSignIn(); return }
    submitInFlight.current = true
    setStage('sending')
    try {
      // Retry a failed media upload against the same pledge, never another balance entry.
      if (!pendingPledge.current) {
        pendingPledge.current = await createPledge({
          targets: [target, ...extraTargets.map((key) => { const [platform, handle] = key.split(':'); return { platform, handle } })],
          contributor: name.trim() || identity?.handle || 'Viewer', amount, expiresInMs: expiryMs,
        })
        setUploadPending(true)
      }
      const pledge = pendingPledge.current
      if (blob.size > pledge.clipLimits.maxBytes) throw new Error('This recording exceeds the upload size limit. Check My bounties for the pending pledge before starting over.')
      if (frames.current.length) await postFrames(pledge.uploadUrl, frames.current)
      await uploadClip(pledge.uploadUrl, blob, duration)
      setStage('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Submission failed. Your take is still here.')
      setStage('terms')
    } finally { submitInFlight.current = false }
  }

  const choices = otherPools.filter((p) => !p.claimed && p.platform && p.handle && !(p.platform === target.platform && p.handle === target.handle)).slice(0, 8)
  const showTerms = stage === 'terms' || stage === 'sending'
  const button = 'inline-flex min-h-10 items-center justify-center border border-border px-4 py-2 text-sm font-semibold text-foreground disabled:opacity-50'
  const primary = `${button} bg-primary text-primary-foreground`

  return (
    <section className="bounty-record-flow max-w-4xl border border-border bg-card p-6">
      <header className="flex items-start justify-between gap-5">
        <div className="min-w-0"><h2 className="break-words text-xl font-bold">Bounty for {target.handle}</h2><p className="mt-1 text-sm text-muted-foreground">Amount and terms, then record and review. Nothing submits until you confirm.</p></div>
        <button type="button" className={button} onClick={onCancel} disabled={stage === 'sending'}>Close</button>
      </header>
      <p className="mt-4 border-l-2 border-[var(--neon-amber)] bg-background/40 p-3 text-sm text-muted-foreground">Preview only. No real payment or refund is sent in this build.</p>

      {showTerms && <div className="mt-5 space-y-5">
        <fieldset disabled={stage === 'sending' || uploadPending} className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-2 text-sm">Bounty amount ($)<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="border border-border bg-background/40 px-3 py-2" /></label>
          <label className="grid gap-2 text-sm">Display name<input value={name} maxLength={64} onChange={(e) => { nameEdited.current = true; setName(e.target.value) }} className="border border-border bg-background/40 px-3 py-2" /></label>
          <label className="grid gap-2 text-sm">Offer expires after<select value={expiryMs} onChange={(e) => setExpiryMs(Number(e.target.value))} className="border border-border bg-background/40 px-3 py-2">{EXPIRIES.map((expiry) => <option key={expiry.ms} value={expiry.ms}>{expiry.label}</option>)}</select></label>
        </fieldset>
        <fieldset disabled={stage === 'sending' || uploadPending}>
          <legend className="mb-2 text-sm">Also offer to other streamers (optional, up to 2)</legend>
          {choices.length > 0 && <div className="flex flex-wrap gap-2">{choices.map((pool) => {
            const key = `${pool.platform}:${pool.handle}`
            const selected = extraTargets.includes(key)
            return <button key={key} type="button" aria-pressed={selected} disabled={!selected && extraTargets.length >= 2} className={`${button} max-w-full break-all ${selected ? 'border-primary bg-primary/10' : ''}`} onClick={() => setExtraTargets((prev) => selected ? prev.filter((item) => item !== key) : [...prev, key])}>{pool.handle}</button>
          })}</div>}
          <div className="mt-3 grid gap-2 sm:grid-cols-[140px_minmax(0,1fr)_auto]">
            <select aria-label="Streamer platform" value={newTargetPlatform} onChange={(e) => setNewTargetPlatform(e.target.value as typeof newTargetPlatform)} className="min-h-10 border border-border bg-background/40 px-3 text-sm">
              {TARGET_PLATFORMS.map((platform) => <option key={platform} value={platform}>{platform === 'pumpfun' ? 'Pump.fun' : platform === 'x' ? 'X' : platform[0].toUpperCase() + platform.slice(1)}</option>)}
            </select>
            <input aria-label="Streamer handle" value={newTargetHandle} onChange={(e) => { setNewTargetHandle(e.target.value); setTargetError('') }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTarget() } }} placeholder="Streamer handle" className="min-h-10 min-w-0 border border-border bg-background/40 px-3 text-sm" />
            <button type="button" className={button} disabled={extraTargets.length >= 2 || !newTargetHandle.trim()} onClick={addTarget}>Add streamer</button>
          </div>
          {targetError && <p role="alert" className="mt-2 text-sm text-[#ffbbb3]">{targetError}</p>}
          {extraTargets.filter((key) => !choices.some((pool) => `${pool.platform}:${pool.handle}` === key)).length > 0 && <div className="mt-2 flex flex-wrap gap-2">{extraTargets.filter((key) => !choices.some((pool) => `${pool.platform}:${pool.handle}` === key)).map((key) => <button key={key} type="button" className={`${button} max-w-full break-all border-primary bg-primary/10`} onClick={() => setExtraTargets((prev) => prev.filter((item) => item !== key))}>{key.replace(':', ' / ')} ×</button>)}</div>}
          {extraTargets.length > 0 && <p className="mt-2 text-sm text-muted-foreground">One {formatDollars(amount)} pledge, shared across {extraTargets.length + 1} names. Only one can receive it.</p>}
        </fieldset>
        <div className="border-t border-border pt-4 text-sm text-muted-foreground"><strong className="text-foreground">Review and refund rules</strong><p>Minimum recording: {config.minClipSeconds} seconds. A declined clip or an unclaimed, expired offer refunds in full. The first content-policy rejection refunds in full; repeat policy rejections refund 50%, with the remainder going to the bounty pool.</p></div>
        {!blob ? <button type="button" className={primary} onClick={() => { if (validTerms()) setStage('idle') }}>Continue to recording</button> : <div className="flex flex-wrap gap-3">
          <button type="button" disabled={stage === 'sending'} className={primary} onClick={() => void submit()}>{stage === 'sending' ? 'Submitting...' : !signedIn ? 'Sign in to submit' : uploadPending ? 'Retry upload' : `Submit ${formatDollars(amount)} preview pledge`}</button>
          {!uploadPending && <button type="button" className={button} disabled={stage === 'sending'} onClick={() => setStage('preview')}>Review recording</button>}
        </div>}
        {uploadPending && <p className="text-sm text-muted-foreground">The pledge exists. Retrying reuses it; the terms are now locked.</p>}
      </div>}

      <div hidden={showTerms && !blob || stage === 'done'} className="mt-5">
        <div className="relative overflow-hidden border border-border bg-[#07121c]">
          <video ref={video} playsInline aria-label="Bounty recording preview" className="aspect-video w-full max-h-[360px]" />
          {!blob && stage !== 'recording' && <span className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-muted-foreground">{stage === 'requesting' ? 'Allow camera and microphone in your browser' : 'Camera off'}</span>}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {stage === 'idle' && <><button type="button" className={primary} onClick={() => void record()}>Record</button><button type="button" className={button} onClick={() => setStage('terms')}>Back to terms</button><span className="text-sm text-muted-foreground">At least {config.minClipSeconds} seconds</span></>}
          {stage === 'requesting' && <><span role="status" className="text-sm">Waiting for camera permission...</span><button type="button" className={button} onClick={cancelCamera}>Cancel camera request</button></>}
          {stage === 'recording' && <><button type="button" className={primary} onClick={() => recorder.current?.stop()}>Stop recording</button><span role="status" className="text-sm text-[var(--neon-amber)]">Recording {elapsed}s</span></>}
          {stage === 'preview' && <><button type="button" className={primary} onClick={() => setStage('terms')}>Review and confirm</button><button type="button" className={button} onClick={() => { setBlob(null); setError(''); setStage('idle') }}>Re-record</button><span className="text-sm text-muted-foreground">{duration}s recorded</span></>}
        </div>
      </div>
      {(error || authError) && <p role="alert" className="mt-4 text-sm text-[#ffbbb3]">{error || authError}</p>}
      {stage === 'done' && <div className="mt-5"><h3 className="text-lg font-bold text-[var(--neon-lime)]">Preview pledge submitted</h3><p className="my-3 text-sm text-muted-foreground">Your recording is ready for moderation. No real funds moved.</p><button type="button" className={primary} onClick={() => onDone(identity ? `${identity.provider}:${identity.username}` : name)}>View my contributions</button></div>}
    </section>
  )
}
