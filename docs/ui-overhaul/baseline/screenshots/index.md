# UI overhaul baseline screenshots

Captured 2026-09-02 from https://megachat.fun with headless Chromium 151 (playwright 1.62.1), signed out, fresh context per capture, dark color scheme, deviceScaleFactor 1. 390 and 768 captured with mobile/touch emulation; 1440 as desktop. Each capture waited for `load`, then network idle (15s cap), then 3s; every `<video>` was paused before the shot. `-fold` is the viewport as first seen; `-full` is the full document after scrolling through once to mount lazy content.

Files sort in capture order: `01/02` = 390x844, `03/04` = 768x1024, `05/06` = 1440x900 (odd = fold, even = full). Where a page fits inside the viewport the fold and full files are byte-identical (noted below).

No page produced horizontal document overflow at any width. No page loaded unstyled (Inter loaded, 3-5 stylesheets attached, dark ground everywhere). No broken images.

## landing (`/?stay=1`, the marketing front door)

| File | Viewport | Note |
|---|---|---|
| `landing/01-390x844-fold.png` | 390x844 fold | Nav collapses to logo + "Enter app" only; Rooms/Bounties/How-it-works links are dropped with no menu. Hero copy is fine. "Compatible with" logo row wraps to two lines; the round replay button sits under the CTA row on the right. |
| `landing/02-390x844-full.png` | 390x844 full | "On the board" table is cramped: room names truncate ("HERRRRRO KRIST..."), the rate cell wraps to three lines ("0.001 / USDC.e / / 1s") and STATUS wraps to two. Bounty rows keep the platform tag squeezed next to the name. Otherwise clean. |
| `landing/03-768x1024-fold.png` | 768x1024 fold | Clean. Full nav present, hero video frame paused, logo row on one line. |
| `landing/04-768x1024-full.png` | 768x1024 full | Clean. Board table fits with five columns. |
| `landing/05-1440x900-fold.png` | 1440x900 fold | Clean. |
| `landing/06-1440x900-full.png` | 1440x900 full | Clean. Two-column feature lists, board and bounty tables all fit; nothing broken. |

## app (`/app`, the room board)

| File | Viewport | Note |
|---|---|---|
| `app/01-390x844-fold.png` | 390x844 fold | Header is overcrowded: "0 rooms on air", "On air" and "Sign in" each wrap to two lines; Bounties/How-it-works links dropped. Room card titles truncate ("HERRRRRO ...", "MegaChat Demo ..."). |
| `app/02-390x844-full.png` | 390x844 full | Same header issue. Below the cards the three "How you get on a stream" tiles and four bounty cards stack fine. Bottom "Held for streamers" strip is clipped on the right: the third and later entries are cut mid-word ("thread...", "ches...", "marti..."). |
| `app/03-768x1024-fold.png` | 768x1024 fold | BUG: the "Bounties" section shows only its heading; the four bounty cards render at ~0px height (grid `sm:grid-cols-2 lg:grid-cols-4` collapses at sm+), so the section is empty. Page ends at the "Held for streamers" strip and the lower ~25% of the viewport is blank. Room titles truncate ("MegaChat De..."). |
| `app/04-768x1024-full.png` | 768x1024 full | Identical to fold (page fits the viewport). Same empty Bounties section. |
| `app/05-1440x900-fold.png` | 1440x900 fold | Same BUG: Bounties heading with zero-height cards under it; "Held for streamers" strip carries the content instead and the lower ~17% of the viewport is blank. Layout otherwise fine (hero room tile + two stacked tiles + "Open a room" placeholder). |
| `app/06-1440x900-full.png` | 1440x900 full | Identical to fold (page fits the viewport). |

## create-room (`/dashboard?new=1`, Create Room)

| File | Viewport | Note |
|---|---|---|
| `create-room/01-390x844-fold.png` | 390x844 fold | Clean single column; the "Charging Paid/Free" toggle sits on its own row under the name field. |
| `create-room/02-390x844-full.png` | 390x844 full | Clean. Advanced-settings tab row wraps to two lines; "Create room" button renders dimmed (disabled until a name is entered, expected); Preview card stacks at the bottom. Signed-out 401s on `/api/account/*` are expected. |
| `create-room/03-768x1024-fold.png` | 768x1024 fold | Clean; rate / screening / longest-clip controls fit on one row. |
| `create-room/04-768x1024-full.png` | 768x1024 full | Clean. Preview stacks below the form with the join card. |
| `create-room/05-1440x900-fold.png` | 1440x900 fold | Clean two-column layout with sticky-looking Preview column on the right; fold cuts through "Save this setup as my defaults" (normal). |
| `create-room/06-1440x900-full.png` | 1440x900 full | Clean. Right column has ~500px of empty space below the preview card. |

## bounty (`/bounty`, the bounty leaderboard)

