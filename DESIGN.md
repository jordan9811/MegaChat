# MegaChat design rules

Codified after the cold-eyes visual audit (2026-07-20). Every UI session
inherits these — deviations are bugs, not style choices. The neon-noir
look lives in `web/app/globals.css` tokens; these rules govern how it's
spent.

## Layout

- Dashboard columns are INDEPENDENT flows (`items-start` + per-column
  `flex flex-col gap-6`), never a shared grid that lets one tall card
  stretch rows — that's how the void-column bug happened.
- Card wrappers that may render null get `empty:hidden`, or ghost wrappers
  eat flex-gap slots and leave dead bands.
- One card = one concern. If a card holds two unrelated blocks, split it.
- Desktop is not stretched mobile: pages with media + controls go
  two-column at `lg` (join page pattern: sticky media column beside card).
- Every container that can be empty gets a DESIGNED idle state (see
  `#previewIdle`), never a dead black box or a grid of disabled inputs.
  Off features collapse to one status line.

## Spacing

- Between cards: `gap-6` (24px). Inside cards: `gap-5` section rhythm,
  `gap-2`–`gap-3` within a group. In-card gaps must stay SMALLER than the
  between-card gap or grouping dissolves.

## Type & casing (the uppercase budget)

Uppercase is spent on exactly three things:
1. Page kickers (`Viewer`, `Streamer dashboard`) — lime, tracking-widest.
2. Big CTAs (Create room, Join Stream, Send a MegaChat).
3. The in-artwork parody pieces (GRAB 10 SEC, breaking-news stinger).

Everything else — card titles, tile titles, tab pills, form labels, copy-row
tags, captions, summaries — is sentence case. When everything is
emphasized, nothing is.

- Hints/captions: `text-xs text-muted-foreground` + `text-pretty` (no
  mid-thought wraps). Labels that sit beside controls get
  `whitespace-nowrap`.
- Never `uppercase` on user content (handles, names) — it misrepresents
  the actual string.

## Components (one of each)

- **Selectable card** (feature tiles, free-room switch, booth arm): checkbox
  + `rounded-xl border p-4`; checked = `border-[accent]/60 bg-[accent]/10`,
  unchecked = `border-border bg-input/20`; title `font-heading text-sm
  font-bold` (sentence case), description `text-xs text-muted-foreground`.
- **Buttons**: primary (solid fill + glow, ONE per view), secondary
  (`border-border bg-input/30`), mini (compact `text-xs` row), pill
  (rounded-full, small actions like Claim/Switch). Don't invent a fifth.
- **Placeholders** are italic + `text-muted-foreground/45` — they must read
  as empty, never as sloppy prefilled values.
- **Walls of text** (>3 lines of instructions) go behind a `<details>`
  disclosure (see "OBS setup guide"), or a triggered popover. Never
  permanent.

## Glow budget

Glow (box or text) belongs to: the landing hero, ONE primary CTA per view,
and live-status accents (LIVE dots). Not on borders, captions, or every
button — glow everywhere reads as mush.

## Verification loop

UI passes are screenshot-verified: `node _diag-ui-shots.mjs [outdir]`
captures every core screen at desktop + mobile; look at the images
yourself before and after. Functional regressions: `_gate-polish.mjs`
(35+ assertions incl. WCAG contrast on the hero CTA) and
`_gate-free-megachat.mjs`.
