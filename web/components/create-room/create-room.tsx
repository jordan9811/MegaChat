'use client'

// CREATE A ROOM — the rebuilt create surface.
//
// Shape settled over four rounds of review; the reasoning lives in
// docs/design/room-control-panel.html. The short version:
//
//   1 · What runs in your room   three feature cards, check to expand
//   2 · Advanced settings        optional, grouped tabs; key choices repeat
//   then the password and CREATE — no third heading; it is just the end
//
// Rules this page exists to fix, all from the audit of the old form:
//   · Everything is priced PER SECOND, MegaChats included. A MegaChat costs
//     rate x length, which is exactly how the server already derives it when
//     letters.price is null — we just store the product explicitly so clips
//     can carry their own rate, independent of the open-mic rate.
//   · Rates are steppers you can also type into. The preset rungs are the
//     sensible prices, not a validity set — the server stores whatever
//     string it is handed — so typing a number between or above them is
//     legal. What the old form got wrong was leaving a raw box that could
//     hold '' or 'abc' and 500 the join page; every typed value here is
//     parsed and floored before it is committed.
//   · Nothing renders as a working control unless it works.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  ChevronRight,
  CircleDollarSign,
  Gift,
  LockKeyhole,
  MessageSquareText,
  Radio,
  Settings2,
  ShieldCheck,
  Users,
  Video,
} from 'lucide-react'
import { useRoom } from '@/components/room-provider'
import { ApiError } from '@/lib/api'
import { AccountChip } from '@/components/account-chip'
import { RoomRecovery } from '@/components/room-recovery'
import { formatDollars } from '@/lib/display-format'
import './create-room.css'

// Server bounds, mirrored from rooms-store.js so the control cannot express
// a value the server would silently clamp on the way back out.
const SEATS = [1, 2, 3] as const
const CLIP_SECONDS = [5, 10, 15, 20, 30] as const
const MEGA_RATES = ['0.0005', '0.001', '0.002', '0.005', '0.01'] as const
const MIC_RATES = ['0.001', '0.005', '0.01', '0.02', '0.05'] as const
const SPEND_CAPS = ['1', '2', '5', '10'] as const

const money = formatDollars

// Below this the atomic-unit conversion truncates to zero, which would turn
// a paid room free without saying so.
const MIN_RATE = 0.000001

function safeRate(raw: string, fallback: string): string {
  const n = parseFloat(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return String(parseFloat(Math.max(MIN_RATE, n).toFixed(6)))
}

function Stepper({
  values,
  value,
  onChange,
  suffix,
  label,
}: {
  values: readonly string[]
  value: string
  onChange: (v: string) => void
  suffix?: string
  label: string
}) {
  // `values` are the rungs the buttons walk, not a set of legal prices — the
  // server stores whatever string it is given, so a typed number between or
  // above the rungs is a real choice and is kept as typed.
  const [typing, setTyping] = useState<string | null>(null)
  // A finite base for the arithmetic: an incoming '' (from a stale saved
  // default) would otherwise make '+' commit the string 'NaN'.
  const parsed = parseFloat(value)
  const good = Number.isFinite(parsed) && parsed > 0 ? value : values[1]
  const n = parseFloat(good)
  const rungs = useMemo(() => values.map((v) => parseFloat(v)).sort((a, b) => a - b), [values])

  const commit = (raw: string) => {
    setTyping(null)
    const next = safeRate(raw, good)
    if (next !== value) onChange(next)
  }
  const lower = () => {
    const below = [...rungs].reverse().find((r) => r < n - 1e-12)
    commit(String(below ?? Math.max(MIN_RATE, n / 2)))
  }
  const raise = () => {
    const above = rungs.find((r) => r > n + 1e-12)
    // There is no server ceiling, so the top rung is not the end of the
    // road — keep climbing by the last gap instead of going dead.
    const gap = rungs[rungs.length - 1] - rungs[rungs.length - 2]
    commit(String(above ?? n + gap))
  }

  return (
    <span className="flex items-center gap-2">
      <button type="button" className="stepbtn" aria-label={`Lower ${label}`} onClick={lower}>
        &#8722;
      </button>
      <span className="ratefield flex items-baseline justify-center">
        <span aria-hidden="true">$</span>
        <input
          type="text"
          inputMode="decimal"
          aria-label={label}
          value={typing ?? String(parseFloat(good))}
          onChange={(e) => {
            const v = e.target.value
            // Bans a leading '-', an 'e', and anything else that would parse
            // to a negative or exponential price.
            if (/^\d*\.?\d{0,6}$/.test(v)) setTyping(v)
          }}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              raise()
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              lower()
            }
          }}
        />
        {suffix ? <span className="text-[12px] text-[var(--mcc-dim)]">{suffix}</span> : null}
      </span>
      <button type="button" className="stepbtn" aria-label={`Raise ${label}`} onClick={raise}>
        +
      </button>
    </span>
  )
}

