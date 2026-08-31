import type { Metadata } from 'next'
import { Plus_Jakarta_Sans } from 'next/font/google'
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
import { AccountChip } from '@/components/account-chip'
import { contactUrl } from '@/components/site-footer'
import './how-it-works.css'

export const metadata: Metadata = {
  title: 'How it works — MegaChat',
  description:
    'Viewers pay per-second in USDC to put their camera on a live broadcast. How the join flow works, how streamers set up rooms, and every question answered.',
}

// One UI face across the app, loaded per route — there is no site-wide
// provider. Same call as the room board's page.
const ui = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-ui',
})

// Spec strip — the rails below, in four numbers.
const STATS = [
  { value: 'Per-second', label: 'USDC settlement', simpleLabel: 'billing, to the second' },
  { value: 'One tap', label: 'Passkey to live', simpleLabel: 'sign-in to live' },
  { value: '0 risk', label: 'Unused balance refunds', simpleLabel: 'unused credits stay yours' },
  { value: 'On-chain', label: 'Tempo network', simpleLabel: 'always verifiable' },
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
    body: 'Sign in with email, a passkey, or your socials — that single tap spins up an embedded wallet for you on Tempo. No extension, no 12 words. Coming back? Sign in the same way.',
    simpleBody:
      'Sign in with email, a passkey, or your socials — your account is ready instantly. Coming back? Sign in the same way.',
  },
  {
    icon: KeyRound,
    title: 'Authorize your session',
    body: 'One prompt approves a hard session cap in USDC (the room sets it — think 2 USDC max). That is the most a session can ever cost you. Billing is per-second from there, silently.',
    simpleBody:
      'One prompt approves a hard session cap in credits — the room sets it. That is the most a session can ever cost you. Billing is one credit per second from there, silently.',
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
    body: 'Hit Leave — or just close the tab. The meter stops instantly and every unspent cent refunds straight back to your wallet.',
    simpleBody:
      'Hit Leave — or just close the tab. The meter stops instantly and unused credits go straight back to your balance.',
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
    simpleBody:
      'Set the price per credit, the session cap, and how many camera seats run at once (up to 3). Tune it to your audience — and list the room in the public directory or keep it unlisted.',
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
    simpleBody:
      'Flip on rewards and viewers earn credit toward their first seat just by watching. Fund the pool, set the drip rate and cap — it feeds joins, not chat.',
  },
]

// The three clocks, in plain words. Card two is the claim that matters, so it
// carries the accent rail.
const CLOCK = [
  {
    title: 'Spectating is delayed',
    body: 'The broadcast you watch runs a touch behind reality — every big platform buffers like that, for every viewer. Nothing here changes it.',
  },
  {
    title: 'Going live is instant',
    lead: true,
    body: 'Your camera doesn’t ride the broadcast — it rides MegaChat’s own connection, straight to the streamer, in well under a second. You two talk in real time; the broadcast relays your moment to everyone else at its usual delay.',
  },
  {
    title: 'MegaChats skip the clock',
    body: 'A MegaChat is recorded, so delay can’t touch it. Record your take, send it, and watch it pop onto the stream like everyone else does.',
  },
]

