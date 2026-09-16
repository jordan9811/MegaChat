'use client'

// Viewer join page — app-skin markup around the UNCHANGED legacy join logic
// (lib/join-page.ts, ported verbatim from public/index.html). Element IDs must
// match what that script expects, and the classes it toggles (.show, .success,
// .error, .live, .addr, .adv-only/.simple-only) are styled in join.css.

import { useEffect } from 'react'
import { StingerPreview } from '@/components/join/stinger-preview'
import { initJoinPage } from '@/lib/join-page'
import { backendWsUrl } from '@/lib/backend'

const primaryBtn =
  'mcj-action mcj-action-record flex w-full items-center justify-center gap-2 px-6 py-3.5 text-[14px] font-bold disabled:opacity-50'

const dopamineBtn =
  'dopamine-btn mcj-action mcj-action-live flex w-full items-center justify-center gap-2 px-6 py-4 text-[15px] font-bold'

const ghostBtn =
  'mcj-secondary flex w-full items-center justify-center gap-2 px-4 py-3 text-[13px] font-semibold disabled:opacity-50'

const miniBtn =
  'mcj-mini flex w-full items-center justify-center gap-1.5 px-3 py-2 text-[12px] font-semibold disabled:opacity-50'

export function JoinClient() {
  useEffect(() => {
    return initJoinPage({ wsUrl: backendWsUrl() })
  }, [])

  return (
    <div className="join-shell mx-auto w-full max-w-[1500px] px-5 pb-10 pt-5">
      <div className="join-room-strip">
        <span className="join-live-label" id="joinRoomState">Room entrance</span>
        <strong id="joinRoomName">Loading room...</strong>
        <span>Your camera stays private until you confirm.</span>
      </div>

      <div
        id="demoBanner"
        className="join-demo-banner"
        style={{ display: 'none' }}
      >
        This is a live demo room. Farm drops by watching, send a MegaChat, go
        live for pennies — everything here runs the real machinery at dust
        prices.
      </div>

      <div className="join-layout">
        <section className="join-media-stage" aria-label="Broadcast preview">
          <div id="hostLiveFeed" className="stream-preview host-live" style={{ display: 'none' }}>
            <div className="stream-preview-frame host-live-frame">
              <div id="hostLiveMount" className="stream-preview-mount" />
            </div>
            <div className="stream-preview-caption">
              <span className="host-live-label">
                <span className="host-live-dot" aria-hidden="true" />
                Real-time with the host — the public stream shows this after a slight delay
              </span>
              <span className="stream-preview-label">Headphones recommended</span>
            </div>
          </div>

          <div id="streamPreview" className="stream-preview" style={{ display: 'none' }}>
            <div className="stream-preview-frame">
              <div id="streamPreviewMount" className="stream-preview-mount" />
            </div>
            <div className="stream-preview-caption">
              <span className="stream-preview-label">Stream preview · slight delay</span>
              <span id="streamPreviewDrops" className="stream-preview-drops" style={{ display: 'none' }}>
                Watching earns drops in this room
              </span>
            </div>
          </div>

          <div id="previewIdle" className="join-preview-idle">
            <div>
              <span className="join-coordinate">Stream preview</span>
              <h1>Preview unavailable</h1>
              <p>This room is not publishing a preview here. Recording and live-seat controls still work normally.</p>
            </div>
          </div>
        </section>

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
              <header><h2>Record a MegaChat</h2><p>Review before sending. Your clip plays once on the broadcast.</p></header>
              <button id="letterBtn" type="button" className={primaryBtn} style={{ display: 'none' }}>
                Send a MegaChat
              </button>
              <div id="letterStage" className="letter-stage" style={{ display: 'none' }}>
                <div className="cam-frame letter-frame"><video id="letterVideo" playsInline muted /></div>
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
              <header><h2>Live seat</h2><p>Your camera stays private until you press Go Live.</p></header>
              <div id="cameraStage">
                <div id="camStatus" className="cam-status">
                  <span className="dot" /><span id="camStatusText">Requesting camera…</span>
                  <span id="lkQualityDot" className="lk-quality" style={{ display: 'none' }} />
                </div>
                <div className="cam-frame">
                  <iframe id="camPublisher" title="Camera publisher" allow="camera; microphone; autoplay; display-capture; fullscreen" />
                </div>
                <iframe id="camDetector" title="Publish detector" className="cam-detector" allow="autoplay" />
                <button id="camRetryBtn" type="button" className={ghostBtn}>Retry camera</button>
                <div id="camHint" />
              </div>
              <button id="joinBtn" type="button" className={dopamineBtn}>Join Stream</button>
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
