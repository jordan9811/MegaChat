# Tokens — L1 · Arcade / Street

R4 brand translation. This is the token set MegaChat would get if the ARCADE / STREET lens owned the whole site: NFL Street, NBA Street Gamebreaker, the announcer saying "MEGAAA CHAT". Bigness, hype, moments. It is written as a real system (ground, text, primary, secondary, semantic, data, type, space, radius, border, glow, motion) so the merge agent can lift pieces without inheriting the whole attitude. The last section says what this lens breaks when it runs unchecked.

Everything is checked against the real logo (violet→magenta MEGA over white CHAT, chrome keyline, angular bubble) and against Jordan's inputs: neon pastels (red / green / blue / yellow), the Chargers retro pairing (deep powder blue + yellow), black stays the base.

## 1. Logo test

Absolute: `C:/Users/jorda/mc-ui-overhaul/docs/ui-overhaul/directions/L1/logo-test-1440-nav.png` (the strip) and `.../L1/logo-test-1440.png` (the sheet). Paths below are repo-relative.

| file | what |
|---|---|
| `docs/ui-overhaul/directions/L1/logo-test-1440-nav.png` | the nav strip alone, 1440 wide, real `wordmark-stacked-bubble-dark.jpg` beside the proposed colors |
| `docs/ui-overhaul/directions/L1/logo-test-1440.png` | full sheet at 1440×900: nav, hero, role swatches, bounty board with the data colors, the moment card, a create-room form |
| `docs/ui-overhaul/directions/L1/logo-test-768.png` | same at 768×1024 |
| `docs/ui-overhaul/directions/L1/logo-test-390.png` | same at 390×844, icon variant `m-icon-bubble-dark.jpg` in the nav |
| `docs/ui-overhaul/directions/L1/L1-logo-test.html` | the source, logo embedded as data URI, re-renderable |

Sampled from the assets (dominant pixels): ground `#080810`, MEGA top `#6018f0`, MEGA bottom / GA `#f81878`, CHAT `#f0f0f0`, keyline `#d8d8e0`, icon glow `#281040`.

**Verdict: the palette does not fight the logo.** Three things make that true and all three are rules, not luck:

1. `bg-0` is the logo JPG's own ground, `#080810`. The asset has a baked-in background, so any other black shows a rectangle around it. On this ground the badge floats with no edge at 1440 and at 390. That alone fixes "the logo looks pasted on".
2. Powder blue is one step round the wheel from the logo's violet. In the strip the blue CTA reads as *action* and the badge reads as *brand*; they are cool relatives, not rivals. Yellow (the complement of violet) is the strongest possible contrast to the logo, which is exactly why it is banned from chrome and only allowed on money.
3. Nothing else in the nav carries hue. The on-air count is neutral text with a 7px green dot; the account chip is neutral. First render had the count in green and a gradient avatar, and the strip read as five hues in 72px. One accent per bar of chrome is the rule.

Where it is *tight*: the JPG carries ~20% padding on every side, so at a naive 52px the mark reads tiny. The test crops to the mark (84px image in a 52px box). Production wants a cut-out PNG/SVG of the badge; until then the crop numbers are in the HTML. And the raw brand violet `#6018f0` is 2.7:1 on the ground; fine as a fill under white text, useless as text. Gradient *text* uses a lifted pair (below).

## 2. Color roles

All values hex. Contrast is WCAG against the surface named; computed in the build script, not eyeballed.

### Ground (black stays the base; a whisper of the logo's plum so the badge fuses)

| token | hex | use |
|---|---|---|
| `--bg-0` | `#080810` | page canvas. Identical to the logo ground. |
| `--bg-1` | `#0f0f18` | panels, cards, rows at rest |
| `--bg-2` | `#16161f` | raised: chips, avatars, pips, segmented controls |
| `--bg-3` | `#1d1d28` | hover on raised, overlays, skeletons |
| `--bg-sunk` | `#0b0b13` | inputs, the inside of a track |

Elevation is layered ground, never shadow. A card is `bg-1` on `bg-0`; a chip on that card is `bg-2`. Four steps is the whole ladder.

### Text

