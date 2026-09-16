# Flow: a bounty, from pledge to release

Every step exists and is gated. The last step writes a ledger row and a recorded intent — **no funds move** (`bounty-settlement.js`). The whole path is mounted only with `BOUNTY_CLAIM=1` (`attachBountyRoutes`, `bounty-routes.js`).

| # | Step | Where | What can stop it |
|---|---|---|---|
| 1 | A fan records a MegaChat for a streamer who is not on MegaChat, picks an amount and an expiry, optionally more than one target. | `web/components/bounty/record-flow.tsx` | must be signed in (`2e12d51`) |
| 2 | `POST /api/bounty/pledge` reserves the handle if needed (`RESERVED`), writes the contribution and pledge, appends the ledger row. Pool state `ACCUMULATING`/`RESERVED`. | `bounty-routes.js`; `pledge()` in `bounty-escrow.js`; `appendLedger` | policy table in `bounty-auth.js`; `pledgeMaxTargets` |
| 3 | The clip is uploaded and stored durably, content-addressed, index appended. Frames the fan's browser sampled arrive separately. | `POST /api/bounty/clip/:contributionId`, `…/frames`; `bounty-clips.js` | size caps (`BOUNTY_CLIP_MAX_BYTES`) |
| 4 | Moderation grades the clip clean / borderline / violation into the approval queue; an admin approves or rejects. Rejection refunds by reason (as a ledger row) and may strike the contributor. | `moderation.js`; `/api/bounty/queue`, `/clip/:id/approve|reject`; `refundRejectedClip`, `addStrike` | unmoderated when no key — sorts with borderline |
| 5 | The streamer claims the handle. Platform ownership is proven through the linked Privy account. Pool → `CLAIM_PENDING` → `CLAIM_VERIFIED`. | `POST /api/bounty/claim`; `claimPledges()` (atomic across pledges targeting several streamers) | the claim race: first to claim wins each pledge |
| 6 | Setup: the claim page connects OBS, adds the overlay, holds a badge on screen for the streamer to see. | `web/lib/obs-oneclick.mjs`; `2afe679` | — |
| 7 | Live: `POST /api/bounty/air-session` opens a session → `AWAITING_AIRTIME`. Self-capture starts with it. Viewer-count and stream-start samples are captured from the platform. | `bounty-routes.js` (`createAirSession`, `startCapture`); `bounty-stream-context.js` | no channel/watch URL → capture skipped, logged |
| 8 | Each MegaChat playback: `POST /api/bounty/admin/playback` opens a window, codes rotate ~4 s bound to that playback, the overlay draws them, `…/playback/end` closes it. A freeze of the capture window is scheduled 51 s after the end. | `bounty-watermark.js`; `scheduleFreeze`, `bounty-capture.js` | a clip under 3 s → `BELOW_SAMPLING_FLOOR`, pays nothing |
| 9 | While live, the streamer's browser posts OBS scene samples and overlay environment reports. | `…/obs-scene`, `…/overlay-env`, `…/badge` | none — corroboration only |
| 10 | `POST /api/bounty/air-session/:id/end`: pending freezes awaited, poster extracted for the room, `attachRecording` on the airing, capture stopped. | `bounty-routes.js` (`awaitPendingFreezes`, `buildPoster`, `stopCapture`) | — |
| 11 | `POST /api/bounty/air-session/:id/verify`: self-capture first (every window, each with the playback it covers), platform replay as fallback; timeline calibrated per source; frames sampled at code midpoints; decoded and measured; **stream context** gate (warm-up, tail) per playback; verdict from the ladder. `frameOrigin` decides the confidence tier. | `bounty-routes.js` (the `verify` handler); `bounty-verifier.js`; `bounty-timeline-calibration.js`; `bounty-ocr.js`; `bounty-confidence.js` | `SOURCE_UNAVAILABLE` / `AMBIGUOUS` / tier 4 → review queue, never denial |
| 12 | Release: `verifiedClips × releaseRatePerClip` (+ per-second), capped per session, idempotent by key, evidence chain must validate. Ledger rows for the contributor bucket and the platform match, separately. Pool → `PARTIALLY_RELEASED`/`RELEASED`. | `release()`, `bounty-escrow.js` | `evidence_unverified` → skipped |
| 13 | Settlement: `StubSettlement.release()` records `{ kind, to, amount, bucket, ref }` and returns `{ ok: true, stubbed: true }`. Nothing else happens. | `bounty-settlement.js` | — |

## Side exits

- **Expiry.** Unclaimed for `reservationTtlMs` (90 d) → `EXPIRED` → `REFUNDED` as ledger rows (`sweepExpiredPledges`, `refundExpired`).
- **Dispute.** `RELEASED` can only move to `DISPUTED`, which can reopen `VERIFYING` (`ALLOWED_TRANSITIONS`).
- **Admin override.** Logged with actor and reason (`POST /api/bounty/admin/override`, `adminOverride`).

## Proven by

`_gate-bounty-claim.mjs` (102/0: state machine, ledger integrity, Gate H, flag on/off in a real browser, G0 build freshness), `_gate-bounty-program.mjs`, `_gate-bounty-auth.mjs`, `_gate-record-flow.mjs`, `_gate-run-b-pipeline.mjs` (the whole verification distance over HTTP with the real decoder), `_gate-self-capture.mjs`, `_gate-broadcast-delay.mjs`, `_gate-stream-context-http.mjs`, `_gate-confidence-split.mjs`, `_gate-missed-code-authoritative.mjs`, and the real-broadcast entries in `OPEN-ISSUES.md` for Twitch, Kick, pump.fun, YouTube and X.
