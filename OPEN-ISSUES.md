# OPEN ISSUES

Running list of stubs, deferrals, and known gaps. Append, don't rewrite.

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
- **G9 — The mutable store (`bounty.json`) is still rewritten whole.** That is current-state, not money history, so it is a far smaller risk than G7 was — but a torn write still loses reserved-handle/claim/session records. The ledger can rebuild pool balances; it cannot rebuild those.
- **G8 — REBASE ORDER: lazy-connect lands FIRST.** `fix/livekit-lazy-connect` is actively saving money and should merge before this branch; `feat/bounty-claim-runA` then rebases onto it. Both touch `public/overlay.html` in different regions (lazy-connect edits the LiveKit connect lifecycle; the bounty badge is a separate block at the end of the script and its own element outside `#stage`), so expect a small merge rather than a conflict.

### Pre-existing, unrelated (carried forward)
- LiveKit Cloud free-tier minutes exhausted; lazy-connect fix is on `fix/livekit-lazy-connect`, unmerged. Abandoned-prewarm cost and webhook-backed session ledger are pinned in `HANDOFF-LAZY-CONNECT.md` on that branch.
- `MODERATION_API_KEY` and `CONTACT_URL` still need setting in Railway.
