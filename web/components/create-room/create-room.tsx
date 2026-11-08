'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronRight, LockKeyhole, Pause, Play } from 'lucide-react'
import { AccountChip } from '@/components/account-chip'
import { BrandText } from '@/components/brand-text'
import { FeatureTag, type FeatureKind } from '@/components/feature-tag'
import { HollerMark } from '@/components/holler-mark'
import { ThemeToggle } from '@/components/theme-toggle'
import { InfoTip } from '@/components/info-tip'
import { useAccount } from '@/lib/use-account'
import { RoomRecovery } from '@/components/room-recovery'
import { ObsSetup } from './obs-setup'
import { LayoutEditor } from './layout-editor'
import { OverlayHealthCard } from '@/components/overlay-health-card'
import { OnCameraTable } from '@/components/on-camera-table'
import { HostCamCard } from '@/components/host-cam-card'
import { LettersQueueCard } from '@/components/letters-queue-card'
import { TwitchPreview } from '@/components/twitch-preview'
import { REWARD_DEFAULTS, useRoom } from '@/components/room-provider'
import { ApiError } from '@/lib/api'
import { formatDollars } from '@/lib/display-format'
import './create-room.css'

const CLIP_SECONDS = [5, 10, 15, 20, 30] as const
const SEAT_SECONDS = [10, 20, 30, 60, 120] as const
const MIN_RATE = 0.000001

function cleanPrice(raw: string, fallback: string) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return fallback
  if (value === 0) return '0'
  return String(Number(Math.max(MIN_RATE, value).toFixed(6)))
}

function PriceInput({ value, onCommit, label, suffix }: { value: string; onCommit: (value: string) => void; label: string; suffix?: string }) {
  const [raw, setRaw] = useState(value)
  useEffect(() => setRaw(value), [value])
  return <span className="mcc-money-input"><span>$</span><input aria-label={label} inputMode="decimal" value={raw} onChange={(event) => { if (/^\d*\.?\d{0,6}$/.test(event.target.value)) setRaw(event.target.value) }} onFocus={(event) => event.currentTarget.select()} onBlur={() => { const next = cleanPrice(raw, value); setRaw(next); onCommit(next) }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />{suffix ? <b>{suffix}</b> : null}</span>
}

// Always a field: it looks typeable, so it needs no "click to rename" line.
function InlineText({ value, onChange, placeholder, label, sanitize, className = '' }: { value: string; onChange: (value: string) => void; placeholder: string; label: string; sanitize?: (value: string) => string; className?: string }) {
  return <input className={`mcc-inline-input ${className}`} aria-label={label} value={value} placeholder={placeholder} spellCheck={false} onChange={(event) => onChange(sanitize ? sanitize(event.target.value) : event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur() }} />
}

// Shows only after the person has typed in this field, and only while
// managing (autosave): saving, then a check that fades out.
function SaveMark({ touched, state }: { touched: boolean; state: 'saved' | 'saving' | 'error' }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!touched) return
    setShown(true)
    if (state !== 'saved') return
    const t = setTimeout(() => setShown(false), 1800)
    return () => clearTimeout(t)
  }, [touched, state])
  if (!touched) return null
  return <span className="mcc-savemark" data-state={state} data-shown={shown} role="status" aria-live="polite">{state === 'saving' ? 'Saving' : state === 'error' ? 'Not saved' : <><Check size={13} strokeWidth={2.4} aria-hidden="true" />Saved</>}</span>
}

function Segment<T extends string | number>({ value, onChange, label, options }: { value: T; onChange: (value: T) => void; label: string; options: readonly { value: T; label: string }[] }) {
  return <span className="mcc-segment" role="group" aria-label={label}>{options.map((option) => <button key={String(option.value)} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>{option.label}</button>)}</span>
}

// The tile marks come from the product's own vocabulary, not an icon kit:
// the record dot (a Holler is a recording), the dashed seat frame with its +
// (an open seat on the board cards), and a Space Mono $ (rewards pay out).
function FeatureMark({ kind }: { kind: FeatureKind }) {
  if (kind === 'holler') return <span className="mcc-mark mcc-mark--holler" aria-hidden="true"><i /></span>
  if (kind === 'callin') return <span className="mcc-mark mcc-mark--callin" aria-hidden="true">+</span>
  return <span className="mcc-mark mcc-mark--rewards" aria-hidden="true">$</span>
}