| token | hex | on bg-0 | on bg-2 | use |
|---|---|---|---|---|
| `--text-0` | `#f4f4f8` | 18.2 | — | headlines, values, primary labels |
| `--text-1` | `#cfd0da` | 13.0 | — | body |
| `--text-2` | `#9a9cab` | 7.3 | 6.7 | nav, secondary, form labels |
| `--text-3` | `#7e8092` | 5.1 | 4.6 | hints, column heads, timestamps (AA floor; never below this) |

### Primary — the seat, the action. Chargers powder blue.

| token | hex | note |
|---|---|---|
| `--primary` | `#62b5e5` | 8.8 on bg-0; the retro powder blue (PMS 2915-class), deliberately not the current cerulean `#0080c6` |
| `--primary-hi` | `#8fd0ff` | hover, glow color, focus ring |
| `--primary-lo` | `#3d95cf` | pressed, large tinted fills, the "deep" in deep powder blue |
| `--primary-ink` | `#06121c` | text on a primary fill (8.3) |
| `--primary-tint` | `rgba(98,181,229,.14)` | selected row, kicker plates, hero wash |

Allowed on: the one primary CTA per view, links, focus rings, selected states, kicker labels, the *total* figure on a bounty bar. Never a status color, never a warning.

### Secondary — money and moments. Chargers gold.

| token | hex | note |
|---|---|---|
| `--secondary` | `#ffc72c` | 12.8 on bg-0; PMS 123-class gold, pastelised one step from stadium orange-gold so it never reads orange on black |
| `--secondary-hi` | `#ffe07a` | hover on a yellow fill, the lit state of a meter |
| `--secondary-ink` | `#1a1400` | text on a yellow fill (11.8) |
| `--secondary-tint` | `rgba(255,199,44,.12)` | "money on the line" plates |

Allowed on: pool totals, the ticking dollar figure, rank 01–03, the row-1 "Put money on it" fill (rows 2+ are yellow *outline*), the QUEUE pip, warnings. Never in the nav, never on a non-money CTA. Today's `#ffd23d` is the same hue one tint lighter and can alias to `--secondary-hi`.

### Semantic

| token | hex | contrast | rule |
|---|---|---|---|
| `--success` | `#57e6a4` | 12.6 on bg-0, 11.4 on bg-2 | live / on air / locked money / confirmed. Never a CTA fill. |
| `--warn` | `#ffc72c` | = `--secondary` | same hue on purpose: on this product "caution" and "money at stake" are one feeling (queue full, contested pool). Warn is distinguished by *shape*, always icon + plate, never by a second yellow. |
| `--danger` | `#ff5e6e` | 6.7 on bg-0 | destructive, declined, errors. Coral-red, warm enough to stay clear of the logo magenta, never orange. Outline buttons only; a filled red button does not exist. |
| `--danger-ink` | `#1c0609` | for the rare filled danger plate (6.6) |
| `--info` | = `--primary` | |

### Brand — reserved

| token | value | rule |
|---|---|---|
| `--brand-violet` | `#6018f0` | fill only (2.7 on bg-0 as text, so never text) |
| `--brand-magenta` | `#f81878` | fill, or text ≥ 20px (5.1) |
| `--brand-gradient` | `linear-gradient(135deg,#6018f0 0%,#f81878 100%)` | plates: the MEGA CHAT tag on a landed MegaChat |
| `--brand-gradient-text` | `linear-gradient(135deg,#8a4cff 0%,#ff2d8f 100%)` | gradient *text*, ends lifted to 4.3 / 5.7 so the violet end survives at 28px. Exactly one word per hero. |
| `--keyline` | `linear-gradient(180deg,#e6e6ee,#8e8e9c)` | 2px chrome stroke, echoing the badge. On the moment card and the rank-1 avatar. Nowhere else. |

The brand gradient is the logo's job. Under L1 it appears on the page in two places only: the tag on a MegaChat that has just landed, and the last word of the hero line. Every other purple on the current site (the `#9b6bff` / `#c05ce0` kickers, the noir blooms in `globals.css`) goes.

### Data — bounty stacked bars

The bar is the argument of the bounty page: money that is *this streamer's* vs money that is *also promised to rivals* vs the whole pot. Three ideas, three encodings, and the second one carries a pattern so it survives color-blindness and a 1-bit stream overlay.

