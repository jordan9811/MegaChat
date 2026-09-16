'use client'

import { useState } from 'react'
import {
  ArrowRight,
  AtSign,
  Camera,
  Check,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Copy,
  ExternalLink,
  Fingerprint,
  Gift,
  Link2,
  LockKeyhole,
  MessageSquareText,
  Mic2,
  MonitorUp,
  Play,
  Radio,
  RefreshCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trophy,
  UserRound,
  Users,
  Video,
  Wallet,
  Zap,
} from 'lucide-react'

type PageId = 'join' | 'account' | 'bounty' | 'how' | 'landing'
type JoinMode = 'mega' | 'seat'
type AccountSection = 'overview' | 'defaults' | 'connections'
type HowMode = 'viewer' | 'streamer'

const PAGES: Array<{ id: PageId; label: string; index: string }> = [
  { id: 'join', label: 'Join room', index: '01' },
  { id: 'account', label: 'Account', index: '02' },
  { id: 'bounty', label: 'Bounty', index: '03' },
  { id: 'how', label: 'How it works', index: '04' },
  { id: 'landing', label: 'Landing support', index: '05' },
]

const BOUNTIES = [
  { handle: 'threadguy', platform: 'Twitch', mark: 'T', photo: 'https://unavatar.io/twitch/threadguy', locked: 100, contested: 100, backers: 2 },
  { handle: 'chessbrah', platform: 'Kick', mark: 'K', photo: 'https://unavatar.io/kick/chessbrah', locked: 100, contested: 100, backers: 2 },
  { handle: 'martinshkreli', platform: 'X', mark: 'X', photo: 'https://unavatar.io/x/martinshkreli', locked: 100, contested: 100, backers: 2 },
  { handle: 'rasmr', platform: 'X', mark: 'X', photo: 'https://unavatar.io/x/rasmr', locked: 100, contested: 100, backers: 2 },
  { handle: 'GnBQ...C64pump', platform: 'pump.fun', mark: 'P', photo: '', locked: 100, contested: 100, backers: 2 },
] as const

function BrandNav({ page }: { page: string }) {
  return (
    <header className="pm-product-nav">
      <div className="pm-product-brand"><strong>MEGACHAT</strong><i /><span>{page}</span></div>
      <nav aria-label="Product navigation"><a href="#">Rooms</a><a href="#">Bounties</a><a href="#">How it works</a></nav>
      <button type="button" className="pm-account-chip"><UserRound size={14} /> Sign in</button>
    </header>
  )
}

