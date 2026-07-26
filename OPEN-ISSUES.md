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
- **L1 — Cloud validation NOT DONE; quota still ~50% exhausted.** 6 of 12 fresh
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
- **L5 — MERGE NOT PERFORMED; bounty rebase CONFLICTS.** The merge was gated on
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

### Pre-existing, carried forward
- `MODERATION_API_KEY` and `CONTACT_URL` still need setting in Railway.