// The room name and its link are prefilled facts, not empty boxes waiting to
// be filled in. They render as text — the handle in the live green — and
// become an input on click, so changing one is still a single click away.
function InlineText({
  value,
  onChange,
  placeholder,
  label,
  sanitize,
  maxLength,
  textClass,
  inputClass,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  label: string
  sanitize?: (v: string) => string
  maxLength?: number
  textClass?: string
  inputClass?: string
}) {
  const [editing, setEditing] = useState(false)
  const ref = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (editing) ref.current?.select()
  }, [editing])

  if (editing) {
    return (
      <input
        ref={ref}
        type="text"
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => onChange(sanitize ? sanitize(e.target.value) : e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
        }}
        className={inputClass}
        autoFocus
      />
    )
  }
  return (
    <button
      type="button"
      className={`inline-edit ${textClass ?? ''}`}
      aria-label={`${label} — click to change`}
      onClick={() => setEditing(true)}
    >
      {value || <span className="text-[var(--mcc-faint)]">{placeholder}</span>}
    </button>
  )
}

function Seg<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { v: T; l: string }[]
  value: T
  onChange: (v: T) => void
  label: string
}) {
  return (
    <span className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.v)}
          type="button"
          aria-pressed={value === o.v}
          onClick={() => onChange(o.v)}
        >
          {o.l}
        </button>
      ))}
    </span>
  )
}

function FeatureCard({
  icon: Icon,
  on,
  onToggle,
  title,
  blurb,
  offLabel = 'OFF',
  accent,
  children,
}: {
  icon: LucideIcon
  on: boolean
  onToggle: () => void
  title: string
  blurb: string
  offLabel?: string
  accent: 'primary' | 'live' | 'money'
  children?: React.ReactNode
}) {
  return (
    <section className="mcc-module" data-enabled={on} data-accent={accent}>
      <button
        type="button"
        aria-pressed={on}
        onClick={onToggle}
        className="mcc-module-head"
      >
        <span className="mcc-module-icon" aria-hidden="true">
          <Icon size={18} strokeWidth={2} />
        </span>
        <span className="mcc-module-copy">
          <strong>{title}</strong>
          <span>{blurb}</span>
        </span>
        <span className="mcc-switch" aria-hidden="true">
          <span>{on ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg> : null}</span>
          {on ? 'On' : offLabel}
        </span>
      </button>
      {on && children ? (
        <div className="mcc-module-body">{children}</div>
      ) : null}
    </section>
  )
}

type Tab = 'mega' | 'mic' | 'drops' | 'access' | 'money' | 'stream'

const ADVANCED_TABS: Array<{ id: Tab; label: string; heading: string; icon: LucideIcon }> = [
  { id: 'mega', label: 'MegaChats', heading: 'Clip controls', icon: MessageSquareText },
  { id: 'mic', label: 'Open mic', heading: 'Live seat controls', icon: Video },
  { id: 'drops', label: 'Drops', heading: 'Reward controls', icon: Gift },
  { id: 'access', label: 'Who gets in', heading: 'Access controls', icon: Users },
  { id: 'money', label: 'Money', heading: 'Payment controls', icon: CircleDollarSign },
  { id: 'stream', label: 'Stream', heading: 'Stream controls', icon: Radio },
]

