'use client'

// CREATE A ROOM — the rebuilt create surface.
//
// Shape settled over four rounds of review; the reasoning lives in
// docs/design/room-control-panel.html. The short version:
//
//   1 · What runs in your room   three feature cards, check to expand
//   2 · Fine-tune it             optional, grouped tabs; key choices repeat
//   3 · Open it                  the two set-once switches, then CREATE
//
// Rules this page exists to fix, all from the audit of the old form:
//   · Everything is priced PER SECOND, MegaChats included. A MegaChat costs
//     rate x length, which is exactly how the server already derives it when
//     letters.price is null — we just store the product explicitly so clips
//     can carry their own rate, independent of the open-mic rate.
//   · No free-text numbers. Every value is a stepper or a segmented control
//     with the server's real bounds; the old form let a typo in one field
//     500 the room's join page.
//   · Nothing renders as a working control unless it works.

import { useCallback, useMemo, useState } from 'react'
import { useRoom } from '@/components/room-provider'
import { ApiError } from '@/lib/api'
import './create-room.css'

// Server bounds, mirrored from rooms-store.js so the control cannot express
// a value the server would silently clamp on the way back out.
const SEATS = [1, 2, 3] as const
const CLIP_SECONDS = [5, 10, 15, 20, 30] as const
const MEGA_RATES = ['0.0005', '0.001', '0.002', '0.005', '0.01'] as const
const MIC_RATES = ['0.001', '0.005', '0.01', '0.02', '0.05'] as const
const SPEND_CAPS = ['1', '2', '5', '10'] as const