| token | hex | role | rendering |
|---|---|---|---|
| `--data-total` | `#62b5e5` | the pot (track + headline figure) | track fill `rgba(98,181,229,.18)`, inset 1px `rgba(98,181,229,.28)`; the total number in `--data-total` mono |
| `--data-guaranteed` | `#57e6a4` | locked to this name only | solid segment |
| `--data-restaked` | `#ffc72c` | pledged to this name *and* others; first to air takes it | hatch `repeating-linear-gradient(135deg,#ffc72c 0 4px,#7a5e10 4px 8px)` |
| `--data-paid` | `#8e8e9c` | claimed / paid out | solid grey, row at 100% opacity, CTA becomes ghost |
| `--data-yours` | `#c48dff` | the viewer's own pledge, when highlighted | thin 2px underline beneath the segment it lives in; 8.2 on bg-0 |

Read at a glance: green is yours, hatched yellow is a race, blue is the size of the pot, grey is history. The numbers under the bar repeat the split in the same three colors in tabular mono, so the bar is never the only carrier. Never add guaranteed + restaked into one figure anywhere; today's "two numbers, two labels" rule stands.

### Where each hue may appear (the sniff test in one table)

| hue | hero | booth | create room | join / record | bounty |
|---|---|---|---|---|---|
| primary blue | CTA, sweep, kicker | Take a seat, filter selected | Create room, key rail, step numbers, focus | Send / Join, focus | total figure, links |
| secondary yellow | — | pool money, queue pip | rate readout (mono) | the ticking meter | pool money, rank, row-1 CTA |
| success green | live pip | ON AIR | ON AIR preview | ON AIR, "sent" | locked money |
| danger coral | — | — | Delete room (outline) | Declined | — |
| brand gradient | one word | — | — | the MEGA CHAT tag when it lands | — |
| keyline chrome | — | — | — | the moment card | rank-1 avatar |

## 3. Type

Three families, three jobs. The site keeps Plus Jakarta Sans as its UI face; L1 promotes the hero's Archivo to a real display role and adds a mono for the scoreboard.

| role | family | axis / weights | why |
|---|---|---|---|
| Display | **Archivo** (variable) | `wdth 112`, `wght 900`; italic for landed / gamebreaker states only | already the sanctioned hero face; semi-expanded at 900 is the bigness without a Bangers-style comic face. Angular enough to sit near the badge, still a text face. |
| UI | **Plus Jakarta Sans** | 400 / 500 / 600 / 700 / 800 | unchanged, `--font-ui` |
| Score | **Geist Mono** | 500 / 600, `font-variant-numeric: tabular-nums` | every dollar, rate, second and rank. Money that ticks must not jitter, and mono is how a scoreboard says "this is being counted". |

### Scale

| token | px | lh | tracking | family / weight | where |
|---|---|---|---|---|---|
| `--d-1` | 96 | 0.92 | −0.025em | Archivo 900 w112 | landing statement ("Parasocial is a design flaw.") desktop |
| `--d-2` | 72 | 0.96 | −0.02em | Archivo 900 w112 | hero line desktop |
| `--d-3` | 56 | 1.00 | −0.015em | Archivo 900 w112 | page heroes (bounty, how it works) desktop |
| `--d-4` | 44 | 1.02 | −0.01em | Archivo 900 w112 | hero line mobile, statement mobile |
| `--d-5` | 32 | 1.05 | 0 | Archivo 900 w112 | section heads ("ON THE BOARD") |
| `--d-6` | 24–28 | 1.10 | +0.01em | Archivo 900 w112 italic | the streamer name on a landed MegaChat |
| `--t-xl` | 20 | 1.3 | −0.01em | Jakarta 700 | card / panel titles, booth section heads |
| `--t-lg` | 17 | 1.4 | −0.01em | Jakarta 600–700 | list titles, feature titles, room names in rows |
| `--t-md` | 15 | 1.5 | 0 | Jakarta 400–500 | body |
| `--t-sm` | 13.5 | 1.5 | 0 | Jakarta 500 | nav, secondary text, buttons ≤ small |
| `--t-xs` | 12.5 | 1.4 | 0 | Jakarta 600 | form labels, hints (sentence case, never caps) |
| `--t-cap` | 11 | 1.2 | +0.10em | Jakarta 700 caps | column heads and status pips. The only two places caps survive below display size. |
| `--s-xl` | 56 | 1.0 | 0 | Geist Mono 600 | the landed MegaChat's dollar figure, the bounty page's escrow totals |
| `--s-lg` | 32 | 1.0 | 0 | Geist Mono 600 | pool totals on tiles |
| `--s-md` | 20 | 1.2 | 0 | Geist Mono 600 | meters, per-second rate readout |
| `--s-sm` | 15 | 1.3 | 0 | Geist Mono 500 | money in table rows, ranks |
| `--s-xs` | 13 | 1.3 | 0 | Geist Mono 500 | rate chips on tiles |

