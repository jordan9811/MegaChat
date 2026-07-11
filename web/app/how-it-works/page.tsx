import type { Metadata } from 'next'
import {
  Compass,
  KeyRound,
  Fingerprint,
  Camera,
  Radio,
  LogOut,
  LayoutDashboard,
  SlidersHorizontal,
  MonitorPlay,
  Share2,
  Users,
  Sparkles,
  Wallet,
  RefreshCcw,
  Zap,
} from 'lucide-react'
import { SiteHeader } from '@/components/site-header'
import { GlitchBackground } from '@/components/glitch-background'
import { SiteFooter, contactUrl } from '@/components/site-footer'

export const metadata: Metadata = {
  title: 'How it works — MegaChat',
  description:
    'Viewers pay per-second in USDC to put their camera on a live broadcast. How the join flow works, how streamers set up rooms, and every question answered.',
}

// Trust stats moved off the landing hero — they summarize the rails below.
const STATS = [
  { value: 'Per-second', label: 'USDC settlement' },
  { value: 'One tap', label: 'Passkey to live' },
  { value: '0 risk', label: 'Unused balance refunds' },
  { value: 'On-chain', label: 'Arc network' },
]

const VIEWER_STEPS = [
  {
    icon: Compass,
    title: 'Find a room',
    body: 'Browse live rooms on the home page — hottest first — or open the join link a streamer shared. Each card shows the per-second price before you commit to anything.',
  },
  {
    icon: Fingerprint,
    title: 'One tap, no seed phrase',
    body: 'Pick a username and create a passkey. That single tap spins up a smart account for you on Arc — no wallet install, no extension, no 12 words. Already have one? Sign back in with the same passkey.',
  },
  {
    icon: KeyRound,
    title: 'Authorize your session',
    body: 'One prompt approves a hard session cap in USDC (the room sets it — think 2 USDC max). That is the most a session can ever cost you. Billing is per-second from there, silently.',
  },
  {
    icon: Camera,
    title: 'Camera check',
    body: 'Your camera preview appears on the join page — nothing is broadcast yet. When the feed looks right, the button flips to GO LIVE. You pull the trigger, not us.',
  },
  {
    icon: Radio,
    title: 'You are the stream',
    body: 'Your face pops onto the broadcast with your entrance stinger, name chip and all. The meter runs per-second only while you are actually live.',
  },
  {
    icon: LogOut,
    title: 'Leave whenever',
    body: 'Hit Leave — or just close the tab. The meter stops instantly and every unspent cent stays yours: passkey sessions keep it in your smart account, Gateway sessions refund automatically.',
  },
]

const STREAMER_STEPS = [
  {
    icon: LayoutDashboard,
    title: 'Create your room',
    body: 'Open the Dashboard, name your room, set a password. That password is your admin key — unlock the room from any device to manage it.',
  },
  {
    icon: SlidersHorizontal,
    title: 'Price your seats',
    body: 'Set the per-second rate, the session cap, and how many camera seats run at once (up to 3). Default is 0.001 USDC per second — tune it to your audience. You can also list the room in the public directory or keep it unlisted.',
  },
  {
    icon: MonitorPlay,
    title: 'Drop the overlay into OBS',
    body: 'Copy your overlay URL into an OBS browser source. Paid camera tiles stack in the corner over your gameplay — transparent, broadcast-clean, stingers included.',
  },
  {
    icon: Share2,
    title: 'Share the join link',
    body: 'Post your join link in chat, your bio, wherever. Viewers land on the join page, pay, and appear on your stream — you never touch their money or their camera.',
  },
  {
    icon: Users,
    title: 'Run the room live',
    body: 'The dashboard shows everyone on camera, what they have spent, and how long they have been on. Kick anyone instantly (their unused balance goes back). Pin a friend as co-host and their seat rides free — the meter pauses while pinned.',
  },
  {
    icon: Sparkles,
    title: 'Optional: watch-to-earn drops',
    body: 'Flip on rewards and viewers earn USDC toward their first seat just by watching. Fund the pool, set the drip rate and cap — it feeds joins, not chat.',
  },
]

