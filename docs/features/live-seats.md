# Live seats

**Status: `SHIPPED`** — the core product. Metered seats have been proven end to end on mainnet dust by the operator (`_gate-tempo-phase2.mjs`, `_gate-tempo-phase3.mjs`, `_gate-lk-phase1.mjs`–`phase3`), and the join flow through the real UI by `_gate-cohost-booth.mjs` and `_gate-free-megachat.mjs`. Not yet exercised by a paying stranger.

<!-- snippet:pre-launch -->
{% hint style="warning" %}
**Pre-launch.** MegaChat is deployed but in stealth with no users. This money path has been verified against fixtures, local infrastructure and rehearsal broadcasts run by the project's own operator — not production traffic. No real money has moved through it on anyone's behalf. See `docs/internal/launch-readiness.md`.
{% endhint %}
<!-- /snippet -->

## What it does

A viewer opens a room's link, pays per second, and their camera appears in a tile on the streamer's broadcast for as long as they stay. Up to three paid tiles per room (`resolveRoomConfig`, `rooms-store.js`), plus a pinned co-host and any whitelisted guests above that ([Guest whitelist](guest-whitelist.md)).

## How it works

1. **Terms.** The join page fetches the room's price, tick and cap from `/api/config` (`server.js`), which also tells it whether the viewer rides free (`viewerRidesFree`) and whether Join Stream is enabled in this room.
2. **Authorize.** The viewer signs one `approve` of the session cap on the payment token (`web/lib/join-page.ts`, "authorize the session cap with ONE approve, then the server pulls per tick via transferFrom").
3. **Join.** `POST /api/join/passkey` runs, in order: the whitelist short-circuit, the room's Join Stream switch, the reputation gates, then the payment authorization (`server.js`, the route body). A seat is created in `activeSeats`.
4. **Go live.** The viewer's browser publishes to the media server; the seat becomes live when the camera is actually up (`activateSeatLive`, `server.js`), the overlay plays the entrance stinger, and metering starts.
5. **Meter.** Once a second the server pulls one tick (`tickAllMeters` → `tickPasskeyStreamSeat`, `server.js`). Out of balance or past the session cap, the seat ends with `out_of_funds`.
6. **Leave.** Closing the tab, pressing Leave, being kicked, or a stalled connection all reach `removeParticipant()` (`server.js`): the overlay is told, the media server drops the participant, and `refundSeat()` handles whatever was unspent — for the approve-and-pull path, nothing left the wallet ([Money and metering](../concepts/money-and-metering.md)).

**Media.** Rooms use LiveKit when the server has credentials, else the vdo.ninja path (`resolveTransport`, `rooms-store.js`; `livekit.js`). Publisher tokens are minted only for a seat the join flow already granted (`livekit.js`, "Authorization model mirrors the meter"). The overlay connects to LiveKit only while a seat is being bought or held (`livekit-lazy.config.js`).

**The streamer's side.** In LiveKit rooms the streamer's own return camera arms once and publishes itself whenever a guest goes live, so a guest sees the host without the host pressing anything per guest (`web/components/host-cam-card.tsx`, header). If the host's camera is held by another application, the booth keeps retrying every 6 s and shows an alert saying guests can hear but not see them (`web/components/host-cam-card.tsx`, `CAM_RETRY_MS`; `_gate-cohost-booth.mjs`).

## How to use it

- **Viewer:** open `megachat.fun/<handle>` (or `/join?room=<id>`), sign in with Google, email, a passkey or MetaMask, pick a stinger under Advanced if you like, press Join. Your unused cap is never taken (`refundSeat`, `server.js`).
- **Streamer:** create a room, set the per-second price and session cap, add the overlay to OBS ([OBS setup](obs-setup.md)), and keep the dashboard open — that is where you kick, pin, and see the booth.

## Admission and gates

Join Stream has its own switch and admission mode on the room (`resolveJoinStream`, `rooms-store.js`: `admission` is `ai` by default, or `approve`/`manual`), and its reputation gates inherit from MegaChats unless the streamer separates them (`gatesSameAsMegaChat`). The only gate enforced today is minimum watch time, read off the rewards module's watch-time ledger (`checkFeatureGates`, `server.js`). Followers-only and subscribers-only are stored and shown as unenforced in the dashboard ("we never silently enforce what we cannot verify").

## What happens to the money when the overlay goes dark

Pass C Part 3b/3c. A seat is a per-second meter, so its money gets a **rolling pending bucket** rather than a discrete escrow (`seat-escrow.js`, header). Every metered seat opens one (`server.js`, `addParticipant`); every tick accrues into it.

- **The meter stops while the overlay is hidden.** When the room's latest [visibility](overlay-visibility.md) signal is `overlay_hidden`, the server-driven meters skip ticks (`server.js`, `tickAllMeters`; `seat-escrow.js`, `shouldCharge`). The guest is not on the broadcast, so the viewer is not charged.
- **Buried seconds refund to the viewer**, backdated to the hidden window's start. OBS stamps nothing, so that start is the poll receipt. The 30 s of detection lag before it — one poll plus the broadcast delay the audience sees — is refunded from the **platform**, not the streamer, and logged as cost (`seat-escrow.js`, `refundBuried`; `SEAT_DETECTION_LAG_MS`).
- **Sweeps release 80 % and hold 20 % for 72 h.** When the overlay comes back, and when the seat closes, pending is swept: most released to the streamer at once, a holdback kept until the clawback window closes with no flag (`SEAT_HOLDBACK_FRACTION`, `SEAT_CLAWBACK_WINDOW_MS`). This is option B of the post-release clawback design, reused rather than rebuilt: a reversal is a non-payment of the tail, never a debt.
- **Could-not-look claws nothing.** A `SOURCE_UNAVAILABLE` flag on a seat opens a review and the holdback matures on schedule; only a positive failure claws back, and never more than the holdback (`seat-escrow.js`, `clawback`; `_gate-bank-and-seats.mjs`, G5–G6).
- **Manual-paste rooms hold longer.** With no obs-websocket there is no signal to sweep on, so seat money holds until the stream ends plus 10 minutes, capped at 24 hours from seat open, then releases optimistically with the same holdback (`SEAT_MANUAL_TAIL_MS`, `SEAT_MANUAL_MAX_HOLD_MS`). The manage page says so and says what shortens it: connecting OBS (`web/components/overlay-health-card.tsx`).

## What this does NOT do

- **It does not move the seat money yet.** The pending bucket is accounting with stub settlement; the per-tick on-chain pull still pays the payout address directly (`server.js`, `tickPasskeyStreamSeat`). Making the bucket real money is retest-checklist work: redirect ticks to a platform-held balance and implement `RealSettlement` against the recorded intents (`seat-escrow.js`, header; internal outstanding list E38).
- **It does not pause an MPP seat.** Those ticks are client-signed vouchers; refusing one trips the stale-kick and ends the seat instead of pausing it (`server.js`, `tickAllMeters`; limitations register L34).
- **It does not enforce follower or subscriber gates** (`checkFeatureGates`, `server.js`).
- **It does not keep a seat across a server restart** — `activeSeats` is memory (`server.js`).
- **It does not give the streamer a copy of the guest's video.** Media goes through LiveKit to the overlay; nothing is recorded by the seat path.
- **It does not charge for a network blip on LiveKit rooms**; the client pauses ticks and the server allows `LIVEKIT_SEAT_GRACE_S` (+5 s) before a stale kick (`tickAllMeters`, `server.js`).
- **It does not use `/api/join/mpp` from the join page** even though the route exists (status call U1, on the internal *Needs a status call* page).
