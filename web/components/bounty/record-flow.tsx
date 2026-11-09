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
import { Circle, Square, RotateCcw, Send, ShieldAlert, Clock, Share2, Check } from 'lucide-react'
import {
  createPledge, fundPledge, postFrames, uploadClip,
  type BountyClientConfig, type ProgramPool, type RejectionPolicy, type PledgeApprovalAsk, type PledgeFundProof,
} from '@/lib/bounty-api'
// Real money: the same approve-and-sign step a campaign creator uses to fund a
// budget, with the pledge's words. The wallet approves exactly the pledge
// amount to Holler's bounty spender, then signs that it means THIS pledge.
import { ApproveStep, connectedWallet, type ApprovalAsk } from '@/components/campaigns/approve-step'
import { getChainInfo } from '@/lib/campaigns-api'
import { getAccountPrefs } from '@/lib/api'
import { FeatureTag } from '@/components/feature-tag'
import { newAttemptId } from '@/lib/attempt-id'
import { useAccount } from '@/lib/use-account'
import { recorderMime } from '@/lib/recorder-mime'

type Stage = 'idle' | 'recording' | 'preview' | 'terms' | 'funding' | 'sending' | 'done' | 'error'

// Colour roles (Holler SPEC §3): the recording itself is the holler magenta —
// the Record button, the REC light, the finished take. Money and the bounty
// steps are bounty yellow; a choice you have made is strap azure; the
// done state is rewards green; an error is the danger orange. The camera frame stays dark in both themes.
const CHOICE_ON = 'border-hl-strap-hi bg-hl-strap/15 text-foreground'
const CHOICE_OFF = 'border-border text-muted-foreground'
const BOUNTY_SOLID = 'bg-f-bounty-solid text-f-bounty-on'
// Every control on the pledge step is at least 44px tall (UX sweep tb-touch-targets).
const CHIP = 'inline-flex min-h-11 items-center rounded-full border px-4 text-xs font-bold'

const MB = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const EXPIRY_CHOICES = [
  { label: '3 days', ms: 3 * 86_400_000 },
  { label: '1 week', ms: 7 * 86_400_000 },
  { label: '2 weeks', ms: 14 * 86_400_000 },
  { label: '30 days', ms: 30 * 86_400_000 },
]
const AMOUNT_PRESETS = ['5', '10', '25']

/**
 * THE MONEY FIELD (UX sweep bo-amount-parse). Digits and one '.' only, as
 * typed: '$', ',' and spaces are stripped, so "$1,000" becomes 1000, never 1.
 * At most 6 decimal places (USDC's).
 */
export function cleanAmount(raw: string): string {
  const s = raw.replace(/[^\d.]/g, '')
  const dot = s.indexOf('.')
  if (dot === -1) return s.slice(0, 12)
  return `${s.slice(0, dot).slice(0, 12)}.${s.slice(dot + 1).replace(/\./g, '').slice(0, 6)}`
}

/**
 * The ONE number the button prints, the server books and My bounties shows:
 * no leading zeros, no trailing '.' or zeros after the point. Null when it is
 * not a positive amount. The server refuses anything else (bounty-escrow.js
 * isCanonicalAmount), before it writes a pledge.
 */
export function canonicalAmount(s: string): string | null {
  if (!/^\d*\.?\d*$/.test(s)) return null
  const [w, f = ''] = s.split('.')
  const whole = w.replace(/^0+(?=\d)/, '') || '0'
  const frac = f.replace(/0+$/, '')
  const out = frac ? `${whole}.${frac}` : whole
  return /^(0|[1-9]\d{0,11})(\.\d{1,6})?$/.test(out) && Number(out) > 0 ? out : null
}

