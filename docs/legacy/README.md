# The legacy front end

The UI overhaul replaced the landing page, the room board and the create-room
form. It **deleted nothing** — the old front end is still here, still runs, and
is still reachable. This is the map.

## The whole thing, as one unit

The complete pre-overhaul site is captured in a tag:

```bash
git switch --detach legacy-ui-2026-08-29
```

That is the entire website exactly as it ran on 2026-08-29 — vanilla pages,
old Next home, original create form, every asset. If anything below is ever
deleted for real, this tag is the recovery point.

## What still runs, and where

### Reachable in the running app

| Route | What it is | Status |
|---|---|---|
| `/legacy` | The previous Next home page — hero, browse deck, room grid — rendered verbatim | **Live, permanent.** Carries a banner back to the new site |
| `/index.html` | The original vanilla Express viewer page | **Live.** `server.js` keeps it as a deliberate fallback (see its comment near the static mount) |
| `/dashboard.html` | The original vanilla dashboard | **Live**, same static mount |
| `/` with `UI_OVERHAUL=0` | Puts the old home page back at the root | **Live flag**, no rebuild needed |
| `/` with `BROWSE_DECK=0` | Inside the legacy home, swaps the deck for the classic directory | **Live flag**, unchanged by the overhaul |

### Files

**Legacy — only the vanilla pages use these:**

- `public/index.html` — the original viewer
- `public/dashboard.html` — the original dashboard
- `public/app-theme.css`, `public/theme.js`, `public/rewards.js`
- `public/passkey-wallet.bundle.js` (built by `npm run build:passkey`)

**NOT legacy — do not archive or move these:**

- `public/overlay.html` — **the live OBS overlay.** Critical path. It shares
  only `code-matrix.cjs` with the pages above and nothing else
- `public/vendor/`, `public/favicon.svg`, `public/code-matrix.cjs`

**Still in the React tree, still in use:**

- `web/components/legacy-home.tsx` — the old home page, extracted intact so
  `/legacy` and the `UI_OVERHAUL=0` flag can both render it
- `web/components/hero.tsx`, `web/components/browse-deck/**`,
  `web/components/browse-directory.tsx` — mounted by the above
- `web/components/megachat-settings.tsx` and the other dashboard cards —
  **these are not legacy.** The overhaul replaced the CREATE form only;
  managing an existing room still uses them

## Why the files were not moved

`server.js` serves `public/` as static and keeps `/index.html` reachable on
purpose. Relocating those files would break that URL, and repointing it means
editing `server.js`, which is off limits. The tag above archives the stack far
more completely than a folder move would, without breaking anything that runs.

## The new front end, for contrast

| Route | What it is |
|---|---|
| `/` | Landing — the launch film, then the product |
| `/app` | The room board (Booth) |
| `/dashboard` | Create a room; managing keeps the older shell |

See [`../design/README.md`](../design/README.md) for the design record behind
those.
