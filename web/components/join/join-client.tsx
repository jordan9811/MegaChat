'use client'

// Viewer join page — app-skin markup around the UNCHANGED legacy join logic
// (lib/join-page.ts, ported verbatim from the since-deleted public/index.html). Element IDs must
// match what that script expects, and the classes it toggles (.show, .success,
// .error, .live, .addr, .adv-only/.simple-only) are styled in join.css.

import { useEffect, useState, type FormEvent } from 'react'
import { FeatureTag } from '@/components/feature-tag'
import { LivenessBadge, type Liveness } from '@/components/liveness-badge'
import { HollerMark } from '@/components/holler-mark'
import { StingerPicker } from '@/components/join/stinger-preview'
import { initJoinPage } from '@/lib/join-page'
import { backendWsUrl } from '@/lib/backend'
import type { RoomFeature } from '@/lib/room-browse'

const primaryBtn =
  'mcj-action mcj-action-record flex w-full items-center justify-center gap-2 px-6 py-3.5 text-[14px] font-bold disabled:opacity-50'

const dopamineBtn =
  'dopamine-btn mcj-action mcj-action-live flex w-full items-center justify-center gap-2 px-6 py-4 text-[15px] font-bold'

const ghostBtn =
  'mcj-secondary flex w-full items-center justify-center gap-2 px-4 py-3 text-[13px] font-semibold disabled:opacity-50'

const miniBtn =
  'mcj-mini flex w-full items-center justify-center gap-1.5 px-3 py-2 text-[12px] font-semibold disabled:opacity-50'

type RoomFlags = {
  letters?: { enabled?: boolean; price?: string | number }
  joinStream?: { enabled?: boolean }
  rewardsEnabled?: boolean
  passkeyTickPrice?: string | number
}

// The same three flags the console below reads, in the order the product
// sells them. Call in follows join-page.ts joinStreamEnabled(): an absent
// block means on, so the tag and the seat controls can never disagree.
function roomFeatures(cfg: RoomFlags): RoomFeature[] {
  const kinds: RoomFeature[] = []
  if (cfg.letters?.enabled === true) kinds.push('holler')
  if (cfg.joinStream?.enabled !== false) kinds.push('callin')
  if (cfg.rewardsEnabled) kinds.push('rewards')
  return kinds
}

// A free room charges for nothing it offers: Call in at no tick price (as
// join-page.ts roomIsFree reads it) and Hollers at no price. Said once, in the
// strip (owner's pick vr-free-zero), instead of "$0" around every control.
function isFreeRoom(cfg: RoomFlags): boolean {
  const callin = cfg.joinStream?.enabled !== false
  const holler = cfg.letters?.enabled === true
  if (!callin && !holler) return false
  const callinFree = !callin || !(parseFloat(String(cfg.passkeyTickPrice ?? '1')) > 0)
  const hollerFree = !holler || !(parseFloat(String(cfg.letters?.price ?? '0')) > 0)
  return callinFree && hollerFree
}

// What this room offers, in the room bar. The script owns the room config and
// announces it with `stream:room`, the config itself as the event's detail, so
// this reads it instead of fetching the same thing a second (and, with the
// wallet provider's, a third) time (audit web-37).
function RoomFeatureTags() {
  const [kinds, setKinds] = useState<RoomFeature[]>([])
  const [free, setFree] = useState(false)

  useEffect(() => {
    const load = (e: Event) => {
      const cfg = (e as CustomEvent<RoomFlags | null>).detail
      if (!cfg) return
      setKinds(roomFeatures(cfg))
      setFree(isFreeRoom(cfg))
    }
    window.addEventListener('stream:room', load)
    return () => window.removeEventListener('stream:room', load)
  }, [])

  if (!kinds.length) return null
  return (
    <span className="join-room-features">
      <span className="sr-only">This room offers: </span>
      {kinds.map((k) => <FeatureTag key={k} kind={k} />)}
      {free ? <span className="join-free-tag">Free room</span> : null}
    </span>
  )
}

