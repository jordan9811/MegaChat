'use client'

// OBS one-click — Connect OBS, then Add to OBS, then a verified-ready state.
//
// This is a correctness feature wearing a convenience costume: a hand-made
// browser source that is smaller than the canvas (or scaled down) shrinks the
// bounty badge under the verifier's legibility floor and an honest streamer
// silently is not paid. The button makes that misconfiguration impossible;
// the copy below exists so the streamer can TRUST that it did.
//
// THE PASSWORD NEVER LEAVES THIS BROWSER. localStorage only, never posted to
// our server, never logged. It is a credential to software on the streamer's
// own machine and we have no business holding it. The auth handshake hashes
// it locally (crypto.subtle) and only the hash crosses the loopback socket.
//
// Every failure path lands on the MANUAL FALLBACK — URL + exact dimensions,
// with copy buttons, rendered right there. Safari (no loopback mixed-content
// exemption) and the cautious take that road; it is first-class, not a shrug.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CircleCheck, CircleAlert, Copy, Plug, MonitorUp, Volume2 } from 'lucide-react'
import { ObsClient, OBS_ERRORS, ObsError } from '@/lib/obs-client.mjs'
import {
  addOverlayToObs, verifyOverlayInObs, MONITOR, type ObsVerifyCheck,
} from '@/lib/obs-oneclick.mjs'
import { useObsSceneWatch } from './use-obs-scene-watch'

const LS_PASSWORD = 'mc_obs_ws_password'
const LS_MONITOR = 'mc_obs_monitor' // '1' hear (default) | '0' mute locally

type Phase = 'idle' | 'testing' | 'connected' | 'adding' | 'verified' | 'failed'

