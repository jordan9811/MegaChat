import type { Metadata } from 'next'
import {
  Radio,
  Fingerprint,
  Compass,
  Sparkles,
  Pin,
  Gift,
  Timer,
  BadgeCheck,
  UserCheck,
  Link2,
  Bookmark,
  ShieldBan,
  Store,
  MonitorPlay,
} from 'lucide-react'
import { SiteHeader } from '@/components/site-header'
import { GlitchBackground } from '@/components/glitch-background'
import { SiteFooter, contactUrl } from '@/components/site-footer'

export const metadata: Metadata = {
  title: 'Roadmap — MegaChat',
  description:
    'What is live, what is next: join gating, Twitch/Kick integrations, persistent rooms, sybil-resistant bans, and the stinger marketplace.',
}

type Item = {
  icon: React.ComponentType<{ className?: string }>
  title: string
  body: string
}

// Product spine: pay-to-join metered camera seats. Everything below extends
// that core without changing the default join flow until shipped (ROADMAP.md).
const LANES: {
  id: string
  label: string
  blurb: string
  chip: string
  color: string
  items: Item[]
}[] = [
  {
    id: 'live',
    label: 'Live today',
    blurb: 'Shipped and running on every room right now.',
    chip: 'SHIPPED',
    color: 'var(--neon-lime)',
    items: [
      {
        icon: Radio,
        title: 'Per-second metered camera seats',
        body: 'The core loop: viewers authorize a session cap and pay per-second in USDC only while their camera is live on the broadcast.',
      },
      {
        icon: Fingerprint,
        title: 'Passkey smart accounts',
        body: 'One-tap onboarding — a device passkey becomes a smart account on Arc. MetaMask + Circle Gateway prepay as the alternative rail.',
      },
      {
        icon: Compass,
        title: 'Public browse directory',
        body: 'Live rooms ranked hottest-first on the home page, with search and direct room-ID lookup for unlisted rooms.',
      },
      {
        icon: Sparkles,
        title: 'Stinger catalogue',
        body: 'Five entrance and four exit transitions — storm strike, breaking-news slam, CRT power-off and friends — picked by the viewer at join time.',
      },
      {
        icon: Pin,
        title: 'Co-host pinning',
        body: 'Pin a guest from the dashboard and their seat rides free: meter paused, no seat slot consumed, CO-HOST badge on the overlay.',
      },
      {
        icon: Gift,
        title: 'Watch-to-earn drops (per room)',
        body: 'Optional rewards module: viewers earn USDC toward their first camera seat just by keeping the stream open.',
      },
    ],
  },
  {
    id: 'next',
    label: 'Next up',
    blurb: 'Designed, stubbed in the dashboard, or actively being built.',
    chip: 'IN DESIGN',
    color: 'var(--neon-cyan)',
    items: [
      {
        icon: Timer,
        title: 'Join gating — min watch time',
        body: 'Require N seconds of focused watching before a viewer can request a seat. Kills drive-by joins and bot spam.',
      },
      {
        icon: BadgeCheck,
        title: 'Join gating — subscribers & followers only',
        body: 'Restrict seats to platform subscribers or followers of the linked channel, once Twitch/Kick OAuth lands.',
      },
      {
        icon: UserCheck,
        title: 'Join gating — reputation score',
        body: 'A minimum on-chain or in-app reputation before joining, composable with the other gates.',
      },
      {
        icon: Link2,
        title: 'Twitch / Kick channel linking',
        body: 'OAuth linkage per room — the identity layer that powers subscriber gates, follower gates and future discovery.',
      },
      {
        icon: Bookmark,
        title: 'Persistent room names',
        body: 'Human-readable reserved slugs that survive restarts and can be re-claimed by the owning wallet — no more random hex IDs.',
      },
    ],
  },
  {
    id: 'later',
    label: 'On the horizon',
    blurb: 'Bigger swings that build on the identity + rooms layers.',
    chip: 'PLANNED',
    color: 'var(--neon-magenta)',
    items: [
      {
        icon: MonitorPlay,
        title: 'Twitch Drops watch credit',
        body: 'Real Twitch/Kick OAuth drops: external watch time earns join balance, so your existing audience arrives with a seat already funded.',
      },
      {
        icon: ShieldBan,
        title: 'Sybil-resistant bans',
        body: 'Bans keyed on wallet + linked platform identity — a kicked troll can’t just rejoin with a fresh burner wallet.',
      },
      {
        icon: Store,
        title: 'Stinger marketplace',
        body: 'Creators publish and sell custom entrance/exit stingers; streamers equip them per room. Cosmetics as an economy.',
      },
    ],
  },
]

