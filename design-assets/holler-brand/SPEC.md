# Holler — front-end brand spec (2026-10-20)

The owner chose the rebrand: **MegaChat → Holler**. Logo = **Record O**: the word HOLLER in a slanted
deep-violet broadcast strap, the O drawn as a red record button. Every agent implements against this file.

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
  (#6d28d9 both themes), padding `.1em .6em .06em .3em`, text #fff.
- Letters: Archivo 900, `font-stretch: 112%` (load Archivo with the `wdth` axis), uppercase, letter-spacing .01em.
- The O: record button — `width/height .7em; border-radius 50%; background: radial-gradient(circle closest-side,
  var(--hl-record) 0 62%, transparent 63%); box-shadow: inset 0 0 0 .06em var(--hl-record)`.
  **Below 24px rendered size** the O becomes a **solid** red dot (the thin ring vanishes at small sizes).
- Variants: `full` (strap + HOLLER), `icon` (strap fragment "H◉" — app icon, favicon, avatars), `bare`
  (letters only, no strap, for very tight spots).
- Glow (dark theme only, optional on hero-size marks): `drop-shadow(0 0 18px color-mix(in srgb, #6d28d9 45%, transparent))`.

## 3. Colour tokens (`web/app/globals.css`, on `:root` = dark, and `.light`)
Everything reads these. No page keeps its own hard-coded brand/feature hexes.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--hl-bg` | #0a0812 | #f6f4fa | page ground |
| `--hl-panel` | #110e1b | #ffffff | cards, panels |
| `--hl-panel-2` | #181424 | #efebf6 | raised / nested |
| `--hl-line` | rgba(255,255,255,.09) | rgba(22,20,28,.10) | hairlines |
| `--hl-line-2` | rgba(255,255,255,.17) | rgba(22,20,28,.18) | stronger borders |
| `--hl-fg` | #f5f3fa | #16141c | text |
| `--hl-muted` | #b3adc2 | #4f4960 | secondary text (≥4.5:1) |
| `--hl-dim` | #8d86a0 | #6b6580 | tertiary (≥4.5:1 on panel) |
| `--hl-strap` | #6d28d9 | #6d28d9 | brand strap, primary buttons (white text) |
| `--hl-strap-hi` | #8b5cff | #5b21b6 | links, focus, brand hover |
| `--hl-record` | #ff3b30 | #e0261c | the record, LIVE / on-air dot |

**Feature colours** — each feature has five tokens: `--f-<x>` (the hue), `--f-<x>-ink` (text in that colour on
the page), `--f-<x>-bg` (tag tint), `--f-<x>-line` (tag border), `--f-<x>-on` (text on a solid fill).

| Feature | `--f-x` dark / light | `-ink` dark / light | `-on` |
|---|---|---|---|
| holler (red) | #ff3b30 / #e0261c | #ff6b62 / #c21d14 | #ffffff |
| callin (purple) | #a855f7 / #7c3aed | #c08bff / #6d28d9 | #ffffff |
| bounty (yellow, the owner's "#cfe83a") | #cfe83a / #cfe83a | #cfe83a / #556400 | #16141c |
| rewards (green/cyan) | #00ffc3 / #00ffc3 | #00ffc3 / #007a5c | #16141c |

`-bg` = the hue at 12% alpha (dark) / 14% (light); `-line` = 45% / 55%. Money amounts use bounty yellow-ink.
LIVE / on air uses `--hl-record` (the red light). Cyan #3ae8ff, lime #b8ff45, pink #ff2d78 and gold #ffd23d are
**retired** as UI colours — replace them by meaning (action → strap violet; live → record red; money/bounty →
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
