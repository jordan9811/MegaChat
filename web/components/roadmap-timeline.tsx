'use client'

// The roadmap as one vertical timeline, two directions:
//  - FORWARD (default): what's next, priority-ordered top to bottom,
//    color-coded by horizon — green near / amber mid / ultramarine ambitious
//    (the page copy still says purple: the owner's wording to change).
//    The horizon colours borrow the Holler palette's hues (rewards green,
//    bounty yellow, the strap ultramarine) but never the FeatureTag shape — no
//    dot — so a horizon chip cannot be read as a feature.
//  - JOURNEY (back-arrow toggle): how we got here, oldest first, ending at
//    today. The Feb 2026 prototype links to the original tweet when
//    JOURNEY_TWEET_URL is set; a quiet placeholder otherwise.
// Same rail, same cards — only the direction of time changes.

import { useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  AtSign,
  Compass,
  CreditCard,
  Gift,
  Megaphone,
  MonitorPlay,
  Radio,
  Rocket,
  ShieldBan,
  ShieldCheck,
  Smartphone,
  Sparkles,
  SplitSquareHorizontal,
  Store,
  Wallet,
  Zap,
} from 'lucide-react'
import { FeatureTag, type FeatureKind } from '@/components/feature-tag'

type Horizon = 'near' | 'mid' | 'far'

// ink: text in that colour (≥4.5:1 in both themes) · hue: the dot itself, the
// -ui token so the pale green and yellow take their ink on a light page
const STRAP_INK = 'color-mix(in srgb, var(--hl-strap-hi) 72%, var(--hl-fg))'
const HORIZONS: Record<Horizon, { color: string; hue: string; chip: string }> = {
  near: { color: 'var(--f-rewards-ink)', hue: 'var(--f-rewards-ui)', chip: 'Near term' },
  mid: { color: 'var(--f-bounty-ink)', hue: 'var(--f-bounty-ui)', chip: 'Mid term' },
  far: { color: STRAP_INK, hue: 'var(--hl-strap-hi)', chip: 'Ambitious' },
}

// A dot's glow, dark theme only (--hl-glow-k is 0 in light).
const glow = (hue: string) => `0 0 10px color-mix(in srgb, ${hue} calc(100% * var(--hl-glow-k)), transparent)`

type ForwardItem = {
  icon: React.ComponentType<{ className?: string }>
  horizon: Horizon
  title: string
  body: string
}

// Priority order top to bottom — the next thing we'd ship is first.
const FORWARD: ForwardItem[] = [
  {
    icon: Radio,
    horizon: 'near',
    title: 'LiveKit hardening',
    body: 'Battle-testing the new media transport — reconnect grace, simulcast tuning, connection quality under real load — until it can be the default on every room.',
  },
  {
    icon: MonitorPlay,
    horizon: 'near',
    title: 'Twitch Drops OAuth, phase 2',
    body: 'Real linked-account drops: watch time on the Twitch side earns join balance here, so your existing audience arrives with a seat already funded. Also unlocks enforced follower/subscriber gates.',
  },
  {
    icon: ShieldCheck,
    horizon: 'near',
    title: 'Live AI moderation (v3)',
    body: 'Hollers already get frames-plus-transcript review before they play. v3 points the same pipeline at live seats, sampling in near-real-time so a room can run hands-off.',
  },
  {
    icon: Store,
    horizon: 'mid',
    title: 'Stinger marketplace',
    body: 'Creators publish and sell custom entrance/exit stingers; streamers equip them per room. Cosmetics as an economy.',
  },
  {
    icon: ShieldBan,
    horizon: 'mid',
    title: 'Sybil-resistant bans',
    body: 'Bans keyed on wallet + linked platform identity — a kicked troll can’t just rejoin with a fresh burner wallet.',
  },
  {
    icon: Compass,
    horizon: 'mid',
    title: 'Browse ranking that means something',
    body: 'Hottest-first, but earned: spend velocity, uptime, and returning viewers feed the directory ranking instead of raw recency.',
  },
  {
    icon: CreditCard,
    horizon: 'far',
    title: 'Card top-ups, flipped on',
    body: 'Buy credits with a debit card straight from the join page — the last crypto-shaped step gone for Simple-mode viewers.',
  },
  {
    icon: Smartphone,
    horizon: 'far',
    title: 'Mobile polish pass',
    body: 'A join flow that feels native on a phone: camera prep, one-thumb controls, layouts that stay overlay-safe.',
  },
]

