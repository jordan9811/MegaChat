'use client'

import { useRef, useState } from 'react'
import { Radio, Rocket, Link2, RefreshCw, KeyRound, ChevronDown } from 'lucide-react'
import { GlassCard, CardHeader } from '@/components/glass-card'
import {
  Field,
  TextInput,
  InputAffix,
  SelectInput,
  Toggle,
} from '@/components/form-primitives'
import { CopyRow } from '@/components/copy-row'
import { useRoom } from '@/components/room-provider'
import { cn } from '@/lib/utils'

export function MegaChatSettings() {
  const {
    mode,
    room,
    draft,
    updateDraft,
    joinUrl,
    overlayUrl,
    create,
    unlock,
    toggleActive,
    switchRoom,
  } = useRoom()

  const [tab, setTab] = useState<'create' | 'manage'>('create')
  const [password, setPassword] = useState('')
  const [manageRoomId, setManageRoomId] = useState('')
  const [managePassword, setManagePassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const resultRef = useRef<HTMLDivElement>(null)

  const managing = mode === 'managing'
  const token = draft.tokenPreset === 'custom' ? 'TOKEN' : 'USDC'
  const tokenSymbol = room?.paymentTokenSymbol || token

  async function handleCreate() {
    setError(null)
    setSuccess(null)
    if (!password || password.length < 4) {
      setError('Room password required (min 4 characters).')
      return
    }
    setBusy(true)
    try {
      await create(password)
      setSuccess('Room created — copy your links below.')
      requestAnimationFrame(() => {
        resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleUnlock() {
    setError(null)
    if (!manageRoomId.trim()) {
      setError('Enter your room ID.')
      return
    }
    setBusy(true)
    try {
      await unlock(manageRoomId, managePassword)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid room ID or password')
    } finally {
      setBusy(false)
    }
  }

  return (
    <GlassCard>
      <CardHeader
        icon={<Radio className="size-5" />}
        title="MegaChat Settings"
        description={
          managing
            ? 'Changes save automatically while you stream.'
            : 'Configure how viewers buy their moment on stream.'
        }
        accent="magenta"
        action={
          managing && room ? (
            <span className="hidden items-center gap-2 sm:inline-flex">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-input/30 px-3 py-1 font-mono text-xs font-medium text-muted-foreground">
                <span
                  className={cn(
                    'size-1.5 rounded-full',
                    room.active ? 'bg-[var(--neon-lime)]' : 'bg-muted-foreground',
                  )}
                />
                {room.id}
              </span>
              <Toggle
                checked={room.active}
                onChange={() => void toggleActive()}
                label={room.active ? 'Accepting joins' : 'Paused'}
              />
            </span>
          ) : (
            <span className="hidden items-center gap-1.5 rounded-full border border-border bg-input/30 px-3 py-1 text-xs font-medium text-muted-foreground sm:inline-flex">
              <span className="size-1.5 rounded-full bg-[var(--neon-lime)]" />
              Draft
            </span>
          )
        }
      />

      {/* Create / Manage entry tabs (hidden once a room is unlocked) */}
      {!managing ? (
        <div className="flex items-center gap-2 border-b border-border/70 px-5 pt-4 pb-3 sm:px-6">
          {(['create', 'manage'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setTab(t)
                setError(null)
              }}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide transition-colors',
                tab === t
                  ? 'border-primary/70 bg-primary/15 text-foreground'
                  : 'border-border bg-input/30 text-muted-foreground hover:text-foreground',
              )}
            >
              {t === 'create' ? 'Create room' : 'Manage existing'}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 border-b border-border/70 px-5 pt-4 pb-3 sm:px-6">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Managing{' '}
            <span className="text-[var(--neon-lime)]">{room?.name}</span>
          </span>
          <button
            type="button"
            onClick={switchRoom}
            className="rounded-full border border-border bg-input/30 px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Switch room
          </button>
        </div>
      )}

      {/* Manage (unlock) form */}
      {!managing && tab === 'manage' ? (
        <div className="grid grid-cols-1 gap-5 px-5 py-6 sm:grid-cols-2 sm:px-6">
          <Field label="Room ID" htmlFor="manage-room-id">
            <TextInput
              id="manage-room-id"
              value={manageRoomId}
              onChange={(e) => setManageRoomId(e.target.value)}
              placeholder="a1b2c3d4"
              autoComplete="off"
            />
          </Field>
          <Field label="Room password" htmlFor="manage-password">
            <TextInput
              id="manage-password"
              type="password"
              value={managePassword}
              onChange={(e) => setManagePassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
          <div className="sm:col-span-2">
            <button
              type="button"
              onClick={handleUnlock}
              disabled={busy}
              className="glow-magenta flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3.5 font-heading text-base font-bold uppercase tracking-wide text-primary-foreground transition-transform hover:scale-[1.01] disabled:opacity-70"
            >
              {busy ? (
                <>
                  <RefreshCw className="size-5 animate-spin" />
                  Unlocking…
                </>
              ) : (
                <>
                  <KeyRound className="size-5" />
                  Unlock room
                </>
              )}
            </button>
            {error ? (
              <p className="mt-3 text-sm text-[var(--neon-magenta)]" aria-live="polite">
                {error}
              </p>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-5 px-5 py-6 sm:grid-cols-2 sm:px-6">
            <Field
              label="Room name"
              htmlFor="room-name"
              hint="Shown to viewers in their join link."
              className="sm:col-span-2"
            >
              <TextInput
                id="room-name"
                value={draft.name}
                onChange={(e) => updateDraft({ name: e.target.value })}
                placeholder="late-night-arena"
              />
            </Field>

            <Field
              label="Price per charge"
              htmlFor="price"
              hint="Pulled from the viewer wallet each interval while live."
            >
              <InputAffix
                id="price"
                affix={tokenSymbol}
                inputMode="decimal"
                value={draft.passkeyTickPrice}
                onChange={(e) => updateDraft({ passkeyTickPrice: e.target.value })}
              />
            </Field>

            <Field label="Charge interval" htmlFor="interval">
              <InputAffix
                id="interval"
                affix="sec"
                inputMode="numeric"
                value={draft.passkeyTickSeconds}
                onChange={(e) => updateDraft({ passkeyTickSeconds: e.target.value })}
              />
            </Field>

            <Field
              label="Max spend / viewer"
              htmlFor="max-spend"
              hint="Auto-kicks the camera when reached."
            >
              <InputAffix
                id="max-spend"
                affix={tokenSymbol}
                inputMode="decimal"
                value={draft.maxSession}
                onChange={(e) => updateDraft({ maxSession: e.target.value })}
              />
            </Field>

            <Field
              label="Max seats"
              htmlFor="max-seats"
              hint="Cameras live on screen at once (up to 3)."
            >
              <InputAffix
                id="max-seats"
                affix="cams"
                inputMode="numeric"
                value={draft.maxSeats}
                onChange={(e) => updateDraft({ maxSeats: e.target.value })}
              />
            </Field>

            <Field
              label="Payment token"
              htmlFor="token"
              className={draft.tokenPreset === 'custom' ? undefined : 'sm:col-span-2'}
            >
              <SelectInput
                id="token"
                value={draft.tokenPreset}
                onChange={(e) =>
                  updateDraft({ tokenPreset: e.target.value as 'usdc' | 'custom' })
                }
              >
                <option value="usdc">USDC — USD Coin</option>
                <option value="custom">Custom ERC-20…</option>
              </SelectInput>
            </Field>

            {draft.tokenPreset === 'custom' ? (
              <Field
                label="Token address"
                htmlFor="custom-token"
                hint="ERC-20 contract on Arc Testnet."
              >
                <TextInput
                  id="custom-token"
                  value={draft.customTokenAddress}
                  onChange={(e) => updateDraft({ customTokenAddress: e.target.value })}
                  placeholder="0x…"
                  className="font-mono"
                />
              </Field>
            ) : null}

            {!managing ? (
              <Field
                label="Room password"
                htmlFor="room-password"
                hint="Min 4 characters. Needed to manage, pause, and kick."
                className="sm:col-span-2"
              >
                <TextInput
                  id="room-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Min 4 characters"
                  autoComplete="new-password"
                />
              </Field>
            ) : null}
          </div>

          {/* Advanced: MetaMask / Gateway prepaid pricing */}
          <details className="group border-t border-border/70 px-5 py-4 sm:px-6">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
              Advanced — MetaMask / Gateway pricing
            </summary>
            <div className="grid grid-cols-1 gap-5 pt-5 sm:grid-cols-2">
              <Field
                label="Charge amount"
                htmlFor="mm-price"
                hint="Prepaid Gateway sessions always use USDC."
              >
                <InputAffix
                  id="mm-price"
                  affix="USDC"
                  inputMode="decimal"
                  value={draft.tickPrice}
                  onChange={(e) => updateDraft({ tickPrice: e.target.value })}
                />
              </Field>
              <Field label="Interval" htmlFor="mm-interval">
                <InputAffix
                  id="mm-interval"
                  affix="sec"
                  inputMode="numeric"
                  value={draft.tickSeconds}
                  onChange={(e) => updateDraft({ tickSeconds: e.target.value })}
                />
              </Field>
            </div>

            {/* Visibility — rooms are public/listed in browse by default. */}
            <div className="mt-6 border-t border-border/50 pt-5">
              <p className="mb-1 text-sm font-semibold text-foreground/90">
                Visibility
              </p>
              <p className="mb-4 text-xs text-muted-foreground">
                Public rooms appear on the browse page while accepting joins.
                Unlisted rooms still work by direct link.
              </p>
              <label className="flex cursor-pointer items-center gap-2.5 text-sm font-medium text-foreground/90">
                <input
                  type="checkbox"
                  id="room-unlisted"
                  className="size-4 accent-[var(--neon-magenta)]"
                  checked={draft.unlisted}
                  onChange={(e) => updateDraft({ unlisted: e.target.checked })}
                />
                Unlisted (opt out of browse)
              </label>
            </div>

            {/* Join gating — anti-spam / abuse controls. Stubs only: no
                server enforcement yet (see ROADMAP.md → Join gating). */}
            <div className="mt-6 border-t border-border/50 pt-5">
              <p className="mb-1 text-sm font-semibold text-foreground/90">
                Join gating{' '}
                <span className="font-normal text-muted-foreground">
                  — anti-spam / abuse controls
                </span>
              </p>
              <p className="mb-4 text-xs text-muted-foreground">
                Coming soon. Throttle low-signal or abusive join attempts
                before they reach a camera seat.
              </p>
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <span title="Coming soon" className="cursor-not-allowed">
                  <Field label="Minimum watch time" htmlFor="gate-min-watch">
                    <InputAffix
                      id="gate-min-watch"
                      affix="sec"
                      placeholder="—"
                      disabled
                      className="opacity-50"
                    />
                  </Field>
                </span>
                <span title="Coming soon" className="cursor-not-allowed">
                  <Field label="Reputation score gate" htmlFor="gate-reputation">
                    <InputAffix
                      id="gate-reputation"
                      affix="min"
                      placeholder="—"
                      disabled
                      className="opacity-50"
                    />
                  </Field>
                </span>
                <label
                  title="Coming soon"
                  className="flex cursor-not-allowed items-center gap-2.5 text-sm font-medium text-muted-foreground opacity-60"
                >
                  <input type="checkbox" id="gate-subscribers" disabled className="size-4" />
                  Subscribers only
                </label>
                <label
                  title="Coming soon"
                  className="flex cursor-not-allowed items-center gap-2.5 text-sm font-medium text-muted-foreground opacity-60"
                >
                  <input type="checkbox" id="gate-followers" disabled className="size-4" />
                  Followers only
                </label>
              </div>
            </div>
          </details>

          {/* Create room */}
          {!managing ? (
            <div className="border-t border-border/70 px-5 py-5 sm:px-6">
              <button
                type="button"
                onClick={handleCreate}
                disabled={busy}
                className="glow-magenta flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3.5 font-heading text-base font-bold uppercase tracking-wide text-primary-foreground transition-transform hover:scale-[1.01] disabled:opacity-70"
              >
                {busy ? (
                  <>
                    <RefreshCw className="size-5 animate-spin" />
                    Spinning up room…
                  </>
                ) : (
                  <>
                    <Rocket className="size-5" />
                    Create room
                  </>
                )}
              </button>
              {error ? (
                <p className="mt-3 text-sm text-[var(--neon-magenta)]" aria-live="polite">
                  {error}
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      {/* Result panel — viewer link points at the new Next.js join page
          (primary); the OBS overlay URL comes from the backend, which still
          serves the overlay. The legacy Express join page remains a fallback
          at the backend origin. */}
      {success ? (
        <p className="border-t border-border/70 px-5 py-3 text-sm text-[var(--neon-lime)] sm:px-6" aria-live="polite">
          {success}
        </p>
      ) : null}

      {managing && joinUrl && overlayUrl && room ? (
        <div
          ref={resultRef}
          className="border-t border-border/70 bg-input/20 px-5 py-5 sm:px-6"
        >
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Link2 className="size-4 text-[var(--neon-lime)]" />
            Room <span className="font-mono text-[var(--neon-lime)]">{room.id}</span>{' '}
            {room.active ? 'is live' : 'is paused'}
          </div>
          <div className="flex flex-col gap-2">
            <CopyRow
              label="Viewer"
              value={
                typeof window !== 'undefined'
                  ? `${window.location.origin}/join?room=${room.id}`
                  : joinUrl
              }
            />
            <CopyRow label="OBS" value={overlayUrl} />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Drop the viewer link in chat. Add the OBS link as a Browser Source
            (~340×620 px, transparent background) to show cameras on your scene.
          </p>
        </div>
      ) : null}
    </GlassCard>
  )
}
