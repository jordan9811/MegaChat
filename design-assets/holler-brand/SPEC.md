# Holler — front-end brand spec (2026-10-20)

The owner chose the rebrand: **MegaChat → Holler**. Logo = **Record O**: the word HOLLER in a slanted
azure broadcast strap, the O drawn as a magenta record button. Every agent implements against this file.

**Colourway, 2026-10-21 (third pick, current): the "Azure" neon set** — from the owner's neon HUD reference:
azure **#0a9bff** strap and Call in, magenta **#ff2bd6** record and Holler, readout yellow **#ffd60a** Bounty,
neon green **#39ff6a** Rewards, on **#070b14**. The brand pair stays two of the features ("our colors are nodding
at our core features"). Every fill carries **dark** text (#060a17): white is 2.9:1 on azure. Light mode is the
"Stone" treatment. `web/app/globals.css` holds the measured values; the tables below are kept in step with it.
(Earlier picks, both retired: violet #6d28d9 + record red #ff3b30; then pink #ff2d78 on ultramarine #2f2ad8.)

**Standing alternate — "Late-night TV with pink" (owner's #2, 2026-10-21).** He may switch to it once the launch
film (shot in that look) is done. Same token structure; swap the values:
- dark ground warm black #0d0a08 (panels a shade warmer), a tungsten-lamp bloom #ff9a3c in one corner
- strap + Call in: CRT teal #19c6c0, letters and text on it dark #061214
- Holler + record: MegaChat pink #ff2d78 · Bounty: lamp amber #ffb238 · Rewards: fluoro green #8be36a
- glow on, text on every fill dark (white on teal is ~2:1). Lab card: `design-assets/holler-lab` → Late-night TV, tv-1.

## 1. Names (user-facing copy only)
| Old | New | Notes |
|---|---|---|
| MegaChat (product) | **Holler** | "Enter MegaChat" → "Enter Holler", titles "… — MegaChat" → "… — Holler" |
| MegaChat / MegaChats (the recorded clip) | **Holler / Hollers** | "Record a MegaChat" → "Record a Holler", "MegaChats" tag → "Hollers" |
| Live seats / Open mic / Join stream (live camera seat feature) | **Call in** | feature label + tag. Verbs in sentences may stay ("take a seat") |
| Drops / rewards | **Rewards** | feature label + tag |
| Bounty / Bounties | Bounty / Bounties | unchanged |

Change ONLY visible copy, page titles and metadata. **Never change**: routes, API paths, query params, data
fields, JSON keys, env var names, localStorage/cookie keys, CSS class prefixes (`mc-`, `mcl-`, `mcr-`…),
component/file names, test ids, server code, `public/overlay.html`. The domain stays megachat.fun. Keep the
owner's other copy word for word (his rule: "dont change the copy, i like text that i already have").

## 2. The mark
Component `web/components/holler-mark.tsx` (built in the foundation step), plus `BrandText` re-pointed to it so
every existing `<BrandText />` becomes the new mark.
- Strap: parallelogram `clip-path: polygon(0 0,100% 0,calc(100% - .4em) 100%,0 100%)`, fill `--hl-strap`
  (#0a9bff both themes), padding `.1em .6em .06em .3em`, text `--hl-on-strap` (#060a17: white is 2.9:1 on azure).
- Letters: Archivo 900, `font-stretch: 112%` (load Archivo with the `wdth` axis), uppercase, letter-spacing .01em.
- The O: record button — `width/height .7em; border-radius 50%; background: radial-gradient(circle closest-side,
  var(--hl-record) 0 62%, transparent 63%); box-shadow: inset 0 0 0 .06em var(--hl-record)`.
  **Below 24px rendered size** the O becomes a **solid** magenta (`--hl-record`) dot (the thin ring vanishes at small sizes).
- Variants: `full` (strap + HOLLER), `icon` (strap fragment "H◉" — app icon, favicon, avatars), `bare`
  (letters only, no strap, for very tight spots).
- Glow (optional on hero-size marks, the `hm--glow` variant): `filter: var(--hl-mark-glow)`, which is
  `drop-shadow(0 0 18px color-mix(in srgb, #0a9bff 55%, transparent))` in dark and a soft shadow,
  `drop-shadow(0 6px 14px rgba(10,132,230,.24))`, in light.

## 3. Colour tokens (`web/app/globals.css`, on `:root` = dark, and `.light`)
Everything reads these. No page keeps its own hard-coded brand/feature hexes.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--hl-bg` | #070b14 | #e6e3ee (Stone) | page ground |
| `--hl-panel` | #0d1220 | #fbfaff | cards, panels |
| `--hl-panel-2` | #141a2b | #f1eff6 | raised / nested |
| `--hl-line` | rgba(255,255,255,.09) | #cdc7db | hairlines |
| `--hl-line-2` | rgba(255,255,255,.17) | #b6afc6 | stronger borders |
| `--hl-fg` | #f3f5fb | #0b0a12 | text |
| `--hl-muted` | #a9b1c7 | #3f3a4f | secondary text (≥4.5:1) |
| `--hl-dim` | #8a92aa | #57526a | tertiary (≥4.5:1 on panel) |
| `--hl-strap` | #0a9bff | #0a9bff | brand strap, primary buttons (dark text, `--hl-on-strap` #060a17) |
| `--hl-strap-hi` | #38b0ff | #005fb3 | links, focus, brand hover |
| `--hl-record` | #ff2bd6 | #ff2bd6 | the record, LIVE / on-air dot |
| `--hl-field` | fg at 40% | fg at 48% | a text field's or select's edge (≥3:1) |
| `--hl-danger` | #ff8a4c | #9c3a10 | errors and destructive steps — never magenta, magenta is Holler (light: 5.5:1 on the ground, ≥4.5:1 on its own 10–18% tint) |

**Feature colours** — each feature has five tokens: `--f-<x>` (the hue), `--f-<x>-ink` (text in that colour on
the page), `--f-<x>-bg` (tag tint), `--f-<x>-line` (tag border), `--f-<x>-on` (text on a solid fill).

| Feature | `--f-x` dark / light | `-ink` dark / light | `-on` |
|---|---|---|---|
| holler (magenta, the record) | #ff2bd6 / #e01fbd | #ff5fe0 / #a8128a | #060a17 on -solid #ff2bd6 |
| callin (azure, the strap) | #0a9bff / #0a84e6 | #38b0ff / #005fb3 | #060a17 on -solid #0a9bff |
| bounty (readout yellow) | #ffd60a / #ffd60a | #ffd60a / #6b5a00 | #060a17 on #ffd60a |
| rewards (neon green) | #39ff6a / #39ff6a | #39ff6a / #0a6e2a | #060a17 on #39ff6a |

`-bg` (the tag tint) and `-line` (the tag border), as shipped:

| Feature | `-bg` dark | `-line` dark | `-bg` light (mixed into `--hl-panel`) | `-line` light |
|---|---|---|---|---|
| holler | hue at 12% | hue at 45% | hue 14% | #e01fbd at 55% |
| callin | hue at 14% | hue at 50% | hue 12% | #0a84e6 at 55% |
| bounty | hue at 4.5% (yellow over the navy goes grey and olive) | hue at 70% (~#b69b11 gold: in dark the yellow lives in the line, not the tint) | hue 14% | 70% ink mixed into the hue |
| rewards | hue at 10% | hue at 45% | hue 14% | 70% ink mixed into the hue |

The light bounty and rewards lines mix in the ink because the pale hue alone vanishes on white. `--f-<x>-ui` is a mark that must hold 3:1 on its own (a stripe, an on-dot, a tag dot's edge):
the hue in dark, the ink in light, except bounty in light, which takes its line #977f03 (3.1:1 on the ground,
3.8:1 on a card; the ink #6b5a00 reads olive beside the neons). Money amounts use bounty yellow-ink. Errors,
faults and alarms use `--hl-danger` (border at 50%, tint at 10%), never a holler token.
LIVE / on air uses `--hl-record` (the magenta light). In light, a lone LIVE dot on the stone ground or a tint
takes `--f-holler` (#e01fbd, 3.25:1; #ff2bd6 is 2.5:1 there), scoped to the dot so the mark's O keeps
#ff2bd6. Cyan #3ae8ff, lime #b8ff45 and #cfe83a, gold #ffd23d,
cyan-green #00ffc3, and the earlier colourways' violet #6d28d9 / record red #ff3b30 / call-in purple #a855f7 /
pink #ff2d78 / ultramarine #2f2ad8 are **retired** as UI colours — replace
them by meaning (action → strap; live → record; money/bounty →
bounty; rewards → rewards; recorded clip → holler; camera seat → callin).

## 4. Feature tags
Component `web/components/feature-tag.tsx`: `<FeatureTag kind="holler|callin|bounty|rewards" />` — a subtle pill:
`--f-x-bg` fill, 1px `--f-x-line` border, 6px dot in `--f-x`, label in `--f-x-ink`, Space Mono 10.5px uppercase
.1em tracking, radius 999px, padding 3px 8px. Optional `children` overrides the label. Use it wherever a room says
what it offers (board cards, featured room, join room bar, create-room feature tiles when on, dashboard, bounty
pages) and to label recorded moments (a recorded clip = holler; a guest on camera = callin).

## 5. Light mode
`next-themes`: `enableSystem` on, `defaultTheme="system"`, attribute `class`. A sun/moon `ThemeToggle` in every
page header. Pages must stop forcing `dark` on their roots; their scoped variables map onto `--hl-*` so both
themes work. Glows: only in dark (`.dark` or `:root:not(.light)`); in light use soft shadows instead. The launch
film and real stream thumbnails stay as they are in both themes.

## 6. Motion (unchanged house rules)
Ease-out `cubic-bezier(.23,1,.32,1)`, 150–260ms, transform/opacity only, `:active` scale .97, hover only under
`(hover:hover) and (pointer:fine)`, reduced motion off.

## 7. House rules
Single quotes, no semicolons, no Prettier (`web/` has no config — never run it). Stage files explicitly; never
`git add -A`. Don't touch money paths (`settlement.js`, `escrow-chain.js`), `server.js` behaviour, or
`docs/internal/needs-a-status-call.md`. Pre-existing uncommitted edits in `docs/` and `web/next-env.d.ts` are
someone else's — leave them unstaged.