export function CreateRoom() {
  const {
    draft,
    updateDraft,
    create,
    hasIdentity,
    identityHandle,
    saveDefaultsFromDraft,
    myRooms,
    openOwnedRoom,
  } = useRoom()
  const [tab, setTab] = useState<Tab>('mega')
  const [modInfo, setModInfo] = useState(false)
  // Off unless asked for. On by default, every room you opened silently
  // rewrote your account defaults, so the next create form came up wearing
  // the last room's settings instead of the real defaults.
  const [saveDefault, setSaveDefault] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const free = draft.passkeyTickPrice === '0'
  const clipSeconds = Number(draft.lettersMaxSeconds) || 10

  // MegaChats are priced per second of clip. The stored field is a flat price,
  // so the per-second rate is that price divided by the clip length — and
  // setting a rate stores rate x length. Same number, honest unit.
  // This used to snap to the nearest preset, because the old stepper needed
  // an index into MEGA_RATES to have a position. The stepper now holds any
  // value, and the snap actively destroyed typed ones — $0.0037 came back
  // as $0.005. Report the real per-second rate instead.
  const megaRate = useMemo(() => {
    const flat = parseFloat(draft.lettersPrice)
    if (Number.isFinite(flat) && flat > 0) {
      return String(parseFloat((flat / Math.max(1, clipSeconds)).toFixed(6)))
    }
    return MEGA_RATES[1] as string
  }, [draft.lettersPrice, clipSeconds])

  const setMegaRate = useCallback(
    (rate: string) => {
      const flat = parseFloat(rate) * clipSeconds
      updateDraft({ lettersPrice: String(parseFloat(flat.toFixed(6))) })
    },
    [clipSeconds, updateDraft],
  )

  const setClipSeconds = useCallback(
    (secs: number) => {
      // keep the per-second rate fixed when the length changes
      const flat = parseFloat(megaRate) * secs
      updateDraft({
        lettersMaxSeconds: String(secs),
        lettersPrice: String(parseFloat(flat.toFixed(6))),
      })
    },
    [megaRate, updateDraft],
  )

  const setFree = useCallback(
    (isFree: boolean) => {
      updateDraft(
        isFree
          ? { passkeyTickPrice: '0', lettersPrice: '' }
          : { passkeyTickPrice: '0.005', lettersPrice: String(parseFloat((0.001 * clipSeconds).toFixed(6))) },
      )
    },
    [clipSeconds, updateDraft],
  )

  const onCreate = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      if (saveDefault) {
        try {
          await saveDefaultsFromDraft()
        } catch {
          // defaults are a convenience — never block opening the room
        }
      }
      await create(hasIdentity ? undefined : password)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not open the room. Try again.')
    } finally {
      setBusy(false)
    }
  }, [create, hasIdentity, password, saveDefault, saveDefaultsFromDraft])

  const canCreate = hasIdentity || password.trim().length >= 4

  // Only when the clash is with a room this account owns — a handle held by
  // someone else is not a room we can offer to open.
  const clashingRoom = useMemo(
    () => (error ? myRooms.find((r) => r.handle && r.handle === draft.handle) : undefined),
    [error, myRooms, draft.handle],
  )

  const clip = money(parseFloat(megaRate) * clipSeconds)
  const micPerMin = money(parseFloat(draft.passkeyTickPrice) * 60)
  const activeAdvanced = ADVANCED_TABS.find((item) => item.id === tab) ?? ADVANCED_TABS[0]

  return (
    <div className="mc-create dark min-h-screen">
      <header className="mcc-header">
        <div className="mcc-header-inner">
          <span className="mcc-brand-lockup">
            <a href="/?stay=1" className="mcc-brand">MEGACHAT</a>
            <span className="mcc-header-divider" />
            <span className="mcc-page-title">New room</span>
          </span>
          <nav className="mcc-progress" aria-label="Product navigation"><a href="/app">Rooms</a><a href="/bounty">Bounties</a><a href="/how-it-works">How it works</a></nav>
          <AccountChip accent="var(--mcc-accent)" />
        </div>
      </header>

      <main className="mcc-shell">
        <RoomRecovery />
        <section className="mcc-identity" aria-label="Room identity">
          <div className="mcc-identity-field">
            <span>Room name</span>
          <InlineText
            value={draft.name}
            onChange={(v) => updateDraft({ name: v })}
            placeholder="Name your room"
            label="Room name"
            maxLength={64}
              textClass="mcc-identity-value"
              inputClass="mcc-identity-input"
          />
          </div>
          <div className="mcc-identity-field">
            <span>Your room link</span>
            <span className="mcc-identity-url">megachat.fun/
            <InlineText
              value={draft.handle}
              onChange={(v) => updateDraft({ handle: v })}
              sanitize={(v) => v.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20)}
              placeholder={identityHandle || 'yourname'}
              label="Your link"
                textClass="handle mcc-handle-value"
                inputClass="handle mcc-handle-input"
            />
          </span>
          </div>
          <div className="mcc-charging">
            <span>Charging</span>
            <Seg
              label="Free or paid"
              value={free ? 'free' : 'paid'}
              onChange={(v) => setFree(v === 'free')}
              options={[
                { v: 'paid', l: 'Paid' },
                { v: 'free', l: 'Free' },
              ]}
            />
          </div>
        </section>

        <div className="mcc-workspace">
          <div className="mcc-form">
            <section className="mcc-form-section">

              <div className="mcc-section-title">
                <span className="stepnum">01</span>
                <div><h1>What runs in your room</h1><p>Start with MegaChats. Add live seats or rewards only when you need them.</p></div>
              </div>

              <div className="mcc-modules">

        <FeatureCard
          icon={MessageSquareText}
          on={draft.lettersEnabled}
          onToggle={() => updateDraft({ lettersEnabled: !draft.lettersEnabled })}
          title="MegaChats"
          blurb="fans pay per second of clip, airs itself"
          accent="primary"
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-6">
              {!free ? (
                <span className="flex flex-col gap-1.5">
                  <span className="lbl">MegaChat rate</span>
                  <Stepper
                    label="MegaChat rate"
                    values={MEGA_RATES}
                    value={megaRate}
                    onChange={setMegaRate}
                    suffix="/s"
                  />
                  <span className="hint">
                    {clipSeconds}s = {clip}
                  </span>
                </span>
              ) : null}
              <span className="flex flex-col gap-1.5">
                <span className="lbl flex items-center gap-1.5">
                  Who screens clips
                  <button
                    type="button"
                    className="infodot"
                    aria-expanded={modInfo}
                    aria-label="How screening works"
                    onClick={() => setModInfo((v) => !v)}
                  >
                    i
                  </button>
                </span>
                <Seg
                  label="Who screens clips"
                  value={draft.lettersModeration}
                  onChange={(v) => updateDraft({ lettersModeration: v })}
                  options={[
                    { v: 'auto' as const, l: 'AI only' },
                    { v: 'approve' as const, l: 'AI, then me' },
                  ]}
                />
                <span className="hint">
                  {draft.lettersModeration === 'auto'
                    ? 'Airs once the filter clears'
                    : 'Nothing airs until you approve'}
                </span>
              </span>
              <span className="flex flex-col gap-1.5">
                <span className="lbl">Longest clip</span>
                <Seg
                  label="Longest clip"
                  value={clipSeconds}
                  onChange={setClipSeconds}
                  options={CLIP_SECONDS.map((s) => ({ v: s, l: `${s}s` }))}
                />
              </span>
            </div>
            {modInfo ? (
              <div className="flex flex-col gap-1.5 border border-[var(--mcc-rule-2)] bg-[var(--mcc-sunk)] px-3 py-2.5">
                <span className="text-[12.5px] leading-relaxed text-[var(--mcc-muted)]">
                  An AI filter runs on <em>every</em> clip either way. &ldquo;AI, then me&rdquo; adds
                  your own pass on top, so nothing airs while you&apos;re away.
                </span>
                <button
                  type="button"
                  onClick={() => setTab('mega')}
                  className="self-start border-0 bg-transparent p-0 text-left text-[12.5px] text-[var(--mcc-accent)]"
                >
                  Set strictness and refunds in Advanced settings &#8594; MegaChats
                </button>
              </div>
            ) : null}
          </div>
        </FeatureCard>

        <FeatureCard
          icon={Video}
          on={draft.joinStreamEnabled}
          onToggle={() => updateDraft({ joinStreamEnabled: !draft.joinStreamEnabled })}
          title="Open mic"
          blurb="viewers take camera seats beside you, billed per second"
          offLabel="OPT IN"
          accent="live"
        >
          <div className="flex flex-wrap items-end gap-6">
            {!free ? (
              <span className="flex flex-col gap-1.5">
                <span className="lbl">Open mic rate</span>
                <Stepper
                  label="Open mic rate"
                  values={MIC_RATES}
                  value={draft.passkeyTickPrice}
                  onChange={(v) => updateDraft({ passkeyTickPrice: v })}
                  suffix="/s"
                />
                <span className="hint">{micPerMin} a minute</span>
              </span>
            ) : null}
            <span className="flex flex-col gap-1.5">
              <span className="lbl">People on camera</span>
              <Seg
                label="People on camera at once"
                value={draft.maxSeats}
                onChange={(v) => updateDraft({ maxSeats: v })}
                options={SEATS.map((n) => ({ v: String(n), l: String(n) }))}
              />
              <span className="hint">+ a pinned co-host, free</span>
            </span>
            {!free ? (
              <span className="flex flex-col gap-1.5">
                <span className="lbl">Most a viewer can spend</span>
                <Seg
                  label="Most a viewer can spend"
                  value={draft.maxSession}
                  onChange={(v) => updateDraft({ maxSession: v })}
                  options={SPEND_CAPS.map((c) => ({ v: c, l: money(c) }))}
                />
                <span className="hint">auto-kick &#183; unused refunds</span>
              </span>
            ) : null}
          </div>
        </FeatureCard>

        <FeatureCard
          icon={Gift}
          on={draft.rewardsEnabled}
          onToggle={() => updateDraft({ rewardsEnabled: !draft.rewardsEnabled })}
          title="Drops &amp; rewards"
          blurb="pay people to watch, or credit toward MegaChats"
          accent="money"
        >
          <div className="flex flex-wrap items-end gap-6">
            <span className="flex flex-col gap-1.5">
              <span className="lbl">They earn</span>
              <Seg
                label="Reward type"
                value={draft.rewardsType === 'points' ? 'points' : 'usdc'}
                onChange={(v) =>
                  // Points carry 0 decimals: a fractional amount truncates to
                  // zero and silently pays nobody, so switch to whole units.
                  updateDraft(
                    v === 'points'
                      ? { rewardsType: 'points', rewardsEarnAmount: '1', rewardsEarnCap: '50' }
                      : { rewardsType: 'usdc', rewardsEarnAmount: '0.1', rewardsEarnCap: '5' },
                  )
                }
                options={[
                  { v: 'usdc', l: 'Cash' },
                  { v: 'points', l: 'MegaChat credit' },
                ]}
              />
              <span className="hint">
                {draft.rewardsType === 'points'
                  ? 'Spendable here only'
                  : 'Real money, theirs to keep'}
              </span>
            </span>
            <span className="flex flex-col gap-1.5">
              <span className="lbl">Each payout</span>
              <span className="text-[15px] font-semibold tabular-nums">
                {draft.rewardsType === 'points'
                  ? `${draft.rewardsEarnAmount} credit`
                  : money(draft.rewardsEarnAmount)}
                <span className="hint"> every {draft.rewardsEarnInterval}s</span>
              </span>
            </span>
            <span className="flex flex-col gap-1.5">
              <span className="lbl">Most one viewer earns</span>
              <span className="text-[15px] font-semibold tabular-nums">
                {draft.rewardsType === 'points'
                  ? `${draft.rewardsEarnCap} credit`
                  : money(draft.rewardsEarnCap)}
              </span>
            </span>
          </div>
        </FeatureCard>

              </div>
            </section>

        {/* ── 2 · advanced settings ── */}
            <section className="mcc-form-section mcc-advanced-section">
              <div className="mcc-section-title">
                <span className="stepnum">02</span>
                <div>
                  <h2>Advanced settings</h2>
                  <p>Rates, screening, access, money, and stream behavior.</p>
                </div>
              </div>

              <div className="mcc-advanced-shell">
                <div role="tablist" aria-label="Settings groups" aria-orientation="vertical" className="mcc-advanced-nav">
                  {ADVANCED_TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`mcc-tab-${id}`}
                aria-controls="mcc-advanced-panel"
                tabIndex={tab === id ? 0 : -1}
                aria-selected={tab === id}
                className="tabchip"
                onClick={() => setTab(id)}
                onKeyDown={(event) => {
                  const index = ADVANCED_TABS.findIndex((item) => item.id === id)
                  const next = event.key === 'Home' ? 0 : event.key === 'End' ? ADVANCED_TABS.length - 1
                    : ['ArrowDown', 'ArrowRight'].includes(event.key) ? (index + 1) % ADVANCED_TABS.length
                    : ['ArrowUp', 'ArrowLeft'].includes(event.key) ? (index + ADVANCED_TABS.length - 1) % ADVANCED_TABS.length : -1
                  if (next < 0) return
                  event.preventDefault()
                  const target = ADVANCED_TABS[next].id
                  setTab(target)
                  document.getElementById(`mcc-tab-${target}`)?.focus()
                }}
              >
                <Icon size={16} strokeWidth={2} aria-hidden="true" />
                <span>{label}</span>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            ))}
                </div>

                <div className="mcc-advanced-panel" id="mcc-advanced-panel" role="tabpanel" aria-labelledby={`mcc-tab-${tab}`} tabIndex={0}>
                  <div className="mcc-advanced-head">
                    <div>
                      <span>Advanced / {activeAdvanced.label}</span>
                      <h3>{activeAdvanced.heading}</h3>
                    </div>
                    <Settings2 size={19} strokeWidth={1.8} aria-hidden="true" />
                  </div>
                  <div className="mcc-advanced-content">
            {tab === 'mega' ? (
              <div className="flex flex-col gap-4">
                {!free ? (
                  <div className="keyrow flex flex-wrap items-end gap-6">
                    <span className="flex flex-col gap-1.5">
                      <span className="lbl" style={{ color: 'var(--mcc-accent)' }}>Key &#183; rate</span>
                      <Stepper label="MegaChat rate" values={MEGA_RATES} value={megaRate} onChange={setMegaRate} suffix="/s" />
                    </span>
                    <span className="flex flex-col gap-1.5">
                      <span className="lbl" style={{ color: 'var(--mcc-accent)' }}>Key &#183; who screens clips</span>
                      <Seg
                        label="Who screens clips"
                        value={draft.lettersModeration}
                        onChange={(v) => updateDraft({ lettersModeration: v })}
                        options={[
                          { v: 'auto' as const, l: 'AI only' },
                          { v: 'approve' as const, l: 'AI, then me' },
                        ]}
                      />
                    </span>
                  </div>
                ) : null}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  <span className="flex flex-col gap-1.5">
                    <span className="lbl">AI strictness</span>
                    <Seg
                      label="AI strictness"
                      value={draft.lettersAiStrictness}
                      onChange={(v) => updateDraft({ lettersAiStrictness: v })}
                      options={[
                        { v: 'severe' as const, l: 'Strict' },
                        { v: 'borderline' as const, l: 'Clear violations only' },
                      ]}
                    />
                  </span>
                  <span className="flex flex-col gap-1.5">
                    <span className="lbl">Refund clips I reject</span>
                    <Seg
                      label="Refund clips I reject"
                      value={draft.lettersAutoRefund ? 'on' : 'off'}
                      onChange={(v) => updateDraft({ lettersAutoRefund: v === 'on' })}
                      options={[
                        { v: 'on', l: 'On' },
                        { v: 'off', l: 'Off' },
                      ]}
                    />
                  </span>
                  <span className="flex flex-col gap-1.5">
                    <span className="lbl">Shortest clip</span>
                    <span className="text-[14px] font-semibold text-[var(--mcc-dim)]">3s — fixed</span>
                    <span className="hint">verifier sampling floor</span>
                  </span>
                </div>
              </div>
            ) : null}

            {tab === 'mic' ? (
              <div className="flex flex-col gap-4">
                <div className="keyrow flex flex-wrap items-end gap-6">
                  {!free ? (
                    <span className="flex flex-col gap-1.5">
                      <span className="lbl" style={{ color: 'var(--mcc-accent)' }}>Key &#183; rate</span>
                      <Stepper
                        label="Open mic rate"
                        values={MIC_RATES}
                        value={draft.passkeyTickPrice}
                        onChange={(v) => updateDraft({ passkeyTickPrice: v })}
                        suffix="/s"
                      />
                    </span>
                  ) : null}
                  <span className="flex flex-col gap-1.5">
                    <span className="lbl" style={{ color: 'var(--mcc-accent)' }}>Key &#183; people on camera</span>
                    <Seg
                      label="People on camera at once"
                      value={draft.maxSeats}
                      onChange={(v) => updateDraft({ maxSeats: v })}
                      options={SEATS.map((n) => ({ v: String(n), l: String(n) }))}
                    />
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  <span className="flex flex-col gap-1.5">
                    <span className="lbl">Entrance &amp; exit sounds</span>
                    <Seg
                      label="Entrance and exit sounds"
                      value={draft.stingerSounds ? 'on' : 'off'}
                      onChange={(v) => updateDraft({ stingerSounds: v === 'on' })}
                      options={[
                        { v: 'on', l: 'On' },
                        { v: 'off', l: 'Off' },
                      ]}
                    />
                    <span className="hint">viewers pick their own stinger</span>
                  </span>
                  <span className="flex flex-col gap-1.5">
                    <span className="lbl">Bill every</span>
                    <span className="text-[14px] font-semibold">1 second</span>
                  </span>
                  <span className="flex flex-col gap-1.5">
                    <span className="lbl">Video connection</span>
                    <span className="text-[14px] font-semibold">Automatic</span>
                  </span>
                </div>
              </div>
            ) : null}

            {tab === 'drops' ? (
              <div className="flex flex-col gap-4">
                <div className="keyrow flex flex-wrap items-center gap-4">
                  <span className="lbl" style={{ color: 'var(--mcc-accent)' }}>Key &#183; drops</span>
                  <Seg
                    label="Drops"
                    value={draft.rewardsEnabled ? 'on' : 'off'}
                    onChange={(v) => updateDraft({ rewardsEnabled: v === 'on' })}
                    options={[
                      { v: 'on', l: 'On' },
                      { v: 'off', l: 'Off' },
                    ]}
                  />
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  <span className="flex flex-col gap-1.5">
                    <span className="lbl">Pay them every</span>
                    <Seg
                      label="Pay them every"
                      value={draft.rewardsEarnInterval}
                      onChange={(v) => updateDraft({ rewardsEarnInterval: v })}
                      options={[
                        { v: '30', l: '30s' },
                        { v: '60', l: '1m' },
                        { v: '300', l: '5m' },
                        { v: '900', l: '15m' },
                      ]}
                    />
                  </span>
                  <span className="flex flex-col gap-1.5">
                    <span className="lbl">Each payout</span>
                    <span className="text-[14px] font-semibold tabular-nums">
                      {draft.rewardsType === 'points'
                        ? `${draft.rewardsEarnAmount} credit`
                        : money(draft.rewardsEarnAmount)}
                    </span>
                  </span>
                  <span className="flex flex-col gap-1.5">
                    <span className="lbl">Most one viewer earns</span>
                    <span className="text-[14px] font-semibold tabular-nums">
                      {draft.rewardsType === 'points'
                        ? `${draft.rewardsEarnCap} credit`
                        : money(draft.rewardsEarnCap)}
                    </span>
                  </span>
                </div>
              </div>
            ) : null}

            {tab === 'access' ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <span className="flex flex-col gap-1.5">
                  <span className="lbl">Watch time before joining in</span>
                  <Seg
                    label="Watch time before joining in"
                    value={draft.mcMinWatch}
                    onChange={(v) => updateDraft({ mcMinWatch: v, jsMinWatch: v })}
                    options={[
                      { v: '0', l: 'Off' },
                      { v: '120', l: '2m' },
                      { v: '600', l: '10m' },
                    ]}
                  />
                </span>
                <span className="flex flex-col gap-1.5">
                  <span className="lbl">Hide from Browse</span>
                  <Seg
                    label="Hide from Browse"
                    value={draft.unlisted ? 'on' : 'off'}
                    onChange={(v) => updateDraft({ unlisted: v === 'on' })}
                    options={[
                      { v: 'off', l: 'Listed' },
                      { v: 'on', l: 'Hidden' },
                    ]}
                  />
                  <span className="hint">your direct link always works</span>
                </span>
                <span className="flex flex-col gap-1.5">
                  <span className="lbl">Followers only</span>
                  <span className="text-[14px] font-semibold text-[var(--mcc-faint)]">Soon</span>
                </span>
              </div>
            ) : null}

            {tab === 'money' ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <span className="flex flex-col gap-1.5">
                  <span className="lbl">Paid in</span>
                  <span className="text-[14px] font-semibold">USDC</span>
                </span>
                <span className="flex flex-col gap-1.5">
                  <span className="lbl">Where your money goes</span>
                  <input
                    type="text"
                    value={draft.payoutAddress}
                    placeholder="0x… your wallet"
                    aria-label="Payout wallet address"
                    onChange={(e) => updateDraft({ payoutAddress: e.target.value.trim() })}
                  />
                  <span className="hint">
                    {draft.payoutAddress ? 'paid straight to you' : 'platform wallet holds it until you add one'}
                  </span>
                </span>
                <span className="flex flex-col gap-1.5">
                  <span className="lbl">Unused balance</span>
                  <span className="text-[14px] font-semibold text-[var(--mcc-live)]">Always refunds</span>
                </span>
              </div>
            ) : null}

            {tab === 'stream' ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <span className="flex flex-col gap-1.5">
                  <span className="lbl">Twitch channel</span>
                  <input
                    type="text"
                    value={draft.twitchChannel}
                    placeholder="your_twitch_login"
                    aria-label="Twitch channel"
                    onChange={(e) => updateDraft({ twitchChannel: e.target.value.trim().toLowerCase() })}
                  />
                  <span className="hint">shows a live badge on your room card</span>
                </span>
                <span className="flex flex-col gap-1.5">
                  <span className="lbl">Use my linked account</span>
                  <Seg
                    label="Use my linked Twitch account"
                    value={draft.twitchAuto ? 'on' : 'off'}
                    onChange={(v) => updateDraft({ twitchAuto: v === 'on' })}
                    options={[
                      { v: 'on', l: 'On' },
                      { v: 'off', l: 'Off' },
                    ]}
                  />
                </span>
                <span className="flex flex-col gap-1.5">
                  <span className="lbl">Overlay</span>
                  <span className="text-[14px] font-semibold text-[var(--mcc-dim)]">
                    Ready after you open the room
                  </span>
                </span>
              </div>
            ) : null}
                  </div>
                </div>
              </div>
            </section>

        {/* No third section heading: what is left is the save-defaults
            switch, the password, and the button. That is the end of the
            form, not a step worth announcing. */}
            <footer className="mcc-submit">

        <button
          type="button"
          aria-pressed={saveDefault}
          onClick={() => setSaveDefault((v) => !v)}
          className="mcc-defaults"
          style={{
            borderColor: saveDefault ? 'rgba(67,224,168,0.35)' : 'var(--mcc-rule)',
            background: saveDefault ? 'rgba(67,224,168,0.04)' : 'var(--mcc-sunk)',
          }}
        >
          <span
            aria-hidden="true"
            className="flex size-[17px] shrink-0 items-center justify-center border-2"
            style={{
              borderColor: saveDefault ? 'var(--mcc-live)' : 'var(--mcc-rule-2)',
              background: saveDefault ? 'var(--mcc-live)' : 'transparent',
            }}
          >
            {saveDefault ? (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#08080a" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : null}
          </span>
          <span className="min-w-0 grow">
            <span className="text-[14px] font-semibold">Save this setup as my defaults</span>
            <span className="block text-[12px] text-[var(--mcc-faint)]">
              {hasIdentity
                ? 'Every room you open later starts here. Change them anytime in your profile.'
                : 'Sign in to keep defaults.'}
            </span>
          </span>
        </button>

        {!hasIdentity ? (
          <div className="mcc-password">
            <span className="lbl">Room password</span>
            <span className="mcc-password-field">
              <LockKeyhole size={16} aria-hidden="true" />
              <input
                type="password"
                value={password}
                placeholder="At least 4 characters"
                aria-label="Room password"
                onChange={(e) => setPassword(e.target.value)}
              />
            </span>
            <span className="hint">The only way back into your room — save it somewhere safe.</span>
          </div>
        ) : null}

        {/* A handle points at one room. If it is already pointing at one of
            yours, the useful move is to go manage that room — not to read a
            409 and work out what to do about it. */}
        {error ? (
          <p role="alert" className="flex flex-wrap items-center gap-3 text-[13px] text-[var(--mcc-accent)]">
            {clashingRoom ? `That link already points at ${clashingRoom.name || 'your other room'}.` : error}
            {clashingRoom ? (
              <button
                type="button"
                onClick={() => void openOwnedRoom(clashingRoom.id)}
                className="border border-[var(--mcc-accent)] px-3 py-1.5 text-[12.5px] font-bold text-[var(--mcc-accent)]"
              >
                Manage that room
              </button>
            ) : null}
          </p>
        ) : null}

        <div className="mcc-submit-action">
          <button
            type="button"
            disabled={busy || !canCreate}
            onClick={() => void onCreate()}
            className="mcc-primary-action"
          >
            <span>{busy ? 'Opening…' : 'Create room'}</span>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
          <span className="hint">Creating opens your room. Connect OBS to play clips on stream.</span>
        </div>
            </footer>
      </div>

      {/* ─────────── RIGHT: what viewers get ─────────── */}
      <aside className="mcc-preview">
        <div className="mcc-preview-inner">
          <div className="mcc-preview-head">
            <div><span>Room preview</span><strong>What viewers see</strong></div>
            <span className="mcc-live-state">Not broadcasting</span>
          </div>

        {/* the room tile, as it lands on the board */}
        <div
          className="mcc-preview-stage relative aspect-video overflow-hidden"
          style={{ background: 'radial-gradient(120% 90% at 22% 18%, #275675 0%, #10253a 55%, #09131f 100%)' }}
        >
          <span
            aria-hidden="true"
            className="absolute left-1/2 top-[58%] size-[150px] -translate-x-1/2 rounded-full blur-[26px]"
            style={{ background: 'rgba(99,186,255,0.34)' }}
          />
          <span
            aria-hidden="true"
            className="absolute inset-0"
            style={{
              background:
                'linear-gradient(to top, rgba(8,8,10,0.92) 0%, rgba(8,8,10,0.28) 34%, rgba(8,8,10,0) 62%)',
            }}
          />
          <span className="bc absolute left-3 top-2.5 flex items-center gap-1.5 bg-[rgba(8,8,10,0.62)] px-2 py-0.5 text-[11px] font-bold tracking-[0.08em] text-[var(--mcc-live)]">
            <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-[var(--mcc-live)]" />
            PREVIEW
          </span>
          {!free ? (
            <span className="bc absolute right-2.5 top-2 bg-[rgba(8,8,10,0.55)] px-2 py-1 text-[12.5px] font-semibold">
              {draft.joinStreamEnabled ? `${money(draft.passkeyTickPrice)}/s` : `${money(megaRate)}/s`}
            </span>
          ) : (
            <span className="bc absolute right-2.5 top-2 bg-[rgba(8,8,10,0.55)] px-2 py-1 text-[12.5px] font-semibold text-[var(--mcc-live)]">
              FREE
            </span>
          )}
          <span className="absolute inset-x-3 bottom-2.5 flex items-end justify-between gap-2.5">
            <span className="min-w-0">
              <span className="block truncate text-[22px] font-bold leading-[1.05] tracking-[-0.01em]">
                {draft.name.trim() || 'Your room'}
              </span>
              <span className="mt-0.5 block text-[12px] font-medium text-[var(--mcc-muted)]">
                {draft.joinStreamEnabled
                  ? `0 of ${draft.maxSeats} on camera`
                  : draft.lettersEnabled
                    ? 'MegaChats open'
                    : 'Watch only'}
                {draft.rewardsEnabled ? ' · Drops' : ''}
              </span>
            </span>
            <span className="whitespace-nowrap bg-[#f2f2f4] px-3 py-1.5 text-[12.5px] font-bold text-[#08080a]">
              {draft.joinStreamEnabled ? 'Take a seat' : draft.lettersEnabled ? 'Send a MegaChat' : 'Watch'}
            </span>
          </span>
        </div>

        {/* the join card */}
        <div className="mcc-preview-ledger flex flex-col gap-2.5">
          <span className="lbl">Join card</span>
          {draft.lettersEnabled ? (
            <span className="flex items-baseline justify-between border-b border-[#1a1a1f] pb-2">
              <span className="text-[13px] text-[var(--mcc-muted)]">A MegaChat</span>
              <span className="text-[13.5px] font-semibold tabular-nums">
                {free ? 'Free' : `${money(megaRate)}/s`}
                {!free ? (
                  <span className="text-[11px] text-[var(--mcc-faint)]">
                    {' '}
                    {clipSeconds}s = {clip}
                  </span>
                ) : null}
              </span>
            </span>
          ) : null}
          <span className="flex items-baseline justify-between border-b border-[#1a1a1f] pb-2">
            <span
              className="text-[13px]"
              style={{ color: draft.joinStreamEnabled ? 'var(--mcc-muted)' : 'var(--mcc-faint)' }}
            >
              A camera seat
            </span>
            <span
              className="text-[13.5px] font-semibold tabular-nums"
              style={{ color: draft.joinStreamEnabled ? 'var(--mcc-fg)' : 'var(--mcc-faint)' }}
            >
              {!draft.joinStreamEnabled
                ? 'Open mic off'
                : free
                  ? 'Free'
                  : `${money(draft.passkeyTickPrice)}/s`}
            </span>
          </span>
          {draft.rewardsEnabled ? (
            <span className="flex items-baseline justify-between border-b border-[#1a1a1f] pb-2">
              <span className="text-[13px] text-[var(--mcc-muted)]">Watching earns</span>
              <span className="text-[13.5px] font-semibold text-[var(--mcc-live)]">
                {draft.rewardsType === 'points' ? 'MegaChat credit' : money(draft.rewardsEarnAmount)}
              </span>
            </span>
          ) : null}
          {draft.mcMinWatch !== '0' ? (
            <span className="flex items-baseline justify-between border-b border-[#1a1a1f] pb-2">
              <span className="text-[13px] text-[var(--mcc-muted)]">Before joining in</span>
              <span className="text-[13.5px] font-semibold">
                Watch {Number(draft.mcMinWatch) / 60}m
              </span>
            </span>
          ) : null}
          {!free ? (
            <span className="flex items-baseline justify-between">
              <span className="text-[13px] text-[var(--mcc-muted)]">Most you can spend</span>
              <span className="text-[13.5px] font-semibold tabular-nums">
                {money(draft.maxSession)}
                <span className="text-[11px] text-[var(--mcc-faint)]"> unused refunds</span>
              </span>
            </span>
          ) : null}
        </div>

        <span className="mcc-preview-note"><ShieldCheck size={14} aria-hidden="true" /> Every number reflects your live configuration.</span>
        </div>
      </aside>
      </div>
    </main>
    </div>
  )
}
