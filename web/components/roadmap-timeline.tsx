'use client'

// The roadmap as one vertical timeline, two directions:
//  - FORWARD (default): what's next, priority-ordered top to bottom,
//    color-coded by horizon — green near / amber mid / purple ambitious.
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

type Horizon = 'near' | 'mid' | 'far'

const HORIZONS: Record<Horizon, { color: string; chip: string }> = {
  near: { color: 'var(--neon-lime)', chip: 'Near term' },
  mid: { color: 'var(--neon-amber)', chip: 'Mid term' },
  far: { color: 'var(--neon-violet)', chip: 'Ambitious' },
}

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
    body: 'MegaChats already get frames-plus-transcript review before they play. v3 points the same pipeline at live seats, sampling in near-real-time so a room can run hands-off.',
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
    title: 'OAuth identity + /r/ handles',
    body: 'Twitch and X sign-in reserves your handle as a display name and a permanent /r/ room link.',
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
  return (
    <div className="flex gap-4 rounded-2xl border border-border/70 bg-card/60 p-5 backdrop-blur-sm transition-all hover:-translate-y-0.5">
      <span
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border"
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
          <h3 className="font-heading text-base font-bold text-foreground">{title}</h3>
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
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{children}</p>
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
          className="flex items-center gap-2 rounded-full border border-border bg-input/30 px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-input/50"
        >
          {journey ? (
            <>
              Back to the roadmap
              <ArrowRight className="size-4 text-[var(--neon-lime)]" />
            </>
          ) : (
            <>
              <ArrowLeft className="size-4 text-[var(--neon-cyan)]" />
              Our journey — how we got here
            </>
          )}
        </button>

        {journey ? null : (
          <div className="flex flex-wrap items-center gap-2" aria-hidden="true">
            {(Object.keys(HORIZONS) as Horizon[]).map((h) => (
              <span
                key={h}
                className="rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest"
                style={{
                  color: HORIZONS[h].color,
                  borderColor: `color-mix(in oklab, ${HORIZONS[h].color} 50%, transparent)`,
                  background: `color-mix(in oklab, ${HORIZONS[h].color} 10%, transparent)`,
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
        <ol className="relative flex flex-col gap-4 border-l border-dashed border-[var(--neon-cyan)]/35 pl-6">
          {JOURNEY.map((m) => (
            <li key={m.title} className="relative">
              <span
                aria-hidden="true"
                className="absolute -left-[31px] top-6 size-2.5 rounded-full bg-[var(--neon-cyan)] shadow-[0_0_10px_var(--neon-cyan)]"
              />
              <TimelineCard icon={m.icon} color="var(--neon-cyan)" chip={m.date} title={m.title}>
                {m.body}{' '}
                {m.tweet ? (
                  journeyTweetUrl ? (
                    <a
                      href={journeyTweetUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold text-[var(--neon-cyan)] underline decoration-dotted underline-offset-2 hover:text-foreground"
                    >
                      Watch the first demo →
                    </a>
                  ) : (
                    <span className="italic text-muted-foreground/70">
                      (first-demo tweet link coming soon)
                    </span>
                  )
                ) : null}
              </TimelineCard>
            </li>
          ))}
          <li className="relative">
            <span
              aria-hidden="true"
              className="absolute -left-[31px] top-2 size-2.5 rounded-full bg-[var(--neon-lime)] shadow-[0_0_10px_var(--neon-lime)]"
            />
            <p className="pt-0.5 text-sm font-semibold text-[var(--neon-lime)]">
              Today — everything above is live. Flip back for what’s next.
            </p>
          </li>
        </ol>
      ) : (
        /* ── forward: priority order, horizon-colored ── */
        <ol className="relative flex flex-col gap-4 border-l border-border/70 pl-6">
          {FORWARD.map((item) => (
            <li key={item.title} className="relative" data-horizon={item.horizon}>
              <span
                aria-hidden="true"
                className="absolute -left-[31px] top-6 size-2.5 rounded-full"
                style={{
                  background: HORIZONS[item.horizon].color,
                  boxShadow: `0 0 10px ${HORIZONS[item.horizon].color}`,
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
