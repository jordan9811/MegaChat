# Bounties

A **bounty** is money fans pool against a streamer's name — someone who is not on MegaChat yet. Fans record MegaChats addressed to that streamer and put money behind them. When the streamer claims the name, sets up the overlay, goes live and plays those MegaChats on their broadcast, verification confirms each one aired and the pool is released to them. Source: the mechanic described at the top of `bounty-claim.config.js`.

<!-- snippet:pre-launch -->
{% hint style="warning" %}
**Pre-launch.** MegaChat is deployed but in stealth with no users. This money path has been verified against fixtures, local infrastructure and rehearsal broadcasts run by the project's own operator — not production traffic. No real money has moved through it on anyone's behalf. See `docs/internal/launch-readiness.md`.
{% endhint %}
<!-- /snippet -->

## Three things the word covers

- **A pool** — contributions accumulated against a reserved handle on a platform (`bounty-store.js`, `reserveHandle`, `addContribution`, `getPool`). Pools are derived from the ledger every time; there is no stored balance to drift (`HANDOFF-BOUNTY.md`, "ledger-derived, never a stored balance").
- **A pledge** — one fan's money spread across up to several streamers, with an expiry, claimable by whichever goes live first (`bounty-escrow.js`, `pledge`, `claimPledges`; `bountyConfig.pledgeMaxTargets`).
- **A clip** — the recorded MegaChat itself, stored durably and content-addressed, because for a bounty the clip is the promise (`bounty-clips.js`, "A fan's money and a fan's recording are the same promise").

## The state machine

Every pool moves through a fixed set of states, and the legal moves are one table — `ALLOWED_TRANSITIONS` in `bounty-escrow.js`: `ACCUMULATING → RESERVED → CLAIM_PENDING → CLAIM_VERIFIED → AWAITING_AIRTIME → VERIFYING → PARTIALLY_RELEASED → RELEASED`, with `EXPIRED`, `REFUNDED`, `DISPUTED` and `VOID` as the exits. A transition not in the table throws `IllegalTransition` and writes nothing; the gate checks all 113 illegal combinations (`_gate-bounty-claim.mjs`, section A).

## The ledger, and what "no funds move" means

Money is tracked as an **append-only ledger** with a sequence and checksum chain (`bounty-ledger.js`); a torn final record recovers, interior corruption refuses to load (`_gate-bounty-claim.mjs`, section J). Releases are proportional to verified clip airtime, idempotent by key, and gated on the evidence chain being intact (`release()`, `bounty-escrow.js`, "EVIDENCE GATE").

**Settlement — the step that would pay someone — is a stub.** `bounty-settlement.js` defines the interface and ships one implementation, `StubSettlement`, which records an intent and returns success. There is no signer, no contract call, no transfer, and by design no code path that becomes one by flipping a flag ("real settlement is deliberately ABSENT rather than written-but-disabled"). Gate H in `_gate-bounty-claim.mjs` scans all sixteen `bounty-*.js` modules for transfer-shaped calls and requires zero.

## The flag

The whole program is off unless `BOUNTY_CLAIM=1`. With it off, no bounty routes are mounted and `/bounty` renders a "not open yet" page (`bounty-routes.js`, `attachBountyRoutes`; `_gate-bounty-claim.mjs`, section G). Every mounted route is registered through a guard that looks its path up in an authorization policy table and throws on an unknown path, so a route cannot be added without deciding who may call it (`bounty-routes.js`, the comment above `guarded`; `bounty-auth.js`).

## How the money would be earned

A claimant opens an **air session**, the overlay draws a rotating code while each MegaChat plays, and after the session a verifier reads the public broadcast for those codes at the seconds they were issued. What that proves and does not prove is the subject of [Verification](../verification/README.md). The [Bounty program](../features/bounty-program.md) feature page walks the surfaces.

## What this does NOT do

- It does not pay anyone. Not fans, not streamers, not refunds. Every amount on `/bounty` is a ledger figure; the settlement intents it would produce are queryable and unexecuted (`StubSettlement.pending()`).
- It does not accept money from a fan today except as a ledger row: `POST /api/bounty/contribute` writes the ledger; nothing on that path calls a payment method (Gate H).
- It does not verify a streamer's viewer count as a condition of payout. Viewer samples are recorded as evidence and explicitly not used to weight amounts (`bounty-confidence.js`, "the same mistake as weighting by viewer count").
