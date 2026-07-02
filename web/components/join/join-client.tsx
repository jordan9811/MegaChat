'use client'

// Viewer join page — MegaChat design-system markup around the UNCHANGED
// legacy join logic (lib/join-page.ts, ported verbatim from
// public/index.html). Element IDs must match what that script expects.

import { useEffect } from 'react'
import { Link2 } from 'lucide-react'
import { GlassCard } from '@/components/glass-card'
import { initJoinPage } from '@/lib/join-page'
import { backendWsUrl } from '@/lib/backend'

const primaryBtn =
  'glow-magenta flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3.5 font-heading text-base font-bold uppercase tracking-wide text-primary-foreground transition-transform hover:scale-[1.01] disabled:opacity-60 disabled:hover:scale-100'

const ghostBtn =
  'flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-input/30 px-4 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-input/50 disabled:opacity-50 disabled:hover:bg-input/30'

export function JoinClient() {
  useEffect(() => {
    return initJoinPage({ wsUrl: backendWsUrl() })
  }, [])

  return (
    <div className="join-shell mx-auto flex w-full max-w-xl flex-col gap-6 px-6 py-10 md:py-14">
      <header className="flex flex-col gap-1">
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

          {/* Wallet choice — same IDs/flows as the legacy page */}
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button id="connectBtn" type="button" className={ghostBtn}>
                🦊 Connect MetaMask
              </button>
              <button id="passkeyBtn" type="button" className={ghostBtn}>
                🔐 Sign in with Passkey (Face ID)
              </button>
            </div>
            <div id="walletInfo" className="text-xs leading-relaxed text-muted-foreground" />
            <div
              id="passkeyFundNote"
              className="rounded-lg border border-border bg-input/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
              style={{ display: 'none' }}
            />
          </div>

          <button id="depositBtn" type="button" className={ghostBtn}>
            💧 Deposit USDC to Gateway (one-time)
          </button>

          <button id="joinBtn" type="button" className={primaryBtn}>
            🎬 JOIN STREAM
          </button>

          {/* className is fully overwritten by the script — styled in join.css */}
          <div id="message" className="join-message" aria-live="polite" />
        </div>
      </GlassCard>

      {/* Camera stage (script toggles .show once a seat is paid) */}
      <div id="cameraStage">
        <GlassCard>
          <div className="relative flex flex-col gap-3 px-5 py-6 sm:px-6">
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
            <button id="goLiveBtn" type="button" className={primaryBtn}>
              Go live
            </button>
            <button id="camRetryBtn" type="button" className={ghostBtn}>
              Retry camera
            </button>
            <button id="leaveBtn" type="button" className={ghostBtn}>
              Leave
            </button>
            <div id="camHint" className="text-xs leading-relaxed text-muted-foreground" />
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