function JoinMock() {
  const [mode, setMode] = useState<JoinMode>('mega')
  const [recording, setRecording] = useState(false)
  return (
    <article className="pm-page pm-join">
      <BrandNav page="Live room" />
      <div className="pm-join-topline">
        <span className="pm-live-label"><i /> Live on Kick</span>
        <span>chessbrah&apos;s room</span>
        <span>1,842 watching</span>
      </div>
      <div className="pm-join-layout">
        <section className="pm-broadcast-stage">
          <div className="pm-signal-bars" aria-hidden="true"><i /><i /><i /><i /><i /><i /></div>
          <div className="pm-stage-copy">
            <span className="pm-coordinate">LIVE FEED / KICK</span>
            <h2>Your face goes<br />right <em>here.</em></h2>
            <p>The streamer sees you in real time. Everyone else sees the moment on broadcast.</p>
          </div>
          <div className="pm-stage-person" aria-hidden="true"><span>CB</span><i /></div>
          <div className="pm-stage-meter"><span>Room signal</span><b>00:42:18</b><i /></div>
        </section>

        <section className="pm-action-console">
          <div className="pm-console-switch" role="tablist" aria-label="Ways to join">
            <button type="button" role="tab" aria-selected={mode === 'mega'} onClick={() => setMode('mega')}><MessageSquareText size={16} /><span>MegaChat<small>Recorded clip</small></span></button>
            <button type="button" role="tab" aria-selected={mode === 'seat'} onClick={() => setMode('seat')}><Video size={16} /><span>Live seat<small>Camera on stream</small></span></button>
          </div>

          {mode === 'mega' ? (
            <div className="pm-recorder">
              <div className="pm-console-title"><span>01 / Record</span><h1>Say it where they can&apos;t scroll past.</h1><p>Record up to 10 seconds. Review it before anything is sent.</p></div>
              <button type="button" className={`pm-camera-window${recording ? ' is-recording' : ''}`} onClick={() => setRecording((value) => !value)}>
                <span className="pm-camera-corners" aria-hidden="true" />
                <span className="pm-record-icon"><Camera size={25} /></span>
                <strong>{recording ? 'Recording 00:06' : 'Camera preview'}</strong>
                <small>{recording ? 'Tap to stop' : 'Tap to start recording'}</small>
              </button>
              <div className="pm-price-block"><span><small>Rate</small><strong>$0.001 / second</strong></span><span><small>10 second clip</small><strong>$0.01 max</strong></span></div>
              <button type="button" className="pm-primary-action" onClick={() => setRecording((value) => !value)}><span>{recording ? 'Stop and review' : 'Start recording'}</span><ArrowRight size={18} /></button>
              <div className="pm-trust-row"><ShieldCheck size={14} /><span>You approve the clip and full price before paying.</span></div>
            </div>
          ) : (
            <div className="pm-recorder pm-seat-mode">
              <div className="pm-console-title"><span>01 / Camera check</span><h1>Take a seat beside the stream.</h1><p>Your camera stays private until you press Go live.</p></div>
              <div className="pm-seat-preview"><div><Video size={28} /><strong>Camera ready</strong><small>Mic and video look good</small></div><span className="pm-ready"><Check size={13} /> Ready</span></div>
              <div className="pm-price-block"><span><small>Live rate</small><strong>$0.005 / second</strong></span><span><small>Hard spend cap</small><strong>$2.00</strong></span></div>
              <button type="button" className="pm-primary-action pm-live-action"><span>Authorize live seat</span><Radio size={18} /></button>
              <div className="pm-trust-row"><RefreshCcw size={14} /><span>Leave anytime. Every unused cent returns automatically.</span></div>
            </div>
          )}
        </section>
      </div>
    </article>
  )
}

function AccountMock() {
  const [section, setSection] = useState<AccountSection>('overview')
  return (
    <article className="pm-page pm-account">
      <BrandNav page="Account" />
      <div className="pm-account-hero">
        <div><span className="pm-coordinate">IDENTITY / PERMANENT</span><h1>@jordandotfun</h1><p>Your handle is your room link everywhere MegaChat appears.</p></div>
        <div className="pm-room-link"><span>megachat.fun/jordandotfun</span><button type="button"><Copy size={15} /> Copy</button><button type="button"><ExternalLink size={15} /> Open</button></div>
      </div>
      <div className="pm-account-layout">
        <nav className="pm-account-nav" aria-label="Account sections">
          {([
            ['overview', 'Overview', UserRound],
            ['defaults', 'Room defaults', Settings2],
            ['connections', 'Connections', Link2],
          ] as const).map(([id, label, Icon]) => <button key={id} type="button" aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}><Icon size={16} /><span>{label}</span><ChevronRight size={14} /></button>)}
          <button type="button" className="pm-signout"><LockKeyhole size={16} /><span>Sign out</span></button>
        </nav>
        <section className="pm-account-work">
          {section === 'overview' ? <AccountOverview /> : null}
          {section === 'defaults' ? <AccountDefaults /> : null}
          {section === 'connections' ? <AccountConnections /> : null}
        </section>
      </div>
    </article>
  )
}

function AccountOverview() {
  return <div className="pm-account-grid"><section className="pm-balance-zone"><span className="pm-coordinate">AVAILABLE BALANCE</span><strong><b>$</b>24.82</strong><p>USDC on Tempo</p><button type="button">Fund balance <ArrowRight size={16} /></button></section><section className="pm-room-status"><div><span className="pm-live-label"><i /> Room live</span><small>jordandotfun</small></div><strong>1 room</strong><p>MegaChats open. Live seats closed.</p><button type="button">Open dashboard <ChevronRight size={16} /></button></section><section className="pm-account-activity"><header><span>Recent activity</span><button type="button">View all</button></header><div><span className="pm-activity-icon is-blue"><MessageSquareText size={15} /></span><p><strong>MegaChat received</strong><small>8 seconds from @couch_goblin</small></p><b>+$0.008</b></div><div><span className="pm-activity-icon is-green"><Wallet size={15} /></span><p><strong>Balance funded</strong><small>Tempo smart account</small></p><b>+$25.00</b></div></section></div>
}

