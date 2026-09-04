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
import { BrandText } from '@/components/brand-text'

export const metadata: Metadata = {
  title: 'How it works — MegaChat',
  description:
    'Record a MegaChat or join a live broadcast on camera. Learn how to join, create a room, and manage your settings.',
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
  { value: 'Per-second', label: 'live-seat billing', simpleLabel: 'live-seat billing' },
  { value: 'One tap', label: 'Passkey to live', simpleLabel: 'sign-in to live' },
  { value: 'Your cap', label: 'maximum spend set up front', simpleLabel: 'maximum spend set up front' },
  { value: 'On-chain', label: 'Tempo network', simpleLabel: 'always verifiable' },
]

const VIEWER_STEPS = [
  {
    icon: Compass,
    title: 'Find a room',
    body: 'Browse Rooms or follow a streamer\'s link. Check the price and which features are enabled before you join.',
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
    title: 'Record or take a live seat',
    body: 'MegaChats have a clip total you review before sending. For a live seat, approve a maximum spend first; the meter charges only while you are on camera.',
    simpleBody:
      'MegaChats have a clip total you review before sending. For a live seat, approve a maximum spend first; the meter charges only while you are on camera.',
  },
  {
    icon: Camera,
    title: 'Camera check',
    body: 'Review your recording before sending it. For a live seat, check your private camera preview and press Go Live when ready.',
  },
  {
    icon: Radio,
    title: 'You are the stream',
    body: 'Your MegaChat plays after screening and any streamer approval. A live seat puts you on camera beside the streamer, with the meter running only while you are live.',
  },
  {
    icon: LogOut,
    title: 'Leave whenever',
    body: 'Hit Leave — or just close the tab. The meter stops instantly and every unspent cent refunds straight back to your wallet.',
    simpleBody:
      'Hit Leave or close the tab. Live-seat billing stops; your unused balance stays yours.',
  },
]

const STREAMER_STEPS = [
  {
    icon: LayoutDashboard,
    title: 'Create your room',
    body: 'Choose Create room and set your name and link. Sign in to own it, or set a room password. Manage an existing room lets you return later.',
  },
  {
    icon: SlidersHorizontal,
    title: 'Set your rates',
    body: 'MegaChats start enabled and paid. Set the rate and clip length; the form shows the total. Open mic and drops are optional. Live seats have their own rate and spend cap.',
    simpleBody:
      'MegaChats start enabled and paid. Set the rate and clip length; the form shows the total. Open mic and drops are optional. Live seats have their own rate and spend cap.',
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
    body: 'Enable rewards if you want to pay viewers to watch. Choose the reward, earning rate, and cap before turning it on.',
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
    simpleBody: 'Live seats bill only for the seconds you are on camera, up to the spend limit you approved.',
  },
  {
    icon: RefreshCcw,
    title: 'Unused money is your money',
    body: 'The session cap is a ceiling, not a price. Leave early and the unspent escrow refunds straight back to your wallet on close.',
    simpleBody: 'The cap is a ceiling, not a price. Leave early and your unused balance stays yours.',
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
    a: 'The room sets the price. The default live-seat rate is $0.001 per second with a $2 spend limit. MegaChats show a separate clip total before you send. Free rooms are marked as free.',
  },
  {
    q: 'What happens if I close the tab?',
    a: 'Your live seat ends and billing stops. Your unused balance stays yours. A brief network blip has a grace window for reconnecting.',
  },
  {
    q: 'Is this real money?',
    a: 'Paid rooms use real funds, including the low-cost demo room. Check the price before confirming. The bounty preview is separate: its example amounts are not funded and its ledger does not send real payments.',
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
    <div className="mch-section-heading">
      <span>{label}</span>
      <h2>{title}</h2>
    </div>
  )
}

type Step = {
  icon: React.ComponentType<{ className?: string }>
  title: string
  body: string
  simpleBody?: string
}

function FlowColumn({
  kind,
  title,
  body,
  steps,
}: {
  kind: 'viewer' | 'streamer'
  title: string
  body: string
  steps: Step[]
}) {
  return (
    <section className={`mch-flow is-${kind}`}>
      <header><span>{kind === 'viewer' ? '01' : '02'}</span><div><h2>{title}</h2><p>{body}</p></div></header>
      <ol>
      {steps.map((s, i) => (
        <li key={s.title}>
          <span>{String(i + 1).padStart(2, '0')}</span>
          <s.icon className="mch-step-icon" />
          <div><h3>{s.title}</h3><p>
            {s.simpleBody ? (
              <>
                <span className="adv-only">{s.body}</span>
                <span className="simple-only">{s.simpleBody}</span>
              </>
            ) : (
              s.body
            )}
          </p></div>
        </li>
      ))}
      </ol>
    </section>
  )
}

