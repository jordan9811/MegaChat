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
} from 'lucide-react'
import { AccountChip } from '@/components/account-chip'
import { contactUrl } from '@/components/site-footer'
import { docsUrl } from '@/lib/docs-url.mjs'
import './how-it-works.css'
import { BrandText } from '@/components/brand-text'
import { FeatureTag, type FeatureKind } from '@/components/feature-tag'
import { ThemeToggle } from '@/components/theme-toggle'

export const metadata: Metadata = {
  title: 'How it works — Holler',
  description:
    'Record a Holler or join a live broadcast on camera. Learn how to join, create a room, and manage your settings.',
}

// One UI face across the app, loaded per route — there is no site-wide
// provider. Same call as the room board's page.
const ui = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-ui',
})

const VIEWER_STEPS: Step[] = [
  {
    icon: Compass,
    title: 'Find a room',
    body: 'Browse Rooms or follow a streamer\'s link. Check the price and which features are enabled before you join.',
    tags: ['holler', 'callin', 'rewards'],
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
    body: 'Hollers have a clip total you review before sending. For a live seat, approve a maximum spend first; the meter charges only while you are on camera.',
    simpleBody:
      'Hollers have a clip total you review before sending. For a live seat, approve a maximum spend first; the meter charges only while you are on camera.',
    tags: ['holler', 'callin'],
  },
  {
    icon: Camera,
    title: 'Camera check',
    body: 'Review your recording before sending it. For a live seat, check your private camera preview and press Go Live when ready.',
  },
  {
    icon: Radio,
    title: 'You are the stream',
    body: 'Your Holler plays after screening and any streamer approval. A live seat puts you on camera beside the streamer, with the meter running only while you are live.',
  },
  {
    icon: LogOut,
    title: 'Leave whenever',
    body: 'Hit Leave — or just close the tab. The meter stops instantly and every unspent cent refunds straight back to your wallet.',
    simpleBody:
      'Hit Leave or close the tab. Live-seat billing stops; your unused balance stays yours.',
  },
]

const STREAMER_STEPS: Step[] = [
  {
    icon: LayoutDashboard,
    title: 'Create your room',
    body: 'Choose Create room and set your name and link. Sign in to own it, or set a room password. Manage an existing room lets you return later.',
  },
  {
    icon: SlidersHorizontal,
    title: 'Set your rates',
    body: 'Hollers start enabled and paid. Set the rate and clip length; the form shows the total. Call in and Rewards are optional. Call in has its own rate and spend cap.',
    simpleBody:
      'Hollers start enabled and paid. Set the rate and clip length; the form shows the total. Call in and Rewards are optional. Call in has its own rate and spend cap.',
    tags: ['holler', 'callin', 'rewards'],
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
    title: 'Optional: watch-to-earn rewards',
    body: 'Enable rewards if you want to pay viewers to watch. Choose the reward, earning rate, and cap before turning it on.',
    simpleBody:
      'Flip on rewards and viewers earn credit toward their first seat just by watching. Fund the pool, set the drip rate and cap — it feeds joins, not chat.',
    tags: ['rewards'],
  },
]

const FAQ = [
  {
    q: 'Do I need a crypto wallet?',
    a: 'No. Creating a passkey spins up a smart account for you — one tap on the join page, no extension, no seed phrase. MetaMask is supported as an optional secondary path.',
  },
  {
    q: 'How much does it cost to be on stream?',
    a: 'The room sets the price. The default live-seat rate is $0.001 per second with a $2 spend limit. Hollers show a separate clip total before you send. Free rooms are marked as free.',
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
  // the features this step is about, shown as FeatureTags over its body
  tags?: FeatureKind[]
}

function FlowColumn({
  kind,
  body,
  steps,
}: {
  kind: 'viewer' | 'streamer'
  body: string
  steps: Step[]
}) {
  return (
    <section className={`mch-flow is-${kind}`}>
      <header><p>{body}</p></header>
      <ol>
      {steps.map((s, i) => (
        <li key={s.title}>
          <span>{String(i + 1).padStart(2, '0')}</span>
          <s.icon className="mch-step-icon" />
          <div><h3>{s.title}</h3>{s.tags ? (
            // spans, not li: .mch-flow li is the step's own grid row
            <span className="mch-step-tags">
              {s.tags.map((k) => <FeatureTag key={k} kind={k} />)}
            </span>
          ) : null}<p>
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
    <div className={`mc-how min-h-screen ${ui.variable}`}>
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
            {docsUrl() ? <a href={docsUrl() as string}>Docs</a> : null}
          </nav>
          <span className="mch-product-actions">
            <a href="/dashboard">Create room</a>
            <ThemeToggle />
            <AccountChip accent="var(--mcc-accent)" />
          </span>
        </div>
      </header>

      <main className="mch-main">
        <section className="mch-hero">
          <span className="mch-coordinate">The full signal path</span>
          <h1>How Holler works</h1>
          <p>Viewers can send a recorded Holler or take a live camera seat. Streamers control the room from one dashboard and one OBS source.</p>
          <ul className="mch-hero-tags" aria-label="Features">
            {(['holler', 'callin', 'bounty', 'rewards'] as const).map((k) => (
              <li key={k}><FeatureTag kind={k} size="md" /></li>
            ))}
          </ul>
        </section>

        <section className="mch-tree-section">
          <div className="mch-arewe">
            <span className="mch-arewe-lead">Are you a</span>
            <span className="mch-tag is-chatter">Chatter</span>
            <span className="mch-arewe-or">or</span>
            <span className="mch-tag is-streamer">Streamer</span>
          </div>
          <div className="mch-flow-grid">
            <FlowColumn kind="viewer" body="Enter a room, choose a format, and approve the maximum cost before anything starts." steps={VIEWER_STEPS} />
            <FlowColumn kind="streamer" body="Open a room, set the terms, add the overlay, and run the broadcast." steps={STREAMER_STEPS} />
          </div>
          <div className="mch-tree-result">
            <span className="mch-coordinate">Result</span>
            <h2>A camera seat on the broadcast.</h2>
            <p>Real-time between viewer and streamer. Public stream timing remains unchanged.</p>
            <FeatureTag kind="callin" size="md" />
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
              <a href="/dashboard">Create room</a>
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
            {docsUrl() ? <a href={docsUrl() as string}>Docs</a> : null}
            <a href={contactHref} target="_blank" rel="noopener noreferrer">Contact</a>
          </nav>
        </div>
      </footer>
    </div>
  )
}