function AccountDefaults() {
  return <div className="pm-settings-zone"><header><div><span className="pm-coordinate">ROOM DEFAULTS</span><h2>Start every room ready.</h2><p>These values load into Create Room and can still be changed per stream.</p></div><button type="button" className="pm-secondary-action">Open full setup <ExternalLink size={15} /></button></header><div className="pm-setting-rows"><div><span><MessageSquareText size={16} /><b>MegaChats</b></span><strong className="is-live">On</strong></div><div><span><Video size={16} /><b>Open mic</b></span><strong>Off</strong></div><div><span><Gift size={16} /><b>Drops</b></span><strong>Off</strong></div><div><span><CircleDollarSign size={16} /><b>Default rate</b></span><strong>$0.001 /s</strong></div><div><span><ShieldCheck size={16} /><b>Screening</b></span><strong>AI only</strong></div></div><button type="button" className="pm-primary-action"><span>Edit defaults</span><ChevronRight size={17} /></button></div>
}

function AccountConnections() {
  return <div className="pm-connections"><header><span className="pm-coordinate">LINKED SIGN-INS</span><h2>One identity, multiple ways back in.</h2></header><div className="pm-connection is-connected"><span className="pm-provider google">G</span><div><strong>Google</strong><small>jordan@example.com</small></div><b><Check size={13} /> Connected</b></div><div className="pm-connection is-connected"><span className="pm-provider twitch">T</span><div><strong>Twitch</strong><small>jordandotfun</small></div><b><Check size={13} /> Connected</b></div><div className="pm-connection"><span className="pm-provider x">X</span><div><strong>X</strong><small>Add another sign-in method</small></div><button type="button">Connect</button></div></div>
}

function PlatformAvatar({ item }: { item: typeof BOUNTIES[number] }) {
  return <span className="pm-avatar" data-letter={item.handle.charAt(0).toUpperCase()}>{item.photo ? <img src={item.photo} alt="" onError={(event) => { event.currentTarget.style.display = 'none' }} /> : null}<i data-platform={item.platform}>{item.mark}</i></span>
}

function BountyMock() {
  const [selected, setSelected] = useState(0)
  const active = BOUNTIES[selected]
  return (
    <article className="pm-page pm-bounty">
      <BrandNav page="Bounties" />
      <section className="pm-bounty-hero"><div><span className="pm-coordinate">CREATOR BOUNTIES / OPEN</span><h1>Your favorite streamer<br />doesn&apos;t even know you.</h1><p>Be more than a username.</p></div><div className="pm-bounty-totals"><span><small>Real money in escrow</small><strong>$600</strong><em>counted once</em></span><i /><span><small>Visible across pools</small><strong>$1,000</strong><em>contested money repeats</em></span></div></section>
      <div className="pm-bounty-layout">
        <section className="pm-leaderboard">
          <header><div><span className="pm-coordinate">TOP TARGETS</span><h2>Top bounties</h2></div><span className="pm-board-live"><i /> 5 open pools</span></header>
          <div className="pm-leader-head"><span>#</span><span>Streamer</span><span>Pool</span><span>Total</span></div>
          {BOUNTIES.map((item, index) => <button type="button" key={item.handle} className="pm-bounty-row" aria-current={selected === index ? 'true' : undefined} onClick={() => setSelected(index)}><span className="pm-rank">{String(index + 1).padStart(2, '0')}</span><span className="pm-streamer"><PlatformAvatar item={item} /><span><strong>{item.handle}</strong><small>{item.platform} / {item.backers} backers</small></span></span><span className="pm-pool-bar"><i style={{ width: '50%' }} /><b style={{ width: '50%' }} /><small><em>$100 locked</em><em>$100 contested</em></small></span><strong className="pm-row-total">$200</strong></button>)}
        </section>
        <aside className="pm-bounty-detail"><span className="pm-coordinate">SELECTED POOL</span><div className="pm-detail-person"><PlatformAvatar item={active} /><span><h2>{active.handle}</h2><p>{active.platform}</p></span></div><div className="pm-detail-money"><strong>$200</strong><span>potential bounty</span></div><div className="pm-detail-split"><span><i className="is-locked" /><b>$100 locked</b><small>Theirs alone when they claim.</small></span><span><i className="is-contested" /><b>$100 contested</b><small>Five names compete. First to air wins.</small></span></div><button type="button" className="pm-money-action"><Mic2 size={17} /><span>Record a MegaChat</span><ArrowRight size={17} /></button><button type="button" className="pm-claim-action">I am {active.handle} - claim this</button></aside>
      </div>
      <footer className="pm-bounty-cta"><div><span className="pm-coordinate">CREATE A BOUNTY</span><h2>Add a streamer.</h2><p>Choose a platform and handle. Add the amount and terms on the next screen.</p></div><div><select aria-label="Platform" defaultValue="twitch"><option>Twitch</option><option>Kick</option><option>X</option><option>Rumble</option></select><input aria-label="Streamer handle" placeholder="their handle" /><button type="button">Continue <ArrowRight size={16} /></button></div></footer>
    </article>
  )
}