type JourneyItem = {
  icon: React.ComponentType<{ className?: string }>
  date: string
  title: string
  body: string
  tweet?: boolean
  tags?: FeatureKind[]
}

// Oldest first — read it top to bottom and you arrive at today.
const JOURNEY: JourneyItem[] = [
  {
    icon: Wallet,
    date: 'Feb 2026',
    title: 'The MetaMask top-up prototype',
    body: 'The first working loop: a MetaMask wallet, a top-up, and a camera seat billed by the second. One tweet, one demo.',
    tweet: true,
  },
  {
    icon: Sparkles,
    date: 'Spring 2026',
    title: 'MVP + the MegaChat brand',
    body: 'The prototype became a product: rooms, the dashboard, the OBS overlay — and a name.',
  },
  {
    icon: Rocket,
    date: 'Spring 2026',
    title: 'Arc testnet deploy',
    body: 'First public deploy: passkey accounts and per-second USDC billing, live on a public testnet.',
  },
  {
    icon: Zap,
    date: 'July 2026',
    title: 'Tempo mainnet migration',
    body: 'Real money: payment-channel billing on Tempo, with one-tap embedded wallets via email, passkey, or socials.',
  },
  {
    icon: Radio,
    date: 'July 2026',
    title: 'vdo.ninja → LiveKit',
    body: 'A second media transport built flag-gated in parallel: SFU tiles, reconnect grace, simulcast — without touching the path rooms already ran on.',
  },
  {
    icon: Sparkles,
    date: 'July 2026',
    title: 'Stingers, with sound',
    body: 'Entrance and exit transitions grew synthesized SFX synced to the animation beats — storm strike, breaking-news slam, CRT power-off.',
  },
  {
    icon: SplitSquareHorizontal,
    date: 'July 2026',
    title: 'MegaChat / Join Stream split',
    body: 'Recorded clips (“send a MegaChat”) and live seats (“Join Stream”) became separate features with their own pricing, gates, and AI moderation for the recorded side.',
  },
  {
    icon: Gift,
    date: 'July 2026',
    title: 'Watch-to-earn drops',
    body: 'Streamers fund a pool and viewers earn toward their first seat just by watching.',
  },
  {
    icon: AtSign,
    date: 'July 2026',
    title: 'OAuth identity + handles',
    body: 'Twitch and X sign-in reserves your handle as a display name and a permanent megachat.xyz/yourname room link.',
  },
  {
    icon: Megaphone,
    date: 'Oct 2026',
    title: 'MegaChat becomes Holler',
    body: 'A new name and a new mark: HOLLER on a broadcast strap, the O a record button. Recorded clips are Hollers, camera seats are Call in, and each feature wears its own colour.',
    tags: ['holler', 'callin', 'bounty', 'rewards'],
  },
]

function TimelineCard({
  icon: Icon,
  color,
  chip,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  color: string
  chip: string
  title: string
  children: React.ReactNode
}) {
  // Square card on the panel fill with a hairline, like every other card in
  // the Holler skin.
  return (
    <div className="flex gap-4 rounded-[3px] border border-hl-line bg-hl-panel p-5 shadow-[var(--hl-shadow)] transition-transform duration-200 ease-[cubic-bezier(.23,1,.32,1)] hover:-translate-y-0.5">
      <span
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-[2px] border"
        style={{
          color,
          borderColor: `color-mix(in oklab, ${color} 40%, transparent)`,
          background: `color-mix(in oklab, ${color} 10%, transparent)`,
        }}
      >
        <Icon className="size-4.5" />
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="font-heading text-base font-bold text-hl-fg">{title}</h3>
          <span
            className="rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest"
            style={{
              color,
              borderColor: `color-mix(in oklab, ${color} 50%, transparent)`,
              background: `color-mix(in oklab, ${color} 10%, transparent)`,
            }}
          >
            {chip}
          </span>
        </div>
        <div className="mt-1 text-sm leading-relaxed text-hl-muted">{children}</div>
      </div>
    </div>
  )
}

