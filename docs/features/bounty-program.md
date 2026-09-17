# Bounty program

**Status: `SHIPPED-PARTIAL`.** Everything up to the money is built and gated: pools, pledges, durable clips, claims, air sessions, the watermark, the verifier, the review queue, the admin surfaces (`_gate-bounty-claim.mjs` 102/0, `_gate-bounty-program.mjs`, `_gate-bounty-auth.mjs`, `_gate-record-flow.mjs`, `_gate-run-b-pipeline.mjs`). **Unproven and unbuilt:** settlement — no funds move, by design (`bounty-settlement.js`). The program is off in production unless `BOUNTY_CLAIM=1` (`bounty-claim.config.js`).

<!-- snippet:pre-launch -->
{% hint style="warning" %}
**Pre-launch.** MegaChat is deployed but in stealth with no users. This money path has been verified against fixtures, local infrastructure and rehearsal broadcasts run by the project's own operator — not production traffic. No real money has moved through it on anyone's behalf. See `docs/internal/launch-readiness.md`.
{% endhint %}
<!-- /snippet -->

## What it does

The concept is on [Bounties](../concepts/bounties.md). This page is the surfaces: what a fan sees, what a streamer sees, what an admin sees, and what happens between them.

## The fan's side — `/bounty`, `/bounty/s/<platform>/<handle>`, `/bounty/mine`

- **The board** (`web/components/bounty/bounty-program.tsx`) lists pools by streamer name with real platform avatars (`d441caa`, `platform-avatars.js`) and, until pools are funded, example amounts marked as such (`web/lib/bounty-examples.ts`, "Example amounts, not funded" on the page).
- **Record and send** (`web/components/bounty/record-flow.tsx`) records a MegaChat for a streamer who is not here yet, attaches an amount and an expiry, and pledges it — across several streamers if the fan wants, claimable by whichever goes live first (`POST /api/bounty/pledge`, `bounty-routes.js`; `bountyConfig.pledgeMaxTargets`). Pledging requires an account, so strikes for rule-breaking clips cannot be shed by renaming (`2e12d51`).
- **My contributions** (`web/components/bounty/my-pledges.tsx`) shows only the signed-in account's own rows; the route takes no identifier from the client, closing an enumeration hole (`GET /api/bounty/my`, `bounty-routes.js`; `b9b8d8f`).
- **Clips are moderated before a streamer sees them** — transcript and frames through the shared pipeline, graded clean / borderline / violation, into an approval queue (`moderation.js`; `POST /api/bounty/clip/:clipId/approve|reject`).

## The streamer's side — claim, set up, go live

1. **Claim the handle** on the streamer page. Ownership of the platform account is proven through the linked Privy account, not asserted (`POST /api/bounty/claim`, `bounty-routes.js`; `_gate-x-claims.mjs`).
2. **Set up the overlay** — the claim flow walks through OBS with a held badge on screen ([OBS setup](obs-setup.md)).
3. **Open an air session** when live (`POST /api/bounty/air-session`). Self-capture starts with the session and only with it (`bounty-routes.js`, "SELF-CAPTURE STARTS WITH THE SESSION AND ONLY WITH THE SESSION"). The room's Twitch/Kick/YouTube/Rumble/X/pump.fun profile decides how verification will behave, and the streamer is shown that bargain in plain words before going live (`PLATFORM_PROFILES[…].notice`, `bounty-claim.config.js`).
4. **Play the MegaChats.** Each playback issues rotating codes bound to that clip; the overlay draws them (`bounty-watermark.js`).
5. **End the session.** Pending captures are frozen, the poster is extracted, and verification runs — reading the public broadcast for each clip's codes and deciding per playback ([Verification](../verification/README.md)).
6. **Release.** Verified airtime releases a proportional slice of the pool as a ledger row, plus a platform match in its own bucket (`release()`, `bounty-escrow.js`). The settlement stub records who *would* be paid (`StubSettlement`).

## The admin's side — `/bounty/admin`

Sessions, reviews, the ledger, overrides, and seeding for the demo board (`/api/bounty/admin/*`, `bounty-routes.js`). Every admin route is behind the policy table in `bounty-auth.js`; `_gate-bounty-auth.mjs` diffs the mounted routes against it.

## What a pool can do while unclaimed

Contributions sit against a reserved handle for up to 90 days (`reservationTtlMs`), then refund — as a ledger row, since no funds moved (`sweepExpiredPledges`, `refundExpired`, `bounty-escrow.js`). A clip that turns out shorter than the sampling floor is recorded as below floor and pays nothing rather than being paid on evidence that cannot be checked (`bountyConfig.minClipSeconds`; `bounty-watermark.js`, "BELOW_SAMPLING_FLOOR").

## Three things a reader of `/bounty` should know

- The preview-build disclosure that used to sit on this page was retired at the owner's call on 2026-09-01: the page does not launch until settlement is real, so a line saying no funds move would describe a state nobody sees it in (`6386a2c`; `docs/design/copy-bank.md`). This handbook says it instead.
- Three fan-facing components render in the pre-overhaul skin (`OPEN-ISSUES.md`, "THE BOUNTY COMPONENTS LOST THE NERVE SKIN") — a front-end task, not a behaviour defect.
- The example pools disappeared once when every seeded pool had been refunded; the condition that hid them was removed in `7ee7426`.

