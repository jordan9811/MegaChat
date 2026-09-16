# Flow: a paid seat, from link to leave

The path the join page actually takes today. Two of the four payment modes in the code are on it (`passkey_stream` for a funded wallet, `credit_stream` for earned balance); the MPP channel route is mounted but not called by the page ([U1](../../internal/needs-a-status-call.md)).

| # | Step | Where | What can stop it |
|---|---|---|---|
| 1 | Viewer opens `/<handle>` or `/join?room=<id>`. The page resolves the room from the path or query (`parseStreamRoomFromUrl`). | `web/lib/join-page.ts` | unknown room → `/api/config` 404 |
| 2 | `GET /api/config?room=…` returns the terms: `passkeyTickPrice`, `passkeyTickSeconds`, `maxSession`, `maxSeats` (the cap in force), `viewerRidesFree`, `joinStream.enabled`, the token, `transport`. | `server.js`, `/api/config` | room paused → `roomActive: false` |
| 3 | Viewer signs in (Privy: Google, email, passkey — or MetaMask) and, if needed, funds the wallet with a plain token transfer. | `web/lib/join-page.ts`, `walletMode`; `web/components/providers/tempo-wallet.tsx` | no wallet → the page offers both paths |
| 4 | First `POST /api/join/passkey` without a payment header fetches session terms for this wallet. | `web/lib/join-page.ts` (`const first = await fetch('/api/join/passkey'…)`) | — |
| 5 | Viewer signs **one** `approve(seller, sessionCap)` on the payment token; the page waits for the transaction. | `web/lib/join-page.ts`, `SEL_APPROVE`, `waitForTx` | rejected in wallet |
| 6 | Second `POST /api/join/passkey` with the `x-modular-payment` header. Server order: whitelist short-circuit (`tryWhitelistJoin`) → `joinStream.enabled` → `checkFeatureGates` (min watch time) → payment authorization → `addParticipant`. Seat exists in `activeSeats` with `paymentMode: 'passkey_stream'`. | `server.js`, `/api/join/passkey` | 403 `feature_disabled` / `min_watch_time`; 402 insufficient; 409 no chair |
| 7 | Overlay receives `seat_added` over the WebSocket, allocates the tile, and — under lazy connect — connects to LiveKit now if it was not already awake (`prewarmTrigger` fired on the first Join click). | `public/overlay.html`; `livekit-activity.js` | breaker blocking new connections → 503 on token |
| 8 | Viewer's browser gets a publisher token minted for *this* seat and publishes camera + mic. | `POST /api/livekit/token`, `livekit.js` | camera permission denied → `schedulePendingCameraTimeout` ends the seat |
| 9 | Server marks the seat live when the camera is up; entry stinger plays; a `seat` moment is recorded on the room's airing if one is open. | `activateSeatLive`, `server.js` | — |
| 10 | Every second: `tickAllMeters` → `tickPasskeyStreamSeat` pulls one tick with `transferFrom`; the seat's `remaining`/`spent` are broadcast to the viewer. | `server.js`, `tickAllMeters`, `tickPasskeyStreamSeat` | pull fails or cap reached → `removeParticipant(seat, 'out_of_funds')` |
| 11 | In LiveKit rooms a network blip pauses ticks client-side and the server allows `LIVEKIT_SEAT_GRACE_S` (+5 s) before a stale kick. | `tickAllMeters`, `server.js` | past grace → `payment_stalled` |
| 12 | Viewer leaves (`POST /api/leave/:seatId`), closes the tab (WS close → grace timer), is kicked (`/api/dashboard/*` → `removeParticipant`), or runs dry. | `server.js`, `removeParticipant` | — |
| 13 | `removeParticipant`: delete from `activeSeats`; record `seat_leave` on the airing; `lkActivity.seatVacated` starts the overlay's disconnect grace; LiveKit kicks the participant; `seat_removed` to the overlay (exit stinger); `refundSeat` — for `passkey_stream` nothing to refund, the unspent allowance never left the wallet. | `server.js`, `removeParticipant`, `refundSeat` | none of it blocks removal (`refundSeat` is fire-and-forget) |

## Where the money is at each point

- Before step 5: nowhere. No hold, no deposit.
- After step 5: an **allowance** on the token, capped at the session cap. Still in the viewer's wallet.
- Steps 10 onward: one tick per second leaves the wallet to the seller (or the room's `payoutAddress`, `resolveRoomConfig`).
- After step 13: the pulled ticks are the seller's; the remainder of the allowance stays where it always was (`refundSeat`, `server.js`: "unspent funds never left the wallet (allowance)").

## Proven by

`_gate-tempo-phase2.mjs` (the meter on mainnet dust), `_gate-lk-phase1.mjs`–`phase3` (media against a real local SFU, reconnect grace), `_gate-cohost-booth.mjs` (the real UI, host camera), `_gate-lazy-connect.mjs` (20/0 against the real SFU, zero-burn measured — `aba45aa`), `_gate-guest-whitelist.mjs` (the short-circuit ordering at step 6).
