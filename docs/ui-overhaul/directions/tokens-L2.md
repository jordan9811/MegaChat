# Tokens, lens L2: polished tech company

Round 4 brand translation. This is the token set MegaChat would get if the Linear / Vercel / Stripe / Raycast lens owned the whole site. It is written to be merged against L1 (arcade) and L3 (Nerve), not to win. Every value is a hex; every contrast figure was computed in Chromium, not asserted.

Proof page (a real HTML reference implementation of the tokens, with the logo in a nav strip):
`docs/ui-overhaul/directions/L2/tokens-L2.html`

Screenshots, rendered with Playwright 1.62 / Chromium at 1x:

| What | Path |
|---|---|
| Logo test, nav strip, 1440 | `docs/ui-overhaul/directions/L2/L2-logo-test-1440.png` |
| Logo test, 2x zoom on the badge and the icon | `docs/ui-overhaul/directions/L2/L2-logo-zoom-2x.png` |
| Bounty stacked bars, 2x zoom | `docs/ui-overhaul/directions/L2/L2-bar-zoom-2x.png` |
| Full token sheet, 1440 x 900 | `docs/ui-overhaul/directions/L2/L2-tokens-1440.png` |
| Full token sheet, 768 x 1024 | `docs/ui-overhaul/directions/L2/L2-tokens-768.png` |
| Full token sheet, 390 x 844 | `docs/ui-overhaul/directions/L2/L2-tokens-390.png` |

Cropped logo assets used by the page: `L2/logo-badge.png`, `L2/logo-icon.png` (tight crops of the two JPGs in `video-stream/design-assets/branding/`; still opaque, see the logo verdict).

---

## The verdict in one paragraph

Black stays, but it stops being dead: every neutral carries a violet tint (OKLCH hue 285, chroma at or under 0.015) so the four surface layers read as indigo-black, the same family as the logo's own ground. Chargers powder blue `#7FC5FF` is the one action colour; nothing else is ever a filled button except gold. Chargers gold `#FFD63E` is money in play: queue, contested pledges, "across pools". Green `#5BE9AC` is live and success, one token. Danger is a pastel red `#FF7C84`, deliberately pink-leaning so nothing on the site is orange on black again. The logo's violet-to-magenta gradient is sampled straight off the badge (`#6A1FF4` to `#FF1C82`) and is reserved for identity: the wordmark, the "MEGA" typographic hit, the glow behind a MegaChat when it lands. Text never wears the gradient; two lifted tints (`#BAA4FF`, `#FF7CBD`) exist for the rare violet or magenta word. Data colours for the bounty bar are green solid (guaranteed), gold hatch (restaked), lavender (released), on a `#27272F` track, with the hatch as the colour-blind redundancy.

How this answers the three gripes:

- "Too black, one accent": four tinted surface layers plus a two-colour accent system (blue acts, gold warns) plus semantic green/red. Five hues in the system, at most two of them on screen in any one piece of chrome.
- "Orange on black is harsh": there is no orange anywhere in the set. The warmest thing on the site is the logo's magenta, and the UI never borrows it.
- "Too square, rough around the edges": four radii (4 / 6 / 8 / 12) with a hard ceiling; pills only for chips and avatars. Transitions get real durations and one easing family instead of `transition-colors` defaults.

---

## Type

Family stays Plus Jakarta Sans via `--font-ui` for everything, including headings; Archivo 800 stays on the landing hero headline only (preserved surface). One addition: a mono for machine strings.

```
--font-ui:   'Plus Jakarta Sans', system-ui, -apple-system, sans-serif
--font-mono: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace
```

Mono is for addresses, tx ids, handles shown as URLs, and rates shown as `0.001 USDC/s` inside inputs. It is never used for prose or headings.

Scale, 12 steps, 4px-rhythm sizes, negative tracking growing with size:

| Token | Size / line | Weight | Tracking | Used for |
|---|---|---|---|---|
| display-1 | 48 / 1.05 (36 on phone) | 800 | -0.03em | Landing statement, one per page |
| display-2 | 40 / 1.08 (32 on phone) | 800 | -0.03em | Section statement ("Parasocial is a design flaw.") |
| h1 | 32 / 1.15 (28 on phone) | 700 | -0.025em | Page title (bounty board, how it works) |
| h2 | 24 / 1.25 | 700 | -0.02em | Section head |
| h3 | 20 / 1.3 | 700 | -0.015em | Form step head, panel title |
| h4 | 17 / 1.35 | 600 | -0.01em | Card title, feature card label |
| body-lg | 16 / 1.55 | 400 | 0 | Marketing paragraphs |
| body | 15 / 1.5 | 400 | 0 | Default reading size |
| body-sm | 14 / 1.5 | 400 | 0 | Table cells, secondary copy |
| ui | 13 / 1.4 | 500 | 0 | Nav links, labels, button-sm, segmented controls |
| caption | 12 / 1.4 | 500 | 0 | Hints, meta, timestamps (fg-3) |
| micro | 11 / 1.3 | 600 | +0.08em, caps | Column heads and status pips. The only caps on the site. |

