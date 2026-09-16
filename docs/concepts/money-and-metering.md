# Money and metering

How a viewer pays for a seat, second by second, and what happens to what they did not spend. This page describes the mechanism as the code implements it, including the parts that are dormant.

<!-- snippet:pre-launch -->
{% hint style="warning" %}
**Pre-launch.** MegaChat is deployed but in stealth with no users. This money path has been verified against fixtures, local infrastructure and rehearsal broadcasts run by the project's own operator — not production traffic. No real money has moved through it on anyone's behalf. See `docs/internal/launch-readiness.md`.
{% endhint %}
<!-- /snippet -->

## The chain and the token

Seats are metered in **USDC.e on Tempo mainnet** — `getEnvDefaults()` in `rooms-store.js` sets the payment token to `TEMPO_USDC_ADDRESS` with symbol `USDC.e`, and `/api/config` in `server.js` reports `chainName: 'Tempo'`. Rooms persisted with an Arc-era token address are remapped to the Tempo default at read time and never rewritten on disk (`resolvePaymentToken`, `rooms-store.js`). The `ARC_*` and `CIRCLE_*` names still in `.env.example` belong to other branches; this tree ignores them (`rooms-store.js`, "The legacy USDC_ADDRESS var stays in .env for the Arc branches but is ignored here").

## The unit

A seat is charged one **tick** at a time: `passkeyTickPrice` every `passkeyTickSeconds` (defaults `0.001` per 1 s), up to `maxSession` (default `2`) after which the seat ends (`getEnvDefaults`, `rooms-store.js`; `tickAllMeters`, `server.js`). The public FAQ states the same numbers (`web/app/how-it-works/page.tsx`, "The default live-seat rate is $0.001 per second with a $2 spend limit").

## Four ways a seat can be paid for

`tickAllMeters()` in `server.js` runs once a second and treats each seat by its `paymentMode`. The modes that exist in the code:

| Mode | How it is funded | How it is charged | What refunds |
|---|---|---|---|
| `passkey_stream` | The viewer signs **one** `approve(seller, sessionCap)` on the payment token (`web/lib/join-page.ts`, "authorize the session cap with ONE approve"), then `POST /api/join/passkey` with the `x-modular-payment` header. | The server pulls each tick with `transferFrom` (`tickPasskeyStreamSeat`, `server.js`; `PASSKEY_METER_APPROACH = 'B'`). | Nothing to refund: unspent allowance never left the wallet (`refundSeat`, `server.js`, "unspent funds never left the wallet (allowance)"). |
| `credit_stream` / `points_stream` | Earned watch-to-earn balance in a room (`reward-credits.js`), joined with `useRewardCredit: true`. | Local ticks against the credit (`tickPasskeyStreamSeat`, `localCredit` branch). | The unspent credit is returned to the viewer's balance (`refundSeat`, `creditViewer`). |
| `mpp_session` | `POST /api/join/mpp`: a TIP-1034 payment channel opens on the first paid tick with the session cap as deposit (`meter-mpp.js`, header). | The client sends a signed off-chain voucher per tick to `/api/meter/tick`; the server only enforces liveness and kicks a seat whose ticks stop (`tickAllMeters`, `payment_stalled`). | The channel settles on-chain with the newest voucher and escrow returns the remainder (`refundSeat`, `settleChannel`). |
| `whitelist_stream`, `free_stream` | No payment. | Never ticked (`tickAllMeters` skips both). | Nothing was charged. |

**Which of these a viewer actually gets:** the join page calls `/api/join/passkey` for both wallet kinds it supports — Privy embedded wallets and MetaMask (`web/lib/join-page.ts`, header: "ONE metered join flow for both modes against /api/join/passkey"). The MPP route is mounted and gated, but nothing in `web/lib/join-page.ts` calls it. The older Gateway prepaid route `POST /api/join` answers `501` ("retired in the Tempo migration", `server.js`). Whether `/api/join/mpp` is a live alternative or retained code is an open status call (U1 on the internal *Needs a status call* page).

## What "unused balance refunds automatically" means

The site copy says it (`web/app/layout.tsx`, the description). Mechanically, for the path the join page uses, it is stronger than a refund: with approve-then-pull, money a seat did not consume was never taken (`refundSeat`, `server.js`). For MPP seats it is a literal escrow return on channel close. For earned credit it is a balance restore. All three are in `refundSeat()`, which runs on every seat removal and is fire-and-forget so it never blocks the removal itself (`removeParticipant`, `server.js`).

## Free rooms and pinned seats

A room whose per-second price is zero is a free room; the join page treats a non-positive `passkeyTickPrice` as free (`web/lib/join-page.ts`, `isFreeRoom`), and free seats are never metered. A **pinned** seat — the streamer's co-host — has its meter fully paused (`tickAllMeters`, `if (seat.pinned) continue`).

## Where the money goes

Session settlements pay the room's `payoutAddress` when one is set, else the platform seller wallet from the environment (`resolveRoomConfig`, `rooms-store.js`, "Streamer payout wallet"). MegaChat refunds on rejection are a plain transfer from the platform wallet (`letters.js`, header).

## What this does NOT do

- It does not hold viewer funds in a MegaChat account. There is no balance ledger for viewers except the earned-credit store, which is in memory (`reward-credits.js`, `const store = new Map()`) and does not survive a restart.
- It does not move any money for **bounties**. Bounty escrow is a ledger; settlement is a stub that records intent and moves nothing (`bounty-settlement.js`, "NO FUNDS MOVE"). See [Bounties](bounties.md).
- It does not charge during a network blip on LiveKit rooms: the client pauses ticks and the server allows a grace window before a stale kick (`tickAllMeters`, `LIVEKIT_SEAT_GRACE_S`).
- It has not been exercised by a paying stranger. Every real-money gate ran with the operator's own wallets on mainnet dust (`_gate-tempo-phase2.mjs`, `_gate-tempo-phase3.mjs`, `_gate-p1-features.mjs`, headers).