// A link that names no room (owner's pick vr-unknown-room): the console gives
// way to this card. The script hides the console and sends `room:notfound`.
function RoomNotFound() {
  const [shown, setShown] = useState(false)
  const [code, setCode] = useState('')
  const [bad, setBad] = useState(false)
  useEffect(() => {
    const on = () => setShown(true)
    window.addEventListener('room:notfound', on)
    return () => window.removeEventListener('room:notfound', on)
  }, [])
  if (!shown) return null
  const go = (e: FormEvent) => {
    e.preventDefault()
    const c = code.trim().replace(/^@/, '')
    if (!/^[a-z0-9_-]{1,32}$/i.test(c)) { setBad(true); return }
    window.location.href = `/join?room=${encodeURIComponent(c.toLowerCase())}`
  }
  return (
    <section className="join-notfound" aria-labelledby="joinNotFoundTitle">
      <h2 id="joinNotFoundTitle">No room at this link</h2>
      <a href="/app" className="mcj-action join-notfound-browse flex w-full items-center justify-center gap-2 px-6 py-3.5 text-[14px] font-bold">Browse live rooms</a>
      <form className="join-notfound-form" onSubmit={go} noValidate>
        <label htmlFor="joinRoomCode" className="lbl">Have a room code?</label>
        <div>
          <input id="joinRoomCode" type="text" autoComplete="off" spellCheck={false} value={code} onChange={(e) => { setCode(e.target.value); setBad(false) }} aria-invalid={bad || undefined} aria-describedby={bad ? 'joinRoomCodeError' : undefined} />
          <button type="submit" className={miniBtn}>Open</button>
        </div>
        {bad ? <p id="joinRoomCodeError" className="join-notfound-error" role="alert">A room code is letters, numbers, - and _.</p> : null}
      </form>
    </section>
  )
}

// Which check stands behind money in this room right now (server
// liveness.js): read every 30s from the public liveness route, keyed by the
// room in the URL (?room=<id>, or the pretty /<handle> path).
const LIVENESS_POLL_MS = 30_000
function RoomLiveness() {
  const [liveness, setLiveness] = useState<Liveness | null>(null)
  useEffect(() => {
    const key = new URLSearchParams(window.location.search).get('room') || window.location.pathname.split('/').filter(Boolean)[0] || ''
    if (!key || key === 'join') return
    let stop = false
    const load = () => fetch(`/api/rooms/${encodeURIComponent(key)}/liveness`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (stop || !d?.tier) return
        setLiveness(d as Liveness)
        window.dispatchEvent(new CustomEvent('room:liveness', { detail: d }))
      })
      .catch(() => {})
    void load()
    const t = setInterval(load, LIVENESS_POLL_MS)
    return () => { stop = true; clearInterval(t) }
  }, [])
  // Every tier shows, Offline included: an off-air room must not look open.
  return <LivenessBadge liveness={liveness} showOff />
}

// While the room is off air, one line right above the Holler button says what
// happens to a Holler sent now. Hidden in every other state (and while the
// room is paused, where the button itself says so).
function OffAirNote() {
  const [offAir, setOffAir] = useState(false)
  useEffect(() => {
    const on = (e: Event) => setOffAir((e as CustomEvent).detail?.tier === 'off')
    window.addEventListener('room:liveness', on)
    return () => window.removeEventListener('room:liveness', on)
  }, [])
  if (!offAir) return null
  return <p className="join-offair-note">Off air: your Holler queues and plays when they go live.</p>
}

