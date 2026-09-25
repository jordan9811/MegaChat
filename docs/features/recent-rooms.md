# Recent rooms — finished broadcasts with a real picture

**Status: `SHIPPED`** — Pass B Run 1, `d4cae00` (2026-09-16); real pictures for ordinary broadcasts and the board's placement, 2026-09-25. Gated by `_gate-airing-poster.mjs` (the frame choice, restarts, the recording fallback, cleanup, owner-only previews), `_gate-board-fold.mjs` (placement and size in a real browser at 1920x927 and 1440x900) and `_gate-room-poster.mjs` (the bounty capture frame and the no-picture card).

## What it does

The board's job is to look alive with few streamers, and a room that was busy an hour ago is more interesting than an empty grid cell. So when nothing is live, **Recently aired sits directly under the featured card, above the rooms**, one row of it, above the fold; when something is live it follows the rooms. Tile size follows how full the board is: four tiles or fewer share one row at 300–520px each, more than that drop to ~236px tiles. Above it all, a big stream (the server's `BOARD_BIG_VIEWERS` Twitch viewers, on a channel its owner has linked) gets the big featured card, and two big streams share the row (`web/components/booth/booth.tsx`, "WHAT FILLS THE BOARD, IN ORDER"; `_gate-board-fold.mjs`). Each card is a picture of that broadcast from when a guest was on camera or a MegaChat was playing — the owner's rule — never a placeholder and never the last frame, which is an end card or black (`airing-posters.js`, header).

## How it works

- **The record** is the airing ([Airings and evidence](../concepts/airings-and-evidence.md)). `/api/rooms/recent` lists finished airings that had a seat or a MegaChat (or our own capture), newest first; a broadcast nobody joined is not board content, even with a recording attached (`airings-store.js`, `recentAirings`).
- **The picture is per airing**, not per room — a room airs many times (`airing-posters.js`; `GET /api/airings/:airingId/poster.jpg`). Best first: our own capture from a bounty air session; a frame of the recording at a chosen second (written by hand today — production has no ffmpeg); **Twitch's live preview, kept while the stream was up** and picked at close from while a guest was on; the recording's own thumbnail as a last resort for a broadcast that had guests but no usable preview. A poster is only ever replaced by one as good or better.
- **While live**, the follow loop keeps each refresh of Twitch's preview image — deduplicated, and never the offline placeholder or a near-black frame — for rooms somebody signed in to own (`server.js`, `followTick`; `snapshotLivePreview`).
- **Which frame**: the middle of the longest stretch with the most guests on camera, or with no seats the first MegaChat; a preview fetched at T shows the stream some time in the five minutes before T, so only previews that could show that stretch are eligible, and ones from the opening or closing minutes only when no other could (`pickCandidate`). A restart ends every seat — seats live in memory — so the server marks one in each open airing at boot (`markRestart`).
- **After the end**, a sweep attaches the Twitch recording, falls back to its thumbnail when needed, and clears previews an hour after the end, plus anything left by airings the store no longer keeps or whose room is gone (`sweepAiringPosters`). A stream that ended while the server was down is closed at the last moment it was known up (`lastEvidenceAt`).
- **A broadcast with no picture gets a card, not a fake frame**: title, guests, duration, drawn flat and typographic (`buildCard`, `room-poster.js`; `web/components/booth/recent-rail.tsx`). `poster.kind` (`frame` | `card`) is the contract; the rail never infers which to draw.

## How to use it

Nothing to configure. A room that follows a Twitch channel records each broadcast; one where a guest took a seat or a MegaChat played shows up on the board with a picture minutes after it ends. `AIRING_POSTERS=0` turns the pictures off (previews, picks and the sweep) and leaves the cards.

## What this does NOT do

- **It does not pull a frame from the recording in production** — there is no ffmpeg or extractor on the host. The `twitch-vod` rank exists for a frame written by hand; the owner's 2026-09-24 stream was backfilled that way (`OPEN-ISSUES.md`, R4).
- **It does not show broadcasts nobody joined** (`airings-store.js`, `recentAirings`; `DECISIONS.md`, "The board's order and its pictures").
- **It does not keep previews for a room nobody signed in to own**, so a password-only room naming someone else's channel cannot fill the volume (`server.js`, `followTick`; `_gate-airing-poster.mjs`, L3).
- **It does not show a room its owner unlisted**, and it links to the room, not into the replay (`server.js`, `/api/rooms/recent`; `web/components/booth/recent-rail.tsx`).
