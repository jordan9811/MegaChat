# Post-release clawback

**Date:** 2026-07-27
**Status:** DESIGN ONLY — nothing here is implemented
**Recommendation:** staged release (hold back a tail), option B below

## The gap

`escrow.refund()` can only touch contributions in `HELD`. Once money moves to
`RELEASED` it belongs to the claimant and nothing in the system can pull it
back. `RELEASED → DISPUTED` is a legal transition, so the state machine can
*express* the situation, but no code implements the reversal. A dispute decided
against a streamer after they have been paid currently has no mechanism at all.

This matters more now than it did a week ago, because releases are
**incremental**: payouts happen per verified clip as checks come back, not in
one lump at the end. So by the time a pattern of fraud is visible across a
session, much of the money for that session is already gone.

## What the 72h dispute window actually covers

Partially mitigating, by design — and it is worth being precise about the edges,
because "we have a dispute window" reads like more protection than it is.

**Covered:** a release becomes final 72h after it is made. Inside that window an
operator can resolve a dispute and (today) refuse *subsequent* releases from the
same pool.

**NOT covered:**

1. **The window gates finality, not funds.** Nothing physically holds the money
   during those 72 hours. `settlement.refund()` is a stub today, so this is
   currently moot — but the moment settlement is real, a release will move funds
   immediately and the window will be pure bookkeeping unless something changes.
   **This is the crux: the window is a promise with no escrow behind it.**
2. **Fraud discovered after 72h.** Platform VOD takedowns, a viewer reporting a
   faked overlay weeks later, a chargeback upstream. All outside the window.
3. **Verifier error found in bulk.** If `OcrCodeChecker` (Run B) turns out to
   over-accept, every release it produced is suspect, and they will not
   conveniently all be inside one 72h window.
4. **The platform match.** Released into its own bucket and never refunded by
   any path. If contributor money is clawed back, the match that rode on it is
   not addressed anywhere.
5. **Multi-session claimants.** The window is per release. Someone paid across
   ten sessions has ten independent clocks, most already expired.

## Options

### A. Accept the loss, with a written policy
Publish that verified releases are final, cap exposure with
`perSessionCapFraction` and pool size, treat fraud as a cost of doing business.

- **For:** zero engineering. Honest. Never claws back money from an innocent
  streamer, which is a real failure mode of every other option.
- **Against:** unbounded on the fraud side once the mechanic is worth attacking.
  A streamer who works out how to satisfy the verifier can drain pools with no
  recourse. Also weak if a contributor ever disputes upstream — we would owe a
  refund with nothing to fund it.

### B. Staged release (hold back a tail) — **RECOMMENDED**
Release most of each payout immediately; retain a fixed fraction (say 20%) per
claim, payable after a maturity window (say 14 days) with no dispute open.

- **For:** the money is genuinely still ours during the risk window, so a
  reversal is a *non-payment*, not a clawback — no negative balance, no debt,
  no chasing anyone. Fits the existing model exactly: the ledger already tracks
  `remaining` per pool, and holding a tail is one more `HELD` slice, so
  `refund()` with `DISPUTE_RESOLVED` already handles the reversal untouched.
  Streamers still get most of their money immediately, which is what makes the
  mechanic attractive.
- **Against:** every honest streamer waits for part of their payout, and the
  copy has to explain that without souring the pitch. Caps exposure at the
  holdback fraction, not at 100%.

### C. Negative ledger entries against future payouts
Record a debit; net it off anything that claimant earns later.

- **For:** no funds move backwards. Cheap to record.
- **Against:** **only works if they come back.** A streamer who defrauds a pool
  and leaves nets zero recovery — and that is precisely the population you want
  to recover from. Introduces a debt concept the ledger does not currently have,
  which is a large change to something deliberately simple. Ugly to explain if
  a legitimate streamer returns months later to a reduced payout.

### D. Real clawback (reverse the transfer)
Attempt an on-chain reversal or off-chain recovery.

- **For:** complete in principle.
- **Against:** not possible on-chain without the claimant's cooperation. Means
  custody or an allowance we do not have and should not want. Legally and
  operationally the heaviest option by far, for the least certain outcome.

## Recommendation: B, staged release

It is the only option that converts an unsolvable problem (get money back) into
a solved one (do not send it yet). Everything else either accepts the loss (A),
depends on the bad actor returning (C), or requires custody (D).

It also needs the least new machinery: a holdback is a `HELD` slice with a
maturity date, and the refund path built this week already reverses `HELD`
correctly with an enumerated reason and per-contribution idempotency.

Suggested shape, if it is picked up:

- `BOUNTY_HOLDBACK_FRACTION` (default 0.20) and `BOUNTY_HOLDBACK_MATURITY_MS`
  (default 14d), both derived into the release calculation rather than applied
  after it.
- A `HOLDBACK` ledger bucket, separate from `contributor` and `platformMatch`,
  so the three never blend — same discipline as the existing match bucket.
- Maturity sweep releases the tail only when no dispute is open **and** evidence
  still verifies, reusing `evidenceIsTrustworthy()`.
- The streamer-facing surface must show the held tail and its maturity date from
  the start. A payout that silently arrives 20% short is worse than no holdback
  at all.

## What this does not solve

Even with B, anything above the holdback fraction discovered after maturity is
gone. B caps the loss; it does not eliminate it. Options A and B are compatible
— hold back a tail *and* publish a finality policy for what escapes it.

Also unresolved regardless of option: the **platform match** has no reversal
story at all. Whichever route is chosen, decide what happens to a match whose
underlying contributor money went back.