Weights: 400 body, 500 UI, 600 labels and emphasis, 700 headings and buttons, 800 display only. Never 300.

Rules:
- Buttons are 600 at 14 (md), 13 (sm), 15 (lg). Not 700 and not 800: an 800 button on a form reads as shouting.
- Money is fg-1 at the surrounding size, `font-variant-numeric: tabular-nums`, with the unit one step smaller in fg-3 (`600 USDC`). Money is not coloured unless it carries state (gold = contested, green = guaranteed).
- Caps are allowed at micro only, which matches the existing site rule (column heads, status pips). Section headings on the landing that are currently caps (`HOW A SEAT WORKS`) become sentence case at h2.
- Max measure 64ch for body, 40ch for hints.

---

## Spacing

4px base. Named steps, and the only ones allowed:

```
--s-1  4    --s-2  8    --s-3 12    --s-4 16    --s-5 20    --s-6 24
--s-8 32    --s-10 40   --s-12 48   --s-16 64   --s-24 96
```

Fixed component metrics:

| Thing | Value |
|---|---|
| Button height sm / md / lg | 32 / 36 / 44 |
| Button padding-x sm / md / lg | 12 / 16 / 20 |
| Input height | 36 (44 on phone for touch) |
| Input padding-x | 12 |
| Label to input gap | 6 |
| Input to hint gap | 6 |
| Field to field gap (vertical) | 16 |
| Card padding | 16 (20 on desktop for reading cards) |
| Page gutter phone / tablet / desktop | 24 / 40 / 64 |
| Max content width, forms and reading | 1200 |
| Max content width, boards (Booth, bounty table) | 1400 |
| Section padding (vertical) | 40 desktop, 32 phone |
| Nav height | 64 marketing, 56 app |

---

## Radius

```
--r-1   4px   checkbox, tag, hatch caps, tiny plates over video
--r-2   6px   button, input, segmented control, stepper, chip
--r-3   8px   card, panel, popover, table container, avatar, room tile in the wall
--r-4  12px   modal, sheet, toast, the featured room tile when it stands alone
--r-pill 999  account chip, status pill, avatar when circular
```

Ceiling is 12. Nothing gets 16 or 20; that is where "bubbly" starts. Nested radii: inner = outer minus padding, floored at r-1 (a 12px card with 16px padding holds 4px children, never 12px children).

---

## Colour roles

All neutrals share one hue (285) so surfaces, hairlines and text feel like one material. Contrast is against `bg-0` unless stated.

### Surfaces

| Token | Hex | Role |
|---|---|---|
| bg-0 | `#0B0B10` | Canvas. Also the logo's ground, within two RGB units. |
| bg-1 | `#13131A` | Panel: app nav, bounty table, form column |
| bg-2 | `#1C1C23` | Raised: cards, inputs at rest, chips, toasts |
| bg-3 | `#27272F` | Hover fill, segmented-control thumb, the bar track |
| scrim | `rgba(11,11,16,0.72)` | Over video and behind modals |

Rule: elevation is lightness plus a hairline, never a drop shadow, because shadows vanish on black. A surface is one step lighter than what it sits on, never two.

### Text

| Token | Hex | Ratio on bg-0 | Role |
|---|---|---|---|
| fg-1 | `#F3F3F7` | 17.7 | Headings, values, primary copy |
| fg-2 | `#BDBDC5` | 10.5 | Body on marketing pages, nav links, labels |
| fg-3 | `#92919A` | 6.3 | Hints, meta, column heads, units |
| fg-4 | `#63626B` | 3.3 | Placeholder and disabled only. Never copy, never a label. |

### Primary: Chargers powder blue

| Token | Hex | Notes |
|---|---|---|
| primary | `#7FC5FF` | 10.7:1 on bg-0. Filled buttons, links, focus, selected borders |
| primary-hover | `#98D3FF` | |
| primary-pressed | `#69B3F0` | |
| primary-ink | `#061A30` | Text on primary. 10.1:1 |
| primary-subtle | `rgba(127,197,255,0.12)` | Selected card fill, info banner |
| primary-border | `rgba(127,197,255,0.45)` | Selected card border, blue tag border |