// Each tile wears its feature's colour only while it is ON — tint, edge,
// switch, icon and the same tag viewers see on the room's card. OFF is
// neutral. The tag is decoration here: the sr-only On/Off carries the state.
function Feature({ kind, title, copy, enabled, onToggle, offLabel = 'Off', children }: { kind: FeatureKind; title: string; copy: string; enabled: boolean; onToggle: () => void; offLabel?: string; children?: ReactNode }) {
  return <section className="mcc-feature" data-kind={kind} data-enabled={enabled}><button type="button" className="mcc-feature-head" aria-pressed={enabled} onClick={onToggle}><span className="mcc-feature-icon"><FeatureMark kind={kind} /></span><span className="mcc-feature-copy"><span className="mcc-feature-title"><strong>{title}</strong>{enabled ? <span className="mcc-feature-tag" aria-hidden="true"><FeatureTag kind={kind} /></span> : null}</span><small>{copy}</small></span><span className="mcc-toggle" aria-hidden="true"><i /></span><span className="sr-only">{enabled ? 'On' : offLabel}</span></button>{enabled && children ? <div className="mcc-feature-body">{children}</div> : null}</section>
}

// The room's offer as viewers see it on the board: one tag per feature that
// is on, in the order the product sells them (lib/room-browse featureKinds).
function featureList(holler: boolean, callin: boolean, rewards: boolean) {
  const kinds: FeatureKind[] = []
  if (holler) kinds.push('holler')
  if (callin) kinds.push('callin')
  if (rewards) kinds.push('rewards')
  return kinds
}

function FeatureTags({ kinds, className = '' }: { kinds: FeatureKind[]; className?: string }) {
  if (kinds.length === 0) return null
  return <span className={`mcc-tags ${className}`}>{kinds.map((kind) => <FeatureTag key={kind} kind={kind} />)}</span>
}

/**
 * "Open and close with my Twitch stream" with the channel it follows in the
 * same row. With no channel the switch reads off and a click goes to the
 * field; typing the first character of a channel turns it on (owner's pick,
 * 2026-11-08: the switch used to sit on with nothing to follow).
 */
function FollowRow({ channel, auto, onChannel, onAuto }: { channel: string; auto: boolean; onChannel: (value: string) => void; onAuto: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const has = channel.trim() !== ''
  const on = has && auto
  const title = 'Open and close with my Twitch stream'
  return <div className="mcc-switch-row mcc-follow-row"><button type="button" role="switch" aria-checked={on} aria-disabled={!has} className="mcc-switch-btn" onClick={() => { if (has) onAuto(); else input.current?.focus() }}><span className="mcc-toggle" data-on={on} aria-hidden="true"><i /></span><strong>{title}</strong></button><label className="mcc-follow-channel"><span>twitch.tv/</span><input id="mcc-twitch-channel" ref={input} aria-label="Twitch channel" value={channel} placeholder="your channel" autoComplete="off" spellCheck={false} onChange={(event) => onChannel(event.target.value.trim().replace(/^@/, '').toLowerCase())} /></label><InfoTip text={FOLLOW_TIP} label={`About ${title}`} /></div>
}

/**
 * End room asks in a modal, not by reflowing the status bar: the inline
 * "Yes, end it" used to land where Pause room had just been, one double-click
 * from deleting a live room. Cancel takes focus; Escape and the backdrop cancel.
 */
function EndRoomDialog({ name, handle, ending, onCancel, onConfirm }: { name: string; handle?: string | null; ending: boolean; onCancel: () => void; onConfirm: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancel.current?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !ending) onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ending, onCancel])
  return <div className="mcc-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !ending) onCancel() }}><div className="mcc-modal" role="alertdialog" aria-modal="true" aria-labelledby="mcc-end-title" aria-describedby="mcc-end-body"><h2 id="mcc-end-title">Delete {name}?</h2><p id="mcc-end-body">Everyone on camera is removed{handle ? <>, and hollertv.com/{handle} stops working</> : null}. This can't be undone.</p><div className="mcc-modal-actions"><button ref={cancel} type="button" className="mcc-ghost-button" disabled={ending} onClick={onCancel}>Cancel</button><button type="button" className="mcc-end-yes" disabled={ending} onClick={onConfirm}>{ending ? 'Deleting…' : 'Delete room'}</button></div></div></div>
}

const FOLLOW_TIP = 'Go live on Twitch and this room opens and joins the board. Before you go live, it stays open while this page is open. End the stream and it pauses within a minute or two. If your connection drops instead, it waits five minutes for you to come back.'

