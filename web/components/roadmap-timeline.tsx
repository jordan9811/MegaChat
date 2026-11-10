// The roadmap as one horizontal track: Shipped → Now → Next → Later, left to
// right, a node per tier on a rail and the items as cards under it. "Now"
// carries the We-are-here marker. Each card is a heading that opens its
// description on a tap, the How it works pattern (owner, 2026-11-10: "collapse
// the descriptions in an expandable subheading"). Styles: app/roadmap/roadmap.css.
//
// Tier colours keep the owner's old wording, "green ships next, amber after
// that, purple is the big swing" (purple became the strap azure with the
// Holler palette): Now green, Next yellow, Later azure. Shipped is the plain
// text colour, done and quiet. A tier colour is a rail and a dot, never the
// FeatureTag pill, so a tier cannot be read as a feature.
//
// No server state and no client state: <details> opens on its own, so this
// renders on the server.

import { FeatureTag, type FeatureKind } from '@/components/feature-tag'

type Tier = 'shipped' | 'now' | 'next' | 'later'

type Item = {
  title: string
  body: string
  tags?: FeatureKind[]
  // a past milestone's month, shown at the top of its description
  when?: string
  // the first demo links to its tweet when JOURNEY_TWEET_URL is set
  tweet?: boolean
}

const TIERS: { id: Tier; name: string; note: string }[] = [
  { id: 'shipped', name: 'Shipped', note: 'Live on Holler today' },
  { id: 'now', name: 'Now', note: 'Being built' },
  { id: 'next', name: 'Next', note: 'Up after that' },
  { id: 'later', name: 'Later', note: 'The big swings' },
]

// Newest first: what shipped in November, then the road before it.
const SHIPPED: Item[] = [
  {
    title: 'Real-money bounties',
    body: 'Back a streamer with real USDC and a Holler for them to air. Your pledge waits for them to claim it, and comes back to you if they don’t before it expires.',
    tags: ['bounty'],
  },
  {
    title: 'A liveness label on every room',
    body: 'Green, yellow or red: how much proof stands behind the money. Green means our badge was seen on the broadcast, yellow that the overlay is up, red that only the channel is live. Hover it for why, and set the lowest tier you’ll back.',
    tags: ['bounty'],
  },
  {
    title: 'Hollers billed by the second',
    body: 'You pay for the seconds you record, up to the room’s longest clip, instead of a flat price for every take. Call in already worked this way.',
    tags: ['holler', 'callin'],
  },
  {
    title: 'Follow my stream, on Twitch and Kick',
    body: 'Link your channel and your room opens when you go live, offers your stream title as its name, and closes when you stop.',
  },
  {
    title: 'Reward campaigns',
    body: 'Offer a reward to viewers who fit your rules, like having 10k followers on X, for sending a Holler or calling in on your stream. They’re paid once it airs.',
    tags: ['rewards'],
  },
  {
    title: 'MegaChat is now Holler',
    body: 'A new name at hollertv.com, the record-button mark, one colour per feature, a light mode, and two looks to switch between from the header: V1 and V2.',
    tags: ['holler', 'callin', 'bounty', 'rewards'],
  },
  {
    title: 'Claimed pledges and Recently aired',
    body: 'The board shows the pledges streamers have claimed, and replays of broadcasts that just aired, each with a real picture from the stream.',
  },
  {
    title: 'Demo money and a guided tour',
    body: 'Try everything in the demo room on demo money, never real money, with a short tour that walks you through it.',
  },
  {
    title: 'Real platform logos',
    body: 'Twitch, Kick, YouTube, X, Rumble and pump.fun badges wear their own logos and colours, so you know the platform at a glance.',
  },
  {
    title: 'Over 150 fixes, picked one by one',
    body: 'Four rounds of polish across the dashboard, the overlay, room pages and the board: prices shown per second, honest loading and error states, bigger touch targets, a simpler OBS setup and a lot less text.',
  },
  {
    title: 'The launch film',
    body: 'A short film on the home page that shows what Holler does, start to finish.',
  },
]