Why blue and not the logo's violet: every product that holds money in the reference set (Stripe, Mercury, Coinbase) puts its action colour in the blue family, it is cool next to the logo's warm magenta so the two do not compete for the same hue, it is the Chargers anchor, and it is close enough to the landing's current mint (`#8FD8E4`) that the preserved hero barely moves.

### Secondary: Chargers gold

| Token | Hex | Notes |
|---|---|---|
| gold | `#FFD63E` | 13.9:1. Queue state, "Join queue" button, contested money, "across pools" |
| gold-hover | `#FFE161` | |
| gold-ink | `#301D00` | Text on gold. 11.5:1 |
| gold-subtle | `rgba(255,214,62,0.12)` | Warn banner fill |

Gold is the only other colour allowed on a filled button, and only when the action is a queue or a pledge into a contested pool. Ranks, headings, links never borrow it.

### Brand: from the logo

Sampled from `wordmark-stacked-bubble-dark.jpg`: the MEGA gradient runs `#651AF3` at top-left to `#FF1C83` at right through `#B21DBE`; CHAT is `#F1F0F5` to white; keyline `#C6C5CD` to `#A2A1A9`; ground `#0B0A12`.

| Token | Value | Role |
|---|---|---|
| brand-violet | `#6A1FF4` | Gradient start. 3.7:1, not text. |
| brand-magenta | `#FF1C82` | Gradient end. 5.4:1, not text. |
| brand-gradient | `linear-gradient(135deg, #6A1FF4 0%, #B21DBE 50%, #FF1C82 100%)` | Wordmark, "MEGA" typographic hit, the ring behind a landing MegaChat |
| brand-violet-text | `#BAA4FF` | 9.3:1. A violet word, at most one per view |
| brand-magenta-text | `#FF7CBD` | 8.4:1. A magenta word, same rule |
| brand-glow | `rgba(140,60,255,0.35)` | The glow the icon already carries; allowed behind the logo and behind a MegaChat as it lands, nowhere else |

Rule: brand is identity, not interface. No button, border, input or chart is ever violet or magenta. That is the single decision that keeps the logo the loudest object on any page.

### Semantic

| Token | Hex | Ink | Role |
|---|---|---|---|
| success / live | `#5BE9AC` | `#002112` (11.2:1) | On air, confirmed, guaranteed. 12.8:1 on bg-0 |
| warn | `#FFD63E` (= gold) | `#301D00` | Contested, queue, unsaved. Shares the gold token on purpose; a second yellow within 20 units would be a near-duplicate |
| danger | `#FF7C84` | `#290B0D` (7.4:1) | Errors, destructive, insufficient funds. 7.9:1 on bg-0 |
| info | `#7FC5FF` (= primary) | `#061A30` | Neutral notices |
| *-subtle | 12% of the hue over the surface | | Banner and tag fills |

Danger is used as text and border by default (`danger` on transparent with a 45% border), filled only on a confirm-destroy button.

### Data: the bounty stacked bar

| Token | Value | Meaning |
|---|---|---|
| data-guaranteed | `#5BE9AC` solid | Locked to this name |
| data-restaked | `#FFD63E`, drawn as `repeating-linear-gradient(135deg, #FFD63E 0 3px, rgba(255,214,62,0.22) 3px 6px)` | Also pledged to rivals; may never arrive |
| data-released | `#CEB6FC` solid | Already paid out (claimed pools) |
| data-track | `#27272F` | The total: track length is the sum |
| data-4 | `#FF9E84` | Spare series (earnings charts) |
| data-5 | `#7FC5FF` | Last resort series; never in a chart that sits beside a primary button |

Bar rules: 8px tall, r-1 ends, segments in the order guaranteed, restaked, released left to right. The three carry three lightnesses (L 0.84 / 0.89 / 0.80) and one carries a pattern, so the split survives a greyscale print and deuteranopia. The headline number is the sum in fg-1; the coloured figures underneath restate each segment in its own colour. Never blend into one coloured total. See `L2-bar-zoom-2x.png`.

Chart series order for anything else: guaranteed-green, gold, lavender, coral, blue.

---

## Hairlines and borders

```
--line-1  rgba(255,255,255,0.08)   rest       (flattens to ~#1F1F23 on bg-0, ~#26262C on bg-1)
--line-2  rgba(255,255,255,0.14)   hover, chips, ghost buttons   (~#2D2D32 on bg-0)
--line-3  rgba(255,255,255,0.24)   strong: checkbox rest, dashed invite tiles   (~#414146, 1.9:1)
--inset-top  inset 0 1px 0 rgba(255,255,255,0.04)   top highlight on bg-2 surfaces
```