const RAILS = [
  {
    icon: Fingerprint,
    title: 'Passkey smart accounts',
    body: 'Circle Modular Wallets turn a device passkey into a smart account on Arc Testnet. Your face, your key — nothing to install or back up.',
  },
  {
    icon: Zap,
    title: 'True per-second settlement',
    body: 'While you are live, the seat pulls the tick price on-chain every second against your one-time authorization. No lump sums, no subscriptions.',
  },
  {
    icon: RefreshCcw,
    title: 'Unused money is your money',
    body: 'The session cap is a ceiling, not a price. Leave early and the unspent balance never leaves your account — Gateway prepays refund on exit.',
  },
  {
    icon: Wallet,
    title: 'Prefer MetaMask?',
    body: 'A secondary path deposits USDC into Circle Gateway and prepays a block (default 0.1 USDC per 10s) with an EIP-3009 signature. Same seat, same refund guarantee.',
  },
]

const FAQ = [
  {
    q: 'Do I need a crypto wallet?',
    a: 'No. Creating a passkey spins up a smart account for you — one tap on the join page, no extension, no seed phrase. MetaMask is supported as an optional secondary path.',
  },
  {
    q: 'How much does it cost to be on stream?',
    a: 'Whatever the room charges — the price is on the room card before you join (default 0.001 USDC per second, capped at 2 USDC per session). You authorize the cap once; the meter only bills seconds you are actually live.',
  },
  {
    q: 'What happens if I close the tab?',
    a: 'Your seat ends and the meter stops. Unspent USDC stays in your smart account; Gateway prepays are refunded automatically. A brief network blip won’t kill your seat — you get a grace window to reconnect.',
  },
  {
    q: 'Is this real money?',
    a: 'MegaChat currently runs on Arc Testnet USDC. Grab free test USDC at faucet.circle.com (select Arc Testnet) and try everything end to end.',
  },
  {
    q: 'Can the streamer remove me?',
    a: 'Yes — streamers can kick any seat instantly from the dashboard. Your unused balance is returned, same as leaving on your own.',
  },
  {
    q: 'What’s a stinger?',
    a: 'Your entrance and exit animation on the broadcast — lightning strike, breaking-news slam, CRT power-off and more. Pick yours under “Advanced” on the join page before you go live.',
  },
  {
    q: 'How many viewers can be on camera at once?',
    a: 'Up to the room’s seat count (max 3 paid seats), plus a pinned co-host who rides free on top.',
  },
]

function SectionHeading({
  kicker,
  title,
  accent = 'lime',
}: {
  kicker: string
  title: string
  accent?: 'lime' | 'magenta' | 'cyan'
}) {
  const accentVar =
    accent === 'lime'
      ? 'var(--neon-lime)'
      : accent === 'cyan'
        ? 'var(--neon-cyan)'
        : 'var(--neon-magenta)'
  return (
    <div className="mb-8 flex flex-col gap-1">
      <span
        className="text-xs font-bold uppercase tracking-widest"
        style={{ color: accentVar }}
      >
        {kicker}
      </span>
      <h2 className="font-heading text-3xl font-bold text-foreground md:text-4xl">{title}</h2>
    </div>
  )
}

function StepGrid({
  steps,
}: {
  steps: { icon: React.ComponentType<{ className?: string }>; title: string; body: string }[]
}) {
  return (
    <ol className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {steps.map((s, i) => (
        <li
          key={s.title}
          className="reveal group relative flex flex-col gap-3 rounded-2xl border border-border/70 bg-card/60 p-5 backdrop-blur-sm transition-all hover:-translate-y-0.5 hover:border-[var(--neon-magenta)]/50 hover:shadow-[0_0_24px_oklch(0.68_0.27_340/0.2)]"
          style={{ ['--reveal-delay' as string]: `${0.08 + i * 0.06}s` }}
        >
          <div className="flex items-center justify-between">
            <span className="inline-flex size-9 items-center justify-center rounded-lg border border-[var(--neon-magenta)]/40 bg-[var(--neon-magenta)]/10 text-[var(--neon-magenta)]">
              <s.icon className="size-4.5" />
            </span>
            <span className="font-heading text-2xl font-bold text-foreground/15 transition-colors group-hover:text-[var(--neon-lime)]/60">
              {String(i + 1).padStart(2, '0')}
            </span>
          </div>
          <h3 className="font-heading text-lg font-bold leading-snug text-foreground">
            {s.title}
          </h3>
          <p className="text-sm leading-relaxed text-muted-foreground">{s.body}</p>
        </li>
      ))}
    </ol>
  )
}