| File | Viewport | Note |
|---|---|---|
| `bounty/01-390x844-fold.png` | 390x844 fold | Clean. Escrow/pools stats stack vertically; first row's pledge bar spans the width. |
| `bounty/02-390x844-full.png` | 390x844 full | Clean. The pump.fun contract-address name truncates with an ellipsis ("GnBQjwQibzB9zFPHEGEhoi..."); "Start a pool" is dimmed (disabled without a handle, expected). |
| `bounty/03-768x1024-fold.png` | 768x1024 fold | Clean. |
| `bounty/04-768x1024-full.png` | 768x1024 full | Clean. The full pump.fun address fits on one line here. |
| `bounty/05-1440x900-fold.png` | 1440x900 fold | Clean table layout (# / Streamer / Pledged / Status + button); fold cuts through the "Demand them" card. |
| `bounty/06-1440x900-full.png` | 1440x900 full | Clean; pump.fun name truncates with ellipsis in the narrower streamer column. |

## account (`/account`, signed-out state)

| File | Viewport | Note |
|---|---|---|
| `account/01-390x844-fold.png` | 390x844 fold | Clean sign-in card; rest of the viewport is empty (expected signed-out state). |
| `account/02-390x844-full.png` | 390x844 full | Identical to fold. |
| `account/03-768x1024-fold.png` | 768x1024 fold | Clean; card is capped at ~620px and left-aligned, ~75% of the viewport empty. |
| `account/04-768x1024-full.png` | 768x1024 full | Identical to fold. |
| `account/05-1440x900-fold.png` | 1440x900 fold | Clean; small left-aligned card, most of the viewport empty. |
| `account/06-1440x900-full.png` | 1440x900 full | Identical to fold. |

## how-it-works (`/how-it-works`)

| File | Viewport | Note |
|---|---|---|
| `how-it-works/01-390x844-fold.png` | 390x844 fold | Clean; steps stack as icon+title over body copy. |
| `how-it-works/02-390x844-full.png` | 390x844 full | The "YOU → STREAMER → EVERYONE" pipe diagram is a fixed 560px SVG inside a 350px `overflow-x-auto` wrapper: it scrolls sideways but at rest the "EVERYONE" node and "broadcast · slight delay" label are cut off at the right edge with no visible affordance. Everything else (clock cards, rails, stat tiles, FAQ, footer) is clean. |
| `how-it-works/03-768x1024-fold.png` | 768x1024 fold | Clean two-column step rows. |
| `how-it-works/04-768x1024-full.png` | 768x1024 full | Clean; diagram fits. |
| `how-it-works/05-1440x900-fold.png` | 1440x900 fold | Clean, content column capped at ~1060px. |
| `how-it-works/06-1440x900-full.png` | 1440x900 full | Clean. |

## join (`/demo`, Join Room for the demo room)

| File | Viewport | Note |
|---|---|---|
| `join/01-390x844-fold.png` | 390x844 fold | Clean; "Send a MegaChat — 0.01 USDC.e" button label wraps to two lines. "No MetaMask detected" is dimmed (expected in headless). The broadcast-preview panel is not rendered at this width. |
| `join/02-390x844-full.png` | 390x844 full | Clean; join card ends with "Join Stream" and the Advanced disclosure. |
| `join/03-768x1024-fold.png` | 768x1024 fold | Clean centered card; no broadcast-preview panel at this width either; lower ~20% of viewport empty. |
| `join/04-768x1024-full.png` | 768x1024 full | Identical to fold. |
| `join/05-1440x900-fold.png` | 1440x900 fold | Clean two-column layout; left column shows the dashed "No broadcast preview in this room" placeholder (expected for the demo room), join card on the right. |
| `join/06-1440x900-full.png` | 1440x900 full | Identical to fold. |

## roadmap (`/roadmap`, legacy chrome, expected)

| File | Viewport | Note |
|---|---|---|
| `roadmap/01-390x844-fold.png` | 390x844 fold | Legacy neon-purple chrome (different nav: MegaChat wordmark, ADV pill, theme toggle, "Log in"); the SIMPLE/ADV toggle drops to just "ADV" at this width. Floating particle squares overlap the heading copy. Styled as intended for legacy. |
| `roadmap/02-390x844-full.png` | 390x844 full | Legacy chrome; timeline cards stack cleanly, footer is the legacy link list (Browse rooms / Bounties / Dashboard / How it works / Roadmap / FAQ / Contact). |
| `roadmap/03-768x1024-fold.png` | 768x1024 fold | Legacy chrome; clean. Decorative blurred blob is positioned off the left edge (clipped, not visible). |
| `roadmap/04-768x1024-full.png` | 768x1024 full | Legacy chrome; clean. |
| `roadmap/05-1440x900-fold.png` | 1440x900 fold | Legacy chrome; clean, content column centered at ~850px. |
| `roadmap/06-1440x900-full.png` | 1440x900 full | Legacy chrome; clean. |

## Things worth fixing (cross-page summary)

1. **`/app` at 768 and 1440: Bounties section is empty.** The four bounty cards are in the DOM but the `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4` grid renders them at 0-6px tall, so only the heading and the "Held for streamers" strip show. At 390 the same cards render at full height.
2. **`/app` at 390: header overcrowded** ("0 rooms on air", "On air", "Sign in" all wrap), and the bottom "Held for streamers" strip is clipped mid-word on the right.
3. **`/how-it-works` at 390: pipe diagram cut off.** Fixed 560px SVG in a 350px horizontal-scroll wrapper; the "EVERYONE" end of the diagram is off-screen at rest.
4. **Landing at 390: "On the board" table** truncates room names and wraps the rate cell to three lines.
5. Nav links (Rooms / Bounties / How it works) disappear at 390 on the landing page and the app board with no hamburger or drawer replacing them.
6. Secondary observations, not bugs: `/account` and `/demo` leave most of the viewport empty at 768/1440; `/dashboard?new=1` at 1440 has a tall empty area under the Preview column; `/bounty` truncates the pump.fun address at 390 and 1440 but shows it whole at 768.