- Always 1px. Never 2px except the focus ring.
- Alpha white, never a flat grey, so the same token works on all four surfaces.
- Tables use line-1 between rows and no vertical rules.
- Dashed borders are allowed for exactly one thing: the "open a room" invite tile.
- Selected / active borders use the role colour at 45% (`primary-border`), never the full colour; the full colour is for focus.
- Focus: `box-shadow: 0 0 0 3px rgba(127,197,255,0.4)` plus `border-color: primary` on inputs; `outline: 2px solid #7FC5FF; outline-offset: 2px` on everything else.

---

## Shadow and glow

Shadows are for things that float, glows are for things that carry state. Nothing at rest has either.

```
--shadow-float  0 12px 32px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06)   popover, toast, dropdown
--shadow-modal  0 24px 64px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.08)   modal, sheet
--glow-primary  0 0 0 1px rgba(127,197,255,0.4), 0 8px 24px rgba(127,197,255,0.18)   primary button on hover only
--ring          0 0 0 3px rgba(127,197,255,0.4)   focus
--brand-glow    rgba(140,60,255,0.35) as a 24px blur   behind the logo mark; behind a MegaChat while it lands (L1 owns that moment)
```

The live dot pulses a green ring (`rgba(91,233,172,0.5)` to 0 over 2s). It is the only infinite animation on the site.

---

## Motion

```
--dur-1 120ms   colour, border, opacity on hover
--dur-2 180ms   state changes: toggle thumb, segmented thumb, checkbox fill, focus ring
--dur-3 240ms   enter/exit: dropdown, popover, toast, tab panel crossfade
--dur-4 320ms   layout: sheet slide, panel expand (feature card opening), modal
--dur-reveal 600ms   page-load rise on the landing only, staggered 150/340/540/760ms as it is today
--ease-out    cubic-bezier(0.2, 0.7, 0.2, 1)   everything that enters or settles (already the landing's curve)
--ease-inout  cubic-bezier(0.4, 0, 0.2, 1)     things that move from A to B and stay
linear        progress, meters, the per-second counter
```

What may move and why:

- opacity, transform (translate up to 8px, scale 0.98 to 1.02), background-color, border-color, box-shadow. These are compositor-cheap and read as response, not decoration.
- height on exactly two things: feature-card expand on Create Room and the advanced-settings panel, at dur-4, because a jump-cut there hides which control just appeared.
- The per-second meter and balance: digits update in place with no animation. When a charge lands, the digit's background flashes `primary-subtle` for dur-3 and returns; when a refund lands, `success-subtle`. One pulse, never a loop, never a counter that "rolls" (rolling numbers feel like a slot machine, wrong for a page that takes money).
- Button press: translateY(1px) at dur-1. Hover lifts nothing; hover changes colour.
- Room tiles: hover lifts the CTA 2px (as today) and brightens the scrim by 4%; the thumbnail itself never scales.

What never moves: width of text containers, font-size, letter-spacing, filter blur, anything continuously (except the live dot). No parallax, no marquee, no auto-playing colour cycles.

`prefers-reduced-motion`: every duration becomes 0ms except opacity fades, which drop to dur-1. The live dot stops pulsing and stays solid.

---

## Component rules that fall out of the tokens

