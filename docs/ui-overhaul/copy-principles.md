# MegaChat copy principles (R5)

What makes a launch-site headline hit; then every heading and call to action on the seven surfaces rewritten three ways (SAFE, CONFIDENT, LOUD); then the lines that still read like a Word document, and why.

How this was grounded: the live site (https://megachat.fun, signed out, fetched 2026-09-02) and the source under `web/`. The landing, `/app`, `/how-it-works` and `/demo` render server-side and match source verbatim. `/bounty`, `/account` and the pool pages are client-rendered, so their strings come from source, cross-checked against the click-through in `docs/ui-overhaul/baseline/ideal-paths.md`, which saw the same lines on the live page. Paths below are relative to `C:/Users/jorda/mc-ui-overhaul/web/`. Line numbers are as of that date.

This document extends `docs/design/copy-bank.md`. Nothing marked "Live now" in the bank is rewritten here (the hero, the landing closer, the bounty headline). Three banked lines are promoted into rewrites below and are flagged where they appear. The tests every rewrite has to pass are P9 in `docs/ui-overhaul/design-principles.md`; they are restated in section 0 so this file stands on its own.

---

## 0. Ground rules

### The register, carried over from the bank

Surgical critique of what is broken, not a value proposition. Blame the platform's design, not the person using it. Concrete over abstract: a number, a cat's name, a robot reading a donation aloud. No pitch-deck vocabulary. Added here: no exclamation marks, no superlatives ("only", "best", "#1"), no emoji in any heading, label or button.

### What every tier has to pass (P9, restated)

- An h1 or h2 is six words or fewer and contains a verb or a stake. Card titles and step titles may be shorter noun phrases.
- No all-caps heading longer than two words. Caps are spent on the preserved hero and on two-word status chips (ON AIR, GO LIVE).
- The swap test: replace "MegaChat" with "Twitch". If the line still works, it is not our line.
- Zero protocol nouns on fan-facing surfaces: TIP-1034, Arc, Tempo, Gateway, escrow, payment channel, seed phrase. Allowed only under "Under the hood" on how-it-works and on /account.
- Banned words: seamless, effortless, powerful, unlock, elevate, experience, journey, ecosystem.
- Money reads as `$` in the simple register and `USDC` in the advanced one. Never `USDC.e`, never a chain name, never `/ 1s` (write `/s` or "a second").

### The three tiers

**SAFE.** Sentence case. Says what the thing is. Nothing you would have to defend. Passes L2 on its own. The fallback when a line sits beside a number or a control and its only job is orientation.

**CONFIDENT.** One idea. A verb or a stake, a concrete noun, sentence case, six words or fewer for h1/h2. Passes the bank's register. This is the default: the builder uses CONFIDENT unless a row is on the LOUD list below.

**LOUD.** The L1 register, in words rather than case. A dare, a stake, or a contrast with a period used as a beat ("Watching lags. You don't."). Still six words or fewer, still sentence case, still no exclamation marks. LOUD is not caps; the film hero already owns caps.

### Where LOUD is allowed

L1 leads on: the landing below the hero (rows L8, L15, L17), the bounty surfaces' headline moments (B6, B9, B14), /app's bounty heads (A10, A12), and the moment a MegaChat lands on the overlay (not in this document). Those rows take LOUD.

Everywhere else the builder takes CONFIDENT. On Create Room, Account, the join page's sign-in and wallet rows, and the how-it-works ledgers, the LOUD column is written down so the builder can see what "too far" looks like on that surface; it is not an option there.

### MegaChat is a noun, and it is bigger than a superchat

A MegaChat is a recorded clip, face and voice, that plays on the broadcast for every second the fan paid for. It is countable: send a MegaChat, three MegaChats waiting, a MegaChat lands. It is not a letter (the server's name for it), not a message, and on fan-facing surfaces not a clip (streamer-side, "clip" is fine: "Longest clip", "Who screens clips").

It is bigger than a superchat because a superchat is a line of text a bot reads out and a MegaChat is the fan on screen. The word "superchat" appears nowhere on the site today. It has to appear exactly twice: once in the first section after the hero (row L8, which should move up to sit directly under the works-with band) and once on the join page (under the MegaChat button, row J8). The canonical line, in three tiers:

- SAFE: MegaChats are bigger than superchats.
- CONFIDENT: Superchats get read. MegaChats get played.
- LOUD: Your $5 bought a robot voice.

### One name per thing

The site currently has four names for the live camera slot (Open mic, Join Stream, camera seat, Take a seat) and two for the product. Pick one each and hold it.

| The thing | Call it | Not |
|---|---|---|
| the recorded clip | a MegaChat | letter, message, clip (fan-side) |
| the live camera slot | a seat ("take a seat", "three seats") | Open mic, Join Stream, slot |
| money on a name | a bounty | pool (only for the pile itself: "the pool pays out") |
| the person streaming | the streamer | host, creator, channel |
| the person watching | you; a fan | viewer (as a kicker), user, contributor |
| what you watch | the stream, the broadcast | the feed, the channel |
| the rate | by the second, `$0.001/s` | per-second (as a noun), `/ 1s`, tick |
| the sign-in | sign in | log in, login, connect (wallets connect; people sign in) |

---

## 1. What makes a launch-site headline hit

Six principles. Each with a reference headline that does it and one that does not, from the eleven sites pulled in R1, then one line on where our own copy stands.

### 1. Specificity: a noun you can picture, a number you can check

**Does it.** Betr, "NO SWEAT ENTRIES UP TO $200": a dollar figure and a mechanism (your first entry cannot lose), nothing to interpret. PrizePicks, "Stack Player & Team Picks in One Lineup": names the actual feature that shipped that week, not the category it belongs to.

**Does not.** Linear, "The product development system for teams and agents": delete "Linear" and it could be Jira, Asana or Notion. Linear can afford a category label because the brand carries the specificity; MegaChat has no equity yet, so its headings have to carry it themselves. Luma, "Delightful events start here": an adjective and a location.

**Us.** "Your favorite streamer doesn't even know you." passes. "HOW A SEAT WORKS" passes barely (a seat is a picture). "Elsewhere", "Advanced settings" and "How MegaChat works" fail: nothing to picture, nothing to check.

### 2. Verb first: the reader is told what to do, or what happens

**Does it.** Underdog, "UNLEASH YOUR DOG": imperative, two beats, the product name folded into the verb phrase. Shotgun, "GRAB YOUR TICKET, MAKE MEMORIES". PrizePicks' second section, "Make your picks. On anything."

**Does not.** Stripe, "Financial infrastructure to grow your revenue.": a noun phrase with the verb buried in an infinitive; it describes an asset, not an action. Raycast, "Your shortcut to everything.": no verb at all. It survives as a tagline because "shortcut" is concrete, but nobody is told what to do, so the CTA ("Download for Mac") has to do all the work.

**Us.** "Take a seat", "Put money on it", "Leave whenever" pass. "Enter app", "Look up", "Session", "Viewers" fail.

### 3. One idea per line

**Does it.** Partiful, "Parties are back": one claim, three words; the subhead ("The easiest way to get your guests on the same page") does the explaining. Rocket League's subhead, "Hit the Pitch for the World Cup", is one instruction.

**Does not.** Marvel Rivals, "THE SUPER HERO TEAM-BASED PVP SHOOTER / ALL HEROES ARE FREE TO PLAY!": what it is and that it is free, stapled together with a slash. The second half is the headline; the first is a taxonomy. Stripe's subhead lists three verbs and a range ("from your first transaction to your billionth").

**Us.** "THE ONLY CHAT THAT PAYS YOU BACK IN AIR TIME" is three ideas (only, pays back, air time). "Nobody has a pool open yet" is one. Rule of thumb: if the line needs "and", a slash or a colon, it is two lines; give the second to the subhead or cut it.

### 4. Contrast with the old way

The headline names what the reader is doing now and offers the exit. This is the bank's register in headline form: blame the design of the old thing, not the person stuck in it.

**Does it.** Partiful, "Parties are back": implies they left (the old way was a Facebook event nobody opened). PrizePicks, "Make your picks. On anything.": against sportsbooks that decide what you may bet on. Our own preserved hero, "Skip the chat. Be the stream.": the old way in three words, the new in three. Our closer, "Parasocial is a design flaw.": the old way named as a defect.

**Does not.** Rocket League, "Hit the Pitch for the World Cup in Rocket League Season 23!": an announcement; there is no before. Linear and Stripe: no before, just a category. Luma: no before, just a feeling.

**Us.** "HOW A SEAT WORKS", "ON THE BOARD", "How MegaChat works": no before, so nothing to want. Every CONFIDENT and LOUD h1/h2 below has a before, stated or implied.

### 5. The CTA names what you get

**Does it.** "Create invite" (Partiful), "Claim Offer" (Betr), "Explore Picks" (PrizePicks), "Create Your First Event" (Luma), "Download for Mac" (Raycast): each ends on the object.

**Does not.** "SIGN UP" (Underdog), "LEARN MORE" (Rocket League), "Get started" (Stripe): the object is missing, so the button is a chore. Marvel Rivals' "PLAY NOW" gets away with it because playing is the product.

**Us.** "Take a seat", "Put money on it", "Send a MegaChat" name the object. "Enter app" does not. "Claim" on a fan-facing pool tile names the wrong object: fans do not claim, streamers do. "Open the create form" names the widget instead of the room.

### 6. Loud is word choice, not case

**Does it.** Underdog and Shotgun shout in caps because the whole page is a poster, L1 wall to wall. Betr shouts a number. PrizePicks and Partiful are L3 and never touch caps; their punch is a period used as a beat.

**Does not.** Rocket League's "LEARN MORE" is a soft verb in a loud costume. Marvel Rivals' twelve-word caps subhead is a paragraph in one.

**Us.** "THE ONLY CHAT THAT PAYS YOU BACK IN AIR TIME" is nine caps words and the flattest line on the landing. The LOUD column below never uses caps; it uses a stake ("$5"), a dare ("Say it to their face"), or a beat ("Watching lags. You don't.").

---

## 2. The rewrites

One row per heading or CTA (a row is one string, or one set that has to be authored together, like a button's state machine). "(hold)" in a cell means the current line is already that tier. Pipes are not used inside cells; a slash separates paired items, a middle dot separates a set.

### Landing (`components/landing/landing.tsx`)

Preserved, not rewritten: the film hero in `landing-hero.tsx` ("SKIP THE CHAT. BE THE STREAM.", "Camera seats on live broadcasts, billed by the second.", "Enter MegaChat", "Watch the film") and the closer ("Parasocial is a design flaw." / "You're more than a username.", copy bank, live). Nav and footer link labels (Rooms, Bounties, How it works, Roadmap, Contact) are labels and stay; "Legacy site" is the P13 leak and should be removed rather than reworded.

| # | Where | Current | SAFE | CONFIDENT | LOUD |
|---|---|---|---|---|---|
| L1 | nav CTA, outline, 184 | Enter app | Open the app | See who's live | Get on a stream |
| L2 | works-with band kicker, 200 | Compatible with | Works with | Plays on | Lands on |
| L3 | h2, 214 | HOW A SEAT WORKS | How a seat works | Three taps to a seat | Couch to broadcast in three taps |
| L4 | link beside L3, 216 | Full walkthrough + FAQ → | Every step and the FAQ → | The whole playbook → | Read the fine print → |
| L5 | step 01 title, 137 | Pick a live room | Pick a room | Pick a room that's on air | Pick your stream |
| L6 | step 02 title, 142 | Take a seat | Take a seat | Take a seat, billed by the second | Sit down on the broadcast |
| L7 | step 03 title, 147 | Leave whenever | Leave whenever | Leave, and the meter stops | Walk out mid-sentence |
| L8 | h2, 241 (the superchat line) | THE ONLY CHAT THAT PAYS YOU BACK IN AIR TIME | MegaChats are bigger than superchats. | Superchats get read. MegaChats get played. | Your $5 bought a robot voice. |
| L9 | feature row 1 kicker, 44 | SEATS | Seats | Three seats, on the broadcast | Three seats. One is yours. |
| L10 | feature row 2 kicker, 49 | THE METER | The meter | Billed by the second | The meter stops when you do |
| L11 | feature row 3 kicker, 54 | BOUNTIES | Bounties | Money on a name | Put a price on them |
| L12 | feature row 4 kicker, 59 | NO WALL | No sign-up wall | Watch without an account | Nobody logs in to look |
| L13 | h2 + sub, 262-263 | ON THE BOARD / Live from the directory | On the board / Updated live | On the board right now / Live, refreshes itself | Who's on right now / Live |
| L14 | empty board + CTA, 270-279 | No rooms on the board right now — the next one could be yours. / Open a room | No rooms on the board right now. / Open a room | The board is empty. The first tile is yours. / Open a room | Nobody's on. Fix that. / Open the first room |
| L15 | h2 + link, 328-331 | HELD FOR STREAMERS / The bounty board → | Bounties open / All bounties → | Streamers with money on their name / The whole board → | Wanted / Every name with a price → |
| L16 | empty bounties CTA, 344 | Start a pool | Start a pool | Put money on a name | Put a price on them |
| L17 | closer CTAs, 390-402 | Create a room / Browse rooms | Create a room / Browse rooms | Open a room / See who's live | Open your room / Get on a stream |
| L18 | closer microline, 404 | Bounties settle in USDC | Bounties settle in USDC | Paid in USDC. Unspent money comes back. | USDC in. Unspent USDC back. |

Notes.

- L8 is the one line P9(f) requires. Its subline at every tier: "A MegaChat is your face and voice on the broadcast, for every second you paid for." At LOUD the subline opens with the banked line first: "You just paid a robot $5 to read your name out loud." Move the section up to sit directly under the works-with band; a first visitor should meet the noun before the mechanism.
- L9 to L12 replace the kicker-plus-paragraph table (the "reads like a Word document" gripe in structural form) with a claim per row. The paragraphs underneath can stay.
- L1 stays outline; the hero's "Enter MegaChat" is the only filled button in that viewport (P4).
- L13's status pips (ON AIR, QUEUE, OPEN SEATS) and column heads stay: two-word caps labels inside the budget.

### The app board (`components/booth/booth.tsx`)

The Booth layout is preserved, so tile CTAs stay at two words and the rail keeps its two-line head. The sr-only h1 ("MegaChat rooms — n on air, n on the board") is for screen readers and holds. State chips (OPEN, ON AIR, FULL, OFF AIR · bounty open) hold.

| # | Where | Current | SAFE | CONFIDENT | LOUD |
|---|---|---|---|---|---|
| A1 | room tile CTA, open / full, 178-183 | Take a seat / Join queue | Join / Queue | Take a seat / Join the queue | Sit down / Get in line |
| A2 | pool tile CTA, 215 | Claim | Open | Back them | Stack it |
| A3 | invite tile, 224-231 | Open a room / Your stream, your seats, your rate. The next tile on this wall is yours. | Open a room / Your stream, your seats, your rate. | (hold) | Open a room / This tile is yours. |
| A4 | empty wall, 322-334 | Nothing on air right now · No rooms on the board yet / The first tile on this wall is yours. / Open a room | Nothing on air right now · No rooms yet / Open a room | (hold) | Empty wall. / Yours. / Open a room |
| A5 | overflow tile, 349-354 | +{n} more rooms | {n} more rooms | See all {n} rooms | {n} more on the wall |
| A6 | h2, 380 | How you get on a stream | Three ways onto a stream | Three ways onto the broadcast | Pick your way on |
| A7 | ways-in card 1, title / CTA, 13-25 | MegaChats / Find a room | MegaChats / Find a room | MegaChats / Pick a room, send one | Send a MegaChat / Send one now |
| A8 | ways-in card 2, 27-43 | Open mic / See who is open | Live seats / See open seats | Seats / See who has a seat open | Take a seat / Grab a seat |
| A9 | ways-in card 3, 45-57 | Bounties / Put money on a name | Bounties / See the board | Bounties / Put money on a name (hold) | Put a price on them / Name your streamer |
| A10 | h2 + link, 413-420 | Bounties / The bounty board → | Bounties / All bounties → | Money on a name / The whole board → | Wanted / Every name with a price → |
| A11 | empty bounties, 432-444 | Nobody has a pool open yet / Start a pool → | No bounties yet / Start a pool → | Nobody has money on them yet / Put money on a name → | Nobody's wanted yet. / Name the first → |
| A12 | rail h2, 456-460 | Held for streamers | Bounties | Money on a name | Wanted |
| A13 | rail empty, 464-468 | Start a pool for any streamer → | Start a pool → | Put money on any name → | Pick a name. Price it. → |
| A14 | rail trust line, 496-500 | Read back off the broadcast | Verified on the broadcast | Proof comes off the stream itself | Verified on air |

Notes.

- A2: "Claim" is the streamer's verb on a tile that fans press. A fan tapping it expects to claim money.
- A7 and A8 CTAs currently link to `/how-it-works`. A button that says "Find a room" has to land on a room (the on-air filter, or the first tile). The card body for A7 at LOUD is the banked line: "Everyone has a camera. Chat still wants 200 characters."
- A8 renames Open mic to Seats everywhere it appears (see section 0). SAFE keeps "Live seats" for a builder who cannot rename the feature this round.
- A14 is the only place on /app that says clips are verified; keep it, in plain words.

### Create Room (`components/create-room/create-room.tsx`)

L2 leads. The builder takes CONFIDENT on every row; LOUD is shown for calibration. Labels (Charging, MegaChat rate, Who screens clips, Longest clip, People on camera, Most a viewer can spend, Room password, the six tabs) are engineered labels and hold, except "Open mic" in the tab strip, which follows C4. The hint under the primary button ("Nothing charges anyone until you go live.") holds; it is the best line on the page.

| # | Where | Current | SAFE | CONFIDENT | LOUD |
|---|---|---|---|---|---|
| C1 | header page label | New room | New room | Open a room | Open your room |
| C2 | step 1 head (`stepnum` 1) | What runs in your room | What's on in your room | What runs in your room (hold) | What's for sale |
| C3 | feature card 1, title — blurb | MegaChats — fans pay per second of clip, airs itself | MegaChats — recorded clips, priced per second, play on their own | MegaChats — fans record a clip, pay per second, it airs itself | MegaChats — their face on your broadcast, paid by the second |
| C4 | feature card 2, OPT IN | Open mic — viewers take camera seats beside you, billed per second | Open mic — a viewer takes a camera seat beside you, billed per second | Seats — a viewer sits beside you on camera, billed per second | Seats — someone from chat, on camera next to you, paying by the second |
| C5 | feature card 3 | Drops & rewards — pay people to watch, or credit toward MegaChats | Drops — pay viewers to watch | Drops — viewers earn cash or MegaChat credit for watching | Drops — pay them to stay |
| C6 | step 2 head (`stepnum` 2) | Advanced settings | More settings | Rates, screening, who gets in | Dial it in |
| C7 | save-defaults toggle | Save this setup as my defaults | Save as my defaults | Remember this setup for next time | Make this my default |
| C8 | primary button, idle / busy | Create room / Opening… | Create room / Creating… | Open the room / Opening… | Open the doors / Opening… |
| C9 | preview column head | Preview | Preview | What fans see | Your tile on the wall |
| C10 | join-card head | Join card | Join card | What it costs them | The price list |
| C11 | preview hint | Sample art — every number is your live configuration. | Sample art; the numbers are yours. | Placeholder art. The numbers are live from your settings. | Fake art, real numbers. |
| C12 | handle-clash CTA | Manage that room | Open that room | Go to that room | Go to that room |
| C13 | after create (`dashboard-shell.tsx` 47-52): kicker / h2 / body | Streamer dashboard / Your room / Share your links, watch viewers roll onto camera, and tune anything you set up. | Your room / {name} is open. | {name} is open / Share the link. Everything else is set. | {name} is open. / Now go get someone on it. |

Notes.

- C8: the button says "Create" while its busy state says "Opening…" and every other surface says "Open a room". CONFIDENT makes them agree.
- C13 is the confirmation the baseline walk found missing (`ideal-paths.md`, T5): a room is created and the page snaps back to a blank form. Whatever the builder does about the `?new=1` reset, the first heading after the primary button has to say the room exists and name it.

### Bounty

L1 leads on the headline moments (B6, B9, B14); the money rows are L2 and take CONFIDENT.

Held: the /bounty h1 "Your favorite streamer doesn't even know you." with "Be more than a username." (copy bank, live), the demand line under B6 ("Record a MegaChat, put money on it, and tell your favorite streamer to come claim it."), the three refund lines, the bar legend, "Before you pay", and every instructional head in the claim flow ("Handle claimed", "1. Add the overlay to OBS", "Keep the badge visible and readable", "2. Go live and play the MegaChats", "Under review"): those decide whether a streamer gets paid and they pass as written. The stat cards on the pool page ("Guaranteed to {handle} / theirs alone the moment they claim", "Contested", "Backers") hold.

**/bounty (`components/bounty/bounty-program.tsx`)**

| # | Where | Current | SAFE | CONFIDENT | LOUD |
|---|---|---|---|---|---|
| B1 | totals label 1 + sub, 301-306 | In escrow / real, counted once | Locked in / counted once | Real money / every pledge counted once | Real / counted once |
| B2 | totals label 2 + sub, 308-313 | Across pools / contested money counted per name | Across pools / contested money counted per name | On the board / contested money counted per name it's offered to | Advertised / contested money counted per name |
| B3 | empty table, 329 | Nobody has money on their name yet. Any handle can be the first. | No bounties yet. | (hold) | Nobody's wanted yet. Name someone. |
| B4 | row CTA, open pool, 239 | Put money on it | Pledge | Put money on it (hold) | Stack it |
| B5 | row CTA, claimed, 233 | Watch the room / See the pool | Open room / Open pool | Watch them / See the pool | They showed up → / See the pool |
| B6 | demand card head, 366 | Don't see them? Demand them. | Not on the board? Add them. | Don't see them? Demand them. (hold) | Demand them. |
| B7 | demand CTA, 395 | Start a pool | Start a pool | Put money on this name | Post the bounty |

**Pool page (`components/bounty/streamer-page.tsx`, still on the legacy skin)**

| # | Where | Current | SAFE | CONFIDENT | LOUD |
|---|---|---|---|---|---|
| B8 | sub under the handle h1, 117-121 | Everything on this page is waiting for them the day they claim this handle. | Waiting for them to claim this handle. | All of this is theirs the day they claim it. | Theirs the moment they show up. |
| B9 | primary CTA, 161-164 | 🎙 Record a MegaChat for {handle} | Record a MegaChat | Record a MegaChat for {handle} | Say it to {handle}'s face |
| B10 | secondary CTA, 166-169 | I am {handle} — claim this | This is me — claim | I'm {handle} — claim it | That's me. Claim it. |

**Record flow (`components/bounty/record-flow.tsx`)**

| # | Where | Current | SAFE | CONFIDENT | LOUD |
|---|---|---|---|---|---|
| B11 | h3, 193 | Record a MegaChat for {handle} | Record a MegaChat | Your MegaChat for {handle} | Camera's on. Say it. |
| B12 | preview CTA, 235-237 | Looks good — set the bounty | Next: set the bounty | Looks good — set the bounty (hold) | Keep it. Now the money. |
| B13 | pay CTA, 320 | Pay {amount} USDC & send | Pay {amount} USDC and send | Pay {amount} and send | Put {amount} on {handle} |
| B14 | done state, head / link, 327-333 | Sent 🎉 / View my contributions → | Sent. / See my bounties → | Sent. {handle} has a reason to show up. / Track it → | It's on the board. / Track it → |

**My bounties (`components/bounty/my-pledges.tsx`)**

| # | Where | Current | SAFE | CONFIDENT | LOUD |
|---|---|---|---|---|---|
| B15 | h1 + sub, 52-55 | My bounties / Every MegaChat you've pledged, where it is, and what happens next. | My bounties / (hold sub) | Your money on the board / Every MegaChat you've pledged, where it is, what happens next. | What you've got riding / (same sub) |
| B16 | lookup CTA, 59-62 | Look up | Look up | Find my pledges | Show me |

**Claim flow (`components/bounty/claim-flow.tsx`)**

| # | Where | Current | SAFE | CONFIDENT | LOUD |
|---|---|---|---|---|---|
| B17 | h3, 94 | Claim the {handle} bounty | Claim the {handle} bounty | Claim {handle} | It's yours. Claim it. |
| B18 | claim CTA, idle / busy, 133 | Claim this handle / Checking… | Claim this handle / Checking… | Claim it / Checking… | Claim it / Checking… |

Notes.

- B1 and B2 keep the two-numbers-never-summed rule from the board's own comment; the change is the vocabulary. "Escrow" is on the banned-noun list for fan surfaces; "Real / Advertised" says the same thing in the words a fan would use.
- B13 in the simple register reads "Pay $5 and send"; advanced reads "Pay 5 USDC and send" (P6). The ampersand goes.
- The bank retired the preview-build disclosure from /bounty, but it still ships in `record-flow.tsx` line 313 ("No real money moves in this preview build") and `claim-flow.tsx` 118-122 ("Identity check is stubbed in this build"). Same reasoning applies: these describe a state that will not exist when anyone sees the page.
- The pip "Seeded" (bounty-program.tsx 148) is repo jargon; "Listed by us" says who put it there.

### Account (`components/account/account-page.tsx`)

L2 leads; CONFIDENT throughout. "Sign in" holds at every tier. The handle h1 is data. The pip "PERMANENT" holds (two-word caps budget). Row labels (Link, Available, PROVIDER, ACCOUNT) hold. "Copy / Copied / Open" hold.

| # | Where | Current | SAFE | CONFIDENT | LOUD |
|---|---|---|---|---|---|
| K1 | signed-out h1, 152 | Sign in to see your account | Sign in to see your account | Your handle and balance live here | Sign in. It's all here. |
| K2 | wallet-only h1, 210 | Wallet only | Wallet only | No handle yet | Claim a handle |
| K3 | h2, 222 | Linked sign-ins | Linked sign-ins | Ways you sign in | Ways in |
| K4 | h2, 252 | Default room settings | Default room settings | How your rooms start | Your house rules |
| K5 | CTA, 279-281 | Open the create form | Open a room | Open a room with these | Open a room |
| K6 | CTA, idle / busy, 283-291 | Clear defaults / Clearing… | Clear / Clearing… | Reset to stock / Resetting… | Wipe them / Wiping… |
| K7 | h2, 303 | Balance | Balance | Balance (hold) | Your stack |
| K8 | CTA, idle / busy, 337-347 | Connect balance / Connecting… | Connect wallet / Connecting… | Connect a wallet / Connecting… | Show my balance / Connecting… |
| K9 | h2, 352 | Elsewhere | Links | Go to | Jump to |
| K10 | h2 + hint, 375-378 | Session / Signs out of both halves — the site cookie and the wallet session. | Session / Signs you out of the site and the wallet. | Sign out / Signs you out here and out of the wallet. | The way out / Signs you out here and out of the wallet. |

Notes.

- K8 also fixes the same string in the header chip menu (`components/account-chip.tsx` 114). You connect a wallet; you see a balance.
- K10 CONFIDENT makes the h2 and the button say the same word, which is fine: the hint carries the only information ("here and out of the wallet").

### How it works (`app/how-it-works/page.tsx`)

L2 leads on the ledgers and the rails; the CTA band (H27, H28) is the one L1 moment and may take LOUD. Kickers ("The playbook", "The clock", "Under the hood", "Questions") are labels and hold; "Step by step", used twice, becomes "Six steps". FAQ questions are questions and hold.

| # | Where | Current | SAFE | CONFIDENT | LOUD |
|---|---|---|---|---|---|
| H1 | h1, 304-306 | How MegaChat works | How a MegaChat works | How you get on the broadcast | Couch to broadcast in six steps |
| H2 | h2, 317 | Viewers | For viewers | Getting on, as a viewer | You, on the stream |
| H3 | h2, 322 | Streamers | For streamers | Running a room, as a streamer | You, running the room |
| H4 | viewer step 01, 50 | Find a room | Find a room | Pick a room that's on air | Pick your stream |
| H5 | viewer step 02, 55 | One tap, no seed phrase | Sign in with one tap | Sign in like any other app | One tap. No crypto homework. |
| H6 | viewer step 03, 62 | Authorize your session | Approve a spend cap | Set the most you'll spend | Cap it. Once. |
| H7 | viewer step 04, 69 | Camera check | Camera check | Check your camera | Camera check |
| H8 | viewer step 05, 74 | You are the stream | Go live | You're on the broadcast | You are the stream |
| H9 | viewer step 06, 79 | Leave whenever | Leave whenever | Leave, and the meter stops | Walk out mid-sentence |
| H10 | streamer step 01, 87 | Create your room | Open a room | Open your room | Open the doors |
| H11 | streamer step 02, 92 | Price your seats | Set your rates | Price your seats (hold) | Name your price |
| H12 | streamer step 03, 99 | Drop the overlay into OBS | Add the overlay to OBS | Drop the overlay into OBS (hold) | One browser source. Done. |
| H13 | streamer step 04, 104 | Share the join link | Share the join link | Post your link in chat | Drop the link in chat |
| H14 | streamer step 05, 109 | Run the room live | Manage the room | Run the room | Run the room |
| H15 | streamer step 06, 114 | Optional: watch-to-earn drops | Drops (optional) | Pay viewers to watch | Pay them to stay |
| H16 | h2, 329 | Why you're never actually late | Why you're never late | Why you're never actually late (hold) | The delay can't touch you |
| H17 | clock card 1, 128 | Spectating is delayed | Watching runs behind | Watching runs a few seconds behind | Watching lags. |
| H18 | clock card 2, 132 | Going live is instant | Going live is instant | You reach the streamer in under a second | You don't. |
| H19 | clock card 3, 137 | MegaChats skip the clock | MegaChats are recorded | MegaChats skip the clock (hold) | A MegaChat can't be late |
| H20 | h2, 375 | The rails it runs on | Under the hood | What moves the money | Where the money actually goes |
| H21 | rail 1, 145 | One-tap accounts | One-tap accounts | One tap, one account | No wallet homework |
| H22 | rail 2, 151 | True per-second settlement | Per-second billing | Billed by the second, literally | Every second, settled |
| H23 | rail 3, 157 | Unused money is your money | Unused money refunds | Unused money is your money (hold) | Unspent means refunded |
| H24 | rail 4, 163 | Prefer MetaMask? | MetaMask works too | Bring your own wallet | Got MetaMask? Fine. |
| H25 | stat strip, value / label, 40-45 | Per-second / USDC settlement · One tap / Passkey to live · 0 risk / Unused balance refunds · On-chain / Tempo network | Per second / billing · One tap / to go live · 100% / of unspent money back · USDC / the only unit | (same as SAFE) | (same as SAFE) |
| H26 | h2, 441 | FAQ | FAQ | Questions people ask | Before you ask |
| H27 | CTA band head, 463-465 | Put your face on the stream. | Ready when you are. | Pick a room. Take a seat. | Enough reading. |
| H28 | CTA band buttons, 467-476 | Browse rooms / Start a room | Browse rooms / Start a room | See who's live / Open a room | Get on a stream / Open your room |

Notes.

- H17 to H19 at LOUD read as one set: "Watching lags." / "You don't." / "A MegaChat can't be late."
- H25: "0 risk" is a claim a payments product should not print. "On-chain / Tempo network" is a protocol noun outside the "Under the hood" heading. The strip carries reference numbers, so one tier is enough.
- The sub under H1 (307-310) is addressed to streamers ("your live broadcast") while the h1 and the first ledger address viewers. Replace it with the superchat line: "A superchat gets your name read out. A MegaChat puts your face and voice on the broadcast, billed by the second, and the unspent part comes back."
- H27 currently duplicates the join page's h1 word for word.
- FAQ "Is this real money?" (177-179) answers with Arc Testnet and a Circle faucet while the product runs on Tempo; both are protocol nouns and the answer is stale. It should read: "Yes. USDC. Whatever you don't spend comes back to you." The chain belongs under "Under the hood".

### Join room (`components/join/join-client.tsx`, `lib/join-page.ts`, `app/join/page.tsx`)

L3 leads. This is the page the design principles single out as where the overhaul is won or lost (P8, P12), and it is the page with the most Word-document copy per square inch. CONFIDENT on every row except J3 and J8, where LOUD is on the table. Every emoji goes (design principles A11), including the stinger option names. Holds: "Display name" with "e.g. couch_goblin" (the one joke on the page, and it works), the meter labels (Remaining, Spent, Time left, Earned), the camera statuses, the no-preview idle copy, "Headphones recommended", and "Preview — how you'll hit the stream" with "Replay".

| # | Where | Current | SAFE | CONFIDENT | LOUD |
|---|---|---|---|---|---|
| J1 | header page label, `app/join/page.tsx` 32 | Join on camera | Join | Get on camera | Get on |
| J2 | kicker, `join-client.tsx` 45 | Viewer | {Room name} | {Room name} · {n} on camera | {Room name} · ON AIR |
| J3 | h1, 46-48 | Put your face on the stream. | Get on {streamer}'s stream. | Put your face on {streamer}'s stream. | Quit the comment section. |
| J4 | sub, 49 | Pay by the second. | Billed by the second. Unused money comes back. | By the second. Leave, and it stops. | Every second costs. Every unused one refunds. |
| J5 | price line set, `join-page.ts` 265-285 | {p} USDC.e / 1s · cap {c} USDC.e · Tempo · per MegaChat · up to {n}s · recorded, plays once · Nothing is enabled in this room right now. | ${p}/s · most you can spend ${c} · a MegaChat · up to {n}s · plays once on the broadcast · This room isn't taking joins right now. | ${p} a second · ${c} max, unused refunds · a MegaChat, up to {n}s, plays once on the broadcast · This room isn't taking joins right now. | (same as CONFIDENT) |
| J6 | sign-in CTA, 209-211 and `join-page.ts` 486 | 🔐 Sign in — Google, email or passkey | Sign in | Sign in — Google, email or passkey | Sign in — Google, email or passkey |
| J7 | wallet row, 219-224 and `join-page.ts` 248 | 🦊 Connect MetaMask / 💧 Fund wallet · ➕ Add funds | Connect MetaMask / Add funds | Use MetaMask instead / Add funds | (same as CONFIDENT) |
| J8 | the MegaChat button, 233 and `join-page.ts` 1755-1757 | 📼 Send a MegaChat — {price} · — FREE | Record a MegaChat · {price} | Send a MegaChat — {price} | MegaChat them — {price} |
| J9 | recorder set, 239-254 and `join-page.ts` 1876-1900 | ⏺ Record / ⏹ Stop ({n}s) / ↺ Re-record / 📮 Send / Cancel | Record / Stop ({n}s) / Re-record / Send / Cancel | Record / Stop ({n}s left) / Re-record / Send for {price} / Cancel | Record / Stop ({n}s left) / Again / Send it — {price} / Cancel |
| J10 | seat button state machine, `join-page.ts` 373-379 | 🎬 Join Stream / ⏳ Processing… / ⏳ Waiting for camera — tap to cancel / 🎥 Go Live / 🔴 You're LIVE — tap to leave | Take a seat — {price}/s / Working… / Waiting for camera — tap to cancel / Go live / You're live — tap to leave | Take a seat — {price}/s / Setting up… / Waiting for your camera — tap to cancel / Go live / You're on — tap to leave | Sit down — {price}/s / Hold on… / Camera… tap to bail / GO LIVE / ON AIR — tap to leave |
| J11 | advanced disclosure, 275 | Advanced — on-stream entrance & exit | Entrance and exit | Your entrance and exit | How you hit the stream |

Notes.

- J2: the page never says whose room you are in. The kicker is where the room name belongs, with the live count beside it, which is also the L3 evidence the page is missing (P8).
- J3 LOUD is the banked "Quit the comment section." The CONFIDENT tier keeps the current line but names the streamer; unnamed, it is the same sentence as the how-it-works CTA band.
- J8 must be the largest interactive element on the page and carry the primary fill (P12). Under it, one line, the second and last place "superchat" appears on the site: "A superchat gets read out. This plays your face on the broadcast." LOUD's "MegaChat them" makes the product a verb; use it only if the builder is ready to hold it everywhere (the overlay stinger, the done state, social copy).
- J10 is the fourth name the site has for a seat. CONFIDENT uses "Take a seat" so the tile, the create-room preview and this button agree, and prints the rate on the button so the price is never more than a glance from the pay action (P6).
- J5 removes `USDC.e`, `Tempo` and `/ 1s` from the one line a first-time payer reads.

---

## 3. Lines that read like a Word document

The current line, where it is, and why it reads like a document instead of a page. Ordered by how much of the site they touch.

1. **How MegaChat works** (how-it-works h1). The generic heading. Swap the product name for any other and it still works; a document title, not a headline.
2. **Advanced settings** (create-room step 2). A menu item from 2004. It says nothing about what is inside (rates, screening, who gets in), so nobody opens it.
3. **Default room settings / Elsewhere / Session** (account h2s). A settings pane's table of contents. "Elsewhere" names nothing; "Session" is the implementation talking, and its hint ("both halves — the site cookie and the wallet session") is a code comment that escaped.
4. **Viewers / Streamers** under the running kicker **Step by step** (how-it-works). Chapter headings from a manual, running head included.
5. **Authorize your session** (how-it-works viewer step 03). An OAuth consent screen. What actually happens is that you decide the most you will spend.
6. **Optional: watch-to-earn drops** (streamer step 06). A form-field qualifier baked into a heading, plus a hyphenated compound nobody says aloud.
7. **Compatible with** (landing band). Vocabulary from the side of a printer box.
8. **Live from the directory** (landing). A directory is a filesystem. This is a list of people who are on air.
9. **Full walkthrough + FAQ →** (landing). Help-center nouns; a walkthrough is what you read when something is broken.
10. **Open the create form** (account). Names the widget, not the outcome. Nobody wants a form; they want a room.
11. **Sign in to see your account** (account, signed out). Describes the gate instead of what is behind it.
12. **Nothing is enabled in this room right now.** (join price line). System status in the passive voice; "enabled" is a checkbox word.
13. **Held for streamers** (landing h2, /app rail). Passive, and "held" is escrow-speak: it reads like a coat check.
14. **In escrow / Across pools** (bounty totals). Finance-desk labels; "escrow" is on the banned-noun list for fan surfaces. The precision underneath is right; the vocabulary is borrowed.
15. **Read back off the broadcast** (/app rail). A verification-pipeline phrase that leaked into a footer. Nobody outside the repo knows what "read back" means.
16. **True per-second settlement** and its body (how-it-works rail). "Settlement", "TIP-1034 payment channels", "signed off-chain vouchers": a whitepaper paragraph under a marketing heading. P9(d) allows the body under "Under the hood"; the heading itself should say the plain thing and let the body carry the jargon.
17. **Connect balance** (account, header chip). You connect a wallet and see a balance; the button fuses two nouns into a verb phrase nobody uses.
18. **Sample art — every number is your live configuration.** (create-room preview). "Configuration" is IT-department. The idea underneath, fake art with real numbers, is good.

Two lines overshoot the other way, into the Red Bull ad the brief warns about: **THE ONLY CHAT THAT PAYS YOU BACK IN AIR TIME** (nine caps words, a superlative, three ideas) and **0 risk** (a claim a payments product cannot make). And one preserved line to flag for whenever the hero is reopened: **Camera seats on live broadcasts, billed by the second.** is an invoice line under the best headline on the site. Not touched this round.

---

## 4. Additions to the copy bank

Lines coined here that are worth keeping findable, whether or not the builder picks them:

- Superchats get read. MegaChats get played. (L8 CONFIDENT; the canonical superchat line)
- Your $5 bought a robot voice. (L8 LOUD)
- Say it to their face. (B9 LOUD, with the handle)
- Wanted. (the bounty section head at LOUD: L15, A10, A12)
- Post the bounty. (B7 LOUD)
- Nobody logs in to look. (L12 LOUD)
- Walk out mid-sentence. (L7, H9 LOUD)
- Watching lags. You don't. (H17, H18 LOUD, as a pair)
- Fake art, real numbers. (C11 LOUD)
- Enough reading. (H27 LOUD)
- MegaChat them — {price}. (J8 LOUD; only if the verb is held everywhere)

Promoted from the bank's "approved, unused" list into rewrites: "You just paid a robot $5 to read your name out loud." (L8 LOUD subline), "Quit the comment section." (J3 LOUD), "Everyone has a camera. Chat still wants 200 characters." (A7 LOUD card body).

Not touched, per the bank: "Skip the chat. Be the stream.", "Parasocial is a design flaw." / "You're more than a username.", "Your favorite streamer doesn't even know you." / "Be more than a username.", and the demand line.
