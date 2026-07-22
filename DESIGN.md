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

### Lifecycle gating (the rule that keeps getting violated)

A card belongs to a **lifecycle state**, and renders `null` outside it.
"Config" cards (things you set up: pricing, features, rewards) appear while
creating AND managing. "Runtime" cards (things that only exist once the
room does: live seats, share links, clip queue, host booth) render ONLY
while managing.

A runtime card that renders an explanation of its own uselessness —
"Create or unlock a room to see who's on camera" — is worse than absent:
it takes the top of the column and pushes what you're actually doing
below it. If a card's empty state says "do the thing you haven't done
yet", it should not be mounted yet.

Current gating (keep this table honest):

| Card | Create | Managing |
|---|---|---|
| MegaChat settings | ✅ | ✅ |
| Rewards / drops | ✅ (config) | ✅ |
| Integrations | ✅ (config) | ✅ |
| Share links | ❌ | ✅ |
| On camera | ❌ | ✅ |
| Co-host booth | ❌ | ✅ (livekit only) |
| MegaChats queue | ❌ | ✅ (when enabled) |

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
yourself before and after.

**Screens are not enough — shoot STATES.** Most defects found by the owner
lived in a state the screenshot pass never entered: the dashboard while
creating, a free room's join page, a signed-out header. Before calling a
UI pass done, walk the matrix and look at each cell:

- dashboard: signed out · signed in, no rooms · creating · managing
- join: free room · paid room · mid-session (live) · no-preview room
- both themes, both Simple/Advanced, 375px and 1280px

A card that looks right in one state is not evidence about the others. Functional regressions: `_gate-polish.mjs`
(35+ assertions incl. WCAG contrast on the hero CTA) and
`_gate-free-megachat.mjs`.
