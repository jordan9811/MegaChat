'use client'

// Viewer join page — app-skin markup around the UNCHANGED legacy join logic
// (lib/join-page.ts, ported verbatim from public/index.html). Element IDs must
// match what that script expects, and the classes it toggles (.show, .success,
// .error, .live, .addr, .adv-only/.simple-only) are styled in join.css.

import { useEffect } from 'react'
import { StingerPreview } from '@/components/join/stinger-preview'
import { initJoinPage } from '@/lib/join-page'
import { backendWsUrl } from '@/lib/backend'

// Send a MegaChat: a flat white block. Loud, but the one warm accent is
// spent on the seat below — that is the purchase this page exists for.
const primaryBtn =
  'flex w-full items-center justify-center gap-2 bg-[var(--mcj-fg)] px-6 py-3.5 text-[15px] font-bold text-[#08080a] disabled:opacity-50'

// Join Stream = the seat itself, so it carries the accent. The pulsing neon
// treatment is gone; the weight comes from size and colour (join.css).
const dopamineBtn =
  'dopamine-btn flex w-full items-center justify-center gap-2 px-6 py-4 text-[17px] font-bold'

const ghostBtn =
  'flex w-full items-center justify-center gap-2 border border-[var(--mcj-rule-2)] bg-[var(--mcj-sunk)] px-4 py-3 text-[13.5px] font-semibold text-[var(--mcj-fg)] transition-colors hover:border-[var(--mcj-fg)] disabled:opacity-50 disabled:hover:border-[var(--mcj-rule-2)]'

// MetaMask/Gateway = secondary path: compact row under the sign-in button.
const miniBtn =
  'flex w-full items-center justify-center gap-1.5 border border-[var(--mcj-rule)] px-3 py-2 text-[12px] font-semibold text-[var(--mcj-dim)] transition-colors hover:border-[var(--mcj-rule-2)] hover:text-[var(--mcj-fg)] disabled:opacity-50'

