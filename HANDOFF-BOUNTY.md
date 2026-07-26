# CREATOR BOUNTY — Run A handoff

Branch: `feat/bounty-claim-runA`, off `v0-ui-migration` (current prod).
Gate: **49/0** (33 in Run A, extended by the patch). Build clean.
Patch applied: playback-bound watermark, append-only ledger, verifier-side
legibility enforcement, ambiguous review queue.

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
| Watermark issuance — **playback-bound**, clip-scoped, clamped | **Real** |
| Overlay badge rendering | **Real** |
| Overlay size check | **Real, but EARLY WARNING ONLY** — see critique #2 |
| Legibility enforcement (measured height in frame) | **Real** in the pipeline; needs a real OCR impl |
| Ambiguous review queue + SLA + release blocking | **Real** |
| Append-only ledger w/ checksum chain validation | **Real** |
| Verifier pipeline | **Real**; frame source + code checker are **mocked** |
| Payout math (per verified CLIP), match, dispute window | **Real** |
| Bounty board / claim flow / admin | **Real** UI on real data |
| Identity verification | **STUBBED** — auto-approves, logs `STUBBED_APPROVAL` |
| Frame grabbing, live status, OAuth, settlement | **STUBBED / absent** — see OPEN-ISSUES.md B1–B5 |

## Interfaces Run B implements
```
FrameSource.getFrames(platform, handle, timestamps[]) -> FrameRef[]
CodeChecker.findCode(frameRef, expectedCodes[])
     -> { found, confidence, pixelHeight }   // pixelHeight REQUIRED, see #2
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
| Code rotation (inside a clip) | `BOUNTY_CODE_ROTATE_MS` | 4s |
| Code validity (clamped to clip end) | `BOUNTY_CODE_VALIDITY_MS` | 5s |
| Min clip length to be payable | `BOUNTY_MIN_CLIP_SECONDS` | 3s |
| Badge min ratio / px (client early warning) | `BOUNTY_BADGE_MIN_RATIO` / `_PX` | 0.03 / 18 |
| **Min code height in captured frame (enforcement)** | `BOUNTY_MIN_CODE_PX` | 12 |
| Release rate per verified clip | `BOUNTY_RELEASE_RATE_PER_CLIP` | 0.04 |
| Release rate per verified clip-second | `BOUNTY_RELEASE_RATE_PER_CLIP_SECOND` | 0.001 |
| Review SLA | `BOUNTY_REVIEW_SLA_MS` | 24h |
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
violations, review queue, override). `node _gate-bounty-claim.mjs` runs the
full gate.

**Codes only appear while a MegaChat is playing.** A parked overlay showing
nothing is correct behaviour, not a bug — that is the whole point of the
patch.

---

# Where I think this design is wrong

You asked for this explicitly. Four things, roughly in order of how much they matter.

## 1. ~~The watermark proves the overlay was on screen~~ — RESOLVED (patch)

**Status: fixed.** Codes are now issued only while a clip is playing and are
bound to that clip's id, so a frame carrying code X proves clip Y aired at that
timestamp. Proof-of-playback and proof-of-air are the same artifact.

Note the fix taken was NOT my original recommendation. I proposed gating
airtime accrual on the server's playback events; the correct objection is that
this leaves two artifacts (a visible code, an event claiming a clip played)
which can disagree — and the money would ride on the unverifiable one. That is
the same trust shape as a client-reported session ledger. Collapsing them into
a single clip-bound code removes the disagreement entirely.

Consequences now live in the code: a parked overlay issues nothing and verifies
`NO_PLAYBACK`; rotation moved to 4s because tiles live ~10s; validity is clamped
to the clip end so no frame can satisfy two clips; clips under
`BOUNTY_MIN_CLIP_SECONDS` are recorded `BELOW_SAMPLING_FLOOR` and pay nothing.
Payout unit is verified clip playbacks (+ a duration component), not on-air
minutes.

## 2. ~~"Detection IS the payout trigger"~~ — CORRECTED (patch)

**Status: fixed, and the mental model is corrected here deliberately.**

Enforcement is NOT the overlay noticing it has been shrunk — it cannot. A page
cannot observe its own OBS scene transform, so the client check sees only a
small browser-source resolution. That check remains, relabelled in code and
copy as an early warning for an honest streamer.

Real enforcement is at verification time: `CodeChecker.findCode` now returns
the code's measured pixel height in the captured frame, and any sample below
`BOUNTY_MIN_CODE_PX` fails **even when the code was found**
(`FAIL_TOO_SMALL` + a `CODE_TOO_SMALL_IN_FRAME` violation). Measurement is
documented as REQUIRED in the Run B `CodeChecker` contract — an OCR
implementation that returns only found/confidence is incomplete.

## 3. There is no "MegaChat badge" to reuse — unchanged, and now load-bearing

The spec said to render the code "inside the MegaChat badge it already
displays". No such component exists (letter tiles use `.username-label` with a
📼 prefix). The badge stays its own persistent element outside `#stage`.

This turned out to matter more after the patch, not less: the badge must remain
mounted across clip boundaries so a code can appear the instant a clip starts.
Hosting it inside a tile that is itself being created and animated would race
the stinger.

## 4. Escrow state on the handle, claims hanging off it — still open (G4)

`ReservedHandle.claimStatus` is the escrow state while claims and air sessions
point at it. Fine for one claimant, ambiguous with two — first approved claim
effectively owns the pool. Real OAuth (Run B) makes this mostly moot. Left
pinned rather than restructured.

## Smaller notes
- **Ledger durability — RESOLVED (patch).** Was G7. Now genuinely append-only:
  JSONL, append+fsync, per-record seq + checksum, chain validated on load. A
  torn final record recovers; an interior gap or bad checksum refuses to start
  rather than folding a corrupt ledger into balances.
- MegaChat handles are 3–20 chars, Twitch logins 3–25 — a long-named streamer
  can have a pool but not a matching room handle (G5, still open).
- **`AMBIGUOUS` routing — RESOLVED (patch).** Was G6. Ambiguous results open a
  review with state/age/assignee, **block release** until a human resolves it,
  surface past-SLA breaches in admin, show "under review" to the streamer, and
  write the reviewer's reason to the ledger.
