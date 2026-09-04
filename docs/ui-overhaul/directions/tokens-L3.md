# Tokens, lens L3: Zoomer digital futurist / Nerve

Proposed as if L3 owned the whole site. Phone-native, neon on a tinted black, watchers vs players, the feed as the product, money you can see move. Every value below is a hex or a px so the merge agent can diff it against L1 and L2 line by line.

Grounding: read `web/components/landing`, `booth`, `create-room`, `app/bounty`, `components/bounty`; the live pages via the baseline recon shots; the round-1 explorations (Prestige was the chosen one: quiet, editorial, hairline rules, 2px radii, one cool accent; the caps-and-stats HyperCut was rejected, which is the taste signal L3 must respect: restraint wins, loudness loses). The logo was sampled pixel by pixel, not eyeballed.

## 0. What the logo actually is

Sampled from `design-assets/branding/wordmark-stacked-bubble-dark.jpg` and `m-icon-bubble-dark.jpg` (PIL, hue-bucketed):

| part | measured | token |
|---|---|---|
| violet top of "MEGA" | #5e15fa extreme, #711ded band average | brand-violet #6c22f0 |
| mid sweep | #b31ec1 / #c31eb5 | brand-mid #b01fc0 |
| magenta bottom | #ff1f75 extreme, #fa1e7d band average | brand-magenta #ff2a7c |
| chrome keyline | #c3c2c9 (wordmark), #c4c4c9 (icon) | brand-chrome #c4c3ca |
| baked-in glow halo | #34144b (wordmark), #30154b (icon) | brand-halo #34144b |
| baked-in JPG ground, wordmark | #0b0a12 | bg-0 (adopted as the site ground) |
| baked-in JPG ground, icon | #0f1219 | mismatch, see the logo test |

Two consequences the whole palette is built on. The logo's own black is a violet-tinted #0b0a12, not the site's neutral #08080a, so the site ground moves to the logo's ground and the "too black" gripe gets a tint instead of a lift. And the logo's hue sweep runs 250 to 340 degrees, so a primary at 212 degrees (powder blue) extends that sweep one step cooler and reads as family; anything cyan-ward of about 200 degrees would start to read as CMYK against the magenta.

## 1. Type

Family stays Plus Jakarta Sans via `--font-ui` (site-wide rule), Archivo 800 stays for display. L3 adds one face for one job: a monospace for numbers that tick. A per-second meter in a proportional face jitters every second; tabular Jakarta fixes the width but not the "this is a counter" read. Proposed `--font-mono: 'JetBrains Mono', ui-monospace, monospace`, used only on `meter-*` roles. If the merge drops the third family, fall back to Jakarta with `font-variant-numeric: tabular-nums` on the same roles; nothing else changes.

| role | size / line (mobile) | weight | tracking | family | where |
|---|---|---|---|---|---|
| display-xl | 64 / 1.0 (40) | 800 | -0.03em | Archivo | landing hero only ("Skip the chat.") |
| display | 40 / 1.05 (32) | 800 | -0.025em | Archivo | the MegaChat-landed badge, page statements ("Parasocial is a design flaw.") |
| h1 | 30 / 1.15 (26) | 800 | -0.02em | Jakarta | page titles |
| h2 | 22 / 1.2 | 700 | -0.015em | Jakarta | section heads, sentence case |
| h3 | 17 / 1.3 | 700 | -0.01em | Jakarta | card titles, room names on tiles |
| body-lg | 16 / 1.55 | 500 | 0 | Jakarta | landing prose |
| body | 14.5 / 1.5 (15) | 500 | 0 | Jakarta | default |
| body-sm | 13 / 1.45 | 500 | 0 | Jakarta | table cells, secondary copy |
| label | 12.5 / 1.3 | 600 | 0 | Jakarta | form labels, sentence case |
| caption | 11.5 / 1.35 | 600 | 0.01em | Jakarta | hints, footnotes, refund terms |
| micro | 11 / 1.2 | 700 | 0.08em, UPPERCASE | Jakarta | status pips and column heads, nothing else |
| meter-lg | 44 / 1.0 | 700 | -0.01em | mono, tabular | the running total on Join while a seat is live |
| meter | 28 / 1.0 | 700 | 0 | mono, tabular | rates, wallet balance, bounty totals |
| meter-sm | 15 / 1.0 | 600 | 0 | mono, tabular | rate chips on tiles, per-row bounty figures |