export function RoadmapTimeline({ journeyTweetUrl }: { journeyTweetUrl: string }) {
  const [journey, setJourney] = useState(false)

  return (
    <div className="mt-10">
      {/* direction switch + (forward only) the horizon legend */}
      <div className="mb-7 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <button
          type="button"
          onClick={() => setJourney((v) => !v)}
          className="flex items-center gap-2 rounded-[2px] border border-hl-line-2 bg-hl-panel/60 px-4 py-2 text-sm font-semibold text-hl-fg transition-colors hover:bg-hl-panel-2"
        >
          {journey ? (
            <>
              Back to the roadmap
              <ArrowRight className="size-4 text-hl-strap-hi" />
            </>
          ) : (
            <>
              <ArrowLeft className="size-4 text-hl-strap-hi" />
              Our journey — how we got here
            </>
          )}
        </button>

        {journey ? null : (
          /* The tint rides on an opaque panel: the legend sits on the page
             over the GlitchBackground, which otherwise shows through and takes
             the light "Near term" under 4.5:1. The card chips have the card. */
          <div className="flex flex-wrap items-center gap-2" aria-hidden="true">
            {(Object.keys(HORIZONS) as Horizon[]).map((h) => (
              <span
                key={h}
                className="rounded-full border bg-hl-panel px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest"
                style={{
                  color: HORIZONS[h].color,
                  borderColor: `color-mix(in oklab, ${HORIZONS[h].color} 50%, transparent)`,
                  backgroundImage: `linear-gradient(color-mix(in oklab, ${HORIZONS[h].color} 10%, transparent) 0 0)`,
                }}
              >
                {HORIZONS[h].chip}
              </span>
            ))}
          </div>
        )}
      </div>

      {journey ? (
        /* ── the journey: oldest first, ends at today ── */
        <ol className="relative flex flex-col gap-4 border-l border-dashed border-hl-strap-hi/40 pl-6">
          {JOURNEY.map((m) => (
            <li key={m.title} className="relative">
              <span
                aria-hidden="true"
                className="absolute -left-[31px] top-6 size-2.5 rounded-full bg-hl-strap-hi"
                style={{ boxShadow: glow('var(--hl-strap-hi)') }}
              />
              <TimelineCard icon={m.icon} color={STRAP_INK} chip={m.date} title={m.title}>
                {m.body}{' '}
                {m.tweet ? (
                  journeyTweetUrl ? (
                    <a
                      href={journeyTweetUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold text-[color-mix(in_srgb,var(--hl-strap-hi)_72%,var(--hl-fg))] underline decoration-dotted underline-offset-2 hover:text-hl-fg"
                    >
                      Watch the first demo →
                    </a>
                  ) : (
                    <span className="italic text-hl-dim">
                      (first-demo tweet link coming soon)
                    </span>
                  )
                ) : null}
                {m.tags ? (
                  <span className="mt-2.5 flex flex-wrap gap-1.5">
                    {m.tags.map((k) => <FeatureTag key={k} kind={k} />)}
                  </span>
                ) : null}
              </TimelineCard>
            </li>
          ))}
          <li className="relative">
            {/* Today is on air: the record light, not a horizon colour. */}
            <span
              aria-hidden="true"
              className="absolute -left-[31px] top-2 size-2.5 rounded-full bg-hl-record"
              style={{ boxShadow: glow('var(--hl-record)') }}
            />
            <p className="pt-0.5 text-sm font-semibold text-f-holler-ink">
              Today — everything above is live. Flip back for what’s next.
            </p>
          </li>
        </ol>
      ) : (
        /* ── forward: priority order, horizon-colored ── */
        <ol className="relative flex flex-col gap-4 border-l border-hl-line-2 pl-6">
          {FORWARD.map((item) => (
            <li key={item.title} className="relative" data-horizon={item.horizon}>
              <span
                aria-hidden="true"
                className="absolute -left-[31px] top-6 size-2.5 rounded-full"
                style={{
                  background: HORIZONS[item.horizon].hue,
                  boxShadow: glow(HORIZONS[item.horizon].hue),
                }}
              />
              <TimelineCard
                icon={item.icon}
                color={HORIZONS[item.horizon].color}
                chip={HORIZONS[item.horizon].chip}
                title={item.title}
              >
                {item.body}
              </TimelineCard>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