const EARLIER: Item[] = [
  {
    when: 'September 2026',
    title: 'Producer mode',
    body: 'Hold every Holler for approval. A moderator airs it, and nothing waits forever.',
    tags: ['holler'],
  },
  {
    when: 'September 2026',
    title: 'Guests that sound right',
    body: 'Echo is found and cancelled on both sides, with a guard against feedback howl and no audio mode to pick.',
    tags: ['callin'],
  },
  {
    when: 'September 2026',
    title: 'Overlay placement',
    body: 'Pick the corner, the direction, the tile size and the gap for your overlay, with a live preview.',
  },
  {
    when: 'July 2026',
    title: 'Your name, your room link',
    body: 'Sign in with Twitch or X to claim your handle as your name and a permanent link to your room.',
  },
  {
    when: 'July 2026',
    title: 'Rewards for watching',
    body: 'Streamers fund a pool, and viewers earn from it just by watching.',
    tags: ['rewards'],
  },
  {
    when: 'July 2026',
    title: 'Hollers and Call in',
    body: 'Recorded clips and live camera seats became two features, each with its own price. Hollers get an AI check before they play.',
    tags: ['holler', 'callin'],
  },
  {
    when: 'July 2026',
    title: 'Stingers, with sound',
    body: 'Entrance and exit animations with sound effects timed to the beat: storm strike, breaking-news slam, CRT power-off.',
  },
  {
    when: 'July 2026',
    title: 'Real money, by the second',
    body: 'Per-second billing with real money, and one-tap wallets from email, a passkey or your socials.',
  },
  {
    when: 'February 2026',
    title: 'The first demo',
    body: 'The first working loop: a wallet, a top-up, and a camera seat billed by the second.',
    tweet: true,
  },
]

const NOW: Item[] = [
  {
    title: 'Getting ready for public launch',
    body: 'The last fixes, the docs, and the final checks before Holler opens to everyone.',
  },
  {
    title: 'Live or recorded, plain on the overlay',
    body: 'Every tile on your stream says whether it’s a Call in, live on camera now, or a Holler playing back, in that feature’s colour.',
    tags: ['callin', 'holler'],
  },
  {
    title: 'Steadier live seats',
    body: 'Reconnects that hold, quality that keeps up under real load, and fewer dropped guests.',
    tags: ['callin'],
  },
  {
    title: 'Mobile polish',
    body: 'A join flow that feels native on a phone: camera prep, one-thumb controls, layouts that stay overlay-safe.',
  },
]

const NEXT: Item[] = [
  {
    title: 'Your bounties: revisit, re-up, top up',
    body: 'One page for every bounty you backed: where it stands, who claimed it, and your clips, playable. If one gets claimed before your clip airs, re-up the same clip for that streamer. Still want to see it? Top it up.',
    tags: ['bounty'],
  },
  {
    title: 'Drag your overlay tiles into place',
    body: 'Place the tiles by dragging them on the preview, instead of picking a corner and a direction.',
  },
  {
    title: 'Overlay health at a glance',
    body: 'Your dashboard shows whether the overlay is up and working on your stream right now.',
  },
  {
    title: 'Claim your channel on more platforms',
    body: 'Prove a pump.fun, Rumble or YouTube channel is yours, so you can claim your name and any bounties waiting for you, the way Twitch and Kick streamers do by signing in.',
    tags: ['bounty'],
  },
  {
    title: 'Follow my stream, everywhere',
    body: 'Rooms that open and close with your stream on YouTube, pump.fun and X too.',
  },
  {
    title: 'Live AI moderation',
    body: 'Hollers already get an AI check before they play. Next, the same check watches live seats, so a room can run hands-off.',
    tags: ['callin'],
  },
  {
    title: 'Public docs',
    body: 'A handbook for streamers and viewers: setup, prices, bounties, rewards.',
  },
]