export function JoinClient() {
  useEffect(() => {
    return initJoinPage({ wsUrl: backendWsUrl() })
  }, [])

  return (
    // Mobile: one column. Desktop: media (preview/host feed) beside the join
    // card, capped at the width of the header bar above it.
    <div className="join-shell mx-auto flex w-full max-w-xl flex-col gap-6 px-5 py-8 md:py-10 lg:max-w-[1400px]">
      <header className="flex flex-col gap-1">
        <span className="text-[12.5px] font-semibold text-[var(--mcj-dim)]">Viewer</span>
        <h1 className="text-[30px] font-extrabold leading-[1.05] tracking-[-0.01em] md:text-[34px]">
          Put your face on the stream.
        </h1>
        <p className="text-[13.5px] font-semibold text-[var(--mcj-accent)]">Pay by the second.</p>
      </header>

      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[1.35fr_0.9fr] lg:items-start lg:gap-7">
      <div className="flex flex-col gap-4 lg:sticky lg:top-6">
      {/* Demo-room banner (join-page.ts shows it when config.isDemo) */}
      <div
        id="demoBanner"
        className="border-l-[3px] border-[var(--mcj-live)] bg-[rgba(67,224,168,0.05)] px-4 py-3 text-[13px] leading-relaxed text-[var(--mcj-live)]"
        style={{ display: 'none' }}
      >
        This is a live demo room. Farm drops by watching, send a MegaChat, go
        live for pennies — everything here runs the real machinery at dust
        prices.
      </div>

      {/* TRUE-LIVE return feed: while this viewer holds a live slot, the
          host's camera streams here sub-second over vdo.ninja (the app's own
          WebRTC pipe) so both sides can hold a real conversation. The delayed
          Twitch embed below is REMOVED during the slot (echo safety). */}
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

      {/* Delayed spectate surface: the room's Twitch stream (populated by
          join-page.ts when the room has a channel set; hidden otherwise).
          True real-time only exists on the WebRTC layer — this embed runs
          ~15s behind live, which is normal for every spectator. */}
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

      {/* Designed idle state for the media column — WITHOUT it, no-preview
          rooms showed a giant dead black rectangle (mobile) or an empty
          desktop column. join-page.ts toggles it off whenever a real
          preview/host feed mounts. Desktop-only: on mobile absence is fine. */}
      <div
        id="previewIdle"
        className="hidden flex-col items-start justify-center gap-2 border border-dashed border-[var(--mcj-rule-2)] px-7 py-16 lg:flex"
      >
        <p className="text-[15px] font-semibold">No broadcast preview in this room</p>
        <p className="max-w-sm text-[13px] leading-relaxed text-[var(--mcj-faint)]">
          Your camera still lands on the stream — the streamer sees you in
          real time either way.
        </p>
      </div>
      </div>

      <div className="flex flex-col gap-5 border border-[var(--mcj-rule)] bg-[var(--mcj-panel)] px-5 py-5">
      {/* Price row — slim. The old block spent ~90px of 3xl type to say
          one word (FREE), then repeated it in the sentence below. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-[var(--mcj-rule)] pb-3">
        <span id="priceAmount" className="text-[19px] font-bold tabular-nums text-[var(--mcj-live)]">
          — USDC
        </span>
        <span id="priceLabel" className="text-pretty text-right text-[12px] text-[var(--mcj-faint)]">
          loading room…
        </span>
      </div>

      {/* Balance / live meter (script toggles .show) */}
      <div id="meter" className="border border-[var(--mcj-rule)] bg-[var(--mcj-sunk)] px-4 py-1.5">
        <div className="flex items-center justify-between border-t border-[var(--mcj-hairline)] py-2 text-[13px] first:border-t-0">
          <span className="text-[var(--mcj-dim)]">Remaining</span>
          <span id="meterRemaining" className="font-semibold tabular-nums">
            — USDC
          </span>
        </div>
        <div className="flex items-center justify-between border-t border-[var(--mcj-hairline)] py-2 text-[13px] first:border-t-0">
          <span className="text-[var(--mcj-dim)]">Spent</span>
          <span id="meterSpent" className="font-semibold tabular-nums">
            0 USDC
          </span>
        </div>
        <div className="flex items-center justify-between border-t border-[var(--mcj-hairline)] py-2 text-[13px] first:border-t-0">
          <span className="text-[var(--mcj-dim)]">Time left</span>
          <span id="meterTime" className="font-semibold tabular-nums text-[var(--mcj-live)]">
            —
          </span>
        </div>
        <div
          id="earnedRow"
          className="flex items-center justify-between border-t border-[var(--mcj-hairline)] py-2 text-[13px] first:border-t-0"
          style={{ display: 'none' }}
        >
          <span className="text-[var(--mcj-dim)]">Earned</span>
          <span id="rewardsEarned" className="font-semibold tabular-nums text-[var(--mcj-live)]">
            0
          </span>
        </div>
      </div>

      {/* (No "Signed in as @x" line here — the header chip 60px up
          already says exactly that. Redundancy is noise.) */}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="username" className="lbl">
          Display name
        </label>
        <input type="text" id="username" placeholder="e.g. couch_goblin" maxLength={20} />
      </div>

      {/* Balance — ONE sign-in button (audit P0-4: the old sign-up/sign-in
          pair both opened the same Privy modal at primary weight). It sits
          at secondary weight so MegaChat + Join Stream stay the only loud
          things. MetaMask stays the compact row below. */}
      <div className="flex flex-col gap-2">
        <div id="privyChoice" className="grid grid-cols-1 gap-2">
          <button id="passkeyBtn" type="button" className={ghostBtn}>
            🔐 Sign in — Google, email or passkey
          </button>
        </div>
        <div id="walletInfo" className="text-[12px] leading-relaxed text-[var(--mcj-faint)]" />
        <div
          id="passkeyFundNote"
          className="border border-[var(--mcj-rule)] bg-[var(--mcj-sunk)] px-3 py-2 text-[12px] leading-relaxed text-[var(--mcj-faint)]"
          style={{ display: 'none' }}
        />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button id="connectBtn" type="button" className={miniBtn}>
            🦊 Connect MetaMask
          </button>
          <button id="depositBtn" type="button" className={miniBtn}>
            💧 Fund wallet
          </button>
        </div>
      </div>

      {/* THE HERO — MegaChat: record a clip, pay flat, it plays once on
          stream. Recorded content sidesteps the broadcast delay entirely.
          Hidden only if the room turns MegaChats off. */}
      <button id="letterBtn" type="button" className={primaryBtn} style={{ display: 'none' }}>
        📼 Send a MegaChat
      </button>
      <div id="letterStage" className="letter-stage" style={{ display: 'none' }}>
        <div className="cam-frame letter-frame">
          <video id="letterVideo" playsInline muted />
        </div>
        <div className="letter-controls">
          <button id="letterRecordBtn" type="button" className={ghostBtn}>
            ⏺ Record
          </button>
          <button id="letterRedoBtn" type="button" className={ghostBtn} style={{ display: 'none' }}>
            ↺ Re-record
          </button>
          <button id="letterSendBtn" type="button" className={primaryBtn} style={{ display: 'none' }}>
            📮 Send
          </button>
          <button id="letterCancelBtn" type="button" className={ghostBtn}>
            Cancel
          </button>
        </div>
        <p id="letterStatus" className="text-xs text-muted-foreground" aria-live="polite" />
      </div>


      {/* Camera stage — ABOVE the join button so the preview and the
          (morphing) button stay in view together. Shown once a seat is
          paid; the join button itself relabels to GO LIVE. */}
      <div id="cameraStage" className="flex flex-col gap-3">
        <div id="camStatus" className="cam-status">
          <span className="dot" />
          <span id="camStatusText">Requesting camera…</span>
          {/* LiveKit connection quality (subtle; hidden on vdo rooms) */}
          <span id="lkQualityDot" className="lk-quality" style={{ display: 'none' }} />
        </div>
        <div className="cam-frame">
          <iframe
            id="camPublisher"
            title="Camera publisher"
            allow="camera; microphone; autoplay; display-capture; fullscreen"
          />
        </div>
        <iframe id="camDetector" title="Publish detector" className="cam-detector" allow="autoplay" />
        <button id="camRetryBtn" type="button" className={ghostBtn}>
          Retry camera
        </button>
        <div id="camHint" className="text-[12px] leading-relaxed text-[var(--mcj-faint)]" />
      </div>

      {/* THE DOPAMINE MODE — Join Stream: your actual camera ON the
          broadcast, billed per second. One button morphs through
          connecting → authorizing → Waiting for camera → Go Live →
          You're LIVE (state machine in join-page.ts). */}
      {/* ONE control for the whole session (audit P0-1): it morphs
          join → cancel → go-live → leave. No sibling Leave button. */}
      <button id="joinBtn" type="button" className={dopamineBtn}>
        🎬 Join Stream
      </button>

      {/* Advanced — overlay stinger picker. Opt-in: untouched selects send
          nothing and the overlay keeps its default animations. The mock
          camera square previews the picked animation (never the real cam). */}
      <details className="border border-[var(--mcj-rule)] bg-[var(--mcj-sunk)] px-4 py-2.5">
        <summary className="lbl cursor-pointer select-none">
          Advanced — on-stream entrance &amp; exit
        </summary>
        <div className="grid grid-cols-1 gap-3 pb-2 pt-3 sm:grid-cols-2">
          <label className="lbl flex flex-col gap-1">
            Fly-in stinger
            <select id="flyInSelect" defaultValue="" className="stinger-select">
              <option value="">Default — pulse blip</option>
              <option value="storm">⛈️ Storm — lightning reveal</option>
              <option value="proroll">🎬 Pro Roll — clean wipe</option>
              <option value="callme">📟 Call Me — beeper pop</option>
              <option value="breaking">🚨 Breaking News — banner slam</option>
              <option value="wildin">👾 Wild Card — glitch materialize</option>
            </select>
          </label>
          <label className="lbl flex flex-col gap-1">
            Fly-out stinger
            <select id="flyOutSelect" defaultValue="" className="stinger-select">
              <option value="">Default — CRT off</option>
              <option value="crt">📺 CRT Off — deluxe scanline</option>
              <option value="crumble">🧱 Crumble — collapse down</option>
              <option value="zapped">⚡ Zapped — electro glitch</option>
              <option value="wildout">📡 Wild Card — signal lost</option>
            </select>
          </label>
          <StingerPreview />
        </div>
      </details>

      {/* className is fully overwritten by the script — styled in join.css */}
      <div id="message" className="join-message" aria-live="polite" />
      </div>
      </div>
    </div>
  )
}