Rules: display faces never below 24px. Caps allowed in display (≤ 6 words) and `--t-cap`; everywhere else sentence case (the create-room label rule stays). Mobile steps down one row on the display scale and does not touch the UI scale. Body measure 56–64ch.

## 4. Spacing

4px base. `--s-1` 4 · `--s-2` 8 · `--s-3` 12 · `--s-4` 16 · `--s-5` 20 · `--s-6` 24 · `--s-8` 32 · `--s-10` 40 · `--s-12` 48 · `--s-16` 64 · `--s-24` 96 · `--s-32` 128.

Page gutter 24 (≤ 600) / 40 (≤ 1024) / 64 (desktop). App content max 1400, marketing text max 1280. Booth tile seam stays 6px of `bg-0` (no borders between tiles). Section rhythm on marketing: `--s-16` between sections, `--s-6` head-to-content. Control heights: 36 (small), 44 (default), 52 (hero CTA).

## 5. Radius

"Soften without going bubbly." Six stops and one angle.

| token | px | where |
|---|---|---|
| `--r-0` | 0 | bar segments, table rows, booth tile edges, anything full-bleed |
| `--r-1` | 3 | chips, checkboxes, tracks, hatch legend swatches, gradient tags |
| `--r-2` | 6 | buttons, inputs, segmented controls, avatars |
| `--r-3` | 10 | cards, panels, room tiles when they float (booth stays square) |
| `--r-4` | 16 | modals, sheets, the moment card |
| `--r-pill` | 999 | status pips, live dots, the account chip. Nothing larger than one line of text is a pill. |
| `--cut` | 8 | **the chamfer.** The primary CTA (and only it) cuts its top-right corner: `clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 0 100%)`. It is the one angular gesture on the page and it points back at the badge's cut corners. Once per view. |

## 6. Borders and hairlines

| token | value | use |
|---|---|---|
| `--hairline` | `rgba(255,255,255,.08)` | row dividers, card edges at rest |
| `--rule` | `rgba(255,255,255,.12)` | inputs at rest, section rules |
| `--rule-strong` | `rgba(255,255,255,.20)` | ghost buttons, dashed empty states |
| `--focus` | `2px solid #8fd0ff`, offset 2px, plus `0 0 0 3px rgba(98,181,229,.28)` on inputs | every focusable, every scope |
| `--keyline` | 2px chrome gradient (§2) | moment card, rank-1 avatar |

Rules are alpha-white so they read the same on every ground step. No colored borders except focus, the yellow-outline money CTA, the coral-outline danger button, and the keyline. The `#ff4d3d` key rail on create-room becomes `--primary` at 3px.

## 7. Shadow and glow

Flat surfaces cast nothing; elevation is ground steps. Only floating things get a shadow, and only three things ever glow.

| token | value | where |
|---|---|---|
| `--shadow-float` | `0 24px 64px rgba(0,0,0,.6)` | modals, sheets, popovers |
| `--glow-primary` | `0 0 0 1px rgba(98,181,229,.55), 0 0 28px rgba(98,181,229,.35)` | primary CTA on hover/focus. Not at rest. |
| `--glow-live` | `0 0 10px rgba(87,230,164,.7)` | the 7px live dot only |
| `--glow-moment` | `0 0 48px rgba(248,24,120,.28), 0 0 96px rgba(96,24,240,.22)` | the card of a MegaChat that has just landed; fades to nothing over `--dur-5` |

One glow per viewport at rest (the live dot). Two during a moment. Text-shadow, chromatic aberration, shimmer sweeps and the neon scrollbar from `globals.css` all go; they are the "Flash site" tell.

## 8. Motion

