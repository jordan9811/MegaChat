'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Gift, LockKeyhole, MessageSquareText, Pause, Play, Video, type LucideIcon } from 'lucide-react'
import { AccountChip } from '@/components/account-chip'
import { BrandText } from '@/components/brand-text'
import { FeatureTag, type FeatureKind } from '@/components/feature-tag'
import { HollerMark } from '@/components/holler-mark'
import { ThemeToggle } from '@/components/theme-toggle'
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

function InlineText({ value, onChange, placeholder, label, sanitize, className = '' }: { value: string; onChange: (value: string) => void; placeholder: string; label: string; sanitize?: (value: string) => string; className?: string }) {
  const [editing, setEditing] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (editing) ref.current?.select() }, [editing])
  if (editing) return <input ref={ref} autoFocus className={`mcc-inline-input ${className}`} aria-label={label} value={value} placeholder={placeholder} onChange={(event) => onChange(sanitize ? sanitize(event.target.value) : event.target.value)} onBlur={() => setEditing(false)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur() }} />
  return <button type="button" className={`mcc-inline ${className}`} aria-label={`${label} — click to change`} onClick={() => setEditing(true)}>{value || placeholder}</button>
}

function Segment<T extends string | number>({ value, onChange, label, options }: { value: T; onChange: (value: T) => void; label: string; options: readonly { value: T; label: string }[] }) {
  return <span className="mcc-segment" role="group" aria-label={label}>{options.map((option) => <button key={String(option.value)} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>{option.label}</button>)}</span>
}

