'use client'

// Viewer join page — app-skin markup around the UNCHANGED legacy join logic
// (lib/join-page.ts, ported verbatim from the since-deleted public/index.html). Element IDs must
// match what that script expects, and the classes it toggles (.show, .success,
// .error, .live, .addr, .adv-only/.simple-only) are styled in join.css.

import { useEffect, useState } from 'react'
import { FeatureTag } from '@/components/feature-tag'
import { HollerMark } from '@/components/holler-mark'
import { StingerPreview } from '@/components/join/stinger-preview'
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
  letters?: { enabled?: boolean }
  joinStream?: { enabled?: boolean }
  rewardsEnabled?: boolean
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

// What this room offers, in the room bar. The script owns the room config and
// announces it with `stream:room`, the config itself as the event's detail, so
// this reads it instead of fetching the same thing a second (and, with the
// wallet provider's, a third) time (audit web-37).
function RoomFeatureTags() {
  const [kinds, setKinds] = useState<RoomFeature[]>([])

  useEffect(() => {
    const load = (e: Event) => {
      const cfg = (e as CustomEvent<RoomFlags | null>).detail
      if (cfg) setKinds(roomFeatures(cfg))
    }
    window.addEventListener('stream:room', load)
    return () => window.removeEventListener('stream:room', load)
  }, [])

  if (!kinds.length) return null
  return (
    <span className="join-room-features">
      <span className="sr-only">This room offers: </span>
      {kinds.map((k) => <FeatureTag key={k} kind={k} />)}
    </span>
  )
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
        <span>Your camera stays private until you confirm.</span>
      </div>

      <div
        id="demoBanner"
        className="join-demo-banner"
        style={{ display: 'none' }}
      >
        This is a live demo room. Farm rewards by watching, send a Holler, go
        live for pennies — everything here runs the real machinery at dust
        prices.
      </div>

      <div className="join-layout">
        {/* The broadcast column is a picture, not page chrome: it stays dark in
            both themes (the .dark scope re-resolves every token inside it). It
            runs the full height of the row, so a console taller than the stage
            never leaves a bare strip of page under the picture; the stage
            inside it stays sticky. */}
        <div className="join-stage-col dark">
          <section className="join-media-stage" aria-label="Broadcast preview">
            <div id="hostLiveFeed" className="stream-preview host-live" style={{ display: 'none' }}>
              <div className="stream-preview-frame host-live-frame">
                <div id="hostLiveMount" className="stream-preview-mount" />
                {/* Shown instead of the host's picture until their booth confirms
                    it is really them — never OBS's placeholder, never a frozen
                    frame. The host's voice plays either way. */}
                <div id="hostFeedHeld" className="host-feed-held" style={{ display: 'none' }}>
                  <div>
                    <span className="join-coordinate">Host camera</span>
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
                <span id="streamPreviewDrops" className="stream-preview-drops" style={{ display: 'none' }}>
                  Watching earns rewards in this room
                </span>
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
                <span className="join-coordinate">Stream preview</span>
                <h1>Preview unavailable</h1>
                <p>This room is not publishing a preview here. Recording and call-in controls still work normally.</p>
              </div>
            </div>
          </section>
        </div>

        <aside className="join-action-console">
          <div className="join-console-body">
            <section className="join-price-zone">
              <span className="join-coordinate">Room rate</span>
              <div>
                <span id="priceAmount">—</span>
                <span id="priceLabel">loading room…</span>
              </div>
            </section>

            <div id="meter" className="join-meter">
              <div><span>Remaining</span><strong id="meterRemaining">—</strong></div>
              <div><span>Spent</span><strong id="meterSpent">$0</strong></div>
              <div><span>Time left</span><strong id="meterTime">—</strong></div>
              <div id="earnedRow" style={{ display: 'none' }}>
                <span>Earned</span><strong id="rewardsEarned">0</strong>
              </div>
            </div>

            <section className="join-identity-zone">
              <label htmlFor="username" className="lbl">Display name</label>
              <input type="text" id="username" autoComplete="off" maxLength={20} />
              <div id="privyChoice">
                <button id="passkeyBtn" type="button" className={ghostBtn}>
                  Sign in — Google, email or passkey
                </button>
              </div>
              <div id="walletInfo" />
              <div id="passkeyFundNote" style={{ display: 'none' }} />
              <div className="join-wallet-row">
                <button id="connectBtn" type="button" className={miniBtn}>Connect MetaMask</button>
                <button id="depositBtn" type="button" className={miniBtn}>Fund wallet</button>
              </div>
            </section>

            <section id="megachatAction" className="join-mode-zone is-record" style={{ display: 'none' }}>
              <header><h2>Record a Holler</h2><p>Review before sending. Your clip plays once on the broadcast<span id="letterKeepNote" />.</p></header>
              <button id="letterBtn" type="button" className={primaryBtn} style={{ display: 'none' }}>
                Send a Holler
              </button>
              <div id="letterStage" className="letter-stage" style={{ display: 'none' }}>
                <div className="cam-frame letter-frame dark"><video id="letterVideo" playsInline muted /></div>
                <div className="letter-controls">
                  <button id="letterRecordBtn" type="button" className={ghostBtn}>Record</button>
                  <button id="letterRedoBtn" type="button" className={ghostBtn} style={{ display: 'none' }}>Re-record</button>
                  <button id="letterSendBtn" type="button" className={primaryBtn} style={{ display: 'none' }}>Send</button>
                  <button id="letterCancelBtn" type="button" className={ghostBtn}>Cancel</button>
                </div>
                <p id="letterStatus" aria-live="polite" />
              </div>
            </section>

            <section id="liveSeatAction" className="join-mode-zone is-live-seat" style={{ display: 'none' }}>
              <header><h2>Call in</h2><p>Your camera stays private until you press Go Live.</p></header>
              <div id="cameraStage">
                <div id="camStatus" className="cam-status">
                  <span className="dot" /><span id="camStatusText">Requesting camera…</span>
                  <span id="lkQualityDot" className="lk-quality" style={{ display: 'none' }} />
                </div>
                <div className="cam-frame dark">
                  <iframe id="camPublisher" title="Camera publisher" allow="camera; microphone; autoplay; display-capture; fullscreen" />
                </div>
                <iframe id="camDetector" title="Publish detector" className="cam-detector" allow="autoplay" />
                <button id="camRetryBtn" type="button" className={ghostBtn}>Retry camera</button>
                <div id="camHint" />
              </div>
              <button id="joinBtn" type="button" className={dopamineBtn}>🎬 Call in</button>
              <p className="join-trust-line">Leave anytime. Every unused cent returns automatically.</p>
            </section>

            <details className="join-advanced">
              <summary>Advanced — on-stream entrance &amp; exit</summary>
              <div className="join-stinger-grid">
                <label className="lbl">Fly-in stinger
                  <select id="flyInSelect" defaultValue="" className="stinger-select">
                    <option value="">Default — pulse blip</option>
                    <option value="storm">Storm — lightning reveal</option>
                    <option value="proroll">Pro Roll — clean wipe</option>
                    <option value="callme">Call Me — beeper pop</option>
                    <option value="breaking">Breaking News — banner slam</option>
                    <option value="wildin">Wild Card — glitch materialize</option>
                  </select>
                </label>
                <label className="lbl">Fly-out stinger
                  <select id="flyOutSelect" defaultValue="" className="stinger-select">
                    <option value="">Default — CRT off</option>
                    <option value="crt">CRT Off — deluxe scanline</option>
                    <option value="crumble">Crumble — collapse down</option>
                    <option value="zapped">Zapped — electro glitch</option>
                    <option value="wildout">Wild Card — signal lost</option>
                  </select>
                </label>
                <StingerPreview />
              </div>
            </details>

            <div id="message" className="join-message" aria-live="polite" />
          </div>
        </aside>
      </div>
    </div>
  )
}
