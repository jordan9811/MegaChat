# Sub-3s clip residual — where does the money go?

**Status: open. Product decision, not an engineering one.**
**Owner: Jordan. Nothing is implemented; current behaviour is option 0 below.**

## The problem in one paragraph

A fan pays to record a MegaChat. If that clip is shorter than
`BOUNTY_MIN_CLIP_SECONDS` (3s), it cannot host a watermark code long enough to
be sampled from a re-encoded stream, so it is recorded `BELOW_SAMPLING_FLOOR`
and **pays the streamer nothing** — correctly, because we cannot prove it
aired. But the fan's contribution is already in the pool. Nothing releases it
and nothing returns it. Over time a pool accumulates money with no defined
destination.

This is small per clip and unbounded in aggregate. It is also the kind of thing
that looks like theft in a screenshot, regardless of intent.

## Current behaviour (option 0 — the status quo, not a choice anyone made)

Money enters the pool, the clip never verifies, the money sits. If the handle
is never claimed it eventually refunds via the expiry path. If the handle IS
claimed, the residual stays in the pool and is silently available to fund
*other* clips' payouts — which is option 2 by accident rather than by decision.

**That accidental-option-2 is the strongest argument for deciding this now:**
we are already doing one of the options, just without having chosen it or told
anyone.

---

## Option 1 — Refund the contributor

Return the money when a clip is marked below the floor.

| | |
|---|---|
| **User-facing** | Fan pays, clip is too short, money comes back. Honest and self-explanatory. Slight oddity: they "sent" something that then un-sent itself. |
| **Implementation** | Low–moderate. The refund path already exists (`refundExpired` → per-contribution idempotency keys → stubbed settlement). Needs a per-contribution trigger rather than a per-handle one, plus a reason code so the fan sees why. **Real settlement is stubbed, so this is not actually payable until Run B.** |
| **Pool accounting** | Cleanest. The contribution never counts toward `totalContributed`, so `remaining` stays honest and no residual accrues. |
| **Risk** | Refund spam: a bad actor could churn sub-floor clips to generate refund traffic. Mitigate with option 3's upload check, which makes this mostly unreachable. |

## Option 2 — Redistribute into the pool for verifiable clips

Keep the money; it funds payouts for clips that do verify.

| | |
|---|---|
| **User-facing** | Fan's money goes to the streamer, just not attributed to their clip. Defensible if disclosed up front; indefensible if discovered later. **Requires explicit copy at upload time**, or it is the screenshot problem above. |
| **Implementation** | Lowest — it is what already happens. Needs disclosure copy and a ledger entry recording the reassignment so it is auditable rather than implicit. |
| **Pool accounting** | Muddies attribution: `totalContributed` includes money no clip can ever claim, so per-clip payout math drifts from what fans think they bought. Needs a distinct bucket (like the existing `platform_match` split) to stay legible. |
| **Risk** | Perverse incentive. A streamer earns from clips they never played, which is precisely the "paid for airtime, not for playing clips" flaw already corrected once in this design. Reintroducing it through the back door would be a regression in principle even if small in money. |

## Option 3 — Reject sub-floor clips at upload

Refuse the recording before payment. The money never enters.

| | |
|---|---|
| **User-facing** | Best. "Clips need to be at least 3 seconds" at record time is a normal, expected constraint — the same class as a file size limit. No money moves, nothing to explain afterwards. |
| **Implementation** | Low, but more than I first assumed — I checked. `letters.js:254` validates only `dur <= 0 \|\| dur > maxSeconds + 1`, i.e. an upper bound. The `Math.min(30, Math.max(3, …))` in `resolveLetters` clamps **maxSeconds**, not a minimum. **There is no minimum-duration check today: a 1-second clip uploads and pays fine.** So this is adding a real check, not binding two existing ones. Still small — one condition plus a message. |
| **Pool accounting** | Perfect. No residual can exist, so nothing to account for. |
| **Risk** | Minimal. Only that the upload minimum and `BOUNTY_MIN_CLIP_SECONDS` drift apart later — derive one from the other rather than duplicating the number. |

## Option 4 — Escrow the residual against a future airing

Hold sub-floor contributions separately; release if the same clip is later
re-recorded above the floor, refund after a TTL if not.

| | |
|---|---|
| **User-facing** | "Your clip was too short — re-record it and your payment carries over." Generous. |
| **Implementation** | Highest. New state, new expiry, a linkage between an abandoned clip and its replacement that nothing currently models. |
| **Pool accounting** | A third bucket alongside contributor and platform_match. |
| **Risk** | Complexity far beyond the money involved. Mentioned for completeness; I do not recommend it. |

---

## Recommendation

**Ship option 3 (reject at upload), with option 1 (refund) as the safety net.**

Reasoning:

1. **Option 3 makes the problem not exist.** Every other option is a policy for
   handling money that should never have been taken. Prevention beats
   remediation, and the validation point already exists.
2. **There is currently no minimum at all** (verified: `letters.js` bounds only
   the maximum), so today a 1-second clip is accepted, charged, and then
   silently unpayable. That is the sharpest form of the problem and it is live
   right now — which moves this from housekeeping to worth doing.
3. **Option 1 is still needed** for clips already in flight and for any future
   case where the floor is raised above the upload minimum. It is a safety net,
   not the primary mechanism, so refund-spam risk stays theoretical.
4. **Option 2 should be explicitly rejected**, not left as the default. It pays
   a streamer for clips they did not play, which is the exact flaw this design
   already corrected once. Doing it accidentally is worse than doing it on
   purpose, and we are currently doing it accidentally.

**Concretely:** add a minimum-duration check at upload derived from
`BOUNTY_MIN_CLIP_SECONDS` (there is none today) so a sub-floor clip cannot be
recorded while bounty mode is on; add a
`BELOW_FLOOR_REFUND` path for contributions that predate the check; and put a
line in the record UI stating the minimum length before the fan hits record.

**One caveat, stated plainly:** nothing here is payable until real settlement
exists (Run B). Until then any refund is a ledger entry describing an intent,
not money moving — so option 3 is doubly right, because it is the only option
that works correctly without a settlement backend.
