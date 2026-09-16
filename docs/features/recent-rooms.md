# Recent rooms — finished broadcasts with a poster

**Status: `SHIPPED`** — Pass B Run 1, `d4cae00` (2026-09-16), with `seat_leave` moments added in `e0fda49`. Gated by `_gate-room-poster.mjs` (20 assertions: frame choice, a real ffmpeg extraction from a fixture, the poster surviving the capture purge, and the no-capture card).

## What it does

The browse board's job is to look alive with few streamers, so under the live rooms it shows rooms that aired recently, each with a picture of what the room looked like while somebody was on — not a placeholder and not the last frame of the stream, which is an end card or black (`web/components/booth/recent-rail.tsx`, header; `room-poster.js`, header).

## How it works

- **The record** is the airing ([Airings and evidence](../concepts/airings-and-evidence.md)); `/api/rooms/recent` lists closed airings with content, newest first, and reads the poster straight off the room record — no second query, no derivation from a seat list (`server.js`, `/api/rooms/recent`, "the same single-source rule effectiveMaxSeats follows").
- **The frame** comes from self-capture, when there is one: at air-session close, `buildPoster()` picks the **midpoint of the longest clip playback** and extracts one 640-px-wide JPEG with ffmpeg (`room-poster.js`, `chooseFrame`, `buildPoster`; the caller is the air-session `end` handler in `bounty-routes.js`). The brief preferred peak seat count; it was not derivable when the feature shipped and is now — `seat_leave` moments exist — but the rule has not been switched, because nothing has measured whether the two rules pick different seconds on a real capture (`room-poster.js`, "WHICH FRAME").
- **Where it lives** is `data/room-posters/`, a directory nothing sweeps — deliberately not `bounty-captures/`, which is purged at 14 days and emptied per session on a refund. A rail that goes blank after two weeks is worse than one that never had pictures (`room-poster.js`, "WHERE THE POSTER LIVES"; `_gate-room-poster.mjs`, section C).
- **Rooms with no capture get a card, not a fake frame.** Capture runs only during a bounty air session, so a plain MegaChat or live-seat room has no picture and never will. `buildCard()` freezes a snapshot — title, up to four guest labels, duration — onto the room record, and the rail draws it flat and typographic with a *No recording* tag. `poster.kind` (`frame` | `card`) is the contract; the rail never infers which to draw (`room-poster.js`, `buildCard`; `recent-rail.tsx`).
- **Moments** on the card count MegaChat plays and seat joins; leaves are bookkeeping for the seat count and are filtered off the wire (`server.js`, `/api/rooms/recent`; `buildCard`, `room-poster.js`).

## How to use it

Nothing to configure. A room that follows a Twitch channel gets an airing when it goes live and a card when it goes dark; a room that ran a bounty air session gets a real frame.

## What this does NOT do

- **It does not resolve a platform VOD.** `attachRecording()` records a capture reference only; `vodUrl` is null on every airing (`docs/pass-b-handoff.md`, "Explicitly not built"). A card links to the room, not into a replay.
- **It does not produce a frame for rooms outside the bounty program** — there is no capture to read (`bounty-capture.js`, "CAPTURE RUNS ONLY WHILE AN AIR SESSION IS OPEN").
- **It does not show airings with nothing in them.** `recentAirings({ withContent: true })` filters airings with no moments, no replay and no capture (`airings-store.js`).
- **It does not show a room its owner unlisted or paused** — the rail is built from airings, but the link is to the room, and a paused room refuses joins ([Rooms and seats](../concepts/rooms-and-seats.md)).
