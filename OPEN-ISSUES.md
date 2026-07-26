# OPEN ISSUES

Running list of stubs, deferrals, and known gaps. Append, don't rewrite.

> **Owner-facing daily summaries live in [`docs/briefs/`](docs/briefs/)** —
> plain English, one file per working day. Any agent can be asked to write
> one; see [`docs/briefs/README.md`](docs/briefs/README.md) for the format.

> Note: this file also exists on `feat/bounty-claim-runA` with the bounty
> section (B1–B5, G1–G9). This branch predates that one, so the two copies
> will need merging when the branches come together.

## LiveKit lazy-connect — Cloud validation run (2026-07-25, `fix/livekit-lazy-connect`)

### Resolved this run (with evidence)
- **Abandon cap — SHIPPED.** Was pinned. Abandoned prewarms release at ~90s
  (`LAZY_ABANDON_MS`) instead of the 5-minute TTL, with a dedicated sweeper so
  it fires without further input from the person who left, plus `sendBeacon` on
  tab-close / wallet-rejection / join-failure so most bails release instantly.
  "Actively progressing" is defined in `livekit-lazy.config.js:progressStages`.
  Evidence: gate section H — abandonment at each of 4 stages releases at the
  cap; a slow join reporting progress past the cap is NOT clipped; unknown
  stages don't reset the clock.
- **Webhook receiver — BUILT** (Cloud side not yet configured, see L3).
  Signature + body-digest verification, freshness window, event-id dedupe,
  out-of-order reconciliation, divergence report with leak direction.
  Evidence: gate section I.
- **Burn circuit breaker — BUILT** (inert until webhooks are on, see L3).
  Daily/monthly budgets from webhook data, warn at 75%, block new tokens at
  95%, live sessions never cut, operator override requiring who+why, long-
  session alarm. Evidence: gate section J, including a synthetic 1800-minute
  session — the 30-hour leak it would have caught on day one.
- **Gate SFU ambiguity — CORRECTED.** The gate has always run against the LOCAL
  dev SFU (`ws://localhost:7880`). "Real SFU" meant real-process-not-mock; the
  phrasing was wrong. Fixed in HANDOFF-LAZY-CONNECT.md.

### New / still open
- **L1 — RESOLVED (2026-07-26). Cloud validation DONE; idle burn is zero.**
  Measured against LiveKit Cloud (project `megachat-qu09ma60`, US East B), not
  the local dev SFU: overlay running, no guests, **29 RoomService polls over 10
  minutes, every one reporting 0 participants → 0.000 participant-minutes.**
  Then prewarm connected `overlay:<roomId>`, and the grace expiry disconnected
  it. Log: `docs/cloud-idle-measurement-2026-07-26.log`.
  Reconciliation: Cloud-observed 0.50 min vs our ledger 1.70 min. **The −1.2
  delta is a polling gap in the harness, not a discrepancy** — it stopped
  integrating during the 75s grace sleep; 0.50 observed + 1.25 unpolled = 1.75
  vs 1.70, within one 20s poll. **What this proves:** no participant is
  connected while idle. **What it does not prove:** what Cloud bills — billing
  data needs the dashboard (L2). Total consumed this run: **~0.5 LiveKit
  minutes** against a 30-minute budget.
- **L1 (historical) — Cloud validation NOT DONE; quota was ~50% exhausted.** 6 of 12 fresh
  `/rtc/validate` probes returned 429 "connection minutes limit exceeded".
  Measuring in that state would produce a false green. Runbook to execute when
  it clears is in HANDOFF-LAZY-CONNECT.md.
- **L2 — No programmatic access to Cloud usage numbers.** The server API key
  authenticates RoomService (verified working) but no usage/analytics endpoint
  (404s); usage lives behind the dashboard login. Blocks the "measured by
  Cloud, not by us" requirement *independently of L1*. Needs a human reading
  the dashboard, or a Cloud API token distinct from the server key.
- **L3 — Webhooks must be configured in the Cloud dashboard.** One step:
  Project Settings → Webhooks → `https://megachat.fun/api/livekit/webhook`,
  events `participant_joined` + `participant_left`, signed with the existing
  project secret. **Until this is done the breaker meters zero and is inert.**
  Highest-value follow-up in this list.
- **L4 — Capacity figures remain MODELS, not measurements.** The abandon cap
  removes the dominant modelled waste (revised ~400 / ~294 sessions per month
  at 50% / 80% abandonment, vs the old 313 / 161), but the underlying
  ~11-participant-minutes-per-session estimate has never been checked against
  Cloud.
