'use client'

// Viewer join page — MegaChat design-system markup around the UNCHANGED
// legacy join logic (lib/join-page.ts, ported verbatim from
// public/index.html). Element IDs must match what that script expects.

import { useEffect } from 'react'
import { Link2 } from 'lucide-react'
import { GlassCard } from '@/components/glass-card'
import { StingerPreview } from '@/components/join/stinger-preview'
import { initJoinPage } from '@/lib/join-page'
import { backendWsUrl } from '@/lib/backend'

const primaryBtn =
  'glow-magenta flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3.5 font-heading text-base font-bold uppercase tracking-wide text-primary-foreground transition-transform hover:scale-[1.01] disabled:opacity-60 disabled:hover:scale-100'

const ghostBtn =
  'flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-input/30 px-4 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-input/50 disabled:opacity-50 disabled:hover:bg-input/30'

// Passkey = primary wallet path: bigger, brighter, above the fold.
const passkeyBtnCls =
  'flex w-full items-center justify-center gap-2 rounded-xl border border-primary/50 bg-primary/15 px-4 py-3.5 text-sm font-bold text-foreground transition-colors hover:bg-primary/25 disabled:opacity-50 disabled:hover:bg-primary/15'

// MetaMask/Gateway = secondary path: compact row under the passkey buttons.
const miniBtn =
  'flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-input/20 px-3 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-input/40 hover:text-foreground disabled:opacity-50 disabled:hover:bg-input/20'

export function JoinClient() {
  useEffect(() => {
    return initJoinPage({ wsUrl: backendWsUrl() })
  }, [])

  return (
    <div className="join-shell mx-auto flex w-full max-w-xl flex-col gap-6 px-6 py-10 md:py-14">
      <header className="reveal flex flex-col gap-1">
        <span className="text-xs font-bold uppercase tracking-widest text-[var(--neon-lime)]">
          Viewer
        </span>
        <h1 className="chromatic font-heading text-4xl font-bold text-foreground">
          Put your face on the stream.
        </h1>
        <p className="text-sm font-semibold uppercase tracking-wide text-[var(--neon-magenta)]">
          Pay by the second.
        </p>
      </header>

      <div className="reveal" style={{ ['--reveal-delay' as string]: '0.1s' }}>
      <GlassCard>
        <div className="flex flex-col gap-5 px-5 py-6 sm:px-6">
          {/* Price block */}
          <div className="flex flex-col items-start gap-1 rounded-xl border border-border bg-input/20 px-4 py-3">
            <span
              id="priceAmount"
              className="text-glow-lime font-heading text-3xl font-bold text-[var(--neon-lime)]"
            >
              — USDC
            </span>
            <span id="priceLabel" className="text-xs text-muted-foreground">
              loading room…
            </span>
          </div>

          {/* Balance / live meter (script toggles .show) */}
          <div id="meter" className="rounded-xl border border-border bg-input/20 px-4 py-3">
            <div className="flex items-center justify-between py-1 text-sm">
              <span className="text-muted-foreground">Remaining</span>
              <span id="meterRemaining" className="font-mono font-semibold text-foreground">
                — USDC
              </span>
            </div>
            <div className="flex items-center justify-between py-1 text-sm">
              <span className="text-muted-foreground">Spent</span>
              <span id="meterSpent" className="font-mono font-semibold text-foreground">
                0 USDC
              </span>
            </div>
            <div className="flex items-center justify-between py-1 text-sm">
              <span className="text-muted-foreground">Time left</span>
              <span id="meterTime" className="font-mono font-semibold text-[var(--neon-cyan)]">
                —
              </span>
            </div>
            <div
              id="earnedRow"
              className="flex items-center justify-between py-1 text-sm"
              style={{ display: 'none' }}
            >
              <span className="text-muted-foreground">Earned</span>
              <span id="rewardsEarned" className="font-mono font-semibold text-[var(--neon-lime)]">
                0
              </span>
            </div>
          </div>

          <input
            type="text"
            id="username"
            placeholder="Username"
            maxLength={20}
            className="h-11 w-full rounded-lg border border-border bg-input/40 px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-primary/70 focus-visible:ring-2 focus-visible:ring-primary/30"
          />

          {/* Wallet choice — Privy (email/social/passkey) is the PRIMARY path
              (bigger, on top); MetaMask is the secondary row below. Clicking
              Join while disconnected runs the Privy sign-in automatically. */}
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button id="passkeyCreateBtn" type="button" className={passkeyBtnCls}>
                ✨ Sign up — email or passkey
              </button>
              <button id="passkeyBtn" type="button" className={passkeyBtnCls}>
                🔐 Sign in
              </button>
            </div>
            <div id="walletInfo" className="text-xs leading-relaxed text-muted-foreground" />
            <div
              id="passkeyFundNote"
              className="rounded-lg border border-border bg-input/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
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

          {/* Advanced — overlay stinger picker. Opt-in: untouched selects send
              nothing and the overlay keeps its default animations. The mock
              camera square previews the picked animation (never the real cam). */}
          <details className="rounded-xl border border-border bg-input/10 px-4 py-2">
            <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Advanced — on-stream entrance &amp; exit
            </summary>
            <div className="grid grid-cols-1 gap-3 pb-3 pt-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
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
              <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
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

          {/* Camera stage — ABOVE the join button so the preview and the
              (morphing) button stay in view together. Shown once a seat is
              paid; the join button itself relabels to GO LIVE. */}
          <div id="cameraStage" className="flex flex-col gap-3">
            <div id="camStatus" className="cam-status">
              <span className="dot" />
              <span id="camStatusText">Requesting camera…</span>
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
            <div id="camHint" className="text-xs leading-relaxed text-muted-foreground" />
          </div>

          {/* THE button: Join Stream → connecting → authorizing → Waiting for
              camera → Go Live → You're LIVE (state machine in join-page.ts). */}
          <button id="joinBtn" type="button" className={primaryBtn}>
            🎬 Join Stream
          </button>
          <button id="leaveBtn" type="button" className={ghostBtn}>
            Leave stream
          </button>

          {/* className is fully overwritten by the script — styled in join.css */}
          <div id="message" className="join-message" aria-live="polite" />
        </div>
      </GlassCard>
      </div>

      {/* Viewer-side platform link stub — no logic yet */}
      <div className="flex items-center gap-3 rounded-xl border border-dashed border-border bg-input/10 px-4 py-3">
        <Link2 className="size-4 shrink-0 text-muted-foreground" />
        <div className="flex-1">
          <p className="text-sm font-semibold text-foreground/80">
            Link Twitch / Kick account
          </p>
          <p className="text-xs text-muted-foreground">
            Link to earn drops from watching — coming soon.
          </p>
        </div>
        <button
          type="button"
          disabled
          title="Coming soon"
          className="cursor-not-allowed rounded-full border border-border bg-input/30 px-3 py-1 text-xs font-medium text-muted-foreground opacity-60"
        >
          Coming soon
        </button>
      </div>
    </div>
  )
}
