# Flow: a whitelisted guest walks in free

The short circuit at the head of every join route, and what it deliberately does not skip.

| # | Step | Where | What can stop it |
|---|---|---|---|
| 1 | The streamer, signed in, adds a handle on the account page → `POST /api/whitelist/add`. The route resolves the requester from the sealed identity cookie — no room password path exists here. The entry pins the guest's `identityKey`. | `whitelist-routes.js`, `requireStreamer`; `addGuest(ownerKey, handle, identityKey)`, `guest-whitelist.js` | 401 signed out; list full (`whitelistMax`) |
| 2 | The streamer turns the list on → `POST /api/whitelist/enabled` with a boolean body; anything else is 400. | `whitelist-routes.js` | — |
| 3 | The guest opens the room link, signed in. `GET /api/config` runs the same server-side check the join will run and reports `viewerRidesFree: true`, so the page shows no wallet chrome. | `server.js`, `/api/config` (`whitelistGuestFor`) | — |
| 4 | `POST /api/join/passkey` (or `/mpp`). **First thing in the handler:** `tryWhitelistJoin(req, res)`. It resolves the room, then `whitelistGuestFor` reads the identity cookie, derives the owner key of the room, and asks `isWhitelisted(owner, handle, identityKey)`. A handle-only match is refused when the entry carries a key. | `server.js`, `tryWhitelistJoin`, `whitelistGuestFor`; `isWhitelisted`, `guest-whitelist.js` | not on the list → returns `false`, the paid path runs as normal |
| 5 | Matched: `addParticipant` with `paymentMode: 'whitelist_stream'`, `pinned: true`, zero balances, no payer. Pinned is what "rides above `maxSeats`, meter paused" has meant for the co-host pin since it shipped, so the guest neither waits for a chair nor takes a paid one. | `server.js`, `tryWhitelistJoin` (the comment above it) | **room stopped → 403.** The whitelist does not override a paused room; that is a missing room, not a gate on the person. |
| 6 | `recordWhitelistJoin` — the whole audit trail: one record that this guest walked in free, one log line. No hold, no ledger row, no transfer. | `server.js`; `recordJoin`, `guest-whitelist.js` | — |
| 7 | The response carries `free: true`, the flag the join client already reads to skip the meter UI. Camera publish and `activateSeatLive` proceed as for any seat. | `server.js`, `tryWhitelistJoin` | camera timeout as for any seat |
| 8 | Every surface reports the cap **in force**: `effectiveMaxSeats(roomId, configured)` = configured + active whitelist guests, capped at ten. `initial_state`, `seat_added`, `/api/seats`, and the browse card all read it; paying admission counts `payingSeatCount` only. | `server.js`, `effectiveMaxSeats`, `payingSeatCount`, `/api/rooms/public` | eleventh tile → refused (`MAX_EFFECTIVE_SEATS`) |
| 9 | `tickAllMeters` skips `whitelist_stream` seats outright — belt and braces on top of `pinned`, so a streamer unpinning a guest from the dashboard cannot start billing someone who was told they ride free. | `server.js`, `tickAllMeters` | — |
| 10 | Leave: `removeParticipant` as for any seat; `refundSeat` marks it refunded because nothing was charged; the effective cap falls back on the next read. | `server.js`, `refundSeat` | — |

## What still applies to a guest

- The room must be accepting joins (step 5).
- Join Stream must be enabled in the room — the short circuit runs before that check only in the sense that a *match* returns early with a seat; the seat itself is refused on a stopped room by `addParticipant`.
- The overlay must have a slot: ten is the ceiling, derived from the canvas and the verifier's badge floor (`server.js`, above `MAX_EFFECTIVE_SEATS`).

## The migration

Entries written before `identityKey` existed match on handle alone. `_migrate-whitelist-identity.mjs` reports them; `--write` pins keys by resolving each handle through `getIdentityByHandle` and leaves the unresolvable ones listed. Exercised locally; **not yet run against the production volume** — on the internal *Outstanding* page.

## Proven by

`_gate-guest-whitelist.mjs` — 63 assertions over real HTTP: add/remove/toggle authorization, the strict boolean toggle, the short-circuit ordering, a rejoin three times, the raised cap visible on `/api/seats` and the browse card with `available === 0` for paying viewers, the fallback on leave, and the guest rendering on the overlay past the configured cap in a real browser.