Rules. Caps live in `micro` only; the landing's caps section heads ("HOW A SEAT WORKS", "ON THE BOARD") go to `h2` sentence case, because caps headings over hairline tables are exactly what reads as a Word document. Tracking is negative on anything 22px and up, zero on body, positive only on `micro`. Weight 800 is reserved for display and h1; buttons are 700; nothing in a form is heavier than 700. Max line length 62ch for prose.

## 2. Spacing

4px base. `s-1` 4, `s-2` 8, `s-3` 12, `s-4` 16, `s-5` 20, `s-6` 24, `s-8` 32, `s-10` 40, `s-12` 48, `s-16` 64, `s-24` 96.

Page gutter 16 (390) / 24 (768) / 32 (1440), content max-width 1400 with the Booth wall exempt (edge to edge, 6px tile gap). Control heights 32 (sm), 40 (md), 48 (lg; the one primary action on a phone is always lg). Minimum touch target 44 on any viewport under 768. Vertical rhythm between sections 48 desktop / 32 mobile; between a heading and its content 12; between rows in a list 0 with a hairline, or 8 with cards, never both.

## 3. Radius

| token | px | where |
|---|---|---|
| r-0 | 0 | video frames, camera feeds, thumbnails, the Booth tiles. The feed is a rectangle; a rounded video reads as a widget. |
| r-1 | 4 | inputs, segmented controls, table cells, rate chips, the bounty track |
| r-2 | 8 | buttons, small cards, swatches |
| r-3 | 12 | cards, panels, modals, the MegaChat-landed badge |
| r-4 | 20 | bottom sheets and the phone frame on Join; nowhere on desktop except a sheet |
| r-pill | 999 | status pips, counters, avatar rings |

Nesting: inner radius = outer radius minus padding, floored at r-1 (a 12px card with 8px padding holds 4px inputs). This is what "soften without going bubbly" means in numbers: nothing above 12 on desktop, nothing above 20 anywhere, and the video stays square.

## 4. Color roles

All on black. Contrast measured against bg-0 (full table in `directions/L3/contrast.md`).

### Background layers

| token | hex | use |
|---|---|---|
| bg-0 | #0b0a12 | page ground; equals the wordmark JPG ground |
| bg-1 | #12111c | cards, panels, the join card, table hover |
| bg-2 | #191827 | inputs, chips, pips, pressed rows |
| bg-3 | #211f33 | popovers, active tab, selected tile |
| bg-scrim | rgba(11,10,18,0.72) | flat scrim over video for text plates |
| bg-scrim-grad | linear-gradient(to top, rgba(11,10,18,0.92) 0%, rgba(11,10,18,0.28) 34%, rgba(11,10,18,0) 62%) | the tile gradient, retinted from #08080a |
| bg-glass | rgba(18,17,28,0.78) + backdrop-filter blur(12px) | phone overlays that sit on live video (record sheet, the meter plate) |

Each step is +7 lightness with the violet lean kept, so a stack of three layers reads as depth without a shadow. This, not a lighter base, is the answer to "reads monochrome."

### Text tiers

| token | hex | vs bg-0 | use |
|---|---|---|---|
| text-1 | #f4f3fa | 17.9 | headings, values, button labels on dark |
| text-2 | #b9b8c9 | 10.1 | body, nav links, legends |
| text-3 | #8d8ca3 | 6.0 | labels, captions, column heads (still AA) |
| text-4 | #5d5c73 | 3.0 | decorative only: placeholders, disabled, rank numbers below the top three. Fails AA on purpose and never carries information. |