function cameraMessage(e: unknown): string {
  const name = e instanceof Error ? e.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera blocked. Allow the camera for this site, then press Record.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera found. Plug one in, then press Record.'
  if (name === 'NotReadableError') return 'Another app is using the camera. Close it, then press Record.'
  return e instanceof Error ? e.message : 'Camera unavailable'
}

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
  const rootRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const amountRef = useRef<HTMLInputElement>(null)
  const recRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const framesRef = useRef<string[]>([])
  const frameTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startedAtRef = useRef(0)
  // The take's playback URL holds the whole recording in memory until revoked.
  const previewUrlRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  // ONE PLEDGE PER TAKE (audit web-5). attemptId names the take on the pledge
  // (the server answers a repeat with the first pledge, bounty-routes.js), and
  // pledgeRef keeps the pledge once it exists, so a failed upload retries the
  // UPLOAD and never escrows the fan's money a second time.
  const attemptIdRef = useRef<string | null>(null)
  const pledgeRef = useRef<{ uploadUrl: string; id?: string; funded?: boolean } | null>(null)
  // Real money: the pledge the server asked us to fund, and the approve step's ask.
  const [approval, setApproval] = useState<PledgeApprovalAsk | null>(null)
  const [explorerUrl, setExplorerUrl] = useState('https://explore.tempo.xyz')
  const realMoney = config.money?.mode === 'real'
  // The liveness tier this pledge releases at: the account's preference
  // (Account → Bounty protection) prefills it, green (badge-verified only) by
  // default, and the fan can change it for THIS pledge right here (UX sweep
  // bo-tier-link: the old link to settings threw the take away).
  const [minTier, setMinTier] = useState<'green' | 'yellow'>('green')
  useEffect(() => { getAccountPrefs().then((p) => setMinTier(p.prefs.bountyMinTier)).catch(() => {}) }, [])
  useEffect(() => { if (realMoney) getChainInfo().then((c) => setExplorerUrl(c.explorerUrl)).catch(() => {}) }, [realMoney])
  const [pledged, setPledged] = useState(false)

  const [stage, setStage] = useState<Stage>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [durationS, setDurationS] = useState(0)
  const [amount, setAmount] = useState('5')
  const [expiryMs, setExpiryMs] = useState(EXPIRY_CHOICES[1].ms)
  const [contributor, setContributor] = useState('')
  const [extraTargets, setExtraTargets] = useState<string[]>([]) // "platform:handle"
  const [policy, setPolicy] = useState<RejectionPolicy | null>(null)
  // Camera and recording problems print under the camera; anything the pay
  // step says prints directly above Pay (UX sweep bo-amount-input), where the
  // fan who pressed it is looking.
  const [error, setError] = useState<string | null>(null)
  const [payError, setPayError] = useState<string | null>(null)
  const [amountInvalid, setAmountInvalid] = useState(false)
  // The live camera before Record (UX sweep bo-recorder-fold): framing first,
  // then a 3-2-1, then the take.
  const [cam, setCam] = useState<'starting' | 'live' | 'off'>('starting')
  const [countdown, setCountdown] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)

  // The pledge route is FAN-tier, so an anonymous fan's submit would die with
  // a 401 AFTER they recorded and filled the form. useAccount hears the
  // sign-in (megachat:identity) without a reload, so the one button turns from
  // "Sign in to pay" into "Pay" the moment it lands, with the take and terms
  // untouched (UX sweep bo-pay-signin). Until the account has loaded the
  // button is Pay: the server still decides.
  const { loaded: accountLoaded, signedIn, openSignIn, authError } = useAccount()
  const needsSignIn = accountLoaded && !signedIn

  const canon = canonicalAmount(amount)
  const currency = config.currency
  const yellowPct = Math.round((config.tiers?.yellowReleaseFraction ?? 0.1) * 100)
  const yellowMin = Math.round((config.tiers?.yellowMinMs ?? 600_000) / 60_000)

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setCam('off')
  }, [])
  const setPreviewUrl = useCallback((b: Blob | null) => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    previewUrlRef.current = b ? URL.createObjectURL(b) : null
    return previewUrlRef.current
  }, [])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      stopTracks()
      setPreviewUrl(null)
      if (frameTimerRef.current) clearInterval(frameTimerRef.current)
    }
  }, [stopTracks, setPreviewUrl])

  /** Open the camera into the frame, live and unrecorded. */
  const startPreview = useCallback(async (cancelled: () => boolean = () => false): Promise<MediaStream | null> => {
    if (streamRef.current) return streamRef.current
    setError(null)
    if (!navigator.mediaDevices?.getUserMedia) { setCam('off'); setError('This browser cannot open a camera here.'); return null }
    setCam('starting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      if (cancelled() || !mountedRef.current) { stream.getTracks().forEach((t) => t.stop()); return null }
      // A second open that raced this one: keep one camera, not two.
      const prev = streamRef.current as MediaStream | null
      if (prev) { stream.getTracks().forEach((t) => t.stop()); return prev }
      streamRef.current = stream
      const v = videoRef.current
      if (v) {
        v.removeAttribute('src')
        v.srcObject = stream
        v.muted = true
        v.controls = false
        void v.play().catch(() => {})
      }
      setCam('live')
      return stream
    } catch (e) {
      if (!cancelled()) { setCam('off'); setError(cameraMessage(e)) }
      return null
    }
  }, [])

  // The recorder opens in view, with the camera already on.
  useEffect(() => {
    rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    let gone = false
    void startPreview(() => gone)
    return () => { gone = true }
  }, [startPreview])

  async function startRecording() {
    setError(null)
    // Asked first: MediaRecorder throws on a format the browser cannot
    // record (Safari has no WebM), and that used to leave the camera on.
    const mime = recorderMime()
    if (!mime) { setError('This browser cannot record video here.'); return }
    const stream = await startPreview()
    if (!stream) return
    // 3-2-1 on the live frame, so the take starts when the fan is ready.
    for (const n of [3, 2, 1]) {
      setCountdown(n)
      await sleep(1000)
      if (!mountedRef.current || streamRef.current !== stream) { setCountdown(null); return }
    }
    setCountdown(null)
    try {
      const v = videoRef.current!

      chunksRef.current = []
      framesRef.current = []
      const rec = new MediaRecorder(stream, { mimeType: mime })
      recRef.current = rec
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data) }
      rec.onstop = () => {
        stopTracks()
        if (frameTimerRef.current) clearInterval(frameTimerRef.current)
        // Unmounted mid-take (the cleanup stopped the tracks, which stops the
        // recorder): nothing left to show it in.
        const vv = videoRef.current
        if (!mountedRef.current || !vv) return
        const dur = Math.max(1, Math.ceil((Date.now() - startedAtRef.current) / 1000))
        setDurationS(dur)
        // The bare type, no codec list: the clip route refuses a codec list with a
        // comma in it (video/webm;codecs=vp8,opus), as letters.js does.
        const b = new Blob(chunksRef.current, { type: mime.split(';')[0] })
        setBlob(b)
        vv.srcObject = null
        vv.src = setPreviewUrl(b) || ''
        vv.muted = false
        vv.controls = true
        // A new take is a new pledge.
        attemptIdRef.current = newAttemptId()
        pledgeRef.current = null
        setPledged(false)
        // Too short to verify on stream → never offer to pay for it. Back
        // to the live camera for another go.
        const refuse = (msg: string) => {
          setBlob(null)
          setPreviewUrl(null)
          vv.removeAttribute('src')
          vv.controls = false
          setStage('idle')
          void startPreview().then(() => setError(msg))
        }
        if (dur < config.minClipSeconds) {
          refuse(`That take was ${dur}s — it needs at least ${config.minClipSeconds}s to be verifiable on stream. Nothing was charged. Go again.`)
          return
        }
        // Too big for the clip route: refused here, before any pledge, not
        // after the money is escrowed and the upload is turned away.
        if (config.clipMaxBytes && b.size > config.clipMaxBytes) {
          refuse(`That take is ${MB(b.size)}, over the ${MB(config.clipMaxBytes)} limit. Nothing was charged. Record a shorter one.`)
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
      // Whatever failed (the recorder), the camera goes off.
      stopTracks()
      if (frameTimerRef.current) clearInterval(frameTimerRef.current)
      if (videoRef.current) videoRef.current.srcObject = null
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
    setPayError(null)
    // Reached only before a pledge (the error stage offers a retry, not a
    // re-record), so nothing is left behind; cleared all the same.
    attemptIdRef.current = null
    pledgeRef.current = null
    setPledged(false)
    const v = videoRef.current
    if (v) { v.removeAttribute('src'); v.controls = false }
    setPreviewUrl(null)
    void startPreview()
  }

  function amountProblem() {
    setPayError('Type a number, like 5')
    setAmountInvalid(true)
    amountRef.current?.focus()
  }

  async function paySubmit() {
    if (!blob) return
    if (!pledgeRef.current && !canon) { amountProblem(); return }
    if (config.clipMaxBytes && blob.size > config.clipMaxBytes) {
      setPayError(`That take is ${MB(blob.size)}, over the ${MB(config.clipMaxBytes)} limit. Record a shorter one.`)
      return
    }
    setStage('sending')
    setPayError(null)
    try {
      let pledge = pledgeRef.current
      if (!pledge) {
        const targets = [
          target,
          ...extraTargets.map((k) => {
            const [platform, handle] = k.split(':')
            return { platform, handle }
          }),
        ]
        attemptIdRef.current = attemptIdRef.current || newAttemptId()
        // THE pay moment — escrow is written here, after preview and terms.
        // The canonical number, the same one the button printed.
        setAmount(canon!)
        const out = await createPledge({
          targets, contributor: contributor.trim(), amount: canon!, expiresInMs: expiryMs,
          attemptId: attemptIdRef.current, minTier,
        })
        pledge = { uploadUrl: out.uploadUrl, id: out.pledge.id, funded: !out.requiresFunding }
        pledgeRef.current = pledge
        setPledged(true)
        setPolicy(out.rejectionPolicy)
        // Real money: nothing is charged yet. The wallet approves and signs
        // next; the upload waits until the pledge is funded.
        if (out.requiresFunding && out.funding?.needsApproval) {
          setApproval(out.funding.needsApproval)
          setStage('funding')
          return
        }
      }
      if (pledge.funded === false) {
        // A retry after the wallet step was cancelled: ask again.
        setStage('funding')
        return
      }
      // Frames ride ahead so moderation has them when the media lands.
      if (framesRef.current.length) {
        await postFrames(pledge.uploadUrl, framesRef.current).catch(() => { /* fail-open */ })
      }
      // Idempotent per contribution server-side: a retry of an upload that
      // did land answers with the stored clip.
      await uploadClip(pledge.uploadUrl, blob, durationS)
      setStage('done')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Submit failed'
      setPayError(msg)
      setStage('error')
      // The server's amount refusal is a field error too.
      if (!pledgeRef.current && /amount/i.test(msg)) { setAmountInvalid(true); amountRef.current?.focus() }
    }
  }

  /** Real money: the wallet approved and signed — pull the pledge, then send the take. */
  async function fundAndSend(proof: PledgeFundProof) {
    const pledge = pledgeRef.current
    if (!pledge?.id) throw new Error('No pledge to fund. Start again.')
    const wallet = await connectedWallet()
    const r = await fundPledge(pledge.id, { wallet, approveTx: proof.approveTx, signature: proof.signature, typedData: proof.typedData })
    if ('needsApproval' in r && r.needsApproval) { setApproval(r.needsApproval); return }
    if (!('ok' in r) || !r.ok) throw new Error('The pledge could not be funded.')
    pledge.funded = true
    pledgeRef.current = pledge
    setApproval(null)
    await paySubmit()
  }

  // After paying: send the streamer the page (UX sweep bo-tell-streamer). A
  // phone gets its share sheet; a desktop copies the link.
  const poolPath = `/bounty/s/${encodeURIComponent(target.platform)}/${encodeURIComponent(target.handle)}`
  async function sendLink() {
    const url = `${window.location.origin}${poolPath}`
    const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
    if (coarse && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: `A Holler bounty for ${target.handle}`, text: `${target.handle}, there's a Holler waiting for you. Claim it here:`, url })
        return
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return
      }
    }
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => { if (mountedRef.current) setCopied(false) }, 2000)
    } catch { /* the address is printed under the button */ }
  }

  const unclaimedOthers = otherPools
    .filter((p) => !p.claimed && !(p.platform === target.platform && p.handle === target.handle))
    .slice(0, 8)

  const payStage = stage === 'terms' || stage === 'funding' || stage === 'sending' || stage === 'error'
  const liveFrame = stage === 'idle' || stage === 'recording'
  const payLabel = stage === 'sending' ? 'Sending…'
    : stage === 'funding' ? 'Approve in wallet above'
      : pledged ? (pledgeRef.current?.funded === false ? 'Fund & send' : 'Retry upload')
        : needsSignIn ? (canon ? `Sign in to pay ${canon} ${currency}` : 'Sign in to pay')
          : !canon ? 'Pay & send'
            : realMoney ? `Pledge ${canon} ${currency} — approve in wallet` : `Pay ${canon} ${currency} & send`
  const shownPayError = payError || (needsSignIn ? authError : null)

  return (
    <div ref={rootRef} className="scroll-mt-20 rounded-2xl border border-border/70 bg-card/60 p-5 backdrop-blur-sm">
      <h3 className="font-heading text-lg font-bold text-foreground">
        Record a Holler for {target.handle}
      </h3>
      {/* The requirement, BEFORE recording starts — not after a failed take. */}
      <p className="mt-0.5 text-xs text-muted-foreground">
        {config.minClipSeconds}s minimum (shorter can&apos;t be verified on stream, so it&apos;s never charged) ·
        plays on their broadcast if they claim · refunds automatically if nobody claims before your expiry.
      </p>

      {/* Capped at 60vh so the controls stay on screen; 16:9 kept by width. */}
      <div className="dark relative mx-auto mt-3 overflow-hidden rounded-xl border border-border bg-hl-bg" style={{ maxWidth: 'calc(60vh * 16 / 9)' }}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- live cam preview */}
        <video ref={videoRef} playsInline
          className={`aspect-video w-full object-cover ${liveFrame ? '-scale-x-100' : ''}`} />
        {liveFrame && cam !== 'live' ? (
          <span className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-muted-foreground">
            {cam === 'starting' ? 'Opening your camera…' : 'Camera is off'}
          </span>
        ) : null}
        {stage === 'recording' ? (
          <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-hl-bg/75 px-2.5 py-1 text-xs font-bold text-f-holler-ink">
            <span className="size-2 animate-pulse rounded-full bg-hl-record" /> REC {elapsed}s
          </span>
        ) : null}
        {countdown !== null ? (
          <span aria-live="assertive" className="absolute inset-0 grid place-items-center bg-hl-bg/35 font-heading text-7xl font-bold text-white tabular">
            {countdown}
          </span>
        ) : null}
        {/* Record and Stop sit on the frame's bottom edge, in view with it. */}
        {stage === 'idle' ? (
          <button type="button" onClick={startRecording} disabled={countdown !== null}
            className="absolute bottom-3 left-1/2 inline-flex min-h-11 -translate-x-1/2 items-center gap-2 rounded-full bg-f-holler-solid px-5 text-sm font-bold text-f-holler-on shadow-lg transition-transform duration-150 ease-[cubic-bezier(.23,1,.32,1)] active:scale-[.97] disabled:opacity-70">
            <Circle className="size-4 fill-current" /> {countdown !== null ? 'Get ready…' : 'Record'}
          </button>
        ) : null}
        {stage === 'recording' ? (
          <button type="button" onClick={stopRecording}
            className="absolute bottom-3 left-1/2 inline-flex min-h-11 -translate-x-1/2 items-center gap-2 rounded-full bg-white px-5 text-sm font-bold text-black shadow-lg">
            <Square className="size-4" /> Stop
          </button>
        ) : null}
      </div>

      {error && !payStage ? <p role="alert" className="mt-2 text-sm text-hl-danger">{error}</p> : null}

      {stage === 'preview' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={redo}
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border px-4 text-sm font-bold text-foreground">
            <RotateCcw className="size-4" /> Re-record
          </button>
          <button type="button" onClick={() => { setError(null); setStage('terms') }}
            className={`inline-flex min-h-11 items-center gap-2 rounded-full px-5 text-sm font-bold transition-transform duration-150 ease-[cubic-bezier(.23,1,.32,1)] active:scale-[.97] ${BOUNTY_SOLID}`}>
            Looks good — set the bounty
          </button>
          <FeatureTag kind="holler">{durationS}s take</FeatureTag>
        </div>
      ) : null}

      {payStage ? (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="bounty-amount" className="text-sm font-medium text-foreground">Bounty amount</label>
              {/* A money field: fixed $ and unit, digits and one '.' only.
                  The terms lock once the pledge exists: a retry uploads under
                  the pledge already made, so the form must show its terms. */}
              <div className={`mt-1 flex h-11 items-center rounded-xl border bg-input/30 ${amountInvalid ? 'border-hl-danger ring-2 ring-hl-danger/40' : 'border-border'}`}>
                <span aria-hidden="true" className="pl-3.5 text-sm font-bold text-muted-foreground">$</span>
                <input id="bounty-amount" ref={amountRef} value={amount} disabled={pledged}
                  onChange={(e) => { setAmount(cleanAmount(e.target.value)); setAmountInvalid(false); if (payError) setPayError(null) }}
                  onBlur={() => { if (canon && canon !== amount) setAmount(canon) }}
                  inputMode="decimal" autoComplete="off" aria-invalid={amountInvalid || undefined}
                  aria-describedby={amountInvalid ? 'bounty-pay-error' : undefined}
                  className="h-full min-w-0 flex-1 bg-transparent px-1.5 text-sm text-foreground outline-none tabular" />
                <span aria-hidden="true" className="pr-3.5 text-xs font-bold text-muted-foreground">{currency}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {AMOUNT_PRESETS.map((v) => (
                  <button key={v} type="button" disabled={pledged} aria-pressed={canon === v}
                    onClick={() => { setAmount(v); setAmountInvalid(false); setPayError(null) }}
                    className={`${CHIP} min-w-14 justify-center tabular ${canon === v ? CHOICE_ON : CHOICE_OFF}`}>
                    ${v}
                  </button>
                ))}
              </div>
            </div>
            <label className="block">
              <span className="text-sm font-medium text-foreground">Display name <span className="font-normal text-muted-foreground">(optional)</span></span>
              <input value={contributor} onChange={(e) => setContributor(e.target.value)} disabled={pledged} maxLength={64}
                placeholder="Shown beside your bounty"
                className="mt-1 h-11 w-full rounded-xl border border-border bg-input/30 px-3.5 text-sm text-foreground placeholder:text-muted-foreground" />
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
                <button key={c.ms} type="button" onClick={() => setExpiryMs(c.ms)} disabled={pledged}
                  aria-pressed={expiryMs === c.ms}
                  className={`${CHIP} ${expiryMs === c.ms ? CHOICE_ON : CHOICE_OFF}`}>
                  {c.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {`If ${target.handle} hasn't claimed by then, your full amount refunds automatically. Nothing is ever locked forever.`}
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
                    <button key={k} type="button" disabled={pledged}
                      onClick={() => setExtraTargets((cur) => on
                        ? cur.filter((x) => x !== k)
                        : cur.length >= 2 ? cur : [...cur, k])}
                      aria-pressed={on}
                      className={`${CHIP} ${on ? CHOICE_ON : CHOICE_OFF}`}>
                      {p.handle}
                    </button>
                  )
                })}
              </div>
              {extraTargets.length ? (
                <p className="mt-1 text-xs text-f-bounty-ink">
                  Heads up: one bounty, {extraTargets.length + 1} doors. Whoever claims first gets it — the others will see it leave their pool.
                </p>
              ) : null}
            </div>
          ) : null}

          {/* Which check releases this money, chosen for THIS pledge, BEFORE
              the pay button. Prefilled from the account. */}
          <fieldset disabled={pledged}>
            <legend className="text-sm font-medium text-foreground">When it pays out</legend>
            <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
              {([
                ['green', 'Pay only for verified airtime'],
                ['yellow', `Also release a ${yellowPct}% slice if the overlay stayed up ${yellowMin} min`],
              ] as const).map(([tier, label]) => (
                <label key={tier}
                  className={`flex min-h-11 cursor-pointer items-center gap-2.5 rounded-xl border px-3.5 py-2 text-xs font-bold has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-hl-strap-hi ${minTier === tier ? CHOICE_ON : CHOICE_OFF}`}>
                  <input type="radio" name="bounty-min-tier" value={tier} checked={minTier === tier}
                    onChange={() => setMinTier(tier)} className="size-4 shrink-0 accent-[var(--hl-strap-hi)]" />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          {/* The rejection policy, BEFORE the pay button. */}
          <div className="rounded-xl border border-f-bounty-line bg-f-bounty-bg p-3">
            <p className="flex items-center gap-1.5 text-sm font-bold text-f-bounty-ink">
              <ShieldAlert className="size-4" /> Before you pay
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs leading-relaxed text-muted-foreground">
              <li>The streamer reviews every clip before it airs. If they simply pass on yours, you get a <strong className="text-foreground">full refund</strong>.</li>
              <li>If a clip breaks the content rules: first time is a full refund with a warning on your account; after that, rejected clips refund at <strong className="text-foreground">50%</strong>, and the rest goes to the streamer&apos;s bounty pool — not to us.</li>
              {realMoney
                ? <li>Your wallet approves <strong className="text-foreground">exactly this amount</strong> and signs for this pledge; it is then held in Holler&apos;s pool wallet and any refund comes back from there.</li>
                : <li>No real money moves in this preview build — the escrow is a ledger and payouts are recorded, not sent.</li>}
            </ul>
          </div>

          {approval && stage === 'funding' ? (
            approval.spender ? (
              <ApproveStep subject="pledge" ask={approval as ApprovalAsk} explorerUrl={explorerUrl}
                onApproved={(proof) => fundAndSend(proof as PledgeFundProof)}
                onCancel={() => { setStage('terms') }} />
            ) : <p role="alert" className="text-sm text-hl-danger">This server can&apos;t take pledges right now (no bounty spender is configured). Nothing was charged.</p>
          ) : null}

          <div>
            {/* Everything the pay step says lands here, right above Pay. */}
            <p id="bounty-pay-error" role="alert" className={shownPayError ? 'mb-2 text-sm font-medium text-hl-danger' : 'sr-only'}>
              {shownPayError || ''}
            </p>
            <button type="button" disabled={stage === 'sending' || stage === 'funding'}
              onClick={needsSignIn && !pledged ? openSignIn : paySubmit}
              className={`inline-flex min-h-11 items-center gap-2 rounded-full px-5 text-sm font-bold transition-transform duration-150 ease-[cubic-bezier(.23,1,.32,1)] active:scale-[.97] disabled:opacity-60 ${BOUNTY_SOLID}`}>
              <Send className="size-4" />
              {payLabel}
            </button>
          </div>
          {pledged && stage === 'error' ? (
            <p className="text-xs text-muted-foreground">
              {pledgeRef.current?.funded === false ? 'Your pledge is recorded but not funded yet; nothing has been charged.' : 'Your pledge is in. Retrying sends this take again, with no second payment.'}
            </p>
          ) : null}
        </div>
      ) : null}

      {stage === 'done' ? (
        <div className="mt-4 rounded-xl border border-f-rewards-line bg-f-rewards-bg p-4">
          <p className="font-heading text-sm font-bold text-f-rewards-ink">Sent 🎉</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Your Holler is in {target.handle}&apos;s bounty{extraTargets.length ? ` (and ${extraTargets.length} more)` : ''}.
            {policy ? ' The review policy you saw applies from here.' : ''} It only pays if {target.handle} hears about it and claims it.
          </p>
          {/* The next thing that matters: the streamer has to hear about it. */}
          <button type="button" onClick={() => void sendLink()}
            className={`mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg px-5 text-sm font-bold transition-transform duration-150 ease-[cubic-bezier(.23,1,.32,1)] active:scale-[.97] ${BOUNTY_SOLID}`}>
            {copied ? <Check className="size-4" aria-hidden="true" /> : <Share2 className="size-4" aria-hidden="true" />}
            {copied ? 'Copied' : `Send ${target.handle} the link`}
          </button>
          <p className="mt-1.5 break-all text-[11px] text-muted-foreground" aria-live="polite">
            {typeof window !== 'undefined' ? window.location.host : ''}{poolPath}
          </p>
          <button type="button" onClick={() => onDone(contributor.trim())}
            className="mt-2 inline-flex min-h-11 items-center text-sm font-bold text-foreground underline decoration-hl-strap-hi decoration-2 underline-offset-4">
            See it in My bounties →
          </button>
        </div>
      ) : null}
    </div>
  )
}
