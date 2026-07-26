'use client'

import { useEffect, useRef, useState } from 'react'
import { Radio, Rocket, RefreshCw, KeyRound, ChevronDown } from 'lucide-react'
import { GlassCard, CardHeader } from '@/components/glass-card'
import {
  Field,
  TextInput,
  InputAffix,
  SelectInput,
  Toggle,
} from '@/components/form-primitives'
import { useRoom } from '@/components/room-provider'
import { useUiMode } from '@/lib/ui-mode'
import { cn } from '@/lib/utils'

export function MegaChatSettings() {
  const {
    mode,
    room,
    draft,
    updateDraft,
    create,
    unlock,
    toggleActive,
    switchRoom,
    livekitConfigured,
    identityHandle,
    hasIdentity,
    myRooms,
    openOwnedRoom,
    linkedTwitch,
  } = useRoom()

  // Server-verified sign-in → you OWN rooms you create (no password needed).
  // Uses the real identity cookie, not the Privy display-name fallback.
  const signedIn = hasIdentity
  // FREE room = per-second price 0. One switch drives the whole free path
  // (seats + auto-priced MegaChats); flip it off to restore the dust default.
  // EXPLICIT state, not derived from the price string: backspacing the price
  // to empty must NOT auto-check free (empty ≠ free), and typing the "0" of
  // "0.005" must not unmount the field mid-keystroke. Only the user's click
  // (or opening a room that IS free) sets it.
  const [freeRoom, setFreeRoom] = useState(false)
  // An empty/garbled price is INVALID, not free — create pauses on it.
  const priceInvalid =
    !freeRoom &&
    (draft.passkeyTickPrice.trim() === '' ||
      !isFinite(parseFloat(draft.passkeyTickPrice)) ||
      parseFloat(draft.passkeyTickPrice) < 0)

  // Opening/switching a room re-derives the switch from the ROOM's saved
  // price. Keyed on the room, not the price string — typing must never flip
  // the checkbox.
  useEffect(() => {
    setFreeRoom(draft.passkeyTickPrice === '0')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, room?.id])

  // Create form is the landing state ONLY when you have no rooms; owners
  // reveal it deliberately via "New room".
  const [showCreate, setShowCreate] = useState(false)
  const [password, setPassword] = useState('')
  // "picking" = signed-in owner choosing a room, not configuring one.
  const picking = mode !== 'managing' && myRooms.length > 0 && !showCreate
  const [manageRoomId, setManageRoomId] = useState('')
  const [managePassword, setManagePassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const managing = mode === 'managing'
  const simple = useUiMode() === 'simple'
  const token = draft.tokenPreset === 'custom' ? 'TOKEN' : 'USDC'
  const tokenSymbol = room?.paymentTokenSymbol || token
  // Simple mode: USDC is dollar-pegged, so amounts read as $ 1:1 and the
  // per-second price IS the price per credit. Presentation only.
  const amountAffix = simple ? '$' : tokenSymbol

  async function handleCreate() {
    setError(null)
    setSuccess(null)
    // Password is optional when signed in (you own the room); required only
    // for anonymous rooms, which need SOME admin path.
    if (!signedIn && (!password || password.length < 4)) {
      setError('Sign in to own this room, or set a room password (min 4 characters).')
      return
    }
    if (password && password.length < 4) {
      setError('Room password must be at least 4 characters.')
      return
    }
    setBusy(true)
    try {
      await create(password || undefined)
      setSuccess('Room created — grab your links from the Share links card.')
      requestAnimationFrame(() => {
        document.getElementById('share-links')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
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

  async function handleOpenOwned(roomId: string) {
    setError(null)
    setBusy(true)
    try {
      await openOwnedRoom(roomId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open that room')
    } finally {
      setBusy(false)
    }
  }

  return (
    <GlassCard>
      <CardHeader
        icon={<Radio className="size-5" />}
        title={managing ? 'MegaChat Settings' : picking ? 'Your rooms' : 'New room'}
        description={
          managing
            ? 'Changes save automatically while you stream.'
            : picking
              ? 'Open one to manage it, or start another.'
              : 'Configure how viewers buy their moment on stream.'
        }
        accent="magenta"
        action={
          // Managing status lives in the bar BELOW — crammed in beside the
          // title it squeezed the header onto three lines in the narrow
          // column, and the room chip just repeated the Share links URL.
          managing ? null : picking ? null : (
            <span className="hidden items-center gap-1.5 rounded-full border border-border bg-input/30 px-3 py-1 text-xs font-medium text-muted-foreground sm:inline-flex">
              <span className="size-1.5 rounded-full bg-[var(--neon-lime)]" />
              Draft
            </span>
          )
        }
      />

      {/* YOUR ROOMS — one click back into any room you own, no password.
          When you HAVE rooms this is the page: the old layout led with a
          create form, then offered your rooms, THEN offered a create/manage
          tab pair — three affordances for two jobs, with the two "manage"
          paths competing (one click here vs typing an id + password there). */}
      {!managing && myRooms.length > 0 ? (
        <div className="border-b border-border/70 px-5 pt-5 pb-4 sm:px-6">
          {/* no "YOUR ROOMS" kicker — the card header already says it */}
          <div className="flex flex-col gap-2">
            {myRooms.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => void handleOpenOwned(r.id)}
                disabled={busy}
                className="group flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-input/20 px-4 py-3 text-left transition-colors hover:border-[var(--neon-lime)]/50 hover:bg-input/40 disabled:opacity-60"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-foreground">
                    {r.name}
                  </span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {r.handle ? `/${r.handle}` : r.id}
                    {r.live > 0 ? ` · ${r.live} live` : r.active ? ' · open' : ' · paused'}
                  </span>
                </span>
                <span className="shrink-0 text-xs font-bold text-[var(--neon-lime)] opacity-80 group-hover:opacity-100">
                  Manage →
                </span>
              </button>
            ))}
          </div>
          {/* Create is a deliberate secondary action once you own rooms —
              not the page you land on. (Extra rooms ARE allowed; only the
              handle is one-per-account, so a second room gets a hex link.) */}
          {!showCreate ? (
            <button
              type="button"
              id="new-room"
              onClick={() => {
                setShowCreate(true)
                setError(null)
              }}
              className="mt-3 flex items-center gap-2 rounded-full border border-border bg-input/30 px-4 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
            >
              <Rocket className="size-3.5" />
              Start new room
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Managing header (unchanged); the create/manage TAB PAIR is gone —
          owners use the list above, and the id+password path is a
          disclosure at the bottom for mods / other devices. */}
      {!managing ? null : (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border/70 px-5 pt-4 pb-3 sm:px-6">
          <span className="text-xs font-semibold text-muted-foreground">
            Managing{' '}
            <span className="text-[var(--neon-lime)]">{room?.name}</span>
          </span>
          <span className="flex items-center gap-2">
            {/* the toggle needs words — an unlabeled pink switch reads as
                "wtf is this", not "room is accepting joins" */}
            {room ? (
              <>
                <span
                  className={cn(
                    'whitespace-nowrap text-xs font-semibold',
                    room.active ? 'text-[var(--neon-lime)]' : 'text-muted-foreground',
                  )}
                >
                  {room.active ? 'Accepting joins' : 'Paused'}
                </span>
                <Toggle
                  checked={room.active}
                  onChange={() => void toggleActive()}
                  label={room.active ? 'Accepting joins' : 'Paused'}
                />
              </>
            ) : null}
            {/* one click to start another room from inside a live one */}
            <button
              type="button"
              id="new-room-managing"
              onClick={() => {
                switchRoom()
                setShowCreate(true)
                setError(null)
              }}
              className="rounded-full border border-border bg-input/30 px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Start new room
            </button>
            {myRooms.length > 1 ? (
              <button
                type="button"
                onClick={() => {
                  switchRoom()
                  setShowCreate(false)
                }}
                className="rounded-full border border-border bg-input/30 px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                Switch room
              </button>
            ) : null}
          </span>
        </div>
      )}

      {/* Unlock-by-password — a DISCLOSURE, not a peer of your rooms list.
          It exists for mods and for signing in from a device that isn't
          carrying your identity cookie; owners never need it. */}
      {!managing ? (
        <details className="group border-b border-border/70 px-5 py-3 sm:px-6">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            <KeyRound className="size-3.5" />
            Have a room ID + password? Unlock it
            <ChevronDown className="ml-auto size-3.5 transition-transform group-open:rotate-180" />
          </summary>
          <div className="grid grid-cols-1 gap-4 pt-4 sm:grid-cols-2">
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
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-input/30 px-4 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-input/50 disabled:opacity-70"
              >
                {busy ? (
                  <>
                    <RefreshCw className="size-4 animate-spin" />
                    Unlocking…
                  </>
                ) : (
                  <>
                    <KeyRound className="size-4" />
                    Unlock room
                  </>
                )}
              </button>
            </div>
          </div>
        </details>
      ) : null}

      {/* Create form — the default ONLY when there's nothing to manage. */}
      {!managing && myRooms.length > 0 && !showCreate ? null : (
        <>
          <div className="grid grid-cols-1 gap-5 px-5 py-6 sm:grid-cols-2 sm:px-6">
            {/* no hint — "shown to viewers" explains what a name is */}
            <Field label="Room name" htmlFor="room-name" className="sm:col-span-2">
              <TextInput
                id="room-name"
                value={draft.name}
                onChange={(e) => updateDraft({ name: e.target.value })}
                placeholder="late-night-arena"
              />
            </Field>

            <Field
              label="Display name"
              htmlFor="room-handle"
              hint={
                managing && !draft.handle
                  ? 'This room has a temporary link — type a name here (or use the Claim button in the links panel below) to make it permanent.'
                  : identityHandle && draft.handle === identityHandle
                    ? `Prefilled from your sign-in. It's also your permanent link: megachat.xyz/${identityHandle} (and /${identityHandle}/overlay for OBS). Change it any time — letters, numbers, underscore.`
                    : identityHandle
                      ? `Your reserved name is @${identityHandle}. This is your display name and your permanent link, e.g. megachat.xyz/${draft.handle || 'your_name'}. Letters, numbers, underscore.`
                      : 'Your display name, and your permanent link: megachat.xyz/your_name (viewers) and /your_name/overlay (OBS). Leave it empty for a temporary link you can set later. Letters, numbers, underscore.'
              }
              className="sm:col-span-2"
            >
              <TextInput
                id="room-handle"
                value={draft.handle}
                onChange={(e) => updateDraft({ handle: e.target.value })}
                placeholder="your_name"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>

            {/* THE two features, up top where they belong. MegaChats is the
                hero (default on); Join Stream is the live dopamine mode.
                Everything below the fold is detail with good defaults. */}
            <div className="grid grid-cols-1 gap-3 sm:col-span-2 sm:grid-cols-2">
              <label
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors',
                  draft.lettersEnabled
                    ? 'border-[var(--neon-magenta)]/60 bg-[var(--neon-magenta)]/10'
                    : 'border-border bg-input/20 opacity-75',
                )}
              >
                <input
                  type="checkbox"
                  id="letters-enabled"
                  className="mt-0.5 size-4 accent-[var(--neon-magenta)]"
                  checked={draft.lettersEnabled}
                  onChange={(e) => updateDraft({ lettersEnabled: e.target.checked })}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-heading text-sm font-bold text-foreground">
                    📼 MegaChats
                  </span>
                  <span className="text-xs leading-relaxed text-muted-foreground">
                    Viewers record a clip, pay flat, it plays once on stream.
                  </span>
                </span>
              </label>
              <label
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors',
                  draft.joinStreamEnabled
                    ? 'border-[var(--neon-lime)]/60 bg-[var(--neon-lime)]/10'
                    : 'border-border bg-input/20 opacity-75',
                )}
              >
                <input
                  type="checkbox"
                  id="joinstream-enabled"
                  className="mt-0.5 size-4 accent-[var(--neon-lime)]"
                  checked={draft.joinStreamEnabled}
                  onChange={(e) => updateDraft({ joinStreamEnabled: e.target.checked })}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-heading text-sm font-bold text-foreground">
                    ⚡ Join Stream
                  </span>
                  <span className="text-xs leading-relaxed text-muted-foreground">
                    Live camera seats on your broadcast, billed per second.
                  </span>
                </span>
              </label>
            </div>

            {/* FREE switch — up top, one flip, no other setup needed. */}
            <label
              className={cn(
                // same geometry as the feature tiles above (DESIGN.md: ONE
                // selectable-card archetype)
                'flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors sm:col-span-2',
                freeRoom
                  ? 'border-[var(--neon-cyan)]/60 bg-[var(--neon-cyan)]/10'
                  : 'border-border bg-input/20',
              )}
            >
              <input
                type="checkbox"
                id="free-room"
                className="mt-0.5 size-4 accent-[var(--neon-cyan)]"
                checked={freeRoom}
                onChange={(e) => {
                  setFreeRoom(e.target.checked)
                  updateDraft({ passkeyTickPrice: e.target.checked ? '0' : '0.001' })
                }}
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-heading text-sm font-bold text-foreground">
                  💸 Free room
                </span>
                <span className="text-xs leading-relaxed text-muted-foreground">
                  No charges — viewers hop on camera (and send MegaChats) without
                  a wallet. Flip off to set a price.
                </span>
              </span>
            </label>

            {!freeRoom ? (
            <Field
              label={
                simple
                  ? 'Price per credit'
                  : draft.passkeyTickSeconds === '1'
                    ? 'Price per second'
                    : `Price per ${draft.passkeyTickSeconds}s charge`
              }
              htmlFor="price"
              hint={
                simple
                  ? 'What one credit (one second on camera) costs viewers.'
                  : 'Drives Join Stream metering AND the auto MegaChat price.'
              }
            >
              <InputAffix
                id="price"
                affix={amountAffix}
                inputMode="decimal"
                value={draft.passkeyTickPrice}
                onChange={(e) => updateDraft({ passkeyTickPrice: e.target.value })}
              />
              {priceInvalid ? (
                <p id="price-invalid" className="mt-1.5 text-xs text-[var(--neon-cyan)]">
                  Enter a price — or flip 💸 Free room above.
                </p>
              ) : null}
            </Field>
            ) : null}

            {/* Connected Twitch — VISIBLE, not buried in Advanced.
                Connecting Twitch is itself the opt-in; making someone re-enter
                their own handle in a collapsed panel was the bug. Shows what it
                actually powers, and offers a real way out. */}
            {linkedTwitch ? (
              <label
                htmlFor="twitch-auto"
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors sm:col-span-2',
                  draft.twitchAuto
                    ? 'border-[var(--neon-violet)]/60 bg-[var(--neon-violet)]/10'
                    : 'border-border bg-input/20',
                )}
              >
                <input
                  type="checkbox"
                  id="twitch-auto"
                  className="mt-0.5 size-4 accent-[var(--neon-violet)]"
                  checked={draft.twitchAuto}
                  onChange={(e) => {
                    const on = e.target.checked
                    // Opting out clears the channel too — leaving the handle
                    // behind while the toggle says "off" is the kind of
                    // half-state that makes people distrust a settings page.
                    updateDraft(
                      on
                        ? { twitchAuto: true, twitchChannel: linkedTwitch }
                        : { twitchAuto: false, twitchChannel: '' },
                    )
                  }}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-heading text-sm font-bold text-foreground">
                    📺 Use your Twitch{' '}
                    <span className="font-mono text-xs font-normal text-[var(--neon-violet)]">
                      @{linkedTwitch}
                    </span>
                  </span>
                  <span className="text-xs leading-relaxed text-muted-foreground">
                    {draft.twitchAuto
                      ? 'Your stream shows on your join page, and your live thumbnail shows in Browse. Already on — nothing to set up.'
                      : "Off — your room won't show a stream preview or a live thumbnail."}
                  </span>
                  {draft.twitchAuto && draft.twitchChannel && draft.twitchChannel !== linkedTwitch ? (
                    <span className="mt-1 text-xs text-[var(--neon-amber)]">
                      Using <span className="font-mono">@{draft.twitchChannel}</span> instead —
                      set under Advanced.
                    </span>
                  ) : null}
                </span>
              </label>
            ) : null}

            {!managing && !signedIn ? (
              <Field
                label={signedIn ? 'Mod password (optional)' : 'Room password'}
                htmlFor="room-password"
                hint={
                  signedIn
                    ? "You own this room via your sign-in — no password needed to manage it. Set one only to share management with mods."
                    : 'Min 4 characters. Needed to manage, pause, and kick. (Or sign in to skip it.)'
                }
                className="sm:col-span-2"
              >
                <TextInput
                  id="room-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={signedIn ? 'Optional — for sharing with mods' : 'Min 4 characters'}
                  autoComplete="new-password"
                />
              </Field>
            ) : null}
          </div>

          {/* Everything else lives here, prefilled with good defaults and
              ordered by how often streamers actually touch it. */}
          <details className="group border-t border-border/70 px-5 py-4 sm:px-6">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
              <span className="adv-only">Advanced — fine-tuning (good defaults preset)</span>
              <span className="simple-only">More settings</span>
            </summary>

            {/* 1 · MegaChat details — the hero feature, most-touched knobs */}
            <div className="pt-5">
              <p className="mb-4 text-sm font-semibold text-foreground/90">
                📼 MegaChat details
              </p>
              {draft.lettersEnabled ? (
                <>
                  {/* Real, working knobs only — pure Field grid, consistent
                      height, no checkbox squeezed into a cell sized for a
                      labeled input. */}
                  <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
                    <Field label="Max length" htmlFor="letters-max">
                      <InputAffix
                        id="letters-max"
                        affix="sec"
                        inputMode="numeric"
                        value={draft.lettersMaxSeconds}
                        onChange={(e) => updateDraft({ lettersMaxSeconds: e.target.value })}
                      />
                    </Field>
                    <Field
                      label="Flat price"
                      htmlFor="letters-price"
                      hint="Empty = max length × per-second rate."
                    >
                      <InputAffix
                        id="letters-price"
                        affix={amountAffix}
                        inputMode="decimal"
                        placeholder="auto"
                        value={draft.lettersPrice}
                        onChange={(e) => updateDraft({ lettersPrice: e.target.value })}
                      />
                    </Field>
                    <Field label="Moderation" htmlFor="letters-moderation">
                      <SelectInput
                        id="letters-moderation"
                        value={draft.lettersModeration}
                        onChange={(e) =>
                          updateDraft({ lettersModeration: e.target.value as 'auto' | 'approve' })
                        }
                      >
                        <option value="auto">Auto-play (default)</option>
                        <option value="approve">Approve queue</option>
                      </SelectInput>
                    </Field>
                    <Field
                      label="AI review strictness"
                      htmlFor="letters-ai-strictness"
                      hint="Runs only when the server has a moderation key."
                    >
                      <SelectInput
                        id="letters-ai-strictness"
                        value={draft.lettersAiStrictness}
                        onChange={(e) =>
                          updateDraft({ lettersAiStrictness: e.target.value as 'severe' | 'borderline' })
                        }
                      >
                        <option value="severe">Block only severe</option>
                        <option value="borderline">Flag borderline too</option>
                      </SelectInput>
                    </Field>
                    <Field
                      label="Min watch time"
                      htmlFor="mc-min-watch"
                      hint="0 = open to all. Enforced live."
                    >
                      <InputAffix
                        id="mc-min-watch"
                        affix="sec"
                        inputMode="numeric"
                        value={draft.mcMinWatch}
                        onChange={(e) => updateDraft({ mcMinWatch: e.target.value })}
                      />
                    </Field>
                  </div>

                  {/* Toggles: ONE compact row, not a grid cell each and not
                      a separate boxed section — `shrink-0 whitespace-nowrap`
                      keeps every label glued to its own checkbox instead of
                      wrapping the text away from the input. Muted color +
                      inline "(soon)" mark the two that don't do anything yet
                      without spending a whole labeled block on that fact. */}
                  <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2">
                    <label className="flex shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap text-sm font-medium text-foreground/90">
                      <input
                        type="checkbox"
                        id="letters-auto-refund"
                        className="size-4 accent-[var(--neon-magenta)]"
                        checked={draft.lettersAutoRefund}
                        onChange={(e) => updateDraft({ lettersAutoRefund: e.target.checked })}
                      />
                      Auto-refund on reject
                    </label>
                    <label
                      className="flex shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap text-sm text-muted-foreground"
                      title="Stored now; enforced when platform verification ships"
                    >
                      <input
                        type="checkbox"
                        id="mc-followers-only"
                        className="size-4 accent-[var(--neon-magenta)]"
                        checked={draft.mcFollowersOnly}
                        onChange={(e) => updateDraft({ mcFollowersOnly: e.target.checked })}
                      />
                      Followers only <span className="text-xs">(soon)</span>
                    </label>
                    <label
                      className="flex shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap text-sm text-muted-foreground"
                      title="Stored now; enforced when platform verification ships"
                    >
                      <input
                        type="checkbox"
                        id="mc-subs-only"
                        className="size-4 accent-[var(--neon-magenta)]"
                        checked={draft.mcSubsOnly}
                        onChange={(e) => updateDraft({ mcSubsOnly: e.target.checked })}
                      />
                      Subscribers only <span className="text-xs">(soon)</span>
                    </label>
                  </div>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  MegaChats are off — flip the tile up top to configure them.
                </p>
              )}
            </div>

            {/* 2 · Join Stream details — gates inherit from MegaChats
                (billing/shipping-address pattern) unless overridden */}
            <div className="mt-6 border-t border-border/50 pt-5">
              <p className="mb-4 text-sm font-semibold text-foreground/90">
                ⚡ Join Stream details
              </p>
              {draft.joinStreamEnabled ? (
                <>
                  <label className="mb-3 flex cursor-pointer items-center gap-2.5 text-sm font-medium text-foreground/90">
                    <input
                      type="checkbox"
                      id="js-gates-same"
                      className="size-4 accent-[var(--neon-magenta)]"
                      checked={draft.jsGatesSame}
                      onChange={(e) => updateDraft({ jsGatesSame: e.target.checked })}
                    />
                    Same gates as MegaChats
                  </label>
                  {!draft.jsGatesSame ? (
                    <div className="flex flex-col gap-5">
                      <Field
                        label="Min watch time"
                        htmlFor="js-min-watch"
                        hint="0 = open to all."
                        className="max-w-xs"
                      >
                        <InputAffix
                          id="js-min-watch"
                          affix="sec"
                          inputMode="numeric"
                          value={draft.jsMinWatch}
                          onChange={(e) => updateDraft({ jsMinWatch: e.target.value })}
                        />
                      </Field>
                      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                        <label
                          className="flex shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap text-sm text-muted-foreground"
                          title="Stored now; enforced when platform verification ships"
                        >
                          <input
                            type="checkbox"
                            id="js-followers-only"
                            className="size-4 accent-[var(--neon-magenta)]"
                            checked={draft.jsFollowersOnly}
                            onChange={(e) => updateDraft({ jsFollowersOnly: e.target.checked })}
                          />
                          Followers only <span className="text-xs">(soon)</span>
                        </label>
                        <label
                          className="flex shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap text-sm text-muted-foreground"
                          title="Stored now; enforced when platform verification ships"
                        >
                          <input
                            type="checkbox"
                            id="js-subs-only"
                            className="size-4 accent-[var(--neon-magenta)]"
                            checked={draft.jsSubsOnly}
                            onChange={(e) => updateDraft({ jsSubsOnly: e.target.checked })}
                          />
                          Subscribers only <span className="text-xs">(soon)</span>
                        </label>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Join Stream is off — this is a MegaChats-only room.
                </p>
              )}
            </div>

            {/* 3 · Stream & overlay */}
            <div className="mt-6 border-t border-border/50 pt-5">
              <p className="mb-4 text-sm font-semibold text-foreground/90">
                Stream &amp; overlay
              </p>
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <Field
                  label="Twitch channel"
                  htmlFor="twitch-channel"
                  hint={
                    linkedTwitch
                      ? `Override — defaults to your connected @${linkedTwitch}. Set a different channel here, or clear it to fall back.`
                      : 'Embeds your stream on the join page and shows a live thumbnail in Browse. Empty = skip.'
                  }
                >
                  <TextInput
                    id="twitch-channel"
                    value={draft.twitchChannel}
                    onChange={(e) => updateDraft({ twitchChannel: e.target.value })}
                    placeholder="your_twitch_login"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                <Field
                  label="Max seats"
                  htmlFor="max-seats"
                  hint="Cameras live at once (up to 3)."
                >
                  <InputAffix
                    id="max-seats"
                    affix="cams"
                    inputMode="numeric"
                    value={draft.maxSeats}
                    onChange={(e) => updateDraft({ maxSeats: e.target.value })}
                  />
                </Field>
              </div>
              <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-sm font-medium text-foreground/90">
                <input
                  type="checkbox"
                  id="stinger-sounds"
                  className="size-4 accent-[var(--neon-magenta)]"
                  checked={draft.stingerSounds}
                  onChange={(e) => updateDraft({ stingerSounds: e.target.checked })}
                />
                Stinger sounds on the overlay
                <span className="text-xs font-normal text-muted-foreground">
                  — paired SFX for every entrance/exit
                </span>
              </label>
            </div>

            {/* 4 · Pricing plumbing — 99% of rooms never touch any of this */}
            <div className="mt-6 border-t border-border/50 pt-5">
              <p className="mb-4 text-sm font-semibold text-foreground/90">
                Pricing plumbing
              </p>
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <Field
                  label="Max spend / viewer"
                  htmlFor="max-spend"
                  hint="Auto-kicks the camera when reached. Default 2."
                >
                  <InputAffix
                    id="max-spend"
                    affix={amountAffix}
                    inputMode="decimal"
                    value={draft.maxSession}
                    onChange={(e) => updateDraft({ maxSession: e.target.value })}
                  />
                </Field>
                <Field
                  label="Charge interval"
                  htmlFor="interval"
                  hint="Seconds per charge — almost every room leaves this at 1."
                  className="adv-only"
                >
                  <InputAffix
                    id="interval"
                    affix="sec"
                    inputMode="numeric"
                    value={draft.passkeyTickSeconds}
                    onChange={(e) => updateDraft({ passkeyTickSeconds: e.target.value })}
                  />
                </Field>
                <Field
                  label="Payment token"
                  htmlFor="token"
                  className="adv-only"
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
                    hint="TIP-20 contract on Tempo."
                    className="adv-only"
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
                <Field
                  label="Charge amount"
                  htmlFor="mm-price"
                  hint="MetaMask/Gateway prepaid sessions (always USDC)."
                  className="adv-only"
                >
                  <InputAffix
                    id="mm-price"
                    affix="USDC"
                    inputMode="decimal"
                    value={draft.tickPrice}
                    onChange={(e) => updateDraft({ tickPrice: e.target.value })}
                  />
                </Field>
                <Field label="Interval" htmlFor="mm-interval" className="adv-only">
                  <InputAffix
                    id="mm-interval"
                    affix="sec"
                    inputMode="numeric"
                    value={draft.tickSeconds}
                    onChange={(e) => updateDraft({ tickSeconds: e.target.value })}
                  />
                </Field>
              </div>
            </div>

            {/* 5 · Visibility & payout */}
            <div className="mt-6 border-t border-border/50 pt-5">
              <p className="mb-4 text-sm font-semibold text-foreground/90">
                Visibility &amp; payout
              </p>
              {!managing && signedIn ? (
                <Field
                  label="Mod password (optional)"
                  htmlFor="room-password"
                  hint="You own this room via your sign-in. Set a password only to share management with mods."
                >
                  <TextInput
                    id="room-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Optional — for sharing with mods"
                    autoComplete="new-password"
                  />
                </Field>
              ) : null}
              <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-sm font-medium text-foreground/90">
                <input
                  type="checkbox"
                  id="room-unlisted"
                  className="size-4 accent-[var(--neon-magenta)]"
                  checked={draft.unlisted}
                  onChange={(e) => updateDraft({ unlisted: e.target.checked })}
                />
                Unlisted (opt out of browse — direct link still works)
              </label>
              <Field
                label="Payout wallet"
                hint="Viewer payments settle straight to this address on Tempo. Empty = platform wallet."
                className="adv-only"
              >
                <TextInput
                  id="room-payout"
                  placeholder="0x… (optional)"
                  value={draft.payoutAddress}
                  onChange={(e) => updateDraft({ payoutAddress: e.target.value })}
                  spellCheck={false}
                />
              </Field>
            </div>

            {/* 6 · Camera transport — LiveKit (default once configured) or vdo.ninja (backup) */}
            <div className="mt-6 border-t border-border/50 pt-5">
              <p className="mb-1 text-sm font-semibold text-foreground/90">
                Camera transport
              </p>
              <p className="mb-4 text-xs text-muted-foreground">
                {livekitConfigured
                  ? 'LiveKit is the default — smoother reconnection and per-viewer connection quality. vdo.ninja stays available as a battle-tested backup.'
                  : 'vdo.ninja is the default; LiveKit unlocks once configured on the server.'}
              </p>
              <Field label="Transport" htmlFor="room-transport">
                <SelectInput
                  id="room-transport"
                  value={draft.transport}
                  onChange={(e) =>
                    updateDraft({ transport: e.target.value as 'vdo' | 'livekit' })
                  }
                >
                  {livekitConfigured ? (
                    <>
                      <option value="livekit">LiveKit (default)</option>
                      <option value="vdo">vdo.ninja (backup)</option>
                    </>
                  ) : (
                    <>
                      <option value="vdo">vdo.ninja (default)</option>
                      <option value="livekit" disabled>
                        LiveKit — not configured
                      </option>
                    </>
                  )}
                </SelectInput>
              </Field>
            </div>
          </details>

          {/* Create room */}
          {!managing ? (
            <div className="border-t border-border/70 px-5 py-5 sm:px-6">
              <button
                type="button"
                onClick={handleCreate}
                disabled={busy || priceInvalid}
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

      {/* Share links moved OUT to their own top-of-column card
          (share-links-card.tsx) — they were buried down here under Advanced,
          which is the last place a streamer's two most important URLs belong. */}
    </GlassCard>
  )
}