### Primary, "Powder" (the Chargers blue, pushed one step toward the logo)

| token | hex | vs bg-0 | use |
|---|---|---|---|
| primary | #6fadf5 | 8.4 | the one action per view, links, selected state, the hero underline, the bounty track outline |
| primary-300 | #a6cdff | 12.0 | link hover, primary text on bg-2, the glow tint |
| primary-700 | #3f83cf | 5.0 | pressed fill, key rail on forms, primary borders |
| primary-ink | #06111f | 8.1 on primary | text on a primary fill |

Hue 212, saturation 85, lightness 69. Deep enough to be the retro Chargers powder, light enough that on black it reads as screen-light on a face, which is the Nerve image: everyone lit by their phone. It is the watcher color: the feed, the nav, the button that gets you in.

### Secondary, "Bolt" (the Chargers yellow)

| token | hex | vs bg-0 | use |
|---|---|---|---|
| secondary | #ffd94d | 14.3 | money in motion: the running meter, the MegaChat price, contested pledges, queue |
| secondary-300 | #ffe98f | 16.2 | meter glow tint, hover |
| secondary-700 | #d4ab1a | 9.0 | pressed money fill, hatch alternate |
| secondary-ink | #1c1500 | 13.2 on secondary | text on a yellow fill |

One meaning: unsettled. Money that is still moving, a seat still in queue, a pledge that could still go to a rival, a caution line. This is why there is no separate warn hue; warn = secondary at text weight, and the system stays at four signal hues.

### Semantic

| token | hex | vs bg-0 | use |
|---|---|---|---|
| success / live | #5ef0a5 | 13.6 | on air, settled money, locked pledges, confirmed refunds. Ink #04170d. |
| danger | #ff6b80 | 7.2 | destructive actions, declined clips, the record dot, expired. Ink #1f0509. The old #ff4d3d retires; this is the red in the pastel set, and it is never a call-to-action fill. |
| warn | = secondary | | see above |
| info | = primary-300 | | |

The motion story that ties them: money runs yellow and lands green. The meter is yellow while a seat is live; when the seat ends and the refund settles, the figure turns green. The bounty bar is the same sentence drawn as a rectangle.

### Brand (the logo gradient, rationed)