## Going on air — how an approved clip reaches the broadcast

When the streamer opens an air session, it is bound to a room: the one they asked for, the one they already own, or one created for them (`bounty-routes.js`, the air-session route). A bounty claimant is by definition a streamer who was not on MegaChat yet, so "none yet" is the normal case. The session hands back the overlay address to paste into OBS — `/overlay?room=<id>&bountyRoom=<id>` — which does two jobs at once: `room` subscribes the overlay to the room so MegaChats render as tiles, and `bountyRoom` resolves the badge code by room so the same URL still works next stream (`public/overlay.html`).

From there a clip the streamer has approved airs on its own:

1. The dispatcher offers one clip per room per 20 s (`bountyConfig.bankDrainIntervalMs`), oldest approval first, and only while the overlay is not known to be hidden (`bounty-bank.js`, `firstAiringCandidates` and `drain`).
2. It is handed to the same queue every MegaChat plays through (`letters.js`, `enqueueStoredClip`), which plays one clip at a time and refuses to play into a room with no overlay connected.
3. Playback opens a window with a fresh per-playback code and marks the clip played, which is what stops it being offered again (`bounty-watermark.js`, `startClipPlayback`; `bounty-clips.js`, `markPlayed`).
4. Verification counts that playback like any other, and the pledge pays once (`_gate-first-airing.mjs`, C1–C11).

A streamer with no obs-websocket connected emits no visibility signal at all, and their clips still air: the check is "not known hidden", never "known visible", so this can never become a requirement to run obs-websocket in order to be paid.

## Banking — when a pledged clip aired while the overlay was hidden

Pass C Part 3a. A clip that played while the overlay was not on the broadcast used to be simply lost: unverified, unpaid, and eventually refunded at pledge expiry. Now it is **banked** and replayed when the overlay comes back (`bounty-bank.js`).

1. A playback is *buried* when an `overlay_hidden` window from [Overlay visibility](overlay-visibility.md) covers at least half of it (`bountyConfig.bankCoverFraction`). The pledge enters `QUEUED`. A NOT_SHOWN verdict on a playback with a matching hidden window banks it the same way (`bounty-bank.js`, `onVerification`). A scaled overlay does **not** bank — it was on screen.
2. When the room's latest signal is `overlay_visible` and the air session is still open, queued clips replay **one at a time, at most one every 20 s per room** (`bountyConfig.bankDrainIntervalMs`), through the same letters queue every MegaChat plays through (`letters.js`, `enqueueStoredClip`). Each replay opens a new playback window with a **fresh per-playback code** (`bounty-watermark.js`, `startClipPlayback`).
3. **One payable airing per pledge.** A pledge pays once, however many times its clip verified: `release()` collapses verified playbacks by contribution and the ledger row records both the evidence count and the paid count (`bounty-escrow.js`, `payablePlaybacks`). A clip aired twice paid twice before this; the gate shows the old number beside the new one (`_gate-bank-and-seats.mjs`, F1–F4).
4. **Expiry.** A clip still banked 10 minutes after its air session closed, or 12 hours after banking, refunds the fan with reason `BANKED_CLIP_EXPIRED` and opens a review naming why (`bountyConfig.bankTailMs`, `bankMaxHoldMs`; `bounty-routes.js`, `sweepBank`). No unbounded liability.
5. Live seats are never banked — see [Live seats](live-seats.md).

The bank's state is folded from `BANK` rows in the escrow ledger, never stored, so every transition is evidence and every writer is replay-safe (`_gate-bank-and-seats.mjs`, A and E6).

## What this does NOT do

- **It does not pay.** Release and refund are ledger rows and recorded intents; there is no signer and no transfer anywhere in the seventeen `bounty-*.js` modules (Gate H, `_gate-bounty-claim.mjs`; extended to the bank, the seat escrow and the visibility path in `_gate-bank-and-seats.mjs`, I1).
- **It does not let the streamer choose the ORDER clips air in.** Approved clips air oldest-approval-first; skip, hold and reorder are unbuilt (`bounty-bank.js`, `firstAiringCandidates`; internal outstanding list E40).
- **It does not take a fan's money.** `POST /api/bounty/contribute` and `/pledge` write the ledger; no payment method is invoked (Gate H).
- **It does not run unless switched on.** `BOUNTY_CLAIM` defaults off and, off, mounts nothing (`attachBountyRoutes`, `bounty-routes.js`).
- **It does not auto-verify on a warning.** A verification whose signals disagree, or that reads well but misses a required code, routes to a person (`bounty-confidence.js`, tier 4; `bounty-verifier.js`, `NOT_SHOWN`).
- **It does not deny silently.** A banked clip, a clip under a scaled overlay, and a banked clip that expired each carry a named cause in the review builder (`bounty-routes.js`, the verify route and `sweepBank`; `_gate-bank-and-seats.mjs`, H6 and H9).