| token | ms | what |
|---|---|---|
| `--dur-1` | 100 | hover color |
| `--dur-2` | 160 | press, toggle, focus ring, chip select |
| `--dur-3` | 240 | state change, bar width, pip swap, filter |
| `--dur-4` | 360 | enter / exit, sheets, modal, tile hover lift |
| `--dur-5` | 600 | **the moment**: a MegaChat lands, money moves, a seat is taken |
| `--dur-6` | 900 | hero staged reveal, once per session (kept from the current landing) |

| easing | curve | use |
|---|---|---|
| `--ease-standard` | `cubic-bezier(.2,.7,.2,1)` | everything by default (the landing's existing curve) |
| `--ease-out-expo` | `cubic-bezier(.16,1,.3,1)` | entrances, reveals |
| `--ease-in` | `cubic-bezier(.4,0,1,1)` | exits |
| `--ease-gamebreaker` | `cubic-bezier(.34,1.56,.64,1)` | overshoot. **Only** on `--dur-5`: the moment card scaling in from 0.92, the dollar figure counting up, the bar segment growing when a pledge lands. |

What may move: opacity, color, transform (translateY ≤ 6px, scale ≤ 1.04 at rest; the moment card from 0.92), bar widths (`--dur-3`), the live dot (2s pulse ring, opacity only). What may not: layout width/height of chrome, letter-spacing, blur (except one 600ms bloom on the moment), background-position loops, anything infinite besides the live pulse. Money readouts do not ease; they tick in tabular mono, and the count-up on a landed MegaChat is the single exception. `prefers-reduced-motion`: transforms off, opacity-only at `--dur-2`, the moment becomes a 160ms fade.

## 9. Copy register (the "Word document" gripe)

Headings are calls, 2–6 words, verb-first when possible, no exclamation marks: SKIP THE CHAT / TAKE A SEAT / PUT MONEY ON IT. One hype line per view, and it is the display line, never body. Body stays plain and specific (rates, seconds, refunds). CTAs are two or three words and name the thing you get, not the action on the form: "Enter MegaChat", "Take a seat", "Put money on it", "Create room". The announcer voice lives in exactly one place on the page at a time.

## 10. Per-surface: how L1 leads, and the L2 / L3 sniff test

- **Landing hero (preserved).** Token alignment only: mint sweep and CTA → `--primary`; the last word of "BE THE STREAM." may carry `--brand-gradient-text`; feature kickers become the four pastels (`#62b5e5` SEATS, `#ffc72c` THE METER, `#57e6a4` BOUNTIES, `#c48dff` NO WALL); the film stays untouched. L2 check: the nav is one accent, quiet. L3 check: the film and the gradient word are the phone-native energy.
- **Booth (preserved).** Token alignment only: "Take a seat" white → `--primary`; queue → `--secondary`; pool "Claim" red → `--secondary`; the red on-air count → neutral text + green dot; key rail → primary. Tiles stay square and seam-gapped.
- **Create room.** L1 gives it the mono rate readout and the chamfered "Create room". Everything else is L2: `bg-sunk` inputs, 3px focus halo, sentence-case labels, one primary per screen, danger as outline. If it feels like a betting slip, yellow has leaked; only the rate is yellow.
- **Join / record / live.** L1 owns the moment: the keyline card, the brand tag, the `--s-xl` mono dollar figure counting up with `--ease-gamebreaker`, the 600ms bloom. L3 check: on a 390 screen the card is full-width, the meter is the biggest thing, the feed sits behind it.
- **Bounty board.** L1's home. Yellow ranks, mono money, the three-color bar, row 1 filled and rows 2+ outlined. L2 check: the header still shows escrow and across-pools as two labelled numbers; the refund terms stay on the page.

## 11. Paste-ready tokens

```css
:root {
  /* ground */
  --bg-0:#080810; --bg-1:#0f0f18; --bg-2:#16161f; --bg-3:#1d1d28; --bg-sunk:#0b0b13;
  /* text */
  --text-0:#f4f4f8; --text-1:#cfd0da; --text-2:#9a9cab; --text-3:#7e8092;
  /* primary — powder blue */
  --primary:#62b5e5; --primary-hi:#8fd0ff; --primary-lo:#3d95cf; --primary-ink:#06121c;
  --primary-tint:rgba(98,181,229,.14);
  /* secondary — gold */
  --secondary:#ffc72c; --secondary-hi:#ffe07a; --secondary-ink:#1a1400;
  --secondary-tint:rgba(255,199,44,.12);
  /* semantic */
  --success:#57e6a4; --warn:var(--secondary); --danger:#ff5e6e; --danger-ink:#1c0609; --info:var(--primary);
  /* brand — reserved */
  --brand-violet:#6018f0; --brand-magenta:#f81878;
  --brand-gradient:linear-gradient(135deg,#6018f0 0%,#f81878 100%);
  --brand-gradient-text:linear-gradient(135deg,#8a4cff 0%,#ff2d8f 100%);
  --keyline:linear-gradient(180deg,#e6e6ee,#8e8e9c);
  /* data — bounty bars */
  --data-total:#62b5e5; --data-total-track:rgba(98,181,229,.18); --data-total-edge:rgba(98,181,229,.28);
  --data-guaranteed:#57e6a4;
  --data-restaked:#ffc72c; --data-restaked-hatch:repeating-linear-gradient(135deg,#ffc72c 0 4px,#7a5e10 4px 8px);
  --data-paid:#8e8e9c; --data-yours:#c48dff;
  /* lines */
  --hairline:rgba(255,255,255,.08); --rule:rgba(255,255,255,.12); --rule-strong:rgba(255,255,255,.2);
  /* radius */
  --r-0:0; --r-1:3px; --r-2:6px; --r-3:10px; --r-4:16px; --r-pill:999px; --cut:8px;
  /* glow + shadow */
  --shadow-float:0 24px 64px rgba(0,0,0,.6);
  --glow-primary:0 0 0 1px rgba(98,181,229,.55),0 0 28px rgba(98,181,229,.35);
  --glow-live:0 0 10px rgba(87,230,164,.7);
  --glow-moment:0 0 48px rgba(248,24,120,.28),0 0 96px rgba(96,24,240,.22);
  /* type */
  --font-display:'Archivo',system-ui,sans-serif;   /* font-variation-settings:'wdth' 112; wght 900 */
  --font-ui:'Plus Jakarta Sans',system-ui,sans-serif;
  --font-score:'Geist Mono',ui-monospace,monospace; /* tabular-nums */
  /* space */
  --s-1:4px; --s-2:8px; --s-3:12px; --s-4:16px; --s-5:20px; --s-6:24px; --s-8:32px;
  --s-10:40px; --s-12:48px; --s-16:64px; --s-24:96px; --s-32:128px;
  /* motion */
  --dur-1:100ms; --dur-2:160ms; --dur-3:240ms; --dur-4:360ms; --dur-5:600ms; --dur-6:900ms;
  --ease-standard:cubic-bezier(.2,.7,.2,1); --ease-out-expo:cubic-bezier(.16,1,.3,1);
  --ease-in:cubic-bezier(.4,0,1,1); --ease-gamebreaker:cubic-bezier(.34,1.56,.64,1);
}
```

## 12. What this lens sacrifices if it truly owns everything

Left alone, L1 turns the trust surfaces into a stadium. The scoreboard mono and the yellow money that make the bounty board sing make a settings form feel like a betting slip: Create Room and Account would get louder than a streamer wiring real USDC wants them to be, and the "one primary action per view" discipline erodes because this lens wants every row to have a filled "Put money on it" (the test sheet had to be corrected to outline rows 2+ for exactly that reason). Display type creeps down the scale until list titles are shouting, glows multiply from one per viewport to one per card, and the gamebreaker overshoot leaks out of the 600ms moment into ordinary hovers, which is the Flash-site tell. It also wants a wide screen and a crowd: the join and record flow under pure L1 is a broadcast graphic, not the vertical, one-dare, phone-in-hand tension the Nerve lens needs, so L3's intimacy is the second casualty. What the merge should keep from L1 without negotiation: the `#080810` ground that fuses with the logo, the powder-blue / gold pairing with yellow fenced to money, the three-color data bars with the hatch, the mono scoreboard for anything that counts, the chamfer on the primary CTA, the keyline moment card, and motion tiers 5 and 6. What it should cap: display face never below 24px, yellow never in chrome, one glow at rest, overshoot only on `--dur-5`, and every L1 gesture on Create Room / Account / How It Works reduced to the mono readout and the chamfered button.