- **L5 — RESOLVED (2026-07-25).** Merge landed and the rebase is done. `fix/livekit-lazy-connect` merged into `v0-ui-migration` with **0 code conflicts**; the bounty branch rebased on top, resolving 3 adjacent-addition hunks take-both-sides plus one import-line collision resolved deterministically (see DECISIONS). Deployed; webhook route live in production. Original finding retained below for history:
- **L5 (historical) — MERGE NOT PERFORMED; bounty rebase CONFLICTS.** The merge was gated on
  items 1–4 passing and item 1 cannot pass (L1/L2). Separately, the rebase does
  NOT apply cleanly, contrary to the earlier G8 prediction:
  - `fix/livekit-lazy-connect` → `v0-ui-migration`: **0 conflicts**, clean.
  - `feat/bounty-claim-runA` rebased onto that: **2 conflicting files** —
    `public/overlay.html` (2 hunks) and `server.js` (1 hunk).
  - All three are ADJACENT-ADDITION conflicts, not semantic ones: both branches
    append CSS right after `.stinger-fx`, both insert an element right after
    `<div id="stage">`, both add imports at the same point in `server.js`.
    Resolution is "take both sides" at each anchor — but per instruction I
    stopped rather than resolving creatively. Trial branches deleted; no state
    left behind.
  - G8's "expect a small merge, not a conflict" was **wrong**. The isolation
    held (the regions really are independent) but git still needs a human to
    say so at three anchor points.

### Newly filed 2026-07-26
- **L8 — Probe events were counted in burn metering; now excluded.** My signed
  verification deliveries were metered (0.02 min in prod) until the container
  restarted and cleared the in-memory tracker — accidental, not a safeguard.
  Probe identities (`__probe__`, `__ackprobe`, `probe:`, `test:`) are now
  recorded but excluded from budget maths, with `probeSessionsExcluded` in
  stats so the discount is auditable.

### Newly filed 2026-07-25
- **L6 — RESOLVED (2026-07-25/26).** The ~50% rejection was **free-tier quota
  exhaustion**, not rate limiting and not structural. Evidence: 10 spaced
  probes (6s apart) → 10/10 success; 12 rapid-fire probes exactly reproducing
  the original failing pattern → 12/12 success; credentials confirmed pointing
  at `megachat-qu09ma60`, the project on the paid plan. The prorated paid plan
  resolved it. Yesterday's bearish case did not materialise.
- **L6 (historical) — Diagnose the ~50% RTC rejections properly.** Report the ACTUAL error
  bodies from the rejected `/rtc/validate` calls rather than only the status
  code. A quota 429 and a rate-limit 429 from firing validate calls in rapid
  succession are different diagnoses with different fixes, and the earlier
  sample fired 12 requests in a tight loop — which could itself have induced
  rate limiting. Re-probe with spacing (e.g. 1 request every 5s) and capture
  full bodies + headers (`Retry-After`, any rate-limit headers) before
  concluding the quota is the cause. **Still open — not done in this run.**
- **L7 — Railway sleep setting is dashboard-only.** Measured: no cold start
  across a 75s idle (TTFB stayed 0.18–0.22s) and `railway.json` contains no
  sleep directive, but Railway's app-sleep toggle lives in the service
  dashboard, which I cannot read. The architecture (persistent WebSocket
  server + interval sweepers) is incompatible with sleeping, so the risk is
  low — but confirm the toggle is OFF, because a slept container drops
  `participant_left` deliveries and leaves sessions permanently open in the
  ledger the breaker meters.

### Bounty follow-ups — PINNED, not done this run
- **G9 — evidence-store durability** (already filed above): the mutable
  `bounty.json` is still rewritten whole.
- **P1 — RESOLVED (2026-07-26), and it was a live bug in the OPPOSITE
  direction.** Not double-pay: windows and codes were keyed by clipId and every
  lookup used `.find()`, which returns the FIRST match — so a second airing
  resolved to the first airing's closed window and issued **zero** codes. A
  streamer replaying a fan's clip earned nothing for the replay. Each airing
  now carries a `playbackId` (clipId + nonce); namespaces, windows and code
  pushes all key on it, and the verifier counts verified PLAYBACKS.
- **P2 — options written, DECISION PENDING (owner).** See
  `docs/decisions/sub3s-residual.md`. Two findings while writing it: the status
  quo is *accidentally* "redistribute to pool", which is the same
  paid-for-airtime flaw this design already corrected once; and **there is no
  minimum-duration check at upload today** (`letters.js:254` bounds only the
  maximum), so a 1-second clip is accepted, charged, and silently unpayable —
  live right now. Recommendation: reject at upload, refund as safety net.
- **P3 — Run B frame-sampling cost.** Nobody has priced the frame retrieval +
  OCR per verification pass. At `sampleSize` frames per clip across many
  clips, this could exceed the bounty it protects.
  *(These three were NOT previously in this file — filed now.)*

### Pre-existing, carried forward
## Creator bounty — Run A (2026-07-25, `feat/bounty-claim-runA`)