const HOW_STEPS = {
  viewer: [
    { n: '01', icon: MessageSquareText, title: 'Pick your move', copy: 'Record a MegaChat or take a live camera seat.' },
    { n: '02', icon: Fingerprint, title: 'Sign in once', copy: 'Email, socials, or passkey. No wallet setup ceremony.' },
    { n: '03', icon: ShieldCheck, title: 'Approve the ceiling', copy: 'See the full price and hard spend cap before going live.' },
    { n: '04', icon: Radio, title: 'Become the stream', copy: 'Your clip or camera lands where chat never could.' },
  ],
  streamer: [
    { n: '01', icon: Settings2, title: 'Open a room', copy: 'Name it, set rates, choose what your audience can do.' },
    { n: '02', icon: MonitorUp, title: 'Add one OBS source', copy: 'The transparent overlay handles clips, seats, and stingers.' },
    { n: '03', icon: Link2, title: 'Share one link', copy: 'Post it in chat, your bio, or anywhere viewers already are.' },
    { n: '04', icon: Zap, title: 'Run it live', copy: 'Approve clips, manage seats, and see money move in real time.' },
  ],
} as const

function HowMock() {
  const [mode, setMode] = useState<HowMode>('viewer')
  return (
    <article className="pm-page pm-how">
      <BrandNav page="How it works" />
      <section className="pm-how-hero"><div><span className="pm-coordinate">THE SIGNAL PATH</span><h1>From username<br />to <em>on-screen.</em></h1><p>MegaChat turns a viewer into part of the broadcast without turning setup into work.</p></div><div className="pm-how-switch" role="tablist" aria-label="How MegaChat works for"><button type="button" role="tab" aria-selected={mode === 'viewer'} onClick={() => setMode('viewer')}><Users size={18} /> I&apos;m a viewer</button><button type="button" role="tab" aria-selected={mode === 'streamer'} onClick={() => setMode('streamer')}><Radio size={18} /> I&apos;m a streamer</button></div></section>
      <section className="pm-pipeline"><div className="pm-pipe-node is-you"><span>{mode === 'viewer' ? 'YOU' : 'YOUR ROOM'}</span><small>{mode === 'viewer' ? 'camera / clip' : 'OBS / dashboard'}</small></div><div className="pm-pipe-line is-fast"><span>MegaChat pipe</span><b>&lt; 1 second</b><i /></div><div className="pm-pipe-node is-streamer"><span>{mode === 'viewer' ? 'STREAMER' : 'VIEWER'}</span><small>real-time connection</small></div><div className="pm-pipe-line"><span>public broadcast</span><b>slight delay</b><i /></div><div className="pm-pipe-node"><span>EVERYONE</span><small>the moment lands</small></div></section>
      <section className="pm-how-body"><header><span className="pm-coordinate">{mode === 'viewer' ? 'VIEWER PLAYBOOK' : 'STREAMER PLAYBOOK'}</span><h2>Four moves. Nothing to hunt for.</h2></header><div className="pm-step-grid">{HOW_STEPS[mode].map(({ n, icon: Icon, title, copy }, index) => <article key={title} data-tone={index}><span>{n}</span><Icon size={21} /><h3>{title}</h3><p>{copy}</p></article>)}</div></section>
      <section className="pm-how-money"><div><CircleDollarSign size={24} /><span><strong>Pay only while you&apos;re on stream.</strong><small>Per-second USDC settlement, not a subscription or lump sum.</small></span></div><div><RefreshCcw size={24} /><span><strong>Unused money stays yours.</strong><small>The cap is a ceiling. Leave early and the rest returns.</small></span></div><button type="button">Browse live rooms <ArrowRight size={17} /></button></section>
    </article>
  )
}