export default function HowItWorksPage() {
  const contactHref = contactUrl()
  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <SiteHeader />
      <div className="relative">
        <GlitchBackground />

        <main className="relative z-10">
          {/* Intro — the product, in the words the landing hero used to carry */}
          <section className="mx-auto max-w-6xl px-6 pb-14 pt-16 md:pt-20">
            <p
              className="reveal text-xs font-bold uppercase tracking-widest text-[var(--neon-lime)]"
              style={{ ['--reveal-delay' as string]: '0.05s' }}
            >
              The playbook
            </p>
            <h1
              className="reveal chromatic mt-2 max-w-3xl font-heading text-4xl font-bold leading-tight text-foreground md:text-6xl"
              style={{ ['--reveal-delay' as string]: '0.12s' }}
            >
              How MegaChat works
            </h1>
            <p
              className="reveal mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-foreground/85"
              style={{ ['--reveal-delay' as string]: '0.2s' }}
            >
              Viewers pay per-second in USDC to put their camera on your live
              broadcast. You keep the mic, they get the moment — a face on
              stream beats a wall of chat every time.
            </p>
            {/* trust strip — relocated from the landing hero */}
            <dl
              className="reveal mt-9 grid grid-cols-2 gap-y-4 divide-border/40 rounded-2xl border border-border/60 bg-card/40 px-6 py-5 backdrop-blur-sm sm:grid-cols-4 sm:divide-x"
              style={{ ['--reveal-delay' as string]: '0.28s' }}
            >
              {STATS.map((s) => (
                <div key={s.label} className="flex flex-col gap-0.5 px-2 first:pl-0 sm:px-4">
                  <dt className="tabular font-heading text-xl font-bold text-foreground">
                    {s.value}
                  </dt>
                  <dd className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {s.label}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {/* Viewers */}
          <section className="mx-auto max-w-6xl px-6 py-12 md:py-16">
            <SectionHeading kicker="For viewers" title="Grab a seat in six steps" accent="magenta" />
            <StepGrid steps={VIEWER_STEPS} />
          </section>

          {/* Streamers */}
          <section className="border-y border-border/50 bg-background/40 backdrop-blur-sm">
            <div className="mx-auto max-w-6xl px-6 py-12 md:py-16">
              <SectionHeading kicker="For streamers" title="Set up a room in minutes" accent="cyan" />
              <StepGrid steps={STREAMER_STEPS} />
            </div>
          </section>

          {/* Latency architecture — the settled design, in plain words. */}
          <section className="border-t border-border/50">
            <div className="mx-auto max-w-6xl px-6 py-12 md:py-16">
              <SectionHeading kicker="The clock" title="Why you're never actually late" accent="cyan" />
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
                <div className="reveal rounded-2xl border border-border/70 bg-card/60 p-5 backdrop-blur-sm">
                  <h3 className="font-heading text-base font-bold text-foreground">👀 Spectating is delayed</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    The broadcast you watch runs ~15 seconds behind reality —
                    every big platform buffers like that, for every viewer.
                    That&apos;s normal and nothing here changes it.
                  </p>
                </div>
                <div
                  className="reveal rounded-2xl border border-[var(--neon-lime)]/40 bg-card/60 p-5 backdrop-blur-sm"
                  style={{ ['--reveal-delay' as string]: '0.08s' }}
                >
                  <h3 className="font-heading text-base font-bold text-foreground">🎬 Going live is instant</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    Your camera doesn&apos;t ride the broadcast — it rides
                    MegaChat&apos;s own connection, straight to the streamer,
                    in well under a second. You two talk in real time; the
                    broadcast relays your moment to everyone else at its usual
                    delay.
                  </p>
                </div>
                <div
                  className="reveal rounded-2xl border border-border/70 bg-card/60 p-5 backdrop-blur-sm"
                  style={{ ['--reveal-delay' as string]: '0.16s' }}
                >
                  <h3 className="font-heading text-base font-bold text-foreground">✉ Letters skip the clock</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    A letter is recorded, so delay can&apos;t touch it. Record
                    your take, send it, and watch it pop onto the stream like
                    everyone else does.
                  </p>
                </div>
              </div>

              {/* One-glance diagram: the two pipes and their clocks. */}
              <div className="reveal mt-8 overflow-x-auto" style={{ ['--reveal-delay' as string]: '0.2s' }}>
                <svg
                  viewBox="0 0 720 150"
                  role="img"
                  aria-label="Diagram: your camera reaches the streamer in under a second over MegaChat's pipe; the public broadcast reaches all spectators about fifteen seconds later"
                  className="mx-auto block min-w-[560px] max-w-3xl"
                >
                  <defs>
                    <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                      <path d="M0 0 L8 4 L0 8 z" fill="currentColor" />
                    </marker>
                  </defs>
                  <g fontFamily="var(--font-space-grotesk), sans-serif" fontSize="13">
                    <rect x="8" y="52" width="120" height="44" rx="10" fill="none" stroke="var(--neon-magenta)" />
                    <text x="68" y="78" textAnchor="middle" fill="currentColor" fontWeight="700">YOU</text>
                    <rect x="300" y="52" width="130" height="44" rx="10" fill="none" stroke="var(--neon-cyan)" />
                    <text x="365" y="78" textAnchor="middle" fill="currentColor" fontWeight="700">STREAMER</text>
                    <rect x="590" y="52" width="122" height="44" rx="10" fill="none" stroke="var(--border)" />
                    <text x="651" y="78" textAnchor="middle" fill="currentColor" fontWeight="700">EVERYONE</text>
                    <g color="var(--neon-lime)">
                      <line x1="132" y1="66" x2="292" y2="66" stroke="currentColor" strokeWidth="2" markerEnd="url(#arr)" />
                    </g>
                    <text x="212" y="52" textAnchor="middle" fill="var(--neon-lime)" fontWeight="700">MegaChat pipe · &lt;1s</text>
                    <g color="var(--muted-foreground)">
                      <line x1="434" y1="82" x2="582" y2="82" stroke="currentColor" strokeWidth="2" strokeDasharray="6 5" markerEnd="url(#arr)" />
                    </g>
                    <text x="508" y="112" textAnchor="middle" fill="var(--muted-foreground)">broadcast · ~15s</text>
                  </g>
                </svg>
              </div>
            </div>
          </section>

          {/* Rails */}
          <section className="mx-auto max-w-6xl px-6 py-12 md:py-16">
            <SectionHeading kicker="Under the hood" title="The rails it runs on" accent="lime" />
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              {RAILS.map((r, i) => (
                <div
                  key={r.title}
                  className="reveal flex gap-4 rounded-2xl border border-border/70 bg-card/60 p-5 backdrop-blur-sm"
                  style={{ ['--reveal-delay' as string]: `${0.08 + i * 0.06}s` }}
                >
                  <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-[var(--neon-cyan)]/40 bg-[var(--neon-cyan)]/10 text-[var(--neon-cyan)]">
                    <r.icon className="size-4.5" />
                  </span>
                  <div>
                    <h3 className="font-heading text-base font-bold text-foreground">{r.title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{r.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* FAQ — merged here on purpose; the nav's FAQ link anchors to it */}
          <section id="faq" className="scroll-mt-24 border-t border-border/50">
            <div className="mx-auto max-w-3xl px-6 py-12 md:py-16">
              <SectionHeading kicker="Questions" title="FAQ" accent="magenta" />
              <div className="flex flex-col gap-3">
                {FAQ.map((f) => (
                  <details
                    key={f.q}
                    className="group rounded-xl border border-border/70 bg-card/60 backdrop-blur-sm transition-colors open:border-[var(--neon-magenta)]/50"
                  >
                    <summary className="flex cursor-pointer select-none items-center justify-between gap-4 px-5 py-4 font-heading text-base font-bold text-foreground [&::-webkit-details-marker]:hidden">
                      {f.q}
                      <span
                        aria-hidden="true"
                        className="text-[var(--neon-lime)] transition-transform group-open:rotate-45"
                      >
                        +
                      </span>
                    </summary>
                    <p className="px-5 pb-4 text-sm leading-relaxed text-muted-foreground">
                      {f.a}
                    </p>
                  </details>
                ))}
              </div>
            </div>
          </section>

          {/* CTA band */}
          <section className="border-t border-border/50">
            <div className="mx-auto flex max-w-6xl flex-col items-start gap-5 px-6 py-12 sm:flex-row sm:items-center sm:justify-between md:py-14">
              <p className="font-heading text-2xl font-bold italic text-foreground md:text-3xl">
                Put your face{' '}
                <span className="text-[var(--neon-magenta)]">on the stream.</span>
              </p>
              <div className="flex flex-wrap gap-3">
                <a
                  href="/#browse"
                  className="glow-magenta rounded-full bg-primary px-6 py-3 text-sm font-bold uppercase tracking-wide text-primary-foreground transition-transform hover:scale-[1.03]"
                >
                  Browse rooms
                </a>
                <a
                  href="/dashboard"
                  className="rounded-full border border-[var(--neon-lime)]/60 bg-[var(--neon-lime)]/10 px-6 py-3 text-sm font-bold uppercase tracking-wide text-[var(--neon-lime)] transition-transform hover:scale-[1.03]"
                >
                  Start a room
                </a>
              </div>
            </div>
          </section>
        </main>
      </div>
      <SiteFooter contactHref={contactHref} />
    </div>
  )
}