### Stubbed, awaiting Run B
| # | Item | Interface to implement | Blocker |
|---|---|---|---|
| B1 | Real platform OAuth | `IdentityVerifier` (bounty-routes.js) | Registered Twitch/Kick/Google apps + credentials. Every stub approval is written to the ledger as `STUBBED_APPROVAL`, so stubbed claims stay distinguishable forever. |
| B2 | Real live-status API | — (not yet an interface) | No confirmed API contract in this repo. Deliberately NOT sketched, to avoid building on an invented shape. |
| B3 | Real frame source | `FrameSource` → `TwitchFrameSource` / `KickFrameSource` (bounty-verifier.js) | Needs the real VOD/clip endpoints, and a decision: VOD segments (delayed, reliable) vs live HLS (immediate, lossy). |
| B4 | Real code checker | `CodeChecker` → `OcrCodeChecker` | Open question: OCR the whole frame (robust, slow) or crop to the badge's expected position (fast, but breaks when a streamer repositions the source — which they're allowed to do). **Must return `pixelHeight`** — legibility enforcement depends on it (patch). |
| B5 | Real settlement | `SettlementInterface` → `RealSettlement` (bounty-settlement.js) | Needs a funded operator wallet, escrow contract address, and an on-chain submit keyed off the ledger row id so a retry can't double-pay. **Currently there is NO transfer code anywhere — verified by gate H.** |

### Resolved by the patch (2026-07-25)
- **G1 — watermark proved airtime, not playback. FIXED.** Codes are now issued only during clip playback and bound to the clip id, so one artifact proves both. Payout unit changed to verified clip playbacks.
- **G2 — legibility enforcement. FIXED.** Moved to the verifier: `findCode` returns measured `pixelHeight` and a sample under `BOUNTY_MIN_CODE_PX` fails even when found. The client-side check remains but is now labelled everywhere as an early warning that cannot see scene transforms.
- **G6 — ambiguous went nowhere. FIXED.** Review queue with state/age/assignee, SLA breach flags in admin, release BLOCKED until a human resolves, "under review" shown to the streamer, reviewer reason written to the ledger.
- **G7 — ledger was rewritten whole. FIXED.** Now JSONL append+fsync with per-record seq + checksum; chain validated on load, torn final record recovers, interior gap or bad checksum refuses to start.

### Known gaps still open
- **G3 — Badge self-reports are still client-side.** Safe only because the incentive aligns: a client that stays silent still fails verification. It exists to make failure legible to the streamer, not to secure anything.
- **G4 — Competing claimants aren't modeled.** Escrow state lives on the ReservedHandle while claims/air sessions hang off it, so the first approved claim effectively wins. Two people claiming the same handle needs a real resolution rule (and B1 makes it mostly moot).
- **G5 — Handle length mismatch.** MegaChat handles are 3–20 chars (`sanitizeHandle`), Twitch logins are 3–25. A 21–25 char streamer can have a bounty pool reserved but cannot take a matching MegaChat room handle. Reserved-handle keys are validated more loosely (≤40) to allow the pool; the room-handle collision is unresolved.
- **G9 — RESOLVED (2026-07-26), and my earlier risk call was wrong.** I filed
  it as "much smaller risk than the ledger was"; that weighed proof as
  bookkeeping. The watermark codes are what a payout is computed FROM, so a
  silent truncation makes a verifier count fewer playbacks and underpay with no
  error raised. New `bounty-evidence.js`: append-only JSONL, seq + checksum,
  validated at boot, interior damage refuses to start, torn final recovers.
  Evidence (codes, playbacks, verifications) is now split from mutable state
  (claim status, review assignment, derived counts), and a release refuses on
  `evidence_unverified` or `evidence_diverged`.
- **G9 (historical) — The mutable store (`bounty.json`) is still rewritten whole.** That is current-state, not money history, so it is a far smaller risk than G7 was — but a torn write still loses reserved-handle/claim/session records. The ledger can rebuild pool balances; it cannot rebuild those.
- **G8 — REBASE ORDER: lazy-connect lands FIRST.** `fix/livekit-lazy-connect` is actively saving money and should merge before this branch; `feat/bounty-claim-runA` then rebases onto it. Both touch `public/overlay.html` in different regions (lazy-connect edits the LiveKit connect lifecycle; the bounty badge is a separate block at the end of the script and its own element outside `#stage`), so expect a small merge rather than a conflict.

### Pre-existing, unrelated (carried forward)
- LiveKit Cloud free-tier minutes exhausted; lazy-connect fix is on `fix/livekit-lazy-connect`, unmerged. Abandoned-prewarm cost and webhook-backed session ledger are pinned in `HANDOFF-LAZY-CONNECT.md` on that branch.
- `MODERATION_API_KEY` and `CONTACT_URL` still need setting in Railway.