// Each tile wears its feature's colour only while it is ON — tint, edge,
// switch, icon and the same tag viewers see on the room's card. OFF is
// neutral. The tag is decoration here: the sr-only On/Off carries the state.
function Feature({ kind, icon: Icon, title, copy, enabled, onToggle, offLabel = 'Off', children }: { kind: FeatureKind; icon: LucideIcon; title: string; copy: string; enabled: boolean; onToggle: () => void; offLabel?: string; children?: ReactNode }) {
  return <section className="mcc-feature" data-kind={kind} data-enabled={enabled}><button type="button" className="mcc-feature-head" aria-pressed={enabled} onClick={onToggle}><span className="mcc-feature-icon"><Icon size={17} strokeWidth={1.7} /></span><span className="mcc-feature-copy"><span className="mcc-feature-title"><strong>{title}</strong>{enabled ? <span className="mcc-feature-tag" aria-hidden="true"><FeatureTag kind={kind} /></span> : null}</span><small>{copy}</small></span><span className="mcc-toggle" aria-hidden="true"><i /></span><span className="sr-only">{enabled ? 'On' : offLabel}</span></button>{enabled && children ? <div className="mcc-feature-body">{children}</div> : null}</section>
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

function FooterChoice({ checked, onClick, title, copy }: { checked: boolean; onClick: () => void; title: string; copy: string }) {
  return <button type="button" className="mcc-footer-choice" aria-pressed={checked} onClick={onClick}><span className="mcc-checkbox" data-checked={checked}>{checked ? '✓' : ''}</span><span><strong>{title}</strong><small>{copy}</small></span></button>
}

// One page, two jobs. CREATING starts a draft; MANAGING is the same form
// bound to the room you own, autosaving as you go, with the live panels
// (links, seats, booth, queue) where the previews were. Owning a room means
// you land here IN it — never on a fresh form with a bumped handle.
export function CreateRoom() {
  const { mode, room, saveState, saveError, toggleActive, endRoom, draft, updateDraft, create, hasIdentity, identityHandle, saveDefaultsFromDraft, myRooms, openOwnedRoom, twitchLive, seats } = useRoom()
  // The moment anyone takes a seat, the live controls (who is on camera, the
  // MegaChat queue, the co-host booth) jump to the TOP of the right column
  // instead of sitting under the preview, layout editor and OBS setup. This is
  // a CSS `order` flip on a flex column, deliberately NOT a re-ordered render:
  // moving HostCamCard in the React tree would remount it, and its unmount
  // hangs up the booth — on a guest, at the exact moment they arrive.
  const liveFirst = seats.length > 0 ? { order: -1 } : undefined
  const managing = mode === 'managing' && !!room
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
  const [shareWithMods, setShareWithMods] = useState(false)
  const [password, setPassword] = useState('')
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

  const canCreate = hasIdentity ? (!shareWithMods || password.trim().length >= 4) : password.trim().length >= 4
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
      <section className="mcc-identity" aria-label="Room identity"><div><span className="mcc-eyebrow">Room name</span><InlineText value={draft.name} onChange={(name) => updateDraft({ name })} placeholder="Name your room" label="Room name" /><small>{managing ? 'Click to rename · saves as you type' : hasIdentity ? `Suggested from your linked ${draft.twitchChannel ? 'Twitch' : 'streaming account'} · click to change` : 'Suggested name · click to change'}</small></div><div><span className="mcc-eyebrow">Your room link</span><span className="mcc-room-url">megachat.fun/<InlineText className="mcc-handle" value={draft.handle} onChange={(handle) => updateDraft({ handle })} sanitize={(value) => value.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20)} placeholder={identityHandle || 'yourname'} label="Your link" /></span><small>{managing ? 'Your permanent link · click the name to change it' : hasIdentity ? 'Reserved by your sign-in · click the name to change' : 'Suggested link · easy to override'}</small></div></section>

      {managing && room ? <section className="mcc-status" aria-label="Room status" data-active={!!room.active}>
        <div className="mcc-status-live"><i aria-hidden="true" /><span><strong>{room.active ? 'Live · taking joins' : 'Paused · no new joins'}</strong><small>{endError ? endError : saveState === 'saving' ? 'Saving changes…' : saveState === 'error' ? (saveError || 'Changes not saved') : 'Changes save automatically while you stream.'}</small></span></div>
        <div className="mcc-status-actions">
          {myRooms.length > 1 ? <select aria-label="Switch room" value={room.id} onChange={(event) => void openOwnedRoom(event.target.value)}>{myRooms.map((owned) => <option key={owned.id} value={owned.id}>{owned.name || owned.handle || owned.id}</option>)}</select> : null}
          <button type="button" className="mcc-status-toggle" onClick={() => void toggleActive()}>{room.active ? <><Pause size={14} /> Pause room</> : <><Play size={14} /> Resume room</>}</button>
          {confirmEnd ? <span className="mcc-end-confirm"><small>Delete this room and clear everyone on camera?</small><button type="button" className="mcc-end-yes" disabled={ending} onClick={() => void endNow()}>{ending ? 'Ending…' : 'Yes, end it'}</button><button type="button" className="mcc-ghost-button" disabled={ending} onClick={() => setConfirmEnd(false)}>Keep it</button></span> : <button type="button" className="mcc-end-button" title="Delete this room and start over" onClick={() => { setConfirmEnd(true); setEndError(null) }}>End room</button>}
        </div>
      </section> : null}

      <div className="mcc-layout" data-mode={managing ? 'manage' : 'create'}><div className="mcc-menus"><section className="mcc-viewer-section"><h1>How viewers join</h1><div className="mcc-feature-stack">
        <Feature kind="holler" icon={MessageSquareText} title="Hollers" copy="Fans send recorded clips to your stream" enabled={draft.lettersEnabled} onToggle={() => updateDraft({ lettersEnabled: !draft.lettersEnabled })}>
          <div className="mcc-pricing-top"><span>Viewer price</span><Segment label="Holler price mode" value={megaFree ? 'free' : 'paid'} onChange={(mode) => setMegaRate(mode === 'free' ? '0' : '0.001')} options={[{ value: 'paid', label: 'Paid' }, { value: 'free', label: 'Free' }]} /></div><div className="mcc-controls two"><label><span>Rate per second</span><PriceInput label="Holler rate" value={megaRate} onCommit={setMegaRate} suffix="/s" /><small>{megaFree ? 'Free' : `${clipSeconds}s = ${clipTotal}`} · enter 0 for free</small></label><label><span>Longest clip</span><select aria-label="Longest clip" value={clipSeconds} onChange={(event) => setClipSeconds(Number(event.target.value))}>{CLIP_SECONDS.map((seconds) => <option key={seconds} value={seconds}>{seconds} seconds</option>)}</select></label></div>
        </Feature>
        <Feature kind="callin" icon={Video} title="Call in" copy="Viewers join you face-to-face" enabled={draft.joinStreamEnabled} offLabel="Opt in" onToggle={() => updateDraft({ joinStreamEnabled: !draft.joinStreamEnabled })}>
          <div className="mcc-pricing-top"><span>Viewer price</span><Segment label="Call in price mode" value={micFree ? 'free' : 'paid'} onChange={(mode) => updateDraft({ passkeyTickPrice: mode === 'free' ? '0' : '0.001' })} options={[{ value: 'paid', label: 'Paid' }, { value: 'free', label: 'Free' }]} /></div><div className="mcc-controls three"><label><span>Price for selected time</span><PriceInput label="Call in price" value={seatPrice} onCommit={setSeatPrice} suffix={`/ ${seatSeconds}s`} /><small>{micFree ? 'Free' : `${formatDollars(micRate)}/second`} · enter 0 for free</small></label><label><span>Default seat time</span><span className="mcc-duration"><button type="button" aria-label="Reduce default seat time" onClick={() => setSeatSeconds((current) => SEAT_SECONDS[Math.max(0, SEAT_SECONDS.indexOf(current as typeof SEAT_SECONDS[number]) - 1)])}>−</button><strong>{seatSeconds}s</strong><button type="button" aria-label="Increase default seat time" onClick={() => setSeatSeconds((current) => SEAT_SECONDS[Math.min(SEAT_SECONDS.length - 1, SEAT_SECONDS.indexOf(current as typeof SEAT_SECONDS[number]) + 1)])}>+</button></span><small>Adjusts in sensible steps</small></label><label><span>People on camera</span><select aria-label="People on camera" value={draft.maxSeats} onChange={(event) => updateDraft({ maxSeats: event.target.value })}><option value="1">1</option><option value="2">2</option><option value="3">3</option></select><small>+ pinned co-host, free</small></label></div>
        </Feature>
        <Feature kind="rewards" icon={Gift} title="Rewards" copy="Give viewers cash, Holler credit, or your token" enabled={draft.rewardsEnabled} onToggle={() => updateDraft({ rewardsEnabled: !draft.rewardsEnabled })}>
          <div className="mcc-controls two rewards"><label><span>Reward type</span><select aria-label="Reward type" value={draft.rewardsType} onChange={(event) => { const d = event.target.value === 'points' ? REWARD_DEFAULTS.points : REWARD_DEFAULTS.cash; updateDraft({ rewardsType: event.target.value, rewardsEarnAmount: d.earnAmount, rewardsEarnCap: d.earnCap }) }}><option value="usdc">Cash</option><option value="points">Holler credit</option><option value="token">Custom token</option></select></label><label><span>Amount per reward</span><span className="mcc-money-input"><span>{rewardPrefix}</span><input aria-label="Amount per reward" inputMode="decimal" value={draft.rewardsEarnAmount} onChange={(event) => updateDraft({ rewardsEarnAmount: event.target.value })} /><b>{rewardSymbol}</b></span></label><label><span>Pay every</span><span className="mcc-compound"><input aria-label="Pay every" inputMode="decimal" value={rewardInterval} onChange={(event) => { if (/^\d*\.?\d*$/.test(event.target.value)) updateDraft({ rewardsEarnInterval: String(Number(event.target.value || 0) * (rewardUnit === 'minutes' ? 60 : 1)) }) }} /><select aria-label="Reward interval unit" value={rewardUnit} onChange={(event) => setRewardUnit(event.target.value as 'seconds' | 'minutes')}><option value="seconds">seconds</option><option value="minutes">minutes</option></select></span></label><label><span>Maximum per viewer</span><span className="mcc-money-input"><span>{rewardPrefix}</span><input aria-label="Maximum per viewer" inputMode="decimal" value={draft.rewardsEarnCap} onChange={(event) => updateDraft({ rewardsEarnCap: event.target.value })} /><b>{rewardSymbol}</b></span></label>{draft.rewardsType === 'token' ? <><label><span>Token contract</span><input aria-label="Token contract" value={draft.rewardsTokenAddress} placeholder="0x…" onChange={(event) => updateDraft({ rewardsTokenAddress: event.target.value.trim() })} /></label><label><span>Token symbol</span><input aria-label="Token symbol" value={draft.rewardsTokenSymbol} onChange={(event) => updateDraft({ rewardsTokenSymbol: event.target.value.toUpperCase().slice(0, 10) })} /></label></> : null}</div><p className="mcc-hint">{draft.rewardsType === 'token' ? 'Custom token amount, timing, and viewer cap are all editable. Verify the contract before going live.' : 'Set the amount, frequency, and cap that fit your room.'}</p>
        </Feature>
      </div></section>

      <details className="mcc-advanced"><summary><strong>Advanced settings</strong><span>Moderation first, then access, money, and stream behavior</span></summary><div className="mcc-advanced-body">
        <section className="mcc-group moderation"><h2>Moderation</h2><p>Separate rules for recorded clips and live camera seats.</p><div className="mcc-group-grid"><label><span>Holler review</span><select value={draft.lettersModeration} onChange={(event) => updateDraft({ lettersModeration: event.target.value as 'auto' | 'approve' })}><option value="auto">AI only</option><option value="approve">AI, then me</option></select></label><label><span>Holler AI strictness</span><select value={draft.lettersAiStrictness} onChange={(event) => updateDraft({ lettersAiStrictness: event.target.value as 'severe' | 'borderline' })}><option value="severe">Strict</option><option value="borderline">Clear violations only</option></select></label><label><span>Call in admission</span><select value={draft.openMicAdmission} onChange={(event) => updateDraft({ openMicAdmission: event.target.value as 'ai' | 'approve' | 'manual' })}><option value="ai">AI pre-check</option><option value="approve">AI, then my approval</option><option value="manual">My approval only</option></select></label><label><span>Call in live safety</span><select value={draft.openMicSafety} onChange={(event) => updateDraft({ openMicSafety: event.target.value as 'alert' | 'remove' | 'host' })}><option value="alert">Monitor + alert me</option><option value="remove">Monitor + auto-remove</option><option value="host">Host controls only</option></select></label><button type="button" className="mcc-check-row" aria-pressed={draft.lettersAutoRefund} onClick={() => updateDraft({ lettersAutoRefund: !draft.lettersAutoRefund })}><span className="mcc-checkbox" data-checked={draft.lettersAutoRefund}>{draft.lettersAutoRefund ? '✓' : ''}</span>Refund Hollers I reject</button></div></section>
        <section className="mcc-group"><h2>Access</h2><div className="mcc-group-grid"><label><span>Room visibility</span><select value={draft.unlisted ? 'hidden' : 'listed'} onChange={(event) => updateDraft({ unlisted: event.target.value === 'hidden' })}><option value="listed">Listed in Browse</option><option value="hidden">Hidden · link only</option></select></label><label><span>Watch before joining</span><select value={draft.mcMinWatch} onChange={(event) => updateDraft({ mcMinWatch: event.target.value, jsMinWatch: event.target.value })}><option value="0">Off</option><option value="120">2 minutes</option><option value="600">10 minutes</option></select></label></div></section>
        <section className="mcc-group"><h2>Stream behavior</h2><div className="mcc-group-grid"><label><span>Twitch channel</span><input value={draft.twitchChannel} placeholder="Your channel" onChange={(event) => updateDraft({ twitchChannel: event.target.value.trim().toLowerCase() })} /><small>{hasIdentity ? 'Prefilled from your linked Twitch · easy to override' : 'Optional · easy to add later'}</small></label><label><span>Entrance & exit sounds</span><select value={draft.stingerSounds ? 'on' : 'off'} onChange={(event) => updateDraft({ stingerSounds: event.target.value === 'on' })}><option value="on">On</option><option value="off">Off</option></select></label></div></section>
        <section className="mcc-group"><h2>Money</h2><div className="mcc-group-grid"><label><span>Payout wallet</span><input value={draft.payoutAddress} placeholder="0x…" onChange={(event) => updateDraft({ payoutAddress: event.target.value.trim() })} /></label><div><span className="mcc-field-title">Unused viewer balance</span><p className="mcc-static-value">Refund automatically</p></div></div></section>
      </div></details>

      {managing ? <footer className="mcc-submit mcc-submit-manage"><FooterChoice checked={draft.twitchAuto} onClick={() => updateDraft({ twitchAuto: !draft.twitchAuto })} title="Follow my stream status" copy="Go live on Twitch and this room opens itself. Stop, and it leaves the board — it only pauses once you have been off a while, so a dropped stream never ends a conversation." /><div className="mcc-manage-row"><button type="button" className="mcc-ghost-button" disabled={!hasIdentity || defaultsState === 'busy'} onClick={() => void saveDefaultsNow()}>{defaultsState === 'busy' ? 'Saving…' : defaultsState === 'saved' ? 'Saved as your defaults' : 'Save this setup as my defaults'}</button><p>{hasIdentity ? 'Your next room starts from these settings.' : 'Sign in to keep defaults.'}</p></div></footer> : <footer className="mcc-submit"><FooterChoice checked={draft.twitchAuto} onClick={() => updateDraft({ twitchAuto: !draft.twitchAuto })} title="Follow my stream status" copy="Go live on Twitch and this room opens itself. Stop, and it leaves the board — it only pauses once you have been off a while, so a dropped stream never ends a conversation." /><FooterChoice checked={saveDefault} onClick={() => setSaveDefault((value) => !value)} title="Save this setup as my defaults" copy={hasIdentity ? 'Use these settings the next time I create a room.' : 'Sign in to keep defaults.'} />{hasIdentity ? <FooterChoice checked={shareWithMods} onClick={() => { setShareWithMods((value) => !value); if (shareWithMods) setPassword('') }} title="Allow moderators to manage this room" copy="Add a separate password for moderators. Your signed-in account always has access." /> : null}{(hasIdentity ? shareWithMods : true) ? <label className="mcc-password"><span>{hasIdentity ? 'Moderator password' : 'Room password'}</span><span><LockKeyhole size={15} /><input type="password" aria-label={hasIdentity ? 'Moderator password' : 'Room password'} value={password} placeholder="At least 4 characters" onChange={(event) => setPassword(event.target.value)} /></span><small>{hasIdentity ? 'Share this only with moderators you trust.' : 'Required while signed out. Save it to manage this room later.'}</small></label> : null}{error ? <p role="alert" className="mcc-error">{clashingRoom ? `That link already points at ${clashingRoom.name || 'your room'}.` : error}{clashingRoom ? <button type="button" onClick={() => void openOwnedRoom(clashingRoom.id)}>Manage that room</button> : null}</p> : null}<div className="mcc-create-row"><button type="button" className="mcc-create-button" disabled={busy || !canCreate} onClick={() => void onCreate()}>{busy ? 'Opening…' : 'Create room'}<ChevronRight size={17} /></button><p>Creating opens your room. Connect OBS to play clips on stream.</p></div></footer>}
      </div>

      {managing && room ? <aside className="mcc-previews mcc-runtime" aria-label="Your room on stream"><section className="mcc-preview-card mcc-stream-card" aria-label="Your stream preview"><div className="mcc-preview-top"><div><span className="mcc-eyebrow">Room preview</span><strong>What viewers see</strong></div><b data-picture={streamPicture}>{!streamChannel ? 'No channel' : streamPicture ? 'On Twitch' : 'No picture'}</b></div><div className="mcc-stage mcc-stream-stage dark"><span className="mcc-stream-fallback" aria-hidden="true"><HollerMark variant="icon" px={52} glow /></span><TwitchPreview channel={streamChannel} live={streamPicture} size="hero" />{streamChannel ? <span className="mcc-preview-badge">twitch.tv/{streamChannel}</span> : null}</div><FeatureTags kinds={savedKinds} className="mcc-stage-offer" /><small className="mcc-preview-note">{!streamChannel ? 'No Twitch channel on this room. Add one under Advanced settings → Stream behavior and your browse card carries your stream’s thumbnail instead of the art above.' : streamPicture ? 'The Twitch thumbnail viewers see on your room’s browse card. Twitch refreshes it every couple of minutes, so it trails your stream a little, and the art above stands in whenever Twitch has no frame ready.' : `Twitch has no live picture for ${streamChannel} yet, so your browse card shows the art above. It can take a minute after you start streaming to appear.`}</small></section><LayoutEditor /><ObsSetup />{room.active ? <><OverlayHealthCard /><div className="mcc-live" style={liveFirst}><OnCameraTable /><LettersQueueCard /></div>{draft.joinStreamEnabled ? <div className="mcc-booth-slot" style={liveFirst}><HostCamCard /></div> : null}</> : null}</aside> : <aside className="mcc-previews"><section className="mcc-preview-card" aria-label="Existing room preview"><div className="mcc-preview-top"><div><span className="mcc-eyebrow">Room preview</span><strong>What viewers see</strong></div><b>Not broadcasting</b></div><div className="mcc-stage dark"><span className="mcc-preview-badge">• Preview</span><span className="mcc-rate-badge" data-free={stageFree}>{stageFree ? 'FREE' : draft.joinStreamEnabled ? `${formatDollars(micRate)}/s` : `${formatDollars(megaRate)}/s`}</span><div><span><FeatureTags kinds={draftKinds} /><strong>{draft.name.trim() || 'Your room'}</strong><small>{activeSummary}</small></span><button type="button" data-kind={ctaKind}>{draft.joinStreamEnabled ? 'Take a seat' : draft.lettersEnabled ? 'Send a Holler' : 'Watch'}</button></div></div><div className="mcc-ledger"><h2>Join card</h2>{draft.lettersEnabled ? <p data-kind="holler" data-on="true"><span>A Holler</span><strong className={megaFree ? undefined : 'mcc-amt'}>{megaFree ? 'Free' : `${formatDollars(megaRate)}/s`}</strong></p> : null}<p data-kind="callin" data-on={draft.joinStreamEnabled}><span>A camera seat</span><strong className={draft.joinStreamEnabled ? (micFree ? undefined : 'mcc-amt') : 'mcc-off'}>{draft.joinStreamEnabled ? (micFree ? 'Free' : `${formatDollars(seatPrice)} / ${seatSeconds}s`) : 'Call in off'}</strong></p><p data-kind="rewards" data-on={draft.rewardsEnabled}><span>Watching earns</span><strong className={draft.rewardsEnabled ? (draft.rewardsType === 'usdc' ? 'mcc-amt' : undefined) : 'mcc-off'}>{draft.rewardsEnabled ? (draft.rewardsType === 'token' ? rewardSymbol : draft.rewardsType === 'points' ? 'Holler credit' : formatDollars(draft.rewardsEarnAmount)) : 'Rewards off'}</strong></p></div><small className="mcc-preview-note">Every number reflects your live configuration.</small></section>
      <section className="mcc-preview-card alternate" aria-label="Alternate room preview"><span className="mcc-concept-label">Card preview · alternate</span><div className="mcc-concept"><div className="mcc-art dark"><span aria-hidden="true"><HollerMark variant="icon" px={56} glow /></span></div><div className="mcc-concept-body"><small>Hosted by you</small><FeatureTags kinds={draftKinds} /><h2>{draft.name.trim() || 'Your room'}</h2><p>{draft.lettersEnabled ? 'Send a video message. Be part of the show.' : draft.joinStreamEnabled ? 'Take a live camera seat beside the host.' : draft.rewardsEnabled ? 'Watch and earn rewards.' : 'Room preview'}</p><div><strong className={primaryIsMoney ? 'mcc-amt' : undefined}>{primaryPrice}</strong><span>{primaryUnit}</span></div><button type="button" data-kind={draft.joinStreamEnabled ? 'callin' : 'holler'}>{draft.joinStreamEnabled ? 'Take a seat' : 'Send a Holler'}</button></div></div><small className="mcc-preview-note">Same settings, different visual hierarchy.</small></section></aside>}
      </div>
    </main>
  </div>
}