const LATER: Item[] = [
  {
    title: 'Your whole OBS scene for guests',
    body: 'Call in guests see your full scene in real time, game, facecam and all, not just your webcam.',
    tags: ['callin'],
  },
  {
    title: 'More kinds of rewards',
    body: 'Pay rewards in tokens, in stablecoins, or in free seconds on stream.',
    tags: ['rewards'],
  },
  {
    title: 'A flat Holler price',
    body: 'An option to charge one set price up to a max length, or a minimum with a tip on top.',
    tags: ['holler'],
  },
  {
    title: 'Watch on Twitch, earn here',
    body: 'Watch time on Twitch counts toward rewards here, so your audience arrives ready to join. It also makes followers-only and subscribers-only rooms real.',
  },
  {
    title: 'Stinger marketplace',
    body: 'Creators publish and sell custom entrance and exit stingers; streamers equip them per room. Cosmetics as an economy.',
  },
  {
    title: 'Bans that stick',
    body: 'Bans tied to a wallet and a linked platform account, so a kicked troll can’t rejoin with a fresh wallet.',
  },
  {
    title: 'A board ranked by what’s hot',
    body: 'Rooms ranked by what people actually spend, uptime and returning viewers, not just whoever went live last.',
  },
  {
    title: 'Pay with a card',
    body: 'Top up with a debit card straight from the room page: the last crypto-shaped step, gone.',
  },
]

const ITEMS: Record<Tier, Item[]> = { shipped: SHIPPED, now: NOW, next: NEXT, later: LATER }

function Chevron() {
  return <span className="rm-chev" aria-hidden="true" />
}

function Check() {
  return (
    <span className="rm-check" aria-hidden="true">
      <svg viewBox="0 0 12 12" width="10" height="10">
        <path d="M2.5 6.4 5 8.8 9.6 3.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

function RoadItem({ item, tier, tweetUrl }: { item: Item; tier: Tier; tweetUrl: string }) {
  return (
    <li>
      <details className="rm-item">
        <summary>
          {tier === 'shipped' ? <Check /> : <span className="rm-tick" aria-hidden="true" />}
          <h3>{item.title}</h3>
          {tier === 'shipped' ? <span className="sr-only">, shipped</span> : null}
          <Chevron />
        </summary>
        <div className="rm-more">
          {item.when ? <span className="rm-when">{item.when}</span> : null}
          <p>
            {item.body}
            {item.tweet && tweetUrl ? (
              <>
                {' '}
                <a href={tweetUrl} target="_blank" rel="noopener noreferrer">
                  Watch it
                </a>
              </>
            ) : null}
          </p>
          {item.tags ? (
            <span className="rm-tags">
              {item.tags.map((k) => <FeatureTag key={k} kind={k} />)}
            </span>
          ) : null}
        </div>
      </details>
    </li>
  )
}

export function RoadmapTimeline({ journeyTweetUrl }: { journeyTweetUrl: string }) {
  return (
    <section className="rm" aria-label="Roadmap: shipped, now, next, later">
      {/* Its own horizontal scroller: the page never pans sideways, the track
          does, one tier per snap. Focusable so a keyboard can scroll it. */}
      <div className="rm-scroll" tabIndex={0} role="region" aria-label="Roadmap tiers, scrolls sideways">
        <ol className="rm-track">
          {TIERS.map((t, i) => (
            <li key={t.id} className={`rm-tier is-${t.id}`} style={{ ['--i' as string]: i }}>
              <div className="rm-head">
                <span className="rm-rail" aria-hidden="true">
                  <span className="rm-node" />
                  {t.id === 'now' ? <span className="rm-here">We are here</span> : null}
                </span>
                <h2>{t.name}</h2>
                <p>
                  {t.note}
                  <span className="rm-count"> · {ITEMS[t.id].length + (t.id === 'shipped' ? EARLIER.length : 0)}</span>
                </p>
              </div>
              <ul className="rm-items">
                {ITEMS[t.id].map((item) => (
                  <RoadItem key={item.title} item={item} tier={t.id} tweetUrl={journeyTweetUrl} />
                ))}
              </ul>
              {t.id === 'shipped' ? (
                <details className="rm-earlier">
                  <summary>
                    <span>Before November</span>
                    <span className="rm-count">{EARLIER.length}</span>
                    <Chevron />
                  </summary>
                  <ul className="rm-items">
                    {EARLIER.map((item) => (
                      <RoadItem key={item.title} item={item} tier="shipped" tweetUrl={journeyTweetUrl} />
                    ))}
                  </ul>
                </details>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