const money = (v: string | number) => {
  const n = typeof v === 'number' ? v : parseFloat(v)
  if (!Number.isFinite(n)) return '$0'
  return `$${parseFloat(n.toFixed(6))}`
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
  const i = Math.max(0, values.indexOf(value))
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        className="stepbtn"
        aria-label={`Lower ${label}`}
        disabled={i <= 0}
        onClick={() => onChange(values[Math.max(0, i - 1)])}
      >
        &#8722;
      </button>
      <span className="min-w-[86px] text-center text-[15px] font-semibold tabular-nums">
        {money(value)}
        {suffix ? <span className="text-[12px] text-[var(--mcc-dim)]">{suffix}</span> : null}
      </span>
      <button
        type="button"
        className="stepbtn"
        aria-label={`Raise ${label}`}
        disabled={i >= values.length - 1}
        onClick={() => onChange(values[Math.min(values.length - 1, i + 1)])}
      >
        +
      </button>
    </span>
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
  on,
  onToggle,
  title,
  blurb,
  offLabel = 'OFF',
  children,
}: {
  on: boolean
  onToggle: () => void
  title: string
  blurb: string
  offLabel?: string
  children?: React.ReactNode
}) {
  return (
    <div
      className="border"
      style={{
        borderColor: on ? 'var(--mcc-accent)' : '#2f2f36',
        background: on ? 'var(--mcc-panel)' : 'var(--mcc-sunk)',
      }}
    >
      <button
        type="button"
        aria-pressed={on}
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center gap-3 border-0 bg-transparent px-3.5 py-3 text-left"
      >
        <span
          aria-hidden="true"
          className="flex size-[17px] shrink-0 items-center justify-center border-2"
          style={{
            borderColor: on ? 'var(--mcc-accent)' : '#2f2f36',
            background: on ? 'var(--mcc-accent)' : 'transparent',
          }}
        >
          {on ? (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#08080a" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : null}
        </span>
        <span className="min-w-0 grow">
          <span
            className="text-[15.5px] font-bold"
            style={{ color: on ? 'var(--mcc-fg)' : 'var(--mcc-dim)' }}
          >
            {title}
          </span>{' '}
          <span
            className="text-[12.5px]"
            style={{ color: on ? 'var(--mcc-muted)' : '#7f8992' }}
          >
            — {blurb}
          </span>
        </span>
        <span
          className="bc shrink-0 text-[11.5px] font-bold tracking-[0.08em]"
          style={{ color: on ? 'var(--mcc-live)' : '#7f8992' }}
        >
          {on ? 'ON' : offLabel}
        </span>
      </button>
      {on && children ? (
        <div className="border-t border-[var(--mcc-rule)] py-3 pl-[46px] pr-3.5">{children}</div>
      ) : null}
    </div>
  )
}

type Tab = 'mega' | 'mic' | 'drops' | 'access' | 'money' | 'stream'

export function CreateRoom() {
  const { draft, updateDraft, create, hasIdentity, identityHandle, saveDefaultsFromDraft } = useRoom()
  const [tab, setTab] = useState<Tab>('mega')
  const [modInfo, setModInfo] = useState(false)
  const [saveDefault, setSaveDefault] = useState(true)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const free = draft.passkeyTickPrice === '0'
  const clipSeconds = Number(draft.lettersMaxSeconds) || 10

  // MegaChats are priced per second of clip. The stored field is a flat price,
  // so the per-second rate is that price divided by the clip length — and
  // setting a rate stores rate x length. Same number, honest unit.
  const megaRate = useMemo(() => {
    const flat = parseFloat(draft.lettersPrice)
    if (Number.isFinite(flat) && flat > 0) {
      const per = flat / Math.max(1, clipSeconds)
      // snap to the nearest offered rate so the stepper has a position
      let best = MEGA_RATES[1] as string
      let bestGap = Infinity
      for (const r of MEGA_RATES) {
        const gap = Math.abs(parseFloat(r) - per)
        if (gap < bestGap) {
          bestGap = gap
          best = r
        }
      }
      return best
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

  const clip = money(parseFloat(megaRate) * clipSeconds)
  const micPerMin = money(parseFloat(draft.passkeyTickPrice) * 60)

  return (
    <div className="mc-create dark min-h-screen">
      {/* the only chrome: one thin bar, same as the room board */}
      <header className="border-b border-[#1a1a1f]">
        <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center justify-between gap-3 px-5 py-3">
        <span className="flex flex-wrap items-baseline gap-3.5">
          <a href="/app" className="bc text-[18px] font-bold tracking-[0.1em] text-[var(--mcc-fg)]">
            MEGACHAT
          </a>
          <span className="text-[13px] font-semibold text-[var(--mcc-dim)]">New room</span>
        </span>
        <span className="text-[12px] text-[var(--mcc-faint)]">
          {hasIdentity ? (
            <>
              Signed in as{' '}
              <span className="font-semibold text-[var(--mcc-fg)]">
                {identityHandle || 'your account'}
              </span>
            </>
          ) : (
            <>
              Have an account?{' '}
              <a href="/dashboard?signin=1" className="text-[var(--mcc-muted)] underline underline-offset-[3px]">
                Sign in
              </a>{' '}
              — we&apos;ll fill most of this in for you
            </>
          )}
        </span>
        </div>
      </header>

      {/* Capped and centred: a form stretched across a wide monitor is
          harder to scan, not easier. The room board is full-bleed because
          it is a wall of video; this is a form. */}
      <div className="mx-auto grid w-full max-w-[1400px] grid-cols-1 lg:grid-cols-[1.5fr_1fr]">
      {/* ─────────── LEFT: the decisions ─────────── */}
      <div className="flex min-w-0 flex-col gap-4 border-b border-[var(--mcc-rule)] p-5 lg:border-b-0 lg:border-r">
        {/* identity — one dense line, no action button up here */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--mcc-rule)] pb-4">
          <input
            type="text"
            value={draft.name}
            maxLength={64}
            placeholder="Name your room"
            aria-label="Room name"
            onChange={(e) => updateDraft({ name: e.target.value })}
            className="min-w-[220px] max-w-[420px] grow"
          />
          <span className="flex items-center gap-1 text-[13px] text-[var(--mcc-dim)]">
            megachat.fun/
            <input
              type="text"
              value={draft.handle}
              placeholder={identityHandle || 'yourname'}
              aria-label="Your link"
              onChange={(e) => updateDraft({ handle: e.target.value.toLowerCase() })}
              className="w-[130px]"
            />
          </span>
          <span className="ml-auto flex items-center gap-2">
            <span className="lbl">Charging</span>
            <Seg
              label="Free or paid"
              value={free ? 'free' : 'paid'}
              onChange={(v) => setFree(v === 'free')}
              options={[
                { v: 'paid', l: 'Paid' },
                { v: 'free', l: 'Free' },
              ]}
            />
          </span>
        </div>

        {/* ── 1 · what runs ── */}
        <div className="flex items-center gap-2.5">
          <span className="stepnum" style={{ background: 'var(--mcc-accent)' }}>1</span>
          <span className="text-[15px] font-bold">What runs in your room</span>
          <span className="hint">click a card to switch it on or off</span>
        </div>

        <FeatureCard
          on={draft.lettersEnabled}
          onToggle={() => updateDraft({ lettersEnabled: !draft.lettersEnabled })}
          title="MegaChats"
          blurb="fans pay per second of clip, it plays on stream by itself"
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
                    {clipSeconds}s clip = {clip}
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
                    ? 'Clips air once the filter clears them'
                    : 'Nothing airs until you approve it'}
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
                <span className="text-[12.5px] font-semibold text-[#d7dde2]">
                  It isn&apos;t only these two.
                </span>
                <span className="text-[12.5px] leading-relaxed text-[var(--mcc-muted)]">
                  An AI filter runs on <em>every</em> clip either way — you choose how strict, and
                  whether a rejected clip refunds automatically. &ldquo;AI, then me&rdquo; adds your
                  own pass on top, so clips wait for you and nothing airs while you&apos;re away.
                </span>
                <button
                  type="button"
                  onClick={() => setTab('mega')}
                  className="self-start border-0 bg-transparent p-0 text-left text-[12.5px] text-[var(--mcc-accent)]"
                >
                  Set strictness and refunds in Fine-tune &#8594; MegaChats
                </button>
              </div>
            ) : null}
          </div>
        </FeatureCard>

        <FeatureCard
          on={draft.joinStreamEnabled}
          onToggle={() => updateDraft({ joinStreamEnabled: !draft.joinStreamEnabled })}
          title="Open mic"
          blurb="viewers take live camera seats beside you, billed per second"
          offLabel="OPT IN"
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
                <span className="hint">{micPerMin} a minute on camera</span>
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
          on={draft.rewardsEnabled}
          onToggle={() => updateDraft({ rewardsEnabled: !draft.rewardsEnabled })}
          title="Drops &amp; rewards"
          blurb="pay people to watch, or hand them credit toward MegaChats to drive engagement"
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
                  ? 'Spendable here only — drives engagement'
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

        {/* ── 2 · fine-tune ── */}
        <div className="mt-3 flex items-center gap-2.5 border-t border-[var(--mcc-rule)] pt-4">
          <span className="stepnum" style={{ background: 'var(--mcc-dim)' }}>2</span>
          <span className="text-[15px] font-bold text-[#d7dde2]">
            Fine-tune it{' '}
            <span className="text-[13px] font-normal text-[var(--mcc-faint)]">
              — optional, good defaults are already in
            </span>
          </span>
        </div>

        <div className="flex flex-col gap-3 border border-[var(--mcc-rule)] bg-[var(--mcc-sunk)] p-4">
          <span className="hint">
            Your key choices from above reappear first in each group, marked{' '}
            {/* JSX drops a leading space that starts a multi-line text chunk,
                so this one has to be explicit — it read "Key ·— same" without it. */}
            <span className="font-bold text-[var(--mcc-accent)]">Key ·</span>{' '}
            — same control, same value, either place. This is the editor you&apos;ll use on the
            live room too.
          </span>

          <div role="tablist" aria-label="Settings groups" className="flex flex-wrap gap-1.5">
            {([
              ['mega', 'MegaChats'],
              ['mic', 'Open mic'],
              ['drops', 'Drops'],
              ['access', 'Who gets in'],
              ['money', 'Money'],
              ['stream', 'Stream'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className="tabchip"
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="border border-[var(--mcc-rule)] bg-[var(--mcc-panel)] p-4">
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
                    <span className="hint">set by the verifier&apos;s sampling floor</span>
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
                    <span className="hint">best available transport</span>
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
                  <span className="hint">
                    {draft.mcMinWatch === '0'
                      ? 'anyone can join in right away'
                      : 'filters drive-bys'}
                  </span>
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
                  <span className="hint">needs the platform link to verify</span>
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
                  <span className="hint">one-click OBS setup comes next</span>
                </span>
              </div>
            ) : null}
          </div>
        </div>

        {/* ── 3 · open it ── */}
        <div className="mt-3 flex items-center gap-2.5 border-t border-[var(--mcc-rule)] pt-4">
          <span className="stepnum" style={{ background: 'var(--mcc-accent)' }}>3</span>
          <span className="text-[15px] font-bold">Open it</span>
          <span className="hint">two things worth setting once</span>
        </div>

        {/* set-once 1 — the auto-live loop isn't wired yet, so this states
            that plainly rather than rendering a switch that does nothing. */}
        <div className="border border-[var(--mcc-rule)] bg-[var(--mcc-sunk)]">
          <div className="flex items-center gap-3 px-3.5 py-3">
            <span
              aria-hidden="true"
              className="relative h-[18px] w-[34px] shrink-0 border border-[var(--mcc-rule-2)]"
            >
              <span className="absolute left-[1px] top-[1px] size-[14px] bg-[var(--mcc-faint)]" />
            </span>
            <span className="min-w-0 grow">
              <span className="text-[15px] font-bold text-[var(--mcc-dim)]">Follow my stream</span>{' '}
              <span className="text-[12.5px] text-[var(--mcc-faint)]">
                — the room would open and close with your broadcast
              </span>
            </span>
            <span className="bc shrink-0 text-[11.5px] font-bold tracking-[0.08em] text-[var(--mcc-warn)]">SOON</span>
          </div>
          <div className="border-t border-[var(--mcc-rule)] py-2.5 pl-[59px] pr-3.5">
            <span className="hint">
              Going live on Twitch would open your room, and ending the stream would close it —
              cameras cut, the clip queue clears, every unused balance refunds. The switch lands
              once that loop is wired; until then you open and close the room yourself.
            </span>
          </div>
        </div>

        {/* set-once 2 */}
        <button
          type="button"
          aria-pressed={saveDefault}
          onClick={() => setSaveDefault((v) => !v)}
          className="flex cursor-pointer items-center gap-3 border px-3.5 py-3 text-left"
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
                : 'Sign in to keep defaults — they follow your account, not this browser.'}
            </span>
          </span>
        </button>

        {!hasIdentity ? (
          <div className="flex flex-col gap-1.5">
            <span className="lbl">Room password</span>
            <input
              type="password"
              value={password}
              placeholder="At least 4 characters"
              aria-label="Room password"
              onChange={(e) => setPassword(e.target.value)}
              className="max-w-[280px]"
            />
            <span className="hint">
              Without an account this password is the only way back into your room — save it
              somewhere safe.
            </span>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-[13px] text-[var(--mcc-accent)]">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            disabled={busy || !canCreate}
            onClick={() => void onCreate()}
            className="bg-[var(--mcc-accent)] px-11 py-4 text-[16.5px] font-bold text-[#08080a] disabled:opacity-50"
          >
            {busy ? 'Opening…' : 'Create room'}
          </button>
          <span className="hint">
            Overlay link and OBS setup come next.
            <br />
            Nothing charges anyone until you go live.
          </span>
        </div>
      </div>

      {/* ─────────── RIGHT: what viewers get ─────────── */}
      <div className="min-w-0 bg-[var(--mcc-sunk)]">
        <div className="flex flex-col gap-3 p-5 lg:sticky lg:top-0 lg:max-h-screen lg:overflow-y-auto">
        <span className="text-[15px] font-bold text-[#d7dde2]">
          What viewers will see{' '}
          <span className="text-[12.5px] font-normal text-[var(--mcc-faint)]">
            — updates as you choose
          </span>
        </span>

        {/* the room tile, as it lands on the board */}
        <div
          className="relative aspect-video overflow-hidden"
          style={{ background: 'radial-gradient(120% 90% at 22% 18%, #24404f 0%, #141c22 62%)' }}
        >
          <span
            aria-hidden="true"
            className="absolute left-1/2 top-[58%] size-[150px] -translate-x-1/2 rounded-full blur-[26px]"
            style={{ background: 'rgba(96,164,190,0.5)' }}
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
            ON AIR
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
        <div className="flex flex-col gap-2.5 border border-[var(--mcc-rule)] bg-[var(--mcc-panel)] px-4 py-3.5">
          <span className="lbl">The join card</span>
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

        <span className="hint">
          Sample room art. Everything else here is your live configuration — if a number looks
          wrong, it will look wrong to viewers too.
        </span>
        </div>
      </div>
      </div>
    </div>
  )
}
