# CREATOR BOUNTY — Run A handoff

Branch: `feat/bounty-claim-runA`, off `v0-ui-migration` (current prod).
Gate: **33/0**. Build clean. Browse-deck gate re-run 19/0, no regression.

> **No funds move in this run.** Escrow is a state machine over an append-only
> ledger; settlement is a stub that records intent. Gate H scans every bounty
> module for `sendTransaction` / `writeContract` / `transferFrom` / `.transfer(` /
> `signTransaction` / `privateKeyToAccount` and asserts zero hits.

## One-line revert
`BOUNTY_CLAIM` is unset/`0` by default — the feature is already off. With it
off, `attachBountyRoutes` mounts nothing (routes 404), `/bounty` renders a
plain "not available" page, and no existing surface changes. Gate G proves all
three.

## What's real vs stubbed

| Area | Status |
|---|---|
| Reserved handles, contributions, pools | **Real** (ledger-derived, never a stored balance) |
| Escrow state machine + transition table | **Real** — 113 illegal combinations verified to throw and write nothing |
| Append-only ledger + idempotency | **Real** |
| Refund path | **Real** ledger-side; settlement stubbed |
| Watermark issuance, rotation, expiry, namespacing | **Real** |
| Overlay badge rendering + size check | **Real** (limitation below) |
| Verifier pipeline | **Real**; frame source + code checker are **mocked** |
| Payout math, platform match, dispute window | **Real** |
| Bounty board / claim flow / admin | **Real** UI on real data |
| Identity verification | **STUBBED** — auto-approves, logs `STUBBED_APPROVAL` |
| Frame grabbing, live status, OAuth, settlement | **STUBBED / absent** — see OPEN-ISSUES.md B1–B5 |

## Interfaces Run B implements
```
FrameSource.getFrames(platform, handle, timestamps[]) -> FrameRef[]
CodeChecker.findCode(frameRef, expectedCodes[])       -> { found, confidence }
IdentityVerifier.verify(platform, handle, claimant)   -> { approved, method }
SettlementInterface.release({ to, amount, bucket, ref })
SettlementInterface.refund({ to, amount, ref })
```
Empty subclasses already exist: `TwitchFrameSource`, `KickFrameSource`,
`OcrCodeChecker`. `RealSettlement` does **not** exist by design — see below.

## Config (`bounty-claim.config.js`)
| Knob | Env | Default |
|---|---|---|
| Master flag | `BOUNTY_CLAIM` | **off** (`1` enables) |
| Reservation TTL | `BOUNTY_RESERVATION_TTL_MS` | 90d |
| Claim TTL | `BOUNTY_CLAIM_TTL_MS` | 14d |
| Code rotation | `BOUNTY_CODE_ROTATE_MS` | 60s |
| Code validity | `BOUNTY_CODE_VALIDITY_MS` | 75s |
| Badge min ratio / px | `BOUNTY_BADGE_MIN_RATIO` / `_PX` | 0.03 / 18 |
| Release rate per verified minute | `BOUNTY_RELEASE_RATE_PER_MIN` | 0.05 |
| Per-session cap | `BOUNTY_PER_SESSION_CAP` | 0.25 |
| Platform match | `BOUNTY_PLATFORM_MATCH` | 0.25 |
| Min confidence | `BOUNTY_MIN_CONFIDENCE` | 0.6 |
| Dispute window | `BOUNTY_DISPUTE_WINDOW_MS` | 72h |
| Verifier fixture | `BOUNTY_FIXTURE_PATH` | none (**fail-closed**) |

With no fixture the mock checker returns `found:false` — verification fails and
nothing pays. Fail-closed is deliberate for a payout path.

## Try it
```bash
BOUNTY_CLAIM=1 BOUNTY_FIXTURE_PATH=fixtures/bounty-pass.json node server.js --prod
```
Then `/bounty` (board + claim) and `/bounty/admin` (sessions, confidence,
violations, override). `node _gate-bounty-claim.mjs` runs the full gate.

---

# Where I think this design is wrong

You asked for this explicitly. Four things, roughly in order of how much they matter.

## 1. The watermark proves the overlay was on screen — not that MegaChats played

This is the big one, and it is a **product** gap, not an implementation bug.

The stated mechanic is "they earn the bounty when they play the recorded
MegaChats on their broadcast." What the watermark actually measures is "a
browser source carrying our badge was visible for N minutes." A streamer can
load the overlay URL, never play a single MegaChat, sit there for three hours,
and accrue verified on-air minutes that release the pool.

Payout is specified as proportional to *verified on-air minutes*, which
reinforces the wrong thing — it pays for airtime, not for playing the fans'
clips. The fans contributed to have their MegaChats *played*.

I built it as specified rather than silently redesigning it, but it needs a
decision. Three options, cheapest first:

- **Gate airtime accrual on playback.** The server already knows when letters
  play (`letters.js` drives the overlay). Only count minutes inside a window
  following a playback event. Small change, keeps the watermark scheme intact.
- **Per-letter proof.** Issue a code *per MegaChat played* and verify each one
  individually. Strongest link to what fans paid for; more verification work.
- **Two-factor release.** Airtime unlocks a portion, "all N clips played"
  unlocks the rest. Most complex, probably not worth it yet.

My recommendation is the first. It reuses everything here and closes the gap in
roughly a day.

## 2. "Detection IS the payout trigger" isn't quite true for the badge size check

The spec's anti-malicious-compliance framing assumes the overlay can detect
being shrunk. It can detect a small *browser-source resolution*, but OBS
renders the page at its configured size and then scales that texture into the
scene — **a page cannot observe its own scene transform.** Scale the source
down in the scene and the page sees nothing unusual.

That's fine, but the reasoning has to shift: the real enforcement is that an
unreadable badge fails the *verifier*, so shrinking still zeroes their payout —
just at verification time, not detection time. The client-side check is an
early-warning affordance so an honest streamer catches a misconfiguration in
OBS instead of discovering it in an unpaid bounty. I implemented and documented
it that way. Worth correcting the mental model, because "we detect it" invites
trusting a signal that can be trivially bypassed.

## 3. There is no "MegaChat badge" to reuse

The spec says render the code "inside the MegaChat badge it already displays"
and "reuse the current badge component, do not fork it." No such component
exists — MegaChat letter tiles use the same `.username-label` class as guest
seats, with a `📼` prefix.

More importantly, putting the code there would be actively wrong: a letter tile
lives about 10 seconds while codes rotate every 60, so the code would almost
never be on screen when the verifier samples. Honest streamers would fail. I
made the badge its own persistent element outside `#stage`, borrowing the
existing label's visual language, and it never touches the tile or stinger
machinery.

## 4. Escrow state on the handle, claims hanging off it

`ReservedHandle.claimStatus` is the escrow state, but claims and air sessions
are separate records pointing at it. That works for one claimant and gets
ambiguous with two — the first approved claim effectively owns the pool. Real
OAuth (Run B) makes this mostly moot, so I did not restructure. Flagged as G4.

## Smaller notes
- Ledger is append-only by construction but the JSON file is rewritten whole on
  save, so durability is weaker than the contract implies (G7).
- MegaChat handles are 3–20 chars, Twitch logins 3–25 — a long-named streamer
  can have a pool but not a matching room handle (G5).
- `AMBIGUOUS` results surface in admin but nothing routes them to a human (G6).