- One filled primary per view. If a view seems to need two, one of them is a ghost. Create Room: "Create room" is the one; "Send a MegaChat" in the preview is a ghost. Booth: every "Take a seat" is primary because each tile is its own view; "Open a room" is a ghost.
- Ghost = transparent, line-2 border, fg-1 text. Quiet = bg-2 fill, no border. Danger = transparent, 45% danger border, danger text.
- Inputs: bg-2, line-1, r-2, 36 tall, inset-top highlight. Label above at ui/600 fg-2; hint below at caption fg-3; error replaces the hint in danger and turns the border danger. No floating labels, no icons inside inputs except a unit on the right in fg-3.
- Segmented control: bg-2 well with 3px padding, thumb is bg-3 with inset-top, r-2 outer / 4px inner. Replaces the current bordered button strips.
- Stepper: one bordered group, minus / value / plus, value in tabular 600.
- Checkbox 18px r-1, fills primary with primary-ink check. Toggle 36x20 pill, primary when on.
- Status pip: micro caps in the state colour with a 6px dot. On air = live with pulse, queue = gold, open = fg-2, ended = fg-4.
- Tags: 22 tall, r-1, bg-2 + line-1 by default; coloured tags use the 12% subtle fill and 45% border of their hue.
- Tables and leaderboards: bg-1 container, r-3, line-1 rows, no zebra. Row hover is 2% white.
- Cards: bg-1, line-1, r-3. Selected: primary-border + primary-subtle fill (replaces the red outline on Create Room's active feature card).

---

## The logo test

Rendered at 1440 in `L2-logo-test-1440.png`; the 2x crop is `L2-logo-zoom-2x.png`.

Does the palette fight the logo? No. The badge is violet-to-magenta with a chrome keyline; the only saturated UI colour beside it is the powder-blue button, which sits on the cool side of the violet and shares none of its hue range, and the white CHAT plus the silver keyline bridge the two. The live-green dot and the blue button are the only two non-neutral hues in the bar, so the badge stays the warmest and loudest object, which is the intent. The "MEGA" gradient sample under the strip matches the badge's own ramp, so a typographic MEGA next to the logo does not look like a second brand.

Two honest caveats:

1. The logo out-shouts the UI rather than the reverse. That is by design under L2, but if the merge leans L1 it will want the nav to answer the badge with more colour than this set allows in chrome.
2. Both logo files are JPEGs with a baked `#0B0A12` ground. On bg-0 (`#0B0B10`) the difference is two RGB units and it disappears; on the bg-1 app strip (`#13131A`) the M icon shows its square plainly (visible in the zoom). No palette fixes that. Until there is a PNG or SVG with alpha, the logo may only be placed on bg-0, which means the app nav has to stay bg-0 with a hairline rather than bg-1. The proof page shows the failure deliberately.

---

## Alignment for the preserved surfaces

Token swaps only; layout untouched.

| Surface | Today | Under L2 |
|---|---|---|
| Landing hero | mint `#8FD8E4` CTA, `#04070A` ground | primary `#7FC5FF` CTA with primary-ink text, bg-0 ground, live `#5BE9AC` unchanged; the underline sweep goes primary |
| Landing feature kickers | four random hues (`#9B6BFF`, `#C05CE0`, `#F0246F`, `#8FD8E4`) | all fg-3 micro caps; the colour was decoration, and it was the one place the site leaked violet and magenta into copy |
| Booth ground / hairline | `#08080A` / `#1A1A1F` | bg-0 / line-1 |
| Booth accent `#FF4D3D` | rooms-on-air count, Open a room, Claim, bounty rail | on-air count goes live green; Open a room goes primary as a ghost; Claim goes primary; rail border goes gold (money in play) |
| Booth "Take a seat" | white fill | primary fill |
| Booth "Join queue" | `#FFD23D` | gold `#FFD63E` |
| Booth tiles | square | r-3 |
| Create Room accent `#FF4D3D` | key rail, step number, selected card outline, Create button | primary everywhere; selected card = primary-border + primary-subtle; Create button = primary lg |
| Create Room handle | green | primary (it is a link, not a live state) |
| Create Room bordered button strips | 1px boxes | segmented control |
| Bounty rank 01-03 | accent | fg-1 (gold is reserved) |
| Bounty locked / hatch | `#43E0A8` / `#FFD23D` on `#6B5A18` | data-guaranteed / data-restaked-hatch; released rows get data-released |
| Bounty CTA | accent fill | primary sm |
| Account chip accent | accent | neutral chip (bg-2, line-2, pill) |
| Every corner | 0 | r-1 to r-4 per the table |

---

## What L2 would sacrifice if it owned everything

The moment. A page built purely to this set has no place where a MegaChat landing feels bigger than a superchat: the brand gradient is fenced to the logo and a single glow, the largest radius is 12, the loudest allowed animation is a 240ms fade, money moves without a sound, and the announcer voice in "MEGAAA CHAT" has nowhere to live because display-1 is the only step that shouts and it is capped at one per page. The hero would read as a very good fintech landing with a film behind it. Join Room and the record-and-send flow would be correct and fast and would feel like a settings screen: no live-dare tension, no watchers-versus-players charge, no neon bleeding into the feed, because L2 treats neon as a state indicator rather than an atmosphere. What L2 gives the merge in exchange is the part a streamer needs before trusting the site with a wallet: one action colour, one attention colour, a violet-tinted black that is no longer "too black", forms whose every control is the same height and radius, contrast that was measured rather than eyeballed, and a hard rule that the logo is the only thing on the page allowed to be magenta. The merge should take the surfaces, text tiers, hairlines, radii, form components and the bar's data encoding from here wholesale, take the primary / gold / green / danger hexes as the shared vocabulary, and then let L1 break the fence on the gradient and the motion for the hero, the landing moment and the bounty board, and let L3 push the feed and the live states past dur-3 and past 12px glow, on the condition that Create Room, Account and How It Works stay inside this document.