// Presentation only. The script writes the status message and the replay's
// moment buttons as plain text, with no hook saying which feature they belong
// to. This reads what it wrote and sets data-feature, so join.css can draw a
// Holler's sent / queued / on-air states in holler magenta and a seat's in call-in
// azure. It never changes the text, the classes the script owns, or any
// click behaviour.
function featureOfMessage(text: string, seated: boolean): RoomFeature | '' {
  if (/\bHollers?\b/.test(text)) return 'holler'
  if (seated || /\b(seat|go live|left the stream)\b/i.test(text)) return 'callin'
  return ''
}

function featureOfMoment(text: string): RoomFeature | '' {
  if (/^Holler\b/.test(text)) return 'holler'
  if (/^On camera\b/.test(text)) return 'callin'
  return ''
}

function setFeature(el: HTMLElement, kind: RoomFeature | '') {
  if (kind) {
    if (el.dataset.feature !== kind) el.dataset.feature = kind
  } else if (el.dataset.feature) {
    delete el.dataset.feature
  }
}

function useFeatureTagging() {
  useEffect(() => {
    const message = document.getElementById('message')
    const moments = document.getElementById('streamReplayMoments')
    const camera = document.getElementById('cameraStage')
    const observers: MutationObserver[] = []

    if (message) {
      const tag = () => setFeature(message, featureOfMessage(message.textContent || '', !!camera?.classList.contains('show')))
      const mo = new MutationObserver(tag)
      mo.observe(message, { childList: true, subtree: true, characterData: true })
      observers.push(mo)
    }
    if (moments) {
      const tag = () => moments.querySelectorAll('button').forEach((b) => setFeature(b, featureOfMoment(b.textContent || '')))
      const mo = new MutationObserver(tag)
      mo.observe(moments, { childList: true })
      observers.push(mo)
    }
    return () => observers.forEach((mo) => mo.disconnect())
  }, [])
}

