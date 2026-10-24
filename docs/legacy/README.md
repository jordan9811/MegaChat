# The legacy front end

The UI overhaul replaced the landing page, the room board and the create-room
form. It **deleted nothing** — the old front end is still here, still runs, and
is still reachable, apart from three files later rounds deleted (listed below).
This is the map.

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
| `/index.html` | The original vanilla Express viewer page | **Gone.** Deleted in 944aa2c (2026-09-17): it carried a client-signed deposit the server could not refuse. Nothing serves an index from `public/` (`server.js`, the comment at the static mount), and Gate H asserts the URL answers 404 (`_gate-money.mjs`, P) |
| `/dashboard.html` | The original vanilla dashboard | **Live**, same static mount |
| `/` with `UI_OVERHAUL=0` | Puts the old home page back at the root | **Live flag**, no rebuild needed |
| `/` with `BROWSE_DECK=0` | Inside the legacy home, swaps the deck for the classic directory | **Live flag**, unchanged by the overhaul |

### Files

**Legacy — only the vanilla pages use these:**

- `public/dashboard.html` — the original dashboard
- `public/app-theme.css`, `public/theme.js`
- Gone: `public/index.html`, the original viewer, and `public/passkey-wallet.bundle.js` (both deleted in 944aa2c; nothing rebuilds the bundle); `public/rewards.js`, deleted 2026-10-24 because no page loaded it — the watch-to-earn client is `initRewardsClient` in `web/lib/join-page.ts`

**NOT legacy — do not archive or move these:**

- `public/overlay.html` — **the live OBS overlay.** Critical path. It shares
  nothing with the pages above; `code-matrix.cjs` is its own badge renderer
- `public/vendor/`, `public/favicon.svg`, `public/code-matrix.cjs`

**Still in the React tree, still in use:**

- `web/components/legacy-home.tsx` — the old home page, extracted intact so
  `/legacy` and the `UI_OVERHAUL=0` flag can both render it
- `web/components/hero.tsx`, `web/components/browse-deck/**`,
  `web/components/browse-directory.tsx` — mounted by the above
- The dashboard shell mounts only the create form. The older dashboard cards
  (`megachat-settings.tsx` and its neighbours) were unmounted and are deleted;
  `git show 1f06bef:web/components/megachat-settings.tsx` has the last copy.

## Why the files were not moved

`server.js` serves `public/` as static, so `/dashboard.html` is reachable at
its file's path. Relocating the files would break that URL, and repointing it
means editing `server.js`, which is off limits. The tag above archives the stack
far more completely than a folder move would, without breaking anything that runs.

## The new front end, for contrast

| Route | What it is |
|---|---|
| `/` | Landing — the launch film, then the product |
| `/app` | The room board (Booth) |
| `/dashboard` | Create a room, then manage it on the same page (`web/components/create-room/create-room.tsx`) |

See [`../design/README.md`](../design/README.md) for the design record behind
those.