function LandingSupportMock() {
  return (
    <article className="pm-page pm-landing-support">
      <BrandNav page="Landing support" />
      <section className="pm-preserved-hero"><div className="pm-film-strip"><span>Preserved launch film</span><Play size={22} fill="currentColor" /></div><div><span className="pm-coordinate">LANDING HERO / UNCHANGED</span><h1>Skip the chat.<br />Be the stream.</h1><button type="button">Enter MegaChat <ArrowRight size={17} /></button></div></section>
      <section className="pm-entry-section"><header><span className="pm-coordinate">THREE WAYS IN</span><h2>Choose how you<br />join the stream.</h2></header><div className="pm-entry-grid"><article data-tone="blue"><span>01</span><MessageSquareText size={23} /><h3>Record a MegaChat</h3><p>Say it on camera. Set the clip loose on their broadcast.</p><a href="#">Find a streamer <ChevronRight size={15} /></a></article><article data-tone="green"><span>02</span><Video size={23} /><h3>Take a live seat</h3><p>Join the stream face-to-face and pay only for the seconds you use.</p><a href="#">Browse rooms <ChevronRight size={15} /></a></article><article data-tone="yellow"><span>03</span><Trophy size={23} /><h3>Start a bounty</h3><p>Back a streamer before they have a room. They claim it by going live.</p><a href="#">Browse bounties <ChevronRight size={15} /></a></article></div></section>
      <section className="pm-landing-bounty"><div className="pm-bounty-poster"><span className="pm-coordinate">THE BOUNTY BOARD</span><h2>Your favorite streamer<br />doesn&apos;t even know you.</h2><p>Be more than a username.</p><button type="button">Browse bounties <ArrowRight size={16} /></button></div><div className="pm-mini-board"><header><span>Top bounties</span><strong>$1,000 across pools</strong></header>{BOUNTIES.slice(0, 3).map((item, index) => <div key={item.handle}><span>{String(index + 1).padStart(2, '0')}</span><PlatformAvatar item={item} /><p><strong>{item.handle}</strong><small>{item.platform}</small></p><b>$200</b></div>)}</div></section>
      <section className="pm-proof-strip"><span><Clock3 size={20} /><b>Per-second</b><small>not per session</small></span><span><Fingerprint size={20} /><b>One-tap sign in</b><small>no seed phrase</small></span><span><RefreshCcw size={20} /><b>Automatic refunds</b><small>unused stays yours</small></span><span><Sparkles size={20} /><b>Built for OBS</b><small>one browser source</small></span></section>
    </article>
  )
}

export function PageMockSuite() {
  const [page, setPage] = useState<PageId>('join')
  const active = PAGES.find((item) => item.id === page) ?? PAGES[0]
  return (
    <div className="page-mocks">
      <header className="pm-lab-nav"><div className="pm-lab-brand"><strong>MEGACHAT</strong><span>Broadcast OS / page suite</span></div><nav aria-label="Page mocks">{PAGES.map((item) => <button key={item.id} type="button" aria-current={page === item.id ? 'page' : undefined} onClick={() => setPage(item.id)}><b>{item.index}</b>{item.label}</button>)}</nav><a href="/dashboard/design-system">Create Room</a></header>
      <section className="pm-lab-intro"><div><span>Page {active.index} / local mock</span><h1>{active.label}</h1></div><p>Broadcast OS with stronger visual hierarchy: color owns regions, not decoration.</p><span className="pm-local"><i /> Local only</span></section>
      <div className="pm-canvas">{page === 'join' ? <JoinMock /> : null}{page === 'account' ? <AccountMock /> : null}{page === 'bounty' ? <BountyMock /> : null}{page === 'how' ? <HowMock /> : null}{page === 'landing' ? <LandingSupportMock /> : null}</div>
    </div>
  )
}