export default function HowItWorksPage() {
  const contactHref = contactUrl()
  return (
    <div className={`mc-how dark min-h-screen ${ui.variable}`}>
      <header className="mch-product-header">
        <div>
          <span className="mch-product-brand">
            <a href="/app" className="bc"><BrandText /></a>
            <i aria-hidden="true" />
            <span>How it works</span>
          </span>
          <nav aria-label="Product navigation">
            <a href="/app">Rooms</a>
            <a href="/bounty">Bounties</a>
            <a href="/how-it-works" aria-current="page">How it works</a>
          </nav>
          <span className="mch-product-actions">
            <a href="/dashboard?new=1">Create room</a>
            <AccountChip accent="var(--mcc-accent)" />
          </span>
        </div>
      </header>

      <main className="mch-main">
        <section className="mch-hero">
          <span className="mch-coordinate">The full signal path</span>
          <h1>How MegaChat works</h1>
          <p>Viewers can send a recorded MegaChat or take a live camera seat. Streamers control the room from one dashboard and one OBS source.</p>
        </section>

        <section className="mch-tree-section">
          <div className="mch-tree-root">
            <span className="mch-coordinate">Start here</span>
            <h2>One room. Two sides.</h2>
            <p>The viewer joins. The streamer decides what the room accepts.</p>
          </div>
          <div className="mch-tree-branch" aria-hidden="true"><i /><i /><i /></div>
          <div className="mch-flow-grid">
            <FlowColumn kind="viewer" title="Viewer" body="Enter a room, choose a format, and approve the maximum cost before anything starts." steps={VIEWER_STEPS} />
            <FlowColumn kind="streamer" title="Streamer" body="Open a room, set the terms, add the overlay, and run the broadcast." steps={STREAMER_STEPS} />
          </div>
          <div className="mch-tree-result">
            <span className="mch-coordinate">Result</span>
            <h2>A camera seat on the broadcast.</h2>
            <p>Real-time between viewer and streamer. Public stream timing remains unchanged.</p>
          </div>
        </section>

        <section className="mch-clock-section">
          <div>
            <SectionHeading label="The clock" title="Why you’re never actually late" />
            <div className="mch-clock-grid">
              {CLOCK.map((c) => (
                <div key={c.title} className={c.lead ? 'is-lead' : undefined}>
                  <h3>{c.title}</h3>
                  <p>{c.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mch-rails-section">
          <div>
            <SectionHeading label="Under the hood" title="The rails it runs on" />
            <div className="mch-rails-grid">
              {RAILS.map((r) => (
                <div key={r.title}>
                  <r.icon className="mch-rail-icon" />
                  <h3>{r.title}</h3>
                  <p>
                    <span className="adv-only">{r.body}</span>
                    <span className="simple-only">{r.simpleBody}</span>
                  </p>
                </div>
              ))}
            </div>

            <dl className="mch-stats">
              {STATS.map((s) => (
                <div key={s.label}>
                  <dt>{s.value}</dt>
                  <dd>
                    <span className="adv-only">{s.label}</span>
                    <span className="simple-only">{s.simpleLabel}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section id="faq" className="mch-faq-section">
          <div>
            <SectionHeading label="Questions" title="FAQ" />
            <div className="mch-faq-list">
              {FAQ.map((f) => (
                <details key={f.q}>
                  <summary>
                    {f.q}
                    <span aria-hidden="true" className="mark">+</span>
                  </summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="mch-cta">
          <div><p>Choose a live room or open your own.</p><div>
              <a href="/app">Browse rooms</a>
              <a href="/dashboard?new=1">Create room</a>
            </div>
          </div>
        </section>
      </main>

      <footer className="mch-footer">
        <div>
          <span className="bc"><BrandText /></span>
          <nav aria-label="Footer">
            <a href="/app">Rooms</a>
            <a href="/bounty">Bounties</a>
            <a href="/dashboard">Dashboard</a>
            <a href="/roadmap">Roadmap</a>
            <a href={contactHref} target="_blank" rel="noopener noreferrer">Contact</a>
          </nav>
        </div>
      </footer>
    </div>
  )
}