const RAILS = [
  {
    icon: Fingerprint,
    title: 'One-tap accounts',
    body: 'Email, passkey, or socials spin up an embedded wallet on Tempo — nothing to install or back up.',
    simpleBody: 'Sign in with email, a passkey, or your socials — your account and balance are ready instantly.',
  },
  {
    icon: Zap,
    title: 'True per-second settlement',
    body: 'Live seats bill through TIP-1034 payment channels: one on-chain escrow, then signed off-chain vouchers every second. No lump sums, no subscriptions.',
    simpleBody: 'You are billed one credit per second you are actually on camera — never a lump sum, never a subscription.',
  },
  {
    icon: RefreshCcw,
    title: 'Unused money is your money',
    body: 'The session cap is a ceiling, not a price. Leave early and the unspent escrow refunds straight back to your wallet on close.',
    simpleBody: 'The cap is a ceiling, not a price. Leave early and unused credits go straight back to your balance.',
  },
  {
    icon: Wallet,
    title: 'Prefer MetaMask?',
    body: 'A secondary path meters through a one-time allowance on Tempo. Same seat, same refund guarantee.',
    simpleBody: 'Power users can bring their own wallet — same seats, same refunds.',
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

function SectionHeading({ label, title }: { label: string; title: string }) {
  return (
    <div className="mb-5 flex flex-col gap-1">
      <span className="lbl">{label}</span>
      <h2 className="text-[22px] font-[800] md:text-[26px]">{title}</h2>
    </div>
  )
}

type Step = {
  icon: React.ComponentType<{ className?: string }>
  title: string
  body: string
  simpleBody?: string
}

// The landing's ledger: numbered rows on hairlines, accent numerals, no cards.
// The number carries the sequence the old scoreboard spine used to.
function Ledger({ steps }: { steps: Step[] }) {
  return (
    <ol className="flex flex-col">
      {steps.map((s, i) => (
        <li
          key={s.title}
          className="grid grid-cols-[34px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5 border-t border-[var(--mcc-rule)] py-5 last:border-b md:grid-cols-[64px_minmax(0,1fr)_minmax(0,1.5fr)] md:gap-x-7"
        >
          <span className="num">{String(i + 1).padStart(2, '0')}</span>
          <h3 className="inline-flex items-center gap-2 text-[16px] font-[700] leading-snug">
            <s.icon className="size-4 shrink-0 text-[var(--mcc-dim)]" />
            {s.title}
          </h3>
          <p className="col-span-2 text-[14.5px] leading-relaxed text-[var(--mcc-muted)] md:col-span-1">
            {s.simpleBody ? (
              <>
                <span className="adv-only">{s.body}</span>
                <span className="simple-only">{s.simpleBody}</span>
              </>
            ) : (
              s.body
            )}
          </p>
        </li>
      ))}
    </ol>
  )
}

export default function HowItWorksPage() {
  const contactHref = contactUrl()
  return (
    <div className={`mc-how dark min-h-screen ${ui.variable}`}>
      {/* the only chrome: one thin bar, same as the room board */}
      <header className="border-b border-[#1a1a1f]">
        <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center justify-between gap-3 px-5 py-3">
          <span className="flex flex-wrap items-baseline gap-3.5">
            <a href="/app" className="bc text-[18px] font-bold tracking-[0.1em] text-[var(--mcc-fg)]">
              MEGACHAT
            </a>
            <span className="text-[13px] font-semibold text-[var(--mcc-dim)]">How it works</span>
          </span>
          <AccountChip accent="var(--mcc-accent)" />
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-[1100px] px-5 pb-10 pt-12 md:pt-16">
          <p className="lbl">The playbook</p>
          <h1 className="mt-2 max-w-[20ch] text-[34px] font-[800] leading-[1.06] md:text-[50px]">
            How MegaChat works
          </h1>
          <p className="mt-4 max-w-[64ch] text-[16px] leading-relaxed text-[var(--mcc-muted)] md:text-[17px]">
            Viewers pay per-second to put their camera on your live broadcast. A face on stream
            beats a wall of chat every time.
          </p>
        </section>

        {/* the two walkthroughs, one ledger each */}
        <section className="mx-auto max-w-[1100px] px-5 pb-10">
          <SectionHeading label="Step by step" title="Viewers" />
          <Ledger steps={VIEWER_STEPS} />
        </section>

        <section className="mx-auto max-w-[1100px] px-5 pb-12">
          <SectionHeading label="Step by step" title="Streamers" />
          <Ledger steps={STREAMER_STEPS} />
        </section>

        {/* Latency architecture — the settled design, in plain words. */}
        <section className="border-t border-[var(--mcc-rule)]">
          <div className="mx-auto max-w-[1100px] px-5 py-12">
            <SectionHeading label="The clock" title="Why you’re never actually late" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {CLOCK.map((c) => (
                <div
                  key={c.title}
                  className={`border border-[var(--mcc-rule)] bg-[var(--mcc-panel)] p-5 ${c.lead ? 'border-l-2 border-l-[var(--mcc-accent)]' : ''}`}
                >
                  <h3 className="text-[15px] font-[700]">{c.title}</h3>
                  <p className="mt-1.5 text-[14px] leading-relaxed text-[var(--mcc-muted)]">{c.body}</p>
                </div>
              ))}
            </div>

            {/* One-glance diagram: the two pipes and their clocks. */}
            <div className="mt-8 overflow-x-auto">
              <svg
                viewBox="0 0 720 150"
                role="img"
                aria-label="Diagram: your camera reaches the streamer in under a second over MegaChat's pipe; the public broadcast reaches all spectators after a slight delay"
                className="mx-auto block min-w-[560px] max-w-3xl"
              >
                <defs>
                  <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                    <path d="M0 0 L8 4 L0 8 z" fill="currentColor" />
                  </marker>
                </defs>
                <g fontFamily="var(--font-ui), system-ui, sans-serif" fontSize="13">
                  <rect x="8" y="52" width="120" height="44" fill="none" stroke="var(--mcc-accent)" />
                  <text x="68" y="78" textAnchor="middle" fill="var(--mcc-fg)" fontWeight="700">YOU</text>
                  <rect x="300" y="52" width="130" height="44" fill="none" stroke="var(--mcc-fg)" />
                  <text x="365" y="78" textAnchor="middle" fill="var(--mcc-fg)" fontWeight="700">STREAMER</text>
                  <rect x="590" y="52" width="122" height="44" fill="none" stroke="var(--mcc-rule-2)" />
                  <text x="651" y="78" textAnchor="middle" fill="var(--mcc-fg)" fontWeight="700">EVERYONE</text>
                  <g color="var(--mcc-live)">
                    <line x1="132" y1="66" x2="292" y2="66" stroke="currentColor" strokeWidth="2" markerEnd="url(#arr)" />
                  </g>
                  <text x="212" y="52" textAnchor="middle" fill="var(--mcc-live)" fontWeight="700">MegaChat pipe · &lt;1s</text>
                  <g color="var(--mcc-dim)">
                    <line x1="434" y1="82" x2="582" y2="82" stroke="currentColor" strokeWidth="2" strokeDasharray="6 5" markerEnd="url(#arr)" />
                  </g>
                  <text x="508" y="112" textAnchor="middle" fill="var(--mcc-dim)">broadcast · slight delay</text>
                </g>
              </svg>
            </div>
          </div>
        </section>

        {/* Rails */}
        <section className="border-t border-[var(--mcc-rule)]">
          <div className="mx-auto max-w-[1100px] px-5 py-12">
            <SectionHeading label="Under the hood" title="The rails it runs on" />
            <div className="grid grid-cols-1 md:grid-cols-2 md:gap-x-10">
              {RAILS.map((r) => (
                <div
                  key={r.title}
                  className="border-t border-[var(--mcc-rule)] py-5 last:border-b md:[&:nth-last-child(2)]:border-b"
                >
                  <h3 className="inline-flex items-center gap-2 text-[16px] font-[700]">
                    <r.icon className="size-4 shrink-0 text-[var(--mcc-dim)]" />
                    {r.title}
                  </h3>
                  <p className="mt-1.5 text-[14.5px] leading-relaxed text-[var(--mcc-muted)]">
                    <span className="adv-only">{r.body}</span>
                    <span className="simple-only">{r.simpleBody}</span>
                  </p>
                </div>
              ))}
            </div>

            {/* Reference data, so it lives with the rails rather than gating
                the explanation up top. */}
            <dl className="mt-10 grid grid-cols-2 gap-px border border-[var(--mcc-rule)] bg-[var(--mcc-rule)] sm:grid-cols-4">
              {STATS.map((s) => (
                <div key={s.label} className="flex flex-col gap-1 bg-[var(--mcc-bg)] px-4 py-4">
                  <dt className="text-[17px] font-[700] tabular-nums">{s.value}</dt>
                  <dd className="text-[12.5px] text-[var(--mcc-dim)]">
                    <span className="adv-only">{s.label}</span>
                    <span className="simple-only">{s.simpleLabel}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* FAQ — the nav and the landing both anchor at #faq */}
        <section id="faq" className="scroll-mt-16 border-t border-[var(--mcc-rule)]">
          <div className="mx-auto max-w-[820px] px-5 py-12">
            <SectionHeading label="Questions" title="FAQ" />
            <div className="flex flex-col">
              {FAQ.map((f) => (
                <details key={f.q} className="border-t border-[var(--mcc-rule)] last:border-b">
                  <summary className="flex select-none items-center justify-between gap-4 py-4 text-[15px] font-[700]">
                    {f.q}
                    <span aria-hidden="true" className="mark text-[16px]">
                      +
                    </span>
                  </summary>
                  <p className="pb-4 pr-8 text-[14.5px] leading-relaxed text-[var(--mcc-muted)]">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* CTA band */}
        <section className="border-t border-[var(--mcc-rule)]">
          <div className="mx-auto flex max-w-[1100px] flex-col items-start gap-5 px-5 py-12 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[22px] font-[800] md:text-[26px]">
              Put your face <span className="text-[var(--mcc-accent)]">on the stream.</span>
            </p>
            <div className="flex flex-wrap gap-3">
              <a href="/app" className="bg-[var(--mcc-accent)] px-6 py-3 text-[14px] font-[700] text-[#08080a]">
                Browse rooms
              </a>
              <a
                href="/dashboard"
                className="border border-[var(--mcc-rule-2)] px-6 py-3 text-[14px] font-[700] text-[var(--mcc-fg)] transition-colors hover:border-[var(--mcc-fg)]"
              >
                Start a room
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--mcc-rule)]">
        <div className="mx-auto flex max-w-[1100px] flex-col items-start justify-between gap-3 px-5 py-6 text-[13px] text-[var(--mcc-faint)] sm:flex-row sm:items-center">
          <span className="bc text-[var(--mcc-dim)]">MEGACHAT</span>
          <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <a href="/app" className="hover:text-[var(--mcc-fg)]">
              Rooms
            </a>
            <a href="/bounty" className="hover:text-[var(--mcc-fg)]">
              Bounties
            </a>
            <a href="/dashboard" className="hover:text-[var(--mcc-fg)]">
              Dashboard
            </a>
            <a href="/roadmap" className="hover:text-[var(--mcc-fg)]">
              Roadmap
            </a>
            <a href={contactHref} target="_blank" rel="noopener noreferrer" className="hover:text-[var(--mcc-fg)]">
              Contact
            </a>
          </nav>
        </div>
      </footer>
    </div>
  )
}