| token | hex |
|---|---|
| brand-violet | #6c22f0 |
| brand-mid | #b01fc0 |
| brand-magenta | #ff2a7c |
| brand-chrome | #c4c3ca |
| brand-halo | #34144b |
| brand-gradient | linear-gradient(180deg, #6c22f0 0%, #b01fc0 52%, #ff2a7c 100%) |

Allowed on: the logo, the MegaChat-landed badge and its overlay toast, the "what is a MegaChat" panel on /how-it-works, and the record button's active ring. Never as text under 22px (violet is 2.9:1 on bg-0), never as a button fill (text-1 on magenta is 3.2:1). Rationing is the point: when the gradient appears, a MegaChat is landing, and the site has been saving it for that.

### Data colors (bounty stacked bar)

| token | hex | rendering | means |
|---|---|---|---|
| data-total | #6fadf5 | the track: 14% alpha fill, 1px 28% alpha outline, number in full primary | the whole pool |
| data-locked | #5ef0a5 | solid | locked to this name only |
| data-contested | #ffd94d | hatch, 4px on / 4px off at 135deg, off stripe rgba(255,217,77,0.35) | also pledged to rivals, first to air takes it |
| data-gone | #ff6b80 | solid at 70% alpha, claimed rows only | paid out or expired |

Order in the bar, left to right: locked, contested, gone. Segment labels use the same hex as the segment, in `meter-sm`. Read at a glance because it is the four pastels and only the four pastels, and because the meanings match the semantic roles the rest of the site already taught: green settled, yellow moving, blue the container, red gone. Platform marks (Twitch #9146ff, Kick #53fc18) keep vendor color at 14px inside an avatar badge only; everywhere else vendor marks render in text-2.

### Retinted placeholders

The six mesh gradients in `booth.css` and `bounty.css` shift to the tinted layer family so tiles stop reading as brown: base ends at bg-2 #191827, highlights at #1c2b4a (blue), #3a1f4a (violet), #1f3a30 (green), #2b2a3f (slate), #3a2a1f (warm), #1f2f3a (steel). Highlight hue is still keyed off the room id hash.

### Delta from today, for the merge agent

| today | proposed | note |
|---|---|---|
| #08080a ground | #0b0a12 | logo ground, tinted |
| #ff4d3d accent | retired; actions #6fadf5, danger #ff6b80 | "orange on black is harsh" |
| #43e0a8 live | #5ef0a5 | greener, the pastel-set green |
| #ffd23d queue/warn | #ffd94d | one step lighter, role widens to "unsettled money" |
| #8fd8e4 landing mint | #6fadf5 | the landing joins the system |
| FEATURES kickers #9b6bff / #c05ce0 / #f0246f / #8fd8e4 | primary / secondary / success / text-2 | kills the four-colour rainbow on the landing rows |
| #1a1a1f, #23232a, #33333c opaque rules | alpha hairlines below | |
| --mcl-*, --mcb-*, --mcc-* per-page namespaces | one `--mc-*` token file | three copies of the skin is how it drifted |

## 5. Borders and hairlines

Alpha-white only, so a rule reads the same over bg-0, bg-1 and video: `hairline` rgba(244,243,250,0.08), `rule` 0.12, `rule-strong` 0.20. Interactive borders: 0.16 at rest, 0.28 on hover, primary 1px plus glow-primary on focus. Always 1px; the only thicker stroke is the 3px key rail on Create Room, in primary-700. Dashed at 0.18 for empty and invite states only. Live border: 1px rgba(94,240,165,0.5). Opaque grey borders (#23232a and friends) are retired because they go muddy over the tinted layers.

## 6. Shadow and glow

No elevation shadows on desktop; depth comes from the layer stack and a hairline. Glows carry state, not decoration, and there is a budget: one glowing element per viewport besides live pips.

| token | value | fires when |
|---|---|---|
| glow-live | 0 0 0 1px rgba(94,240,165,0.35), 0 0 24px rgba(94,240,165,0.22) | a seat or room is on air |
| glow-primary | 0 0 0 3px rgba(111,173,245,0.28) | focus-visible, selected tile, the one primary button on a phone |
| glow-money | 0 0 20px rgba(255,217,77,0.28) | the meter is running |
| glow-brand | 0 0 40px rgba(255,42,124,0.35), 0 0 80px rgba(108,34,240,0.25) | a MegaChat lands |
| shadow-sheet | 0 -8px 32px rgba(0,0,0,0.5) | the one real shadow: a bottom sheet over video |

## 7. Motion

Durations: 120 (micro: hover, toggle), 200 (state: chip, pip, tab), 320 (enter and exit: panel, sheet, bar width), 600 (a moment: MegaChat lands, money settles), 1000 (one tick of the meter).

Easings: standard cubic-bezier(0.2, 0.7, 0.2, 1) (already on the landing, kept); exit cubic-bezier(0.4, 0, 1, 1); overshoot cubic-bezier(0.34, 1.56, 0.64, 1), allowed on exactly two things, the MegaChat-landed badge and the money-settled tick.

What may move: opacity, transform, box-shadow (glow intensity), color and background-color, and the bounty bar segment widths (320 standard, because the data changed). What may not: layout properties, hover lifts (the current `-translate-y-0.5` on tile CTAs goes; the feed does not bounce), parallax, looping gradients, anything on scroll.

Choreography. Live pip: the dot only, opacity 1 to 0.55 to 1 over 2s ease-in-out. Meter: digits never transition (mono tabular, so they do not jitter); glow-money blooms in over 600 at start, and at stop the figure and glow settle yellow to green over 600. MegaChat lands: scale 0.92 to 1 over 600 with overshoot, glow-brand blooms with it, then decays over 2s; this is the announcer moment and the only overshoot on the site. Sheets: translateY(100%) to 0 over 320; panels and rows: translateY(12px) plus fade over 320, staggered 40 per row, max five rows. Reduced motion: transforms off, fades capped at 200, glows static, breathing off.

## 8. Logo test

Files: `directions/L3/logo-test-1440.png`, `logo-test-768.png`, `logo-test-390.png`, `logo-test-zoom3x.png` (the nav at 3x), `logo-test.html` (re-renderable), `contrast.md`. Rendered with a scratchpad playwright 1.62 against the cached chromium-1234, not the shared MCP browser.

Does the palette fight the logo? No, with one placement rule. Blue, violet, magenta is one hue sweep, so the powder primary beside the wordmark reads as the same brand one step cooler; the green live pip that sits closest to the logo is neutral to it; the chrome keyline matches text-2 and bg-3 edges. The one loud pairing in the whole set is a yellow money fill directly beside the magenta-glow badge (visible in the "moment" row of the test page): it is arcade, not Nerve, and it is a lot. Rule: the money button and the brand badge never share a row except on the overlay itself, where loud is the job.

Seam, measured in the 1440 shot: wordmark JPG interior corners #080810 against page #0b0a12, three levels under, invisible at 1x and a whisper at 3x; the pass is real, not eyeballed. The icon variant is a fail: #0d1017 inside against #0b0a12 outside draws a faint box around the M at every size. Both assets should be re-exported as PNG with alpha (the halo baked in), and until then the icon must not appear on bg-0. On the old #08080a the wordmark showed a lighter box by the same three levels, so the ground change is neutral for the wordmark and only exposes what the icon already did.

The 390 shot is where L3 makes its case: the meter in mono, the glass record sheet, one lg primary, pips wrapping cleanly. The 768 shot shows the tokens holding in a two-column layout without any of the glows stacking.

## 9. Sniff test on the other two lenses

L1: the hero stays Archivo 64 with the film; the MegaChat-landed badge is display-size brand gradient with the only overshoot on the site; yellow money fills glow; the bounty bar is a scoreboard. Bigness is concentrated in three places instead of spread across caps headings. L2: 4px grid, 14.5 body, sentence-case labels at 12.5/600, one primary per view, alpha hairlines, every text tier measured against every layer, the four signal hues each with one meaning, no shadow theatre. Create Room in these tokens is bg-1 cards on bg-0 with primary-700 key rails and mono rate fields; it reads engineered.

## 10. What L3 sacrifices if it truly owns everything

The trust surfaces pay first. If Create Room, Account and Money are bottom sheets on glass with glowing mono tickers, a streamer pricing a room is looking at a dare app, not a ledger; L2's calm (opaque panels, no glow, a form that feels like a spreadsheet) is what makes someone leave a wallet connected, and L3 keeps chipping at it. The tinted layers and backdrop blurs also cost real frames on the OBS browser source and on the phone that is the whole point. L1 pays second: Nerve is sleek, not loud, so chunky chrome type, announcer-scale numerals and the swagger of NFL Street get flattened into phone-UI restraint, the logo's gradient gets rationed to one moment and is under-used on marketing pages, sentence case everywhere kills the caps micro-language hype runs on, and the hero film gets neon competition at its edges. Desktop density pays third: the feed-as-product wants cards and sheets, while the bounty leaderboard and the Booth wall want dense grids; at 1440, L3 leaves air where L2 would put data and L1 would put a bigger number. What the merge should keep from here regardless: the tinted ground and layer stack, the four-hue signal system with one meaning each, yellow-runs-green-lands, the rationed brand gradient, the radius floor at 0 for video, and the mono meter.