export function ObsOneClick({
  overlayUrl,
  badgeMinHeightPx = 18,
  badgeCssPx = 28,
  mode = 'bounty',
  airSessionId = null,
  scenePollMs,
}: {
  overlayUrl: string
  badgeMinHeightPx?: number
  badgeCssPx?: number
  /**
   * When set, keep asking OBS whether the overlay is on screen and report it.
   * Corroboration only — a streamer who never connects OBS is not penalised,
   * so this being null is a completely ordinary state.
   */
  airSessionId?: string | null
  scenePollMs?: number
  /**
   * 'bounty' — the overlay carries the payment badge, so canvas-exact sizing
   *   is mandatory and the copy says why.
   * 'room'   — an ordinary room. Same correct setup, but it is a convenience
   *   offered alongside manual, not a correctness requirement.
   */
  mode?: 'bounty' | 'room'
}) {
  const isBounty = mode === 'bounty'
  const [password, setPassword] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [obsVersion, setObsVersion] = useState<string | null>(null)
  const [canvas, setCanvas] = useState<{ w: number; h: number } | null>(null)
  const [checks, setChecks] = useState<ObsVerifyCheck[]>([])
  const [hearSounds, setHearSounds] = useState(true)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    try {
      setPassword(localStorage.getItem(LS_PASSWORD) || '')
      setHearSounds(localStorage.getItem(LS_MONITOR) !== '0')
    } catch { /* storage blocked — fields just start empty */ }
  }, [])

  const savePassword = useCallback((v: string) => {
    setPassword(v)
    try { localStorage.setItem(LS_PASSWORD, v) } catch { /* best-effort */ }
  }, [])

  const copy = useCallback((label: string, text: string) => {
    void navigator.clipboard.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied(null), 1500)
  }, [])

  const withClient = useCallback(async (fn: (c: ObsClient) => Promise<void>) => {
    const client = new ObsClient({ password })
    try {
      await client.connect()
      await fn(client)
    } finally {
      client.close()
    }
  }, [password])

  const describe = (e: unknown): string => {
    if (e instanceof ObsError) return e.message
    return e instanceof Error ? e.message : String(e)
  }

  const testConnection = useCallback(async () => {
    setPhase('testing'); setError(null)
    try {
      await withClient(async (c) => {
        const v = await c.request<{ obsVersion: string; obsWebSocketVersion: string }>('GetVersion')
        const vs = await c.request<{ baseWidth: number; baseHeight: number }>('GetVideoSettings')
        setObsVersion(`OBS ${v.obsVersion} (websocket ${v.obsWebSocketVersion})`)
        setCanvas({ w: vs.baseWidth, h: vs.baseHeight })
      })
      setPhase('connected')
    } catch (e) {
      setError(describe(e)); setPhase('failed')
    }
  }, [withClient])

  const addToObs = useCallback(async () => {
    setPhase('adding'); setError(null)
    try {
      let result: Awaited<ReturnType<typeof verifyOverlayInObs>> | null = null
      await withClient(async (c) => {
        const monitorType = hearSounds ? MONITOR.HEAR : MONITOR.MUTE_LOCAL
        const added = await addOverlayToObs(c, { overlayUrl, monitorType })
        setCanvas({ w: added.baseWidth, h: added.baseHeight })
        // Verify, then say so — the green state is read back from OBS, not
        // assumed from "we just set it".
        result = await verifyOverlayInObs(c, { overlayUrl, badgeMinHeightPx, badgeCssPx, checkBadge: isBounty })
      })
      if (result && (result as { ok: boolean }).ok) {
        setChecks((result as { checks: ObsVerifyCheck[] }).checks)
        setPhase('verified')
      } else {
        setChecks(result ? (result as { checks: ObsVerifyCheck[] }).checks : [])
        setError('OBS accepted the source but verification found a mismatch — see the checks below, or use the manual setup.')
        setPhase('failed')
      }
    } catch (e) {
      setError(describe(e)); setPhase('failed')
    }
  }, [withClient, overlayUrl, hearSounds, badgeMinHeightPx, badgeCssPx, isBounty])

  const toggleHear = useCallback(async (next: boolean) => {
    setHearSounds(next)
    try { localStorage.setItem(LS_MONITOR, next ? '1' : '0') } catch { /* best-effort */ }
    // Applied live when OBS is reachable; otherwise it simply applies on the
    // next Add to OBS click.
    try {
      await withClient(async (c) => {
        await c.request('SetInputAudioMonitorType', {
          inputName: 'MegaChat Overlay',
          monitorType: next ? MONITOR.HEAR : MONITOR.MUTE_LOCAL,
        })
      })
    } catch { /* OBS not up right now — fine */ }
  }, [withClient])

  // Watch only once OBS has been verified: before that there is no overlay
  // source to have an opinion about, and reporting NOT_IN_SCENE for a source
  // that has not been added yet would be noise dressed as a finding.
  const sceneWatch = useObsSceneWatch({
    airSessionId,
    password,
    pollMs: scenePollMs,
    enabled: isBounty && phase === 'verified',
  })

  const dims = canvas ? `${canvas.w} × ${canvas.h}` : 'your OBS canvas size (usually 1920 × 1080)'

  const failedChecks = useMemo(() => checks.filter((c) => !c.ok), [checks])

  return (
    <div className="space-y-4">
      {/* ── One-time connect ─────────────────────────────────────────── */}
      <div className="rounded-xl border border-border/70 bg-background/40 p-3">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Plug className="size-4" /> Connect OBS <span className="text-xs font-normal text-muted-foreground">(one time)</span>
        </p>
        <ol className="mt-1.5 list-decimal space-y-0.5 pl-5 text-xs leading-relaxed text-muted-foreground">
          <li>In OBS: <strong className="text-foreground">Tools → WebSocket Server Settings</strong></li>
          <li>Tick <strong className="text-foreground">Enable WebSocket server</strong>, then <strong className="text-foreground">Show Connect Info</strong></li>
          <li>Copy the <strong className="text-foreground">Server Password</strong> and paste it here</li>
        </ol>
        <div className="mt-2 flex gap-2">
          <input
            type="password"
            value={password}
            onChange={(e) => savePassword(e.target.value)}
            placeholder="OBS WebSocket password"
            className="min-w-0 flex-1 rounded-lg border border-border bg-input/30 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-[var(--neon-cyan)]/70 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void testConnection()}
            disabled={phase === 'testing' || phase === 'adding'}
            className="shrink-0 rounded-lg border border-[var(--neon-cyan)]/50 px-3 py-2 text-sm font-bold text-[var(--neon-cyan)] disabled:opacity-60"
          >
            {phase === 'testing' ? 'Testing…' : 'Test connection'}
          </button>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          The password stays in this browser (saved locally, never sent to MegaChat).
          It unlocks OBS on <em>your</em> machine — we have no business holding it.
        </p>
        {phase === 'connected' && obsVersion ? (
          <p className="mt-1.5 flex items-center gap-1 text-xs font-semibold text-[var(--neon-lime)]">
            <CircleCheck className="size-3.5" /> Connected — {obsVersion}, canvas {dims}
          </p>
        ) : null}
      </div>

      {/* ── The button ───────────────────────────────────────────────── */}
      <div className="rounded-xl border border-[var(--neon-lime)]/40 bg-[var(--neon-lime)]/5 p-3">
        <button
          type="button"
          onClick={() => void addToObs()}
          disabled={phase === 'adding' || phase === 'testing'}
          className="w-full rounded-full bg-[var(--neon-lime)] px-5 py-2.5 text-sm font-bold text-black transition-transform hover:scale-[1.01] disabled:opacity-60"
        >
          <span className="inline-flex items-center gap-1.5">
            <MonitorUp className="size-4" />
            {phase === 'adding' ? 'Adding to OBS…' : 'Add to OBS'}
          </span>
        </button>
        <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
          Creates the overlay as a browser source sized exactly to your canvas —
          full size, no scaling{isBounty
            ? ' — so the payment badge can never end up too small to verify'
            : ', so tiles land exactly where they were designed to'}.
          Re-clicking repairs a moved or resized source.
        </p>
        {/* Chrome 142+ gates local-network access behind a permission prompt.
            WebSockets were not covered at launch, but Chrome has stated it is
            extending it to them — so a streamer may see the prompt with no
            warning and read it as us doing something shady. Naming it first
            turns an alarming dialog into an expected one. */}
        <p className="mt-1 text-center text-[11px] text-muted-foreground">
          Your browser may ask permission to <em>connect to devices on your local
          network</em> — that&apos;s OBS on your own machine. Allow it, or use the
          manual setup below.
        </p>

        <label className="mt-2 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={hearSounds}
            onChange={(e) => void toggleHear(e.target.checked)}
            className="size-3.5 accent-[var(--neon-lime)]"
          />
          <Volume2 className="size-3.5" />
          Hear overlay sounds in your headphones (join &amp; stinger sounds — turn off if your monitoring echoes)
        </label>
      </div>

      {/* ── Verified-ready ───────────────────────────────────────────── */}
      {phase === 'verified' ? (
        <div className="rounded-xl border border-[var(--neon-lime)]/50 bg-[var(--neon-lime)]/10 p-3">
          <p className="flex items-center gap-1.5 text-sm font-bold text-[var(--neon-lime)]">
            <CircleCheck className="size-4" /> Verified ready
          </p>
          <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
            {checks.map((c) => (
              <li key={c.name} className="flex items-center gap-1">
                <CircleCheck className="size-3 shrink-0 text-[var(--neon-lime)]" /> {c.name}
              </li>
            ))}
          </ul>
          {/* ── Live scene watch ────────────────────────────────────────
              Say it while it can still be fixed. A streamer who switched
              away from the overlay scene has minutes to notice, and the
              alternative to telling them here is telling them at payout. */}
          {sceneWatch?.checked && !sceneWatch.visible ? (
            <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-[var(--neon-amber)]/10 px-2 py-1.5 text-[11px] font-semibold text-[var(--neon-amber)]">
              <CircleAlert className="mt-px size-3 shrink-0" />
              <span>
                {sceneWatch.detail || 'The overlay is not visible in your live scene.'}
                {' '}MegaChats playing now will not be verifiable.
              </span>
            </p>
          ) : null}
          {sceneWatch?.checked && sceneWatch.visible ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Watching your live scene — overlay on screen{sceneWatch.sceneName ? ` in "${sceneWatch.sceneName}"` : ''}.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ── Failure: named error + always the manual road ────────────── */}
      {phase === 'failed' ? (
        <div className="rounded-xl border border-[var(--neon-amber)]/50 bg-[var(--neon-amber)]/5 p-3">
          <p className="flex items-center gap-1.5 text-sm font-bold text-[var(--neon-amber)]">
            <CircleAlert className="size-4" /> {error}
          </p>
          {failedChecks.length ? (
            <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
              {failedChecks.map((c) => (
                <li key={c.name}>{c.name}: got {c.got}, wanted {c.want}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* ── Manual fallback — ALWAYS rendered, first-class ───────────── */}
      <div className="rounded-xl border border-border/70 bg-background/40 p-3">
        <p className="text-sm font-semibold text-foreground">Manual setup (works everywhere)</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          In OBS add a <strong className="text-foreground">Browser</strong> source with this URL,
          width and height <strong className="text-foreground">{dims}</strong> — full canvas,
          position 0,0, no scaling. Tick <strong className="text-foreground">Control audio via OBS</strong>.
        </p>
        <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-border bg-input/30 px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{overlayUrl}</code>
          <button
            type="button"
            onClick={() => copy('url', overlayUrl)}
            className="inline-flex shrink-0 items-center gap-1 text-xs font-bold text-[var(--neon-cyan)]"
          >
            <Copy className="size-3.5" /> {copied === 'url' ? 'Copied' : 'Copy'}
          </button>
        </div>
        {canvas ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Width <code className="text-foreground">{canvas.w}</code> · Height{' '}
            <code className="text-foreground">{canvas.h}</code>{' '}
            <button type="button" onClick={() => copy('dims', `${canvas.w}x${canvas.h}`)} className="font-bold text-[var(--neon-cyan)]">
              {copied === 'dims' ? 'copied' : 'copy'}
            </button>
          </p>
        ) : null}
      </div>
    </div>
  )
}