export default function RoadmapPage() {
  const contactHref = contactUrl()
  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <SiteHeader />
      <div className="relative">
        <GlitchBackground />

        <main className="relative z-10 mx-auto max-w-4xl px-6 pb-16 pt-16 md:pt-20">
          <p
            className="reveal text-xs font-bold uppercase tracking-widest text-[var(--neon-lime)]"
            style={{ ['--reveal-delay' as string]: '0.05s' }}
          >
            Where this is going
          </p>
          <h1
            className="reveal chromatic mt-2 font-heading text-4xl font-bold leading-tight text-foreground md:text-6xl"
            style={{ ['--reveal-delay' as string]: '0.12s' }}
          >
            Roadmap
          </h1>
          <p
            className="reveal mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-foreground/85"
            style={{ ['--reveal-delay' as string]: '0.2s' }}
          >
            The spine stays the same — pay-to-join metered camera seats.
            Everything here extends that core without touching the default join
            flow until it ships.
          </p>

          <div className="mt-12 flex flex-col gap-12">
            {LANES.map((lane, laneIdx) => (
              <section key={lane.id} aria-labelledby={`lane-${lane.id}`}>
                <div
                  className="reveal mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-1"
                  style={{ ['--reveal-delay' as string]: `${0.1 + laneIdx * 0.08}s` }}
                >
                  <span
                    className="rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest"
                    style={{
                      color: lane.color,
                      borderColor: `color-mix(in oklab, ${lane.color} 50%, transparent)`,
                      background: `color-mix(in oklab, ${lane.color} 10%, transparent)`,
                    }}
                  >
                    {lane.chip}
                  </span>
                  <h2
                    id={`lane-${lane.id}`}
                    className="font-heading text-2xl font-bold text-foreground md:text-3xl"
                  >
                    {lane.label}
                  </h2>
                  <p className="w-full text-sm text-muted-foreground sm:w-auto">{lane.blurb}</p>
                </div>

                {/* neon timeline rail */}
                <ol
                  className="relative flex flex-col gap-4 border-l pl-6"
                  style={{
                    borderColor: `color-mix(in oklab, ${lane.color} 35%, transparent)`,
                  }}
                >
                  {lane.items.map((item, i) => (
                    <li
                      key={item.title}
                      className="reveal relative rounded-2xl border border-border/70 bg-card/60 p-5 backdrop-blur-sm transition-all hover:-translate-y-0.5"
                      style={{
                        ['--reveal-delay' as string]: `${0.14 + laneIdx * 0.08 + i * 0.05}s`,
                      }}
                    >
                      {/* node on the rail */}
                      <span
                        aria-hidden="true"
                        className="absolute -left-[31px] top-6 size-2.5 rounded-full"
                        style={{
                          background: lane.color,
                          boxShadow: `0 0 10px ${lane.color}`,
                        }}
                      />
                      <div className="flex gap-4">
                        <span
                          className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border"
                          style={{
                            color: lane.color,
                            borderColor: `color-mix(in oklab, ${lane.color} 40%, transparent)`,
                            background: `color-mix(in oklab, ${lane.color} 10%, transparent)`,
                          }}
                        >
                          <item.icon className="size-4.5" />
                        </span>
                        <div>
                          <h3 className="font-heading text-base font-bold text-foreground">
                            {item.title}
                          </h3>
                          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                            {item.body}
                          </p>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>

          {/* CTA */}
          <div className="mt-14 flex flex-wrap items-center gap-4 border-t border-border/50 pt-8">
            <p className="font-heading text-lg font-bold text-foreground">
              Want something bumped up the list?
            </p>
            <a
              href={contactHref}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full border border-[var(--neon-cyan)]/60 bg-[var(--neon-cyan)]/10 px-5 py-2.5 text-sm font-bold uppercase tracking-wide text-[var(--neon-cyan)] transition-transform hover:scale-[1.03]"
            >
              Tell us on X
            </a>
          </div>
        </main>
      </div>
      <SiteFooter contactHref={contactHref} />
    </div>
  )
}