export function JoinClient() {
  useFeatureTagging()

  useEffect(() => {
    return initJoinPage({ wsUrl: backendWsUrl() })
  }, [])

  return (
    <div className="join-shell mx-auto w-full max-w-[1500px] px-5 pb-10 pt-5">
      <div className="join-room-strip">
        <span className="join-live-label" id="joinRoomState">Room entrance</span>
        <strong id="joinRoomName">Loading room...</strong>
        <RoomFeatureTags />
        <RoomLiveness />
      </div>

      <div className="join-layout">
        {/* The broadcast column is a picture, not page chrome: it stays dark in
            both themes (the .dark scope re-resolves every token inside it). It
            runs the full height of the row, so a console taller than the stage
            never leaves a bare strip of page under the picture; the stage
            inside it stays sticky. */}
        <div className="join-stage-col dark">
          {/* is-idle while nothing real is mounted (join-page.ts
              syncPreviewIdle): on phones the stage folds to a thin strip. */}
          <section className="join-media-stage is-idle" aria-label="Broadcast preview">
            <div id="hostLiveFeed" className="stream-preview host-live" style={{ display: 'none' }}>
              <div className="stream-preview-frame host-live-frame">
                <div id="hostLiveMount" className="stream-preview-mount" />
                {/* Shown instead of the host's picture until their booth confirms
                    it is really them — never OBS's placeholder, never a frozen
                    frame. The host's voice plays either way. */}
                <div id="hostFeedHeld" className="host-feed-held" style={{ display: 'none' }}>
                  <div>
                    <h2 id="hostFeedHeldTitle">Waiting for the host</h2>
                    <p id="hostFeedHeldText">Their camera and voice come through here when they join you.</p>
                  </div>
                </div>
              </div>
              <div className="stream-preview-caption">
                <span className="host-live-label">
                  <span className="host-live-dot" aria-hidden="true" />
                  Real-time with the host — the public stream shows this after a slight delay
                </span>
                <span className="stream-preview-label">Headphones recommended</span>
              </div>
              {/* Shown when this page's mic is sending the host's own voice back
                  (web/lib/echo-detector.ts). */}
              <p id="guestEchoWarn" className="guest-echo-warn" role="alert" hidden>
                <strong>The host can hear their own voice through your mic.</strong> Put on headphones — or mute any
                other tab or app playing the stream.
              </p>
            </div>

            <div id="streamPreview" className="stream-preview" style={{ display: 'none' }}>
              <div className="stream-preview-frame">
                <div id="streamPreviewMount" className="stream-preview-mount" />
              </div>
              <div className="stream-preview-caption">
                <span id="streamPreviewLabel" className="stream-preview-label">Stream preview · slight delay</span>
              </div>
              {/* An offline room plays the replay of its last broadcast here, and
                  these jump to its moments (join-page.ts mountReplay). */}
              <div id="streamReplayMoments" className="stream-replay-moments" hidden />
            </div>

            {/* Nothing to show yet: the same H◉ fallback the create page's
                preview uses, with the note as a quiet caption under it. */}
            <div id="previewIdle" className="join-preview-idle">
              <span className="join-preview-mark" aria-hidden="true"><HollerMark variant="icon" px={52} glow /></span>
              <div>
                {/* "<channel> is off air" when the room's Twitch channel is not
                    live: the player mounts only while it is (mountStreamPreview). */}
                <h1 id="previewIdleTitle">No preview</h1>
              </div>
            </div>
          </section>
        </div>

        <aside className="join-action-console">
          <div className="join-console-body">
            {/* Watch-to-earn on its own line at the top (owner's picks
                rw-earned-in-seat-meter, rw-hint-hidden, rw-pause-silent): the
                terms, this viewer's state and balance, and the one step that
                starts earning. Hidden in rooms that do not reward watching;
                join-page.ts renderRewardsLine fills it. */}
            <section id="rewardsLine" className="join-rewards-line" aria-label="Watch to earn" hidden>
              <p className="join-rewards-text">
                <span className="join-rewards-tag">Watch to earn</span>
                <span id="rewardsState" aria-live="polite" />
                <button id="rewardsSignIn" type="button" className="payout-open" hidden>Sign in to start</button>
                <button id="rewardsPayoutBtn" type="button" className="payout-open" aria-controls="payoutSheet" hidden>Add payout wallet</button>
              </p>
              {/* Opened in place by "Add payout wallet": the account's payout
                  wallet, saved through POST /api/account/payout-wallet. */}
              <div id="payoutSheet" className="payout-sheet" hidden>
                <p className="payout-sheet-title">Where should this room pay you?</p>
                <button id="payoutUseHoller" type="button" className={miniBtn} hidden>Use my Holler wallet</button>
                <form id="payoutForm" className="payout-form" noValidate>
                  <input id="payoutAddress" type="text" autoComplete="off" spellCheck={false} placeholder="Paste an address (0x…)" aria-label="Payout wallet address" />
                  <button id="payoutSave" type="submit" className={miniBtn}>Save</button>
                </form>
                <p id="payoutResult" className="payout-result" aria-live="polite" />
                <button id="payoutClose" type="button" className="payout-close">Cancel</button>
              </div>
              <div id="rewardsMessage" className="join-message" aria-live="polite" />
            </section>

            {/* The seat's meter: on screen only while a seat is held. */}
            <div id="meter" className="join-meter">
              <div><span>Remaining</span><strong id="meterRemaining">—</strong></div>
              <div><span>Spent</span><strong id="meterSpent">$0</strong></div>
              <div><span>Time left</span><strong id="meterTime">—</strong></div>
            </div>

            <section className="join-identity-zone">
              <label htmlFor="username" className="lbl">Display name</label>
              {/* No sign-in button here: the header chip signs in, and Send,
                  Call in and Add funds ask for it the moment they need it. */}
              <input type="text" id="username" autoComplete="off" maxLength={25} enterKeyHint="done" />
              <div id="walletInfo" />
              <div id="passkeyFundNote" style={{ display: 'none' }} />
              <div className="join-wallet-row">
                {/* Shown only when an injected wallet is detected (renderWallet). */}
                <button id="connectBtn" type="button" className={miniBtn} style={{ display: 'none' }}>Connect MetaMask</button>
                <button id="depositBtn" type="button" className={miniBtn}>Fund wallet</button>
              </div>
              <div id="walletMessage" className="join-message" aria-live="polite" />
            </section>

            <section id="megachatAction" className="join-mode-zone is-record" style={{ display: 'none' }}>
              <header><h2>Record a Holler</h2><p>Review before sending. Your clip plays once on the broadcast<span id="letterKeepNote" />.</p></header>
              <OffAirNote />
              <button id="letterBtn" type="button" className={primaryBtn} style={{ display: 'none' }}>
                Send a Holler
              </button>
              <div id="letterStage" className="letter-stage" style={{ display: 'none' }}>
                <div className="cam-frame letter-frame dark"><video id="letterVideo" playsInline muted /></div>
                {/* The review step: shown with Send (join-page.ts letterButtons). */}
                <StingerPicker id="letter" />
                <div id="letterControls" className="letter-controls">
                  <button id="letterRecordBtn" type="button" className={ghostBtn}>Record</button>
                  <button id="letterRedoBtn" type="button" className={ghostBtn} style={{ display: 'none' }}>Re-record</button>
                  <button id="letterSendBtn" type="button" className={primaryBtn} style={{ display: 'none' }}>Send</button>
                  <button id="letterCancelBtn" type="button" className={ghostBtn}>Cancel</button>
                </div>
                <div id="letterRedoConfirm" className="letter-controls letter-redo-confirm" role="group" aria-label="Discard this take?" style={{ display: 'none' }}>
                  <span>Discard this take?</span>
                  <button id="letterRedoYes" type="button" className={ghostBtn}>Discard</button>
                  <button id="letterRedoNo" type="button" className={primaryBtn}>Keep it</button>
                </div>
                <p id="letterStatus" aria-live="polite" />
              </div>
              {/* A Holler's results, under the block that sent it. */}
              <div id="letterMessage" className="join-message" data-feature="holler" aria-live="polite" />
            </section>

            <section id="liveSeatAction" className="join-mode-zone is-live-seat" style={{ display: 'none' }}>
              <header><h2>Call in</h2><p>Your camera stays private until you press Go Live.</p></header>
              {/* While a seat is held the one button (Call in → Go Live → live)
                  is a bar on the camera frame's bottom edge (join.css). */}
              <div id="seatCam" className="seat-cam">
                <div id="cameraStage">
                  <div id="camStatus" className="cam-status">
                    <span className="dot" /><span id="camStatusText">Requesting camera…</span>
                    <span id="lkQualityDot" className="lk-quality" style={{ display: 'none' }} />
                  </div>
                  <div className="cam-frame dark">
                    <iframe id="camPublisher" title="Camera publisher" allow="camera; microphone; autoplay; display-capture; fullscreen" />
                  </div>
                  <iframe id="camDetector" title="Publish detector" className="cam-detector" allow="autoplay" />
                </div>
                <button id="joinBtn" type="button" className={dopamineBtn}>Call in</button>
              </div>
              {/* After Call in, before Go Live (join-page.ts setJoinState). */}
              <StingerPicker id="seat" />
              <button id="camRetryBtn" type="button" className={ghostBtn}>Retry camera</button>
              <div id="camHint" />
              {/* A seat's results, under Call in. */}
              <div id="seatMessage" className="join-message" data-feature="callin" aria-live="polite" />
              {/* Hidden where the seat costs nothing (join-page.ts). */}
              <p id="seatTrustLine" className="join-trust-line">Leave anytime. Every unused cent returns automatically.</p>
            </section>

            <div id="message" className="join-message" aria-live="polite" />
          </div>
          <RoomNotFound />
        </aside>
      </div>
    </div>
  )
}
