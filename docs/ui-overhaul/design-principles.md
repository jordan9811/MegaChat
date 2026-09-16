# MegaChat design principles (R3)

Fifteen principles for this product, each with a pass/fail test a verifier can run on a screenshot or a DOM census. Then the vibe-coded mistakes the overhaul must not make, each with a detector. Every principle carries one line on where the current site stands, with the file.

How this was grounded: the live site (https://megachat.fun, signed out) captured 2026-09-02 at 1280x720 and 375x812, plus a DOM census of computed `font-size` and `border-radius` on every leaf text node (script in the appendix), plus the source under `web/`. Paths below are relative to `C:/Users/jorda/mc-ui-overhaul/web/` unless they start with `docs/` or `design-assets/`. Baseline screenshots and axe/Lighthouse numbers live in `docs/ui-overhaul/baseline/`.

Three lenses, all required on every page, none dominant: L1 arcade/street (bigness, the moment), L2 polished tech company (engineered forms, one primary action), L3 Nerve (phone-native, live tension, money moving). The tests below reference them by number.

Preserved surfaces, token alignment only: the landing hero (`components/landing/landing-hero.tsx`), the Booth board (`components/booth/booth.tsx`), the logo (`design-assets/branding/wordmark-stacked-bubble-dark.jpg`: violet-to-magenta MEGA over white CHAT, chrome keyline, angular bubble with a tail).

---

## 0. The reference ladders the tests use

These are the values the tests below check against. R4 (tokens) may rename them; it may not add steps.

**Type ladder (px).** 11 micro (column heads, status pips; the only size where caps are allowed) / 12 hint / 13 label / 14 app body / 16 marketing body and input text / 18 row and card title / 22 app section title / 28 marketing section title, app h1 / 36 marketing h1, mobile display / 48 display (bounty totals, the statement line) / 64 hero (72 permitted on the film hero only). Weights: 500 body, 600 label, 700 title, 800 display. Line height 1.5 at 16 and under, 1.35 from 18 to 28, 1.1 from 36 up. Two families: Plus Jakarta Sans for everything, Archivo only at 48 and above. A page uses at most 7 steps (8 on the landing, which owns the hero size).

**Spacing ladder (px).** 4, 8, 12, 16, 24, 32, 48, 64, 96. Inside a component: 8, 12, 16. Between components: 16, 24. Between sections: 48 on app pages, 64 or 96 on marketing pages, one value per page, repeated. Gutters 16 / 24 / 64 at 375 / 768 / 1280.

**Radius ladder (px).** r1 = 4 (inputs, chips, segmented controls, buttons under 40px tall). r2 = 8 (buttons 44px and taller, tiles, cards). r3 = 12 (panels, dialogs, the video frame). Pill (9999) only on dots up to 12px and on avatars. Nested: inner radius = outer radius minus padding, floor 4. Nothing rectangular with a text label goes above 12. This is the "soften without going bubbly" instruction made numeric: Jordan chose Prestige (2px corners, editorial) in round 1 and rejected FomoCut (999px pills) and Impact (18px comic corners).

**Color roles (names only; hexes are R4's job).** `ground-0` page, `ground-1` panel, `ground-2` sunk/input. `ink-0` text, `ink-1` muted, `ink-2` dim, `ink-3` faint, all AA on `ground-0`. `rule-0` hairline, `rule-1` border. `primary` + `primary-ink`: the one filled button, focus ring, selected tab; candidate is a violet that sits beside the logo's violet-to-magenta. `secondary`: informational accent (kickers, selected filter, links); candidate is the Chargers powder blue. `live` green, `queue` yellow (the Chargers yellow can be this), `danger` a coral red that is not the primary. `data-1..5`: the neon-pastel set (blue, yellow, green, red, violet) used only inside bars, charts, legends and the numbers those bars label. Black stays the base; the fix is more roles, not a lighter ground.

**Motion budgets.** Hover: one property, 150ms or less, 2px or less of travel. State change: 250ms or less. Entrance: 400ms per element, 600ms for the whole page, once per load. Money moved: tabular digit tick plus a 200ms color flash on the changed number. Seat taken or clip sent: one 250ms scale from 0.98 to 1. Infinite loops: only the on-air dot (one cycle per 2s or slower) and a live meter. Everything is off under `prefers-reduced-motion`.

---

## 1. Principles

### P1. One type ladder, seven steps per page

Every rendered size sits on the ladder in section 0 and a page uses at most seven of them.

**Test.** Run the census. PASS if every computed `font-size` on the page is a ladder value, no value has a fractional pixel, and there are 7 or fewer distinct values (8 on the landing). Screenshot version: pick any three headings of the same rank on a page; they must be the same size and weight.

**Current site: FAIL on every page.** The landing renders 16 distinct sizes, seven of them fractional (10.5, 11.5, 12.5, 13.5, 14.5, 15.5, 16.5px, all `text-[Npx]` arbitraries in `components/landing/landing.tsx`); create-room renders 14, /bounty 12, /join 11, how-it-works 10. No `--fs-*` token exists anywhere.

### P2. Spacing on the 4-grid, one section rhythm per page

Every gap is a ladder value and section-to-section gaps repeat.

**Test.** Measure the vertical gap between each pair of consecutive sections and between siblings inside any component. PASS if every gap is on the ladder, all section gaps on one page are within one step of each other, no gap exceeds 96px (128px allowed between the hero and the first section), and a section's top padding equals its bottom padding unless a rule separates the sections.

**Current site: FAIL on the landing, PASS on create-room.** The landing's five sections use five different padding pairs (`pt-12/pb-8`, `pt-16/pb-10`, `pt-6/pb-16`, `pt-2/pb-16`, `pt-10/pb-20`, `components/landing/landing.tsx` lines 212, 240, 260, 326, 382), so section gaps run 72 / 80 / 88 / 104 / 120px. Create-room holds `gap-4`/`gap-6` throughout (`components/create-room/create-room.tsx`); /bounty rows are 16-18px but the demand card uses `py-[22px]` (`components/bounty/bounty-program.tsx`).

### P3. Three radii, no pills on words

Corners come from a three-step scale; a label never sits inside a pill.

**Test.** Run the census on `border-radius`, ignoring 50% and 9999px on elements 24px or smaller. PASS if there are 3 or fewer distinct values, every button and input uses r1 or r2 consistently by height, no element with a text label has a radius of half its height or more, and any card's radius is larger than the radius of the inputs inside it.

**Current site: FAIL by omission.** The app pages return an empty radius census (/bounty `{}`, how-it-works `{}`, create-room only the 50% info dot): every corner is 0px, which is the "too square, rough around the edges" gripe, hard-coded in `app/bounty/bounty.css`, `components/create-room/create-room.css`, `components/booth/booth.css`. At the same time `app/globals.css` sets `--radius: 0.75rem` and `components/ui/button.tsx` ships `rounded-lg`, so the repo holds two radius systems and neither is a scale.

### P4. One filled primary per viewport

There is exactly one solid-primary element in any viewport that has an action.

**Test.** At 1280x720 and at 375x812, count elements filled with the primary color. PASS if the count is exactly 1 in every viewport that contains an action. Row actions and tile actions are outline, ghost, or neutral white. The header never carries a filled button on a page that has a primary in its body. A closing CTA pair on a marketing page is one filled plus one outline.

**Current site: PASS on the landing hero, FAIL on every app page.** Hero: `Enter MegaChat` filled, nav `Enter app` outlined (`components/landing/landing.tsx` 184-189, `landing-hero.tsx`). /bounty: five filled `.rowcta` plus a filled `Sign in` plus a filled `.btn` Start a pool, seven accent fills in one viewport (`app/bounty/bounty.css`). /join: a white-filled `Send a MegaChat` stacked on a red-filled `Join Stream` under a red-filled `Sign in` (`components/join/join-client.tsx` `primaryBtn` / `dopamineBtn`). Create-room: header `Sign in` and `Create room` share the same accent fill (`components/account-chip.tsx` `accent` prop, passed from every app page).

### P5. Every color has one job

The primary means "you can act here". Status colors mean status. Data colors live inside bars. Nothing else gets a hue.

**Test.** (a) The primary appears only on clickable elements, focus rings, and selected states. (b) `live`, `queue`, `danger` appear only on status text, dots, and bars. (c) `data-*` appear only inside bars and charts, their legends, and the numbers those bars label. (d) `grep -E '#[0-9a-f]{3,8}|rgba?\(|oklch\('` over `components/` and `app/**/*.tsx` returns nothing outside the token file. (e) No hue means both "selected" and "error". (f) At most two non-status accent hues are visible in any one viewport.

**Current site: FAIL on every page.** Create-room paints `#ff4d3d` as Sign in, Create room, the selected feature-card border and checkbox, the step-1 numeral, the "Key ·" labels, the key rail, and the `role="alert"` error text (`components/create-room/create-room.tsx` FeatureCard, `.stepnum`, `.keyrow`): one hue, seven jobs. The landing gives its four feature kickers four inline hexes used nowhere else (`#9b6bff`, `#c05ce0`, `#f0246f`, `#8fd8e4`; `landing.tsx` FEATURES) and runs a mint primary (`#8fd8e4`, `landing.css`) that the app never uses (`#ff4d3d`, `booth.css`), so the front door and the app disagree on what "act here" looks like. /bounty paints ranks 01-03 in the accent as decoration. Under all of it the `body` ground is the legacy plum `oklch(0.16 0.045 305)` from `app/globals.css`, visible in overscroll behind `#04070a` (landing) and `#08080a` (app): three blacks.

### P6. Money reads in one glance: unit, rate, total, what is real

A fan never has to compute, translate, or guess.

**Test.** For every price on screen: (1) the unit is `$` in the simple register or `USDC` in the advanced one, never a bridge suffix (`.e`), a chain name, or a tick (`/ 1s` is written `/s`); (2) a per-second rate has a human total within 40px (`$0.06 a minute`, `10s = $0.01`, `most you can spend $2`); (3) numbers in a column are `tabular-nums` and right-aligned; (4) money that can go elsewhere is never summed with money that cannot: two numbers, two labels, two colors, and the stacked bar's segments use those same two colors with its legend in the same viewport; (5) the refund rule sits within one viewport of any pay button; (6) at most four significant digits on display.

**Current site: PASS on create-room and /bounty, FAIL on /join, /app and the landing.** Create-room shows `$0.001 /s`, `10s = $0.01`, `$2 unused refunds` (`money()` in `create-room.tsx`). /bounty shows In escrow and Across pools as two labeled numbers, green locked vs yellow-hatch contested on the bar, a legend, and three refund lines (`bounty-program.tsx`, `bounty.css .track/.hatch`): the best money surface on the site. /join prints `0.001 USDC.e / 1s · cap 2 USDC.e · Tempo` (`join-client.tsx` `#priceLabel`). The /app rate chip and the landing table print `0 USDC.e / 1s` because `booth.tsx` RateChip and `landing.tsx` Rate render `paymentTokenSymbol` raw, and the advanced register is the default, so that is what a first visitor sees.

### P7. Motion has a job

Every animation confirms a state change, points at something newly live, or keeps spatial continuity. Nothing else moves.

**Test.** List every animation and transition on the page and assign it one of the three jobs; anything unassigned fails. Budgets from section 0 apply. Two screenshots of a static page taken 3s apart must be pixel-identical except for live data and the on-air dot. Hover changes one property in 150ms or less. The one place money moves in real time (the /join meter) must show it: the digit ticks and flashes.

**Current site: FAIL.** The join meter is a static table that is `display:none` until live and gives no feedback when a number changes (`join-client.tsx` `#meter`), so the one animation with a job does not exist. `app/globals.css` still ships `animate-float-slow` (6s infinite), `animate-neon-pulse` (2.4s infinite), `grab-rattle`, and three glow utilities. The landing entrance stacks four 700ms rises and a 900ms sweep that starts at 1.1s, about 2s total (`landing.css`). PASS: the Booth tile hover (`-translate-y-0.5`, `booth.tsx`) and the film hero (reduced-motion honored, pause control present, `landing-hero.tsx`).

### P8. Every page passes all three lenses

A page leads with one lens and still shows evidence of the other two.

**Test.** Fill a three-row ledger per page: one concrete element per lens with its pixel size. L1 is present if there is a display element of 36px or larger or the logo badge at 48px or taller. L2 is present if labels are 12-13px sentence case, inputs share one height (40-44px), columns sit on a grid, and the focus ring is visible. L3 is present if at least one live element (on-air dot, live count, ticking meter, video frame) is in the first viewport. PASS when all three rows are filled and the lead lens's element is the largest thing on the page. Crop test: cover the h1; the page must still read as MegaChat (L1), engineered (L2), and live (L3).

**Current site: PASS /app, FAIL /join, partial elsewhere.** /app: 34px tile names, a 48px chrome bar, an on-air dot with a live count (`booth.tsx`). /join is a settings form with a red button: no feed, no watchers, no live count, and the namesake action is the white secondary (`join-client.tsx`); it fails L1 and L3 outright. The landing has L1 (film, 72px) and L2 (tables) but nothing live below the fold: `OPEN SEATS` is static text (`landing.tsx` 305-316). /bounty has L1 (40px headline) and L2 (the table) but no L3 (no "last pledge 4m ago", no countdown). Create-room is strong L2, L1 only through red step numerals, L3 only through the preview tile's `ON AIR` chip.

### P9. Copy in three voices, none of them a Word document

Headlines announce, labels engineer, hints befriend.

**Test.** (a) Every h1/h2 is six words or fewer and contains a verb or a stake. (b) No all-caps heading longer than two words. (c) Body blocks are at most two sentences on marketing pages and one on app pages. (d) Zero protocol nouns on fan-facing surfaces (TIP-1034, Arc, Tempo, Gateway, escrow, payment channel); they are allowed only under an "Under the hood" heading on how-it-works and on /account. (e) Swap test: replace "MegaChat" with "Twitch"; if the sentence still works, rewrite it. (f) The landing above the fold and the join page each use "MegaChat" as a countable noun and say in one line why it is bigger than a superchat. (g) Banned: seamless, effortless, powerful, unlock, elevate, experience, journey, ecosystem.

**Current site: FAIL on the landing, how-it-works and /join; PASS on /bounty and create-room.** Landing h2s: `THE ONLY CHAT THAT PAYS YOU BACK IN AIR TIME` (nine words, caps), `HOW A SEAT WORKS`, `ON THE BOARD`, `HELD FOR STREAMERS` (`landing.tsx` 214, 241, 262, 328), and "MegaChat" never appears as a unit; "superchat" appears nowhere on the site. The feature rows are a table of kicker-plus-paragraph, which is the "reads like a Word document" gripe in structural form. How-it-works ships `TIP-1034 payment channels`, `Arc Testnet USDC`, `Gateway prepays` (`app/how-it-works/page.tsx` 150, 182, 178). /join ships `· Tempo` in the price line. PASS: `Parasocial is a design flaw.` (landing), `Your favorite streamer doesn't even know you.` (/bounty), and every create-room label and hint (`Nothing charges anyone until you go live.`).

### P10. Thumb-first: 44px targets, primary within reach

At phone width every target is a thumb target and the primary action is never a scroll away.

**Test.** At 375x812: every interactive element has a hit area of at least 44x44 CSS px (text links get padding, not bigger type); adjacent targets are at least 8px apart; the page primary is visible without scrolling or is sticky at the bottom; the header is 56px or shorter with at most three items and no wrapping; no horizontal scroll.

**Current site: FAIL on every page measured.** Landing: `Watch the film` is 119x21, footer links are 20px tall, `Full walkthrough + FAQ` is 19px (`landing-hero.tsx`, `landing.tsx`). /app: `0 rooms on air` and `On air` wrap to two lines inside the 48px bar and `All` is 15px wide (`booth.tsx` header `h-12` with five items). /bounty: `Put money on it` 125x38, `Sign in` 69x34 (`bounty.css .rowcta` 9px 14px padding). Create-room: stepper buttons 26x26, info dot 15x15, segmented buttons 29px tall (`create-room.css .stepbtn/.seg/.infodot`), and `Create room` sits roughly 2,000px down with no sticky bar. /join: `Sign in` 69x34, the MetaMask and Fund wallet buttons 36px tall.

### P11. Three states per data region, no layout jump

Every region that loads data has a designed loading, empty, and error state, and none of them moves the page.

**Test.** For each data region: loading is a skeleton in the shape of the content (rows for a table, tiles for the wall), never a lone grey slab or a spinner; empty is one sentence about what belongs here plus one action, filled only if it is the page primary; error says what happened and offers retry. The region's bounding box in loading vs loaded differs by 8px or less.

**Current site: PASS on /app and the landing empties, FAIL on /bounty loading and /join.** /app empty: `The first tile on this wall is yours.` plus Open a room (`booth.tsx`); landing empties: dashed box plus CTA. /bounty loading is one `h-40 animate-pulse bg-white/5` slab standing in for a five-column table (`bounty-program.tsx`). /join's meter is `display:none` until live and pops in, and the camera state is text only (`Requesting camera…`). PASS: /join's `No broadcast preview in this room` copy; the account chip's 92x31 skeleton matches its loaded size (`account-chip.tsx`).

### P12. One big moment per page, and the namesake gets it

Each page has one display-scale element, and where a MegaChat can be bought, the MegaChat action is the biggest thing you can press.

**Test.** Exactly one text element at 36px or larger per page; the second-largest text is at most 60% of it. On any page where a MegaChat is purchasable, the MegaChat action is the largest interactive element and carries the primary fill.

**Current site: FAIL on the landing and /join, PASS on /bounty and /app.** The landing runs a 72px hero and then a 64px `Parasocial is a design flaw.` (`landing.tsx` 383): two heroes competing. On /join, `Send a MegaChat` is the white secondary under a bigger red `Join Stream` (`join-client.tsx` `primaryBtn` vs `dopamineBtn`): the product's namesake is the runner-up on its own purchase page. /bounty: 40px h1 over 26px totals. /app: the 34px hero-tile name.

### P13. Minimum path: price before sign-in, three taps to a seat

Nobody hunts, nobody logs in to look.

**Test.** From `/`, a first visitor reaches a visible price in two taps or fewer and a pay button in three. From `/app`, any tile is one tap to its join page. Watching and seeing a price never require sign-in. Every list row is one click target (the whole row), not a button inside a row inside a link. No path lands on the legacy skin.

**Current site: PASS with one leak.** `/` to `Enter MegaChat` to a tile to `/join` is three taps with the price on the tile and again above the sign-in button; /bounty rows are single anchors. The leak: `/app` sends `+N more rooms` to `/legacy#browse` (`booth.tsx`), a dead end into the old theme.

### P14. One token sheet, zero page palettes

Colors, type, space and radius are declared once and consumed everywhere.

**Test.** `grep -rE '#[0-9a-f]{3,8}|rgba?\(|oklch\(' components app --include=*.tsx --include=*.css` returns matches only in the token file. Each role token is declared exactly once. No page overrides document chrome (`scrollbar-color`, `color-scheme`) with `:has()`. The `body` background equals `ground-0`.

**Current site: FAIL.** Seven scoped palettes: `--mcl-*` (`landing.css`), `--mcb-*` (`booth.css`), `--mcc-*` declared separately in `create-room.css`, `bounty.css`, `how-it-works.css`, `account.css`, and `--mcj-*` (`join.css`), already drifting (`--mcl-muted #b9c2c6` vs `--mcc-muted #b9c1c8`; landing ground `#04070a` vs app `#08080a`). A 15-line `html:has(.mc-x)` scrollbar override is copied into six files. `app/globals.css` still defines the legacy plum/magenta theme, glow utilities and bloom gradients that nothing in the overhaul uses.

### P15. AA contrast and a visible focus ring everywhere

Legible on black is a floor, not a feature.

**Test.** All text 4.5:1 or better against its ground (3:1 for bold text 24px and up); filled-button labels 4.5:1 on the fill; status colors 3:1; a 2px ring with 2px offset on every focusable element; keyboard order matches visual order.

**Current site: PASS, fragile.** The landing raised its faint ink to `#8b969b` for AA (`landing.css` comment); `#ff4d3d` on `#08080a` is about 6:1; baseline axe reports 0 critical or serious on landing, /app, /bounty and 1 serious on how-it-works (`docs/ui-overhaul/baseline/audits.md`). Each scope declares its own ring, which is why it works today and why it will regress the first time a new scope forgets (see P14).

---

## 2. Vibe-coded mistakes and how to detect them

| # | Mistake | Detector | Current site |
|---|---|---|---|
| A1 | Oversized rounded buttons | Any labeled button taller than 56px at desktop, or radius at or above half its height, or vertical padding above 1.2x the font size. | Clean of pills. `/join` `Join Stream` is 58px tall at 17px type (`py-4`), just over. |
| A2 | Equal-weight CTAs | Two or more filled buttons of similar size in one viewport. | `/join` (white and red, both full width); `/bounty` (seven red); create-room header vs body. |
| A3 | Gradient soup | More than one gradient with three or more stops per viewport; any gradient on text; any gradient as a card ground. Allowed: a scrim that makes text legible over media, and the logo. | `globals.css` `.bg-noir` (three radial blooms), `.chromatic`, `.text-glow-magenta`. Overhaul pages use only scrims and the six mesh placeholders (`booth.css`), which are acceptable as stand-ins for a missing feed. |
| A4 | Orphan spacing | A gap not on the ladder; a section whose top and bottom padding differ with no rule between; a gap above 1.5x the page's section rhythm. | Landing sections (P2); `/bounty` 22px card padding; `/app` mixes 28px between sections with 12px inside. |
| A5 | Inconsistent radii | More than three radius values; an inner radius equal to or larger than its container's. | Two systems: 0px on app pages, 12px in `globals.css` and `ui/button.tsx`. |
| A6 | No type scale | More than eight sizes per page; fractional pixels; sizes 1px apart doing different jobs (15 / 16 / 16.5 on the landing). | Landing 16 sizes, create-room 14. |
| A7 | Decorative motion | Infinite keyframes on a non-live element; entrance above 600ms; hover scale other than 1; breathing glows. | `globals.css` float and pulse; landing 2s entrance; the class name `dopamine-btn` promises a pulse (`join.css` 701) that is currently, correctly, a flat fill. |
| A8 | Glassmorphism by default | `backdrop-filter` on anything not floating over media; translucent white-alpha cards on a flat ground. | `components/glass-card.tsx` (`rounded-2xl bg-card/70 shadow-xl backdrop-blur-md`) is still in the tree for the legacy dashboard. Overhaul pages are clean; the account dropdown is solid `#101014`. |
| A9 | Icon-per-bullet | Three or more sibling items each with a 16-24px stroke icon plus title plus body where the icons could be shuffled without loss. Color-per-bullet is the same disease. | `/app` "How you get on a stream" (three cards, icon plus color plus arrow, `booth.tsx` WAYS_IN); how-it-works puts twelve lucide icons on twelve steps (`page.tsx` 48-114); the landing uses four colors as bullets. |
| A10 | Copy that could describe any product | Swap test (P9e); banned-word count; generic headings (`How it works`, `Features`, `Why us`). | `How MegaChat works` is the generic heading. Body copy is mostly specific (per second, seats, refunds) but "MegaChat" is undefined on the front door. |
| A11 | Emoji as icons | Any emoji inside a button, label, heading, or status. | `/join`: 🔐 🦊 💧 📼 🎬 in five buttons (`join-client.tsx`, `lib/join-page.ts`). They render differently per OS and cannot take the theme. |
| A12 | Raw data in the UI | Token tickers with suffixes, chain names, contract addresses, `/ 1s`, unformatted decimals, `—` in a loaded state. | `USDC.e`, `Tempo`, `/ 1s` on `/join`, `/app` and the landing; a 44-character pump.fun mint shown as a streamer name on `/bounty` row 05 with nothing saying it is a token. |
| A13 | The header's competing button | A filled-accent `Sign in` in the top bar on a page that has its own primary. | Create-room, `/bounty`, `/join`, how-it-works (`account-chip.tsx` `accent` prop). |
| A14 | Neon glow as hierarchy | `text-shadow` or colored `box-shadow` with blur above 8px; `-webkit-text-stroke` on body text. | `globals.css` `.text-glow-magenta`, `.glow-magenta/.glow-lime/.glow-cyan`, `.graffiti-tag` (five-layer text-shadow), all still in the bundle. |
| A15 | Truncating the thing you came for | Ellipsis on a primary label at 1280px or wider; a room or streamer name cut under 12 characters on mobile. | `/app`: `MegaChat Demo — try everyth…` at 1280, `HERRRRRO…` at 375 (`booth.tsx` `truncate` on 24/34px names). |
| A16 | All-caps micro-label carpet | More than five uppercase tracked labels in one viewport. | Landing, first viewport after the hero: `COMPATIBLE WITH`, four kickers, five column heads, three status pips: thirteen. |
| A17 | Per-page palettes and theme fights | The same role token declared in more than one file; `:has()` overrides of document chrome. | P14: seven palettes, six scrollbar overrides. |

---

## 3. Scorecard: current site by principle and page

P = pass, F = fail, ~ = partial, n/a = principle does not apply, nm = not measured.

| | Landing | /app | Create room | /join | /bounty | How it works |
|---|---|---|---|---|---|---|
| P1 type ladder | F (16 sizes) | F (11) | F (14) | F (11) | F (12) | F (10) |
| P2 spacing rhythm | F | ~ | P | P | ~ | P |
| P3 radius scale | F (0px) | F (0px) | F (0px) | F (0px) | F (0px) | F (0px) |
| P4 one primary | P | F | F | F | F | ~ (only `Sign in`) |
| P5 color roles | F | F | F | F | F | F (accent numerals) |
| P6 money | F (`USDC.e / 1s`) | F | P | F | P | n/a |
| P7 motion | F (2s entrance) | P | n/a | F (silent meter) | P | P |
| P8 three lenses | ~ | P | ~ | F | ~ | ~ |
| P9 copy | F | P | P | F | P | F |
| P10 thumb targets | F | F | F | F | F | nm |
| P11 three states | P | P | n/a | F | F | n/a |
| P12 one big moment | F | P | P | F | P | P |
| P13 minimum path | P | ~ (`/legacy` leak) | n/a | P | P | n/a |
| P14 one token sheet | F | F | F | F | F | F |
| P15 contrast + focus | P | P | P | P | P | ~ (1 serious axe) |

Read across: P3, P5 and P14 fail everywhere and are the same defect seen three ways, which is why the token sheet is the first thing R4 builds. Read down: `/join` fails ten of thirteen applicable principles and is the L3 surface; it is where the overhaul's argument is won or lost.

---

## Appendix: the census

Paste into the console on any page. Leaf text nodes only, so wrappers do not double-count.

```js
(() => {
  const fs = {}, br = {}
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el)
    if (el.textContent.trim() && el.children.length === 0)
      fs[cs.fontSize] = (fs[cs.fontSize] || 0) + 1
    if (cs.borderRadius !== '0px')
      br[cs.borderRadius] = (br[cs.borderRadius] || 0) + 1
  }
  const filled = [...document.querySelectorAll('a,button')]
    .filter(b => getComputedStyle(b).backgroundColor !== 'rgba(0, 0, 0, 0)')
    .map(b => [b.textContent.trim().slice(0, 24), getComputedStyle(b).backgroundColor])
  const targets = [...document.querySelectorAll('a,button,input,select')]
    .map(el => { const r = el.getBoundingClientRect()
      return [el.textContent.trim().slice(0, 18) || el.getAttribute('aria-label') || el.tagName, Math.round(r.width), Math.round(r.height)] })
    .filter(t => t[2] > 0 && (t[1] < 44 || t[2] < 44))
  return { page: location.pathname, fontSizes: fs, radii: br, filled, smallTargets: targets }
})()
```

Numbers quoted in this document came from this script on 2026-09-02 at 1280x720 (desktop) and 375x812 (mobile, Android UA).