/** m:ss until `at`, ticking each second; null when there is nothing to count. */
function useCountdown(at: string | null | undefined) {
  const target = at ? Date.parse(at) : NaN
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!Number.isFinite(target)) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [target])
  if (!Number.isFinite(target)) return null
  const s = Math.max(0, Math.ceil((target - now) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function FooterChoice({ checked, onClick, title, copy }: { checked: boolean; onClick: () => void; title: string; copy?: string }) {
  return <button type="button" className="mcc-footer-choice" aria-pressed={checked} onClick={onClick}><span className="mcc-checkbox" data-checked={checked}>{checked ? '✓' : ''}</span><span><strong>{title}</strong>{copy ? <small>{copy}</small> : null}</span></button>
}

// One page, two jobs. CREATING starts a draft; MANAGING is the same form
// bound to the room you own, autosaving as you go, with the live panels
// (links, seats, booth, queue) where the previews were. Owning a room means
// you land here IN it — never on a fresh form with a bumped handle.
export function CreateRoom() {
  const { mode, room, saveState, saveError, toggleActive, endRoom, draft, updateDraft, create, hasIdentity, identityHandle, saveDefaultsFromDraft, accountDefaults, myRooms, openOwnedRoom, twitchLive, seats, follow, adoptTwitchTitle } = useRoom()
  const { openSignIn } = useAccount()
  // One control, three states: signed out it offers the sign-in; signed in it
  // saves, or updates what is already saved.
  const defaultsLabel = !hasIdentity ? 'Sign in to store defaults' : accountDefaults ? 'Update room default settings' : 'Save as room default'
  // The moment anyone takes a seat, the live controls (who is on camera, the
  // MegaChat queue, the co-host booth) jump to the TOP of the right column
  // instead of sitting under the preview, layout editor and OBS setup. This is
  // a CSS `order` flip on a flex column, deliberately NOT a re-ordered render:
  // moving HostCamCard in the React tree would remount it, and its unmount
  // hangs up the booth — on a guest, at the exact moment they arrive.
  const liveFirst = seats.length > 0 ? { order: -1 } : undefined
  const managing = mode === 'managing' && !!room
  // The stream ended and the room pauses on its own: say when, instead of
  // "Live" for minutes after the board has already dropped it.
  const pausingIn = useCountdown(managing && room.active && follow?.state === 'ended' ? follow.closesAt : null)
  // A name the streamer typed keeps the stream title from replacing it. Only
  // then, offer the title beside it: nothing shows when the name follows the
  // stream or there is no title to offer (owner, 2026-11-07).
  const twitchTitle = managing && follow?.following && room.nameSource === 'owner' && follow.title
    && follow.title.trim() !== room.name.trim() && follow.title.trim() !== draft.name.trim() ? follow.title.trim() : null
  const [defaultsState, setDefaultsState] = useState<'idle' | 'busy' | 'saved'>('idle')
  const saveDefaultsNow = useCallback(async () => {
    setDefaultsState('busy')
    try { await saveDefaultsFromDraft(); setDefaultsState('saved'); setTimeout(() => setDefaultsState('idle'), 2400) }
    catch { setDefaultsState('idle') }
  }, [saveDefaultsFromDraft])
  // End room is destructive and irreversible — it deletes the room and clears
  // everyone on camera (each refunded) — so it two-steps: arm, then confirm.
  // Pause is the reversible "stop new joins" and stays a separate button.
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [ending, setEnding] = useState(false)
  const [endError, setEndError] = useState<string | null>(null)
  const endNow = useCallback(async () => {
    setEnding(true); setEndError(null)
    try { await endRoom() }
    catch (cause) { setEndError(cause instanceof Error ? cause.message : 'Could not end the room.') }
    finally { setEnding(false); setConfirmEnd(false) }
  }, [endRoom])
  const [saveDefault, setSaveDefault] = useState(false)
  // Holler price is entered per 10 seconds by default (whole cents read
  // better than a per-second decimal); one tap switches to per second.
  const [hollerUnit, setHollerUnit] = useState<10 | 1>(10)
  const [password, setPassword] = useState('')
  const [touchedName, setTouchedName] = useState(false)
  const [touchedHandle, setTouchedHandle] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [seatSeconds, setSeatSeconds] = useState(20)
  const [rewardUnit, setRewardUnit] = useState<'seconds' | 'minutes'>('seconds')

  const clipSeconds = Number(draft.lettersMaxSeconds) || 10
  const micRate = Number(draft.passkeyTickPrice) || 0
  const micFree = Number(draft.passkeyTickPrice) === 0
  const megaRate = useMemo(() => {
    const flat = Number(draft.lettersPrice)
    if (draft.lettersPrice.trim() !== '' && Number.isFinite(flat) && flat >= 0) return String(Number((flat / Math.max(1, clipSeconds)).toFixed(6)))
    return micFree ? '0' : '0.001'
  }, [draft.lettersPrice, clipSeconds, micFree])
  const megaFree = Number(megaRate) === 0
  const clipTotal = formatDollars(Number(megaRate) * clipSeconds)
  const seatPrice = String(Number((micRate * seatSeconds).toFixed(6)))
  const rewardSymbol = draft.rewardsType === 'token' ? (draft.rewardsTokenSymbol || 'TOKEN').toUpperCase() : draft.rewardsType === 'points' ? 'credit' : 'USDC'
  const rewardPrefix = draft.rewardsType === 'token' ? '' : '$'
  const rewardInterval = rewardUnit === 'minutes' ? String(Number(draft.rewardsEarnInterval || 0) / 60) : draft.rewardsEarnInterval

  const setMegaRate = useCallback((rate: string) => updateDraft({ lettersPrice: String(Number((Number(rate) * clipSeconds).toFixed(6))) }), [clipSeconds, updateDraft])
  const setClipSeconds = useCallback((seconds: number) => updateDraft({ lettersMaxSeconds: String(seconds), lettersPrice: String(Number((Number(megaRate) * seconds).toFixed(6))) }), [megaRate, updateDraft])
  const setSeatPrice = useCallback((total: string) => updateDraft({ passkeyTickPrice: String(Number((Number(total) / seatSeconds).toFixed(6))) }), [seatSeconds, updateDraft])

  const onCreate = useCallback(async () => {
    setBusy(true); setError(null)
    try { if (saveDefault && hasIdentity) await saveDefaultsFromDraft().catch(() => {}); await create(password || undefined) }
    catch (cause) { setError(cause instanceof ApiError ? cause.message : 'Could not open the room. Try again.') }
    finally { setBusy(false) }
  }, [create, hasIdentity, password, saveDefault, saveDefaultsFromDraft])

  const canCreate = hasIdentity ? (password.trim().length === 0 || password.trim().length >= 4) : password.trim().length >= 4
  const clashingRoom = useMemo(() => error ? myRooms.find((room) => room.handle === draft.handle) : undefined, [draft.handle, error, myRooms])
  const activeSummary = [draft.lettersEnabled ? 'Hollers open' : '', draft.joinStreamEnabled ? 'Call in' : '', draft.rewardsEnabled ? 'Rewards' : ''].filter(Boolean).join(' · ') || 'Room closed'
  const draftKinds = featureList(draft.lettersEnabled, draft.joinStreamEnabled, draft.rewardsEnabled)
  // The primary action on the preview takes the colour of the feature it
  // starts: a seat is a call-in, a recorded clip is a Holler.
  const ctaKind: FeatureKind | 'watch' = draft.joinStreamEnabled ? 'callin' : draft.lettersEnabled ? 'holler' : 'watch'
  const stageFree = draft.joinStreamEnabled ? micFree : draft.lettersEnabled ? megaFree : true
  const primaryPrice = draft.lettersEnabled ? (megaFree ? 'Free' : clipTotal) : draft.joinStreamEnabled ? (micFree ? 'Free' : formatDollars(seatPrice)) : draft.rewardsEnabled ? 'Rewards' : '—'
  const primaryUnit = draft.lettersEnabled ? `for a ${clipSeconds}-second clip` : draft.joinStreamEnabled ? `for ${seatSeconds} seconds` : draft.rewardsEnabled ? rewardSymbol : ''
  const primaryIsMoney = draft.lettersEnabled ? !megaFree : draft.joinStreamEnabled ? !micFree : false

  // Reads the SAVED channel, not the draft: this card claims to show what
  // viewers see, and viewers see the saved config. The preview has three
  // genuinely different states and the card must keep them apart — no Twitch channel on the room at all, a channel Twitch
  // has no live picture for, and a real frame. `twitchLive` is the same
  // 90s-cached server probe the public browse cards use, so this card agrees
  // with what viewers see. That cache is lazy: a cold first load answers false
  // for a channel that IS live and flips true on the next poll, so a false
  // means "no picture to show yet", never "you are offline".
  const streamChannel = (room?.twitchChannel || '').trim().replace(/^@/, '')
  const streamPicture = !!streamChannel && twitchLive
  // Same rule for the offer: what the room has SAVED, read the way the draft
  // reads it (room-provider), so the tags match the board card.
  const savedKinds = room ? featureList(!!room.letters?.enabled, room.joinStream ? room.joinStream.enabled !== false : true, !!room.rewards?.enabled) : []

  return <div className="mc-create">
    <header className="mcc-header"><div className="mcc-header-inner"><span className="mcc-brand-lockup"><a href="/?stay=1" className="mcc-brand"><BrandText /></a><i /><span>{managing ? 'Your room' : 'New room'}</span></span><nav aria-label="Product navigation"><a href="/app">Rooms</a><a href="/bounty">Bounties</a><a href="/dashboard/campaigns">Campaigns</a><a href="/how-it-works">How it works</a></nav><div className="mcc-header-end"><ThemeToggle /><span className="mcc-account"><AccountChip /></span></div></div></header>
    <main className="mcc-shell">
      {!hasIdentity ? <RoomRecovery /> : null}
      <section className="mcc-identity" aria-label="Room identity"><div><span className="mcc-eyebrow">Room name</span><span className="mcc-field-row"><InlineText value={draft.name} onChange={(name) => { setTouchedName(true); updateDraft({ name }) }} placeholder="Name your room" label="Room name" />{managing ? <SaveMark touched={touchedName} state={saveState} /> : null}</span>{twitchTitle ? <small className="mcc-name-twitch">On Twitch: <b>{twitchTitle}</b> <button type="button" onClick={() => { setTouchedName(true); void adoptTwitchTitle() }}>Use this name</button></small> : null}</div><div><span className="mcc-eyebrow">Your room link</span><span className="mcc-field-row"><span className="mcc-room-url">hollertv.com/<InlineText className="mcc-handle" value={draft.handle} onChange={(handle) => { setTouchedHandle(true); updateDraft({ handle }) }} sanitize={(value) => value.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20)} placeholder={identityHandle || 'yourname'} label="Your link" /></span>{managing ? <SaveMark touched={touchedHandle} state={saveState} /> : null}</span></div></section>

      {managing && room ? <section className="mcc-status" aria-label="Room status" data-active={!!room.active} data-ending={pausingIn != null}>
        <div className="mcc-status-live"><i aria-hidden="true" /><span><strong>{room.active ? (pausingIn != null ? `Stream ended · pausing in ${pausingIn}` : 'Live · taking joins') : 'Paused · no new joins'}</strong>{endError || saveState !== 'saved' ? <small>{endError ? endError : saveState === 'saving' ? 'Saving changes…' : (saveError || 'Changes not saved')}</small> : null}</span></div>
        <div className="mcc-status-actions">
          {myRooms.length > 1 ? <select aria-label="Switch room" value={room.id} onChange={(event) => void openOwnedRoom(event.target.value)}>{myRooms.map((owned) => <option key={owned.id} value={owned.id}>{owned.name || owned.handle || owned.id}</option>)}</select> : null}
          <button type="button" className="mcc-status-toggle" onClick={() => void toggleActive()}>{room.active ? <><Pause size={14} /> Pause room</> : <><Play size={14} /> Resume room</>}</button>
          <button type="button" className="mcc-end-button" title="Delete this room and start over" onClick={() => { setConfirmEnd(true); setEndError(null) }}>End room</button>
        </div>
      </section> : null}
      {managing && room && confirmEnd ? <EndRoomDialog name={room.name || room.handle || 'this room'} handle={room.handle} ending={ending} onCancel={() => setConfirmEnd(false)} onConfirm={() => void endNow()} /> : null}

      <div className="mcc-layout" data-mode={managing ? 'manage' : 'create'}><div className="mcc-menus"><section className="mcc-viewer-section"><h1>How viewers join</h1><div className="mcc-feature-stack">
        <Feature kind="holler" title="Hollers" copy="Fans send recorded clips to your stream" enabled={draft.lettersEnabled} onToggle={() => updateDraft({ lettersEnabled: !draft.lettersEnabled })}>
          <div className="mcc-pricing-top"><span>Viewer price</span><Segment label="Holler price mode" value={megaFree ? 'free' : 'paid'} onChange={(mode) => setMegaRate(mode === 'free' ? '0' : '0.001')} options={[{ value: 'paid', label: 'Paid' }, { value: 'free', label: 'Free' }]} /></div><div className="mcc-controls two"><label><span>{hollerUnit === 10 ? 'Price per 10 seconds' : 'Price per second'}</span><span className="mcc-rate-row"><PriceInput label={hollerUnit === 10 ? 'Holler price per 10 seconds' : 'Holler price per second'} value={String(Number((Number(megaRate) * hollerUnit).toFixed(6)))} onCommit={(value) => setMegaRate(String(Number((Number(value) / hollerUnit).toFixed(6))))} suffix={hollerUnit === 10 ? '/10s' : '/s'} /><Segment label="Holler price unit" value={hollerUnit} onChange={setHollerUnit} options={[{ value: 10, label: '10s' }, { value: 1, label: '1s' }]} /></span><small className="mcc-rate-chip">{megaFree ? 'Free' : hollerUnit === 10 ? `= ${formatDollars(megaRate)} a second` : `= ${formatDollars(Number(megaRate) * 10)} per 10 seconds`}</small></label><label><span>Longest clip</span><select aria-label="Longest clip" value={clipSeconds} onChange={(event) => setClipSeconds(Number(event.target.value))}>{CLIP_SECONDS.map((seconds) => <option key={seconds} value={seconds}>{seconds} seconds</option>)}</select></label></div>
        </Feature>
        <Feature kind="callin" title="Call in" copy="Viewers join you face-to-face" enabled={draft.joinStreamEnabled} offLabel="Opt in" onToggle={() => updateDraft({ joinStreamEnabled: !draft.joinStreamEnabled })}>
          <div className="mcc-pricing-top"><span>Viewer price</span><Segment label="Call in price mode" value={micFree ? 'free' : 'paid'} onChange={(mode) => updateDraft({ passkeyTickPrice: mode === 'free' ? '0' : '0.001' })} options={[{ value: 'paid', label: 'Paid' }, { value: 'free', label: 'Free' }]} /></div><div className="mcc-controls three"><label><span>Price for selected time</span><PriceInput label="Call in price" value={seatPrice} onCommit={setSeatPrice} suffix={`/ ${seatSeconds}s`} /><small>{micFree ? 'Free' : `${formatDollars(micRate)}/second`}</small></label><label><span>Default seat time</span><span className="mcc-duration"><button type="button" aria-label="Reduce default seat time" onClick={() => setSeatSeconds((current) => SEAT_SECONDS[Math.max(0, SEAT_SECONDS.indexOf(current as typeof SEAT_SECONDS[number]) - 1)])}>−</button><strong>{seatSeconds}s</strong><button type="button" aria-label="Increase default seat time" onClick={() => setSeatSeconds((current) => SEAT_SECONDS[Math.min(SEAT_SECONDS.length - 1, SEAT_SECONDS.indexOf(current as typeof SEAT_SECONDS[number]) + 1)])}>+</button></span><small>Adjusts in sensible steps</small></label><label><span>People on camera</span><select aria-label="People on camera" value={draft.maxSeats} onChange={(event) => updateDraft({ maxSeats: event.target.value })}><option value="1">1</option><option value="2">2</option><option value="3">3</option></select><small>+ pinned co-host, free</small></label></div>
        </Feature>
        <Feature kind="rewards" title="Rewards" copy="Give viewers cash, Holler credit, or your token" enabled={draft.rewardsEnabled} onToggle={() => updateDraft({ rewardsEnabled: !draft.rewardsEnabled })}>
          <div className="mcc-controls two rewards"><label><span>Reward type</span><select aria-label="Reward type" value={draft.rewardsType} onChange={(event) => { const d = event.target.value === 'points' ? REWARD_DEFAULTS.points : REWARD_DEFAULTS.cash; updateDraft({ rewardsType: event.target.value, rewardsEarnAmount: d.earnAmount, rewardsEarnCap: d.earnCap }) }}><option value="usdc">Cash</option><option value="points">Holler credit</option><option value="token">Custom token</option></select></label><label><span>Amount per reward</span><span className="mcc-money-input"><span>{rewardPrefix}</span><input aria-label="Amount per reward" inputMode="decimal" value={draft.rewardsEarnAmount} onChange={(event) => updateDraft({ rewardsEarnAmount: event.target.value })} /><b>{rewardSymbol}</b></span></label><label><span>Pay every</span><span className="mcc-compound"><input aria-label="Pay every" inputMode="decimal" value={rewardInterval} onChange={(event) => { if (/^\d*\.?\d*$/.test(event.target.value)) updateDraft({ rewardsEarnInterval: String(Number(event.target.value || 0) * (rewardUnit === 'minutes' ? 60 : 1)) }) }} /><select aria-label="Reward interval unit" value={rewardUnit} onChange={(event) => setRewardUnit(event.target.value as 'seconds' | 'minutes')}><option value="seconds">seconds</option><option value="minutes">minutes</option></select></span></label><label><span>Maximum per viewer</span><span className="mcc-money-input"><span>{rewardPrefix}</span><input aria-label="Maximum per viewer" inputMode="decimal" value={draft.rewardsEarnCap} onChange={(event) => updateDraft({ rewardsEarnCap: event.target.value })} /><b>{rewardSymbol}</b></span></label>{draft.rewardsType === 'token' ? <><label><span>Token contract</span><input aria-label="Token contract" value={draft.rewardsTokenAddress} placeholder="0x…" onChange={(event) => updateDraft({ rewardsTokenAddress: event.target.value.trim() })} /></label><label><span>Token symbol</span><input aria-label="Token symbol" value={draft.rewardsTokenSymbol} onChange={(event) => updateDraft({ rewardsTokenSymbol: event.target.value.toUpperCase().slice(0, 10) })} /></label></> : null}</div><p className="mcc-hint">{draft.rewardsType === 'token' ? 'Custom token amount, timing, and viewer cap are all editable. Verify the contract before going live.' : 'Set the amount, frequency, and cap that fit your room.'}</p>
        </Feature>
      </div></section>

      <details className="mcc-advanced" id="mcc-advanced"><summary><strong>Advanced settings</strong></summary><div className="mcc-advanced-body">
        <section className="mcc-group moderation"><h2>Moderation</h2><div className="mcc-group-grid"><label><span>Holler review</span><select value={draft.lettersModeration} onChange={(event) => updateDraft({ lettersModeration: event.target.value as 'auto' | 'approve' })}><option value="auto">AI only</option><option value="approve">AI, then me</option></select></label><label><span>Holler AI strictness</span><select value={draft.lettersAiStrictness} onChange={(event) => updateDraft({ lettersAiStrictness: event.target.value as 'severe' | 'borderline' })}><option value="severe">Strict</option><option value="borderline">Clear violations only</option></select></label><label><span>Call in admission</span><select value={draft.openMicAdmission} onChange={(event) => updateDraft({ openMicAdmission: event.target.value as 'ai' | 'approve' | 'manual' })}><option value="ai">AI pre-check</option><option value="approve">AI, then my approval</option><option value="manual">My approval only</option></select></label><label><span>Call in live safety</span><select value={draft.openMicSafety} onChange={(event) => updateDraft({ openMicSafety: event.target.value as 'alert' | 'remove' | 'host' })}><option value="alert">Monitor + alert me</option><option value="remove">Monitor + auto-remove</option><option value="host">Host controls only</option></select></label><button type="button" className="mcc-check-row" aria-pressed={draft.lettersAutoRefund} onClick={() => updateDraft({ lettersAutoRefund: !draft.lettersAutoRefund })}><span className="mcc-checkbox" data-checked={draft.lettersAutoRefund}>{draft.lettersAutoRefund ? '✓' : ''}</span>Refund Hollers I reject</button></div></section>
        <section className="mcc-group"><h2>Access</h2><div className="mcc-group-grid"><label><span>Room visibility</span><select value={draft.unlisted ? 'hidden' : 'listed'} onChange={(event) => updateDraft({ unlisted: event.target.value === 'hidden' })}><option value="listed">Listed in Browse</option><option value="hidden">Hidden · link only</option></select></label><label><span>Watch before joining</span><select value={draft.mcMinWatch} onChange={(event) => updateDraft({ mcMinWatch: event.target.value, jsMinWatch: event.target.value })}><option value="0">Off</option><option value="120">2 minutes</option><option value="600">10 minutes</option></select></label></div></section>
        <section className="mcc-group"><h2>Stream behavior</h2><div className="mcc-group-grid"><label><span>Entrance & exit sounds</span><select value={draft.stingerSounds ? 'on' : 'off'} onChange={(event) => updateDraft({ stingerSounds: event.target.value === 'on' })}><option value="on">On</option><option value="off">Off</option></select></label></div></section>
        <section className="mcc-group"><h2>Money</h2><div className="mcc-group-grid"><label><span>Payout wallet</span><input value={draft.payoutAddress} placeholder="0x…" onChange={(event) => updateDraft({ payoutAddress: event.target.value.trim() })} /></label><div><span className="mcc-field-title">Unused viewer balance</span><p className="mcc-static-value">Refund automatically</p></div></div></section>
      </div></details>

      {managing ? <footer className="mcc-submit mcc-submit-manage"><FollowRow channel={draft.twitchChannel} auto={draft.twitchAuto} onAuto={() => updateDraft({ twitchAuto: !draft.twitchAuto })} onChannel={(value) => updateDraft(draft.twitchChannel.trim() === '' && value !== '' ? { twitchChannel: value, twitchAuto: true } : { twitchChannel: value })} /><div className="mcc-manage-row"><button type="button" className="mcc-ghost-button" disabled={defaultsState === 'busy'} onClick={() => { if (!hasIdentity) { openSignIn(); return } void saveDefaultsNow() }}>{!hasIdentity ? <><LockKeyhole size={13} aria-hidden="true" /> {defaultsLabel}</> : defaultsState === 'busy' ? 'Saving…' : defaultsState === 'saved' ? <><Check size={13} aria-hidden="true" /> Saved</> : defaultsLabel}</button></div></footer> : <footer className="mcc-submit"><FollowRow channel={draft.twitchChannel} auto={draft.twitchAuto} onAuto={() => updateDraft({ twitchAuto: !draft.twitchAuto })} onChannel={(value) => updateDraft(draft.twitchChannel.trim() === '' && value !== '' ? { twitchChannel: value, twitchAuto: true } : { twitchChannel: value })} />{hasIdentity ? <FooterChoice checked={saveDefault} onClick={() => setSaveDefault((value) => !value)} title={defaultsLabel} /> : <button type="button" className="mcc-footer-choice mcc-footer-locked" onClick={openSignIn}><LockKeyhole size={14} aria-hidden="true" /><span><strong>{defaultsLabel}</strong></span></button>}<div className="mcc-password"><span className="mcc-password-label"><span>Room password</span><em data-required={!hasIdentity}>{hasIdentity ? 'Optional · recommended for mod access' : 'Required'}</em><InfoTip label="About the room password" text={hasIdentity ? 'Moderators use it to manage this room. Your signed-in account never needs it.' : 'Your way back into this room. Sign in instead and your account gets you back in, no password needed.'} /></span><span><LockKeyhole size={15} /><input type="password" aria-label="Room password" required={!hasIdentity} value={password} placeholder="At least 4 characters" onChange={(event) => setPassword(event.target.value)} /></span></div>{error ? <p role="alert" className="mcc-error">{clashingRoom ? `That link already points at ${clashingRoom.name || 'your room'}.` : error}{clashingRoom ? <button type="button" onClick={() => void openOwnedRoom(clashingRoom.id)}>Manage that room</button> : null}</p> : null}<div className="mcc-create-row"><button type="button" className="mcc-create-button" disabled={busy || !canCreate} onClick={() => void onCreate()}>{busy ? 'Opening…' : 'Create room'}<ChevronRight size={17} /></button></div></footer>}
      </div>

      {managing && room ? <aside className="mcc-previews mcc-runtime" aria-label="Your room on stream"><section className="mcc-preview-card mcc-stream-card" aria-label="Your stream preview"><div className="mcc-preview-top"><div><span className="mcc-eyebrow">Room preview</span><strong>What viewers see</strong></div><b data-picture={streamPicture}>{!streamChannel ? 'No channel' : streamPicture ? 'On Twitch' : 'No picture'}</b></div><div className="mcc-stage mcc-stream-stage dark"><span className="mcc-stream-fallback" aria-hidden="true"><HollerMark variant="icon" px={52} glow /></span><TwitchPreview channel={streamChannel} live={streamPicture} size="hero" />{streamChannel ? <span className="mcc-preview-badge">twitch.tv/{streamChannel}</span> : null}</div><FeatureTags kinds={savedKinds} className="mcc-stage-offer" />{!streamChannel ? <button type="button" className="mcc-add-twitch" onClick={() => { const advanced = document.getElementById('mcc-advanced') as HTMLDetailsElement | null; if (advanced) advanced.open = true; const field = document.getElementById('mcc-twitch-channel') as HTMLInputElement | null; field?.scrollIntoView({ block: 'center', behavior: 'smooth' }); field?.focus({ preventScroll: true }) }}>+ Add Twitch channel</button> : <small className="mcc-preview-note">{streamPicture ? 'The Twitch thumbnail viewers see on your room’s browse card. Twitch refreshes it every couple of minutes, so it trails your stream a little, and the art above stands in whenever Twitch has no frame ready.' : `Twitch has no live picture for ${streamChannel} yet, so your browse card shows the art above. It can take a minute after you start streaming to appear.`}</small>}</section><LayoutEditor /><ObsSetup />{room.active ? <><OverlayHealthCard /><div className="mcc-live" style={liveFirst}><OnCameraTable /><LettersQueueCard /></div>{draft.joinStreamEnabled ? <div className="mcc-booth-slot" style={liveFirst}><HostCamCard /></div> : null}</> : null}</aside> : <aside className="mcc-previews"><section className="mcc-preview-card" aria-label="Existing room preview"><div className="mcc-preview-top"><div><span className="mcc-eyebrow">Room preview</span><strong>What viewers see</strong></div><b>Not broadcasting</b></div><div className="mcc-stage dark"><span className="mcc-preview-badge">• Preview</span><span className="mcc-rate-badge" data-free={stageFree}>{stageFree ? 'FREE' : draft.joinStreamEnabled ? `${formatDollars(micRate)}/s` : `${formatDollars(megaRate)}/s`}</span><div><span><FeatureTags kinds={draftKinds} /><strong>{draft.name.trim() || 'Your room'}</strong><small>{activeSummary}</small></span><button type="button" data-kind={ctaKind}>{draft.joinStreamEnabled ? 'Take a seat' : draft.lettersEnabled ? 'Send a Holler' : 'Watch'}</button></div></div><div className="mcc-ledger"><h2>Join card</h2>{draft.lettersEnabled ? <p data-kind="holler" data-on="true"><span>A Holler</span><strong className={megaFree ? undefined : 'mcc-amt'}>{megaFree ? 'Free' : `${formatDollars(megaRate)}/s`}</strong></p> : null}<p data-kind="callin" data-on={draft.joinStreamEnabled}><span>A camera seat</span><strong className={draft.joinStreamEnabled ? (micFree ? undefined : 'mcc-amt') : 'mcc-off'}>{draft.joinStreamEnabled ? (micFree ? 'Free' : `${formatDollars(seatPrice)} / ${seatSeconds}s`) : 'Call in off'}</strong></p><p data-kind="rewards" data-on={draft.rewardsEnabled}><span>Watching earns</span><strong className={draft.rewardsEnabled ? (draft.rewardsType === 'usdc' ? 'mcc-amt' : undefined) : 'mcc-off'}>{draft.rewardsEnabled ? (draft.rewardsType === 'token' ? rewardSymbol : draft.rewardsType === 'points' ? 'Holler credit' : formatDollars(draft.rewardsEarnAmount)) : 'Rewards off'}</strong></p></div></section>
      <section className="mcc-preview-card alternate" aria-label="Alternate room preview"><span className="mcc-concept-label">Card preview · alternate</span><div className="mcc-concept"><div className="mcc-art dark"><span aria-hidden="true"><HollerMark variant="icon" px={56} glow /></span></div><div className="mcc-concept-body"><small>Hosted by you</small><FeatureTags kinds={draftKinds} /><h2>{draft.name.trim() || 'Your room'}</h2><p>{draft.lettersEnabled ? 'Send a video message. Be part of the show.' : draft.joinStreamEnabled ? 'Take a live camera seat beside the host.' : draft.rewardsEnabled ? 'Watch and earn rewards.' : 'Room preview'}</p><div><strong className={primaryIsMoney ? 'mcc-amt' : undefined}>{primaryPrice}</strong><span>{primaryUnit}</span></div><button type="button" data-kind={draft.joinStreamEnabled ? 'callin' : 'holler'}>{draft.joinStreamEnabled ? 'Take a seat' : 'Send a Holler'}</button></div></div></section></aside>}
      </div>
    </main>
  </div>
}
