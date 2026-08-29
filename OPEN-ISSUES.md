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

## Webhook cleanup + min-duration + refunds (2026-07-26, `v0-ui-migration`)

### Resolved this run (with evidence)
- **Real webhook delivery — VERIFIED END TO END.** A genuine participant
  (`seat:webhookverify`) connected to the production LiveKit Cloud project for
  ~15.6s. Cloud delivered `participant_joined` and `participant_left`; the
  session opened, closed, and left nothing open. Recorded duration 0.230min vs
  0.261min wall clock (the gap is the webhook clock vs our own start/stop
  timestamps, well inside tolerance). The breaker now meters **non-zero from
  webhook data** — 0.23 min, 0.1% of the daily budget — which was the entire
  point of activating it. Evidence: `_verify-webhook-delivery.mjs`, 6/0.
  **LiveKit minutes consumed: 0.23** (budget was 10).
- **L8 — RECONCILIATION WAS A PERMANENT FALSE ALARM. FIXED.** The delta this
  run demanded I explain turned out to be a real bug in the comparison itself,
  not in either data source. `lkActivity`'s ledger is **persisted** (`/data`,
  `loadLedger()` at boot) and reports a rolling 24h; the webhook tracker is
  **in-memory** and starts empty at every boot. Straight subtraction therefore
  reports `overreported` divergence after every single deploy, for up to 24h,
  with nothing wrong — prod showed ledger 2.8min vs webhook 0.23min. The
  comparison is now clamped to the window both sides cover
  (`webhookStats.observingSince` → `ledgerStats(sinceFloor)`), refuses to call
  an unclamped comparison a divergence at all, and stays quiet until it has
  ≥5min of observation. Evidence: gate I, 4 cases.
- **Minimum clip duration — SHIPPED.** `letters.minSeconds` is **derived** from
  `bountyConfig.minClipSeconds` (the verifier's sampling floor) rather than
  hardcoded a second time; raising the floor raises the recording minimum
  automatically, and a `maxSeconds` below the floor is lifted rather than left
  inverted. Rejected client-side at the end of recording (no wallet prompt for
  a clip we won't accept) and enforced server-side **above the payment
  handshake**, so a sub-threshold clip is never charged for. `minSeconds` is
  deliberately absent from `RoomConfigPatch` — a dashboard PUT must not be able
  to configure a room below the level at which a clip can be proven to have
  aired. Evidence: gate M (4 cases) + `_verify-min-duration.mjs` 10/0.
  **Existing sub-threshold clips: ZERO, structurally.** `letters.js` holds
  clips in an in-memory `Map` with no `fs` usage anywhere in the file, and
  `removeLetter()` deletes them after playback. There is no persisted clip
  corpus to migrate, so no backfill decision is needed.
- **Refund architecture — GENERALIZED.** One `escrow.refund()` with an
  enumerated `REFUND_REASONS` (`HANDLE_EXPIRED`, `UNVERIFIABLE_CLIP`,
  `DISPUTE_RESOLVED`, `ADMIN_ACTION`); free-text reasons and anonymous actors
  are refused. Idempotency is **per contribution, not per (contribution,
  reason)** — a dispute landing on a clip that already refunded as unverifiable
  returns the original row instead of paying twice. Every refund writes reason,
  actor and external reference to the ledger. `refundExpired()` is now a thin
  wrapper. Settlement remains the stub; gate H still finds zero transfer calls.
  Evidence: gate N, 15 cases.

### What the hold-release path does NOT cover (read before Run B)
- **No clawback.** Refunds only touch `HELD` contributions. Once money is
  `RELEASED` to a claimant it is out of reach of every path in this file —
  a dispute resolved against a streamer *after* a release has no mechanism.
  `RELEASED → DISPUTED` is a legal transition, so the state machine can express
  it, but nothing implements the reversal. This is the largest remaining hole
  in the money model and it needs its own design, not an extra reason code.
- **No partial refund of a single contribution.** A contribution refunds whole.
  Splitting one across reasons has no representation.
- **Platform match is never refunded.** It is tracked in its own bucket and the
  refund path ignores it entirely. Correct today (it was never contributor
  money), but Run B has to decide what happens to a match whose underlying
  contributor money went back.

### New for Run B
- **B6 — Capture concurrent viewer count at each clip playback.** At every
  playback, alongside the watermark evidence, record the channel's concurrent
  viewer count from the platform API into the evidence log. The intent is that
  payout scales **proportionally to viewers**, not that a viewer threshold gates
  payment — a clip played to 40 people should pay less than the same clip
  played to 40,000, and neither should be worth zero. This must be built with
  B3/B4 rather than after: **viewer counts cannot be backfilled.** Once a
  broadcast is over, the concurrent count at a given timestamp is gone, so any
  playback recorded before this lands is permanently unpriceable under a
  viewer-weighted model. It belongs in `bounty-evidence.js` as part of
  `PLAYBACK_STARTED`, because it is data a payout is computed FROM.

### Small, filed while working
- **`/api/health` overstates what it knows about persistence.**
  `dataDirInfo()` returns `persistent: !!process.env.DATA_DIR` — it checks that
  the variable is *set*, not that a volume is actually mounted there. The
  comment above it says "false here means the NEXT deploy wipes every room",
  which invites reading `true` as a guarantee it doesn't. Production currently
  reports `persistentData: true, dataDir: /data`; that confirms configuration,
  **not** an attached Railway volume. I relied on this while diagnosing L8 and
  it could have sent me the wrong way. (The L8 fix is correct either way: the
  window clamp is right whether the ledger survives a deploy or only an
  in-place restart.) A real check would write and re-read a marker file across
  boots, or read the mount table.

## Overnight closeout (2026-07-27, `feat/overnight-hardening`)

### The finding of the night
- **T2 — THE BOUNTY MECHANIC HAD NO CONTENT LAYER.** The trace asked for came
  back worse than "clips do not persist": there were no clips. `letterRef` on
  `BountyContribution` was write-only (set by `addContribution`, read by
  nothing, only other appearances are two test fixtures). No bounty route
  touched media. And a MegaChat is recorded INTO a room, which an unclaimed
  streamer does not have — so there was no container for the recording the
  product promises to keep for 90 days. Escrow, watermark, verifier and payout
  were all real and all accounting for something that did not exist.
  **FIXED:** new `bounty-clips.js` — append-only index (seq + checksum, same
  primitives as the escrow and evidence logs) plus content-addressed media on
  the volume. Clips are evidence, not cache: a purge appends a reason instead
  of erasing, so "a fan paid for this, where did it go?" stays answerable.
  Design + capacity + object-store swap: `docs/decisions/bounty-clip-storage.md`.

- **T8 — THE MECHANIC WAS DEAD AT GO-LIVE.** `/api/bounty/air-session` called
  `watermark.issueCode()`, deleted by the playback-bound redesign. Every call
  threw. A streamer who claimed their handle and tried to go live got a 400.
  **FIXED**, and not by renaming: issuing a code at session-open is exactly what
  that redesign forbade, so the route now returns `code: null` and says why.
  Nothing caught it because every gate creates air sessions through
  `store.createAirSession()` rather than the HTTP route — the same family of
  mistake as the mirror problem. `_verify-no-dead-calls.mjs` now resolves every
  cross-module call statically so the next deletion cannot leave a caller behind.

### Also resolved this run
- **T1 — the daily cap was deploy-resettable.** Webhook session state was
  memory-only, so every restart zeroed the breaker's view of the day's burn:
  the cap could be walked past by deploying, and a leak spanning a restart was
  invisible to the thing built to catch it. Now persisted, with `observingSince`
  restored so the observation window is continuous. **Boot reconciliation
  policy:** ask LiveKit who is actually connected (RoomService); still there →
  confirm, gone → close at last-known-alive, never inventing downtime minutes.
  With no probe, or a FAILED probe, sessions stay open — deliberately risking
  over-counting, because under-counting is the failure that defeats a circuit
  breaker. Gate K, 12 cases across all four policies.
- **Persistence was never actually proven.** `dataDirInfo()` returned
  `!!process.env.DATA_DIR`, which only proves someone set a variable. Now each
  boot writes a marker and reads what earlier boots left, so `/api/health`
  reports `proven` or `unproven` and never claims a volume is absent (the
  asymmetry is deliberate — seeing a prior boot proves survival, not seeing one
  proves nothing). The marker is gitignored: a committed one would report
  "proven" on a fresh container with no volume, which is the exact false
  confidence this removes.
- **T3 — alarms now reach a human.** `ops-alerts.js` posts to a Discord/Slack/
  generic webhook (`OPS_ALERT_WEBHOOK`), wired to budget warn, budget block,
  long-session, and clip-storage pressure. No-ops when unset, never throws into
  a caller, rate-limits PER CONDITION so a flapping alarm cannot swallow a new
  one, and reports how many occurrences were suppressed. `POST
  /api/livekit/burn/test-alert` exists because an alerting system nobody has
  seen fire is indistinguishable from a broken one.
- **T4a — duplicate overlays bill twice.** Coexistence was the right fix for the
  black tile, but a duplicated scene is now two billed participants for one
  broadcast. Detected and surfaced (with `wastedParticipants` and
  `extraMinutes`) in burn metering and on the overlay health endpoint. Never
  evicts.
- **T4b — the prefix whitelist fails open.** Any identity type added later that
  is not `overlay:/host:/seat:/viewer:` would be silently unmetered. Unknown
  prefixes are now counted and logged loudly on first sight, naming the constant
  to change. Dashboard tests exempted so it does not cry wolf.
- **T4c — the sessionStorage fallback rebuilt the original leak.** It fell back
  to a per-JS-context id that does NOT survive a reload — and the overlay
  reloads itself when its websocket drops, so every reload minted a fresh
  identity and stacked a billed participant. New chain: sessionStorage →
  `window.name` → no suffix at all (room-scoped identity), deliberately choosing
  mutual eviction (a visible black tile) over silent per-reload billing.
- **T5 — the Twitch thumbnail does render.** Confirmed in production: the
  `jordandotfun` room carries `twitchChannel` on `/api/rooms/public` from the
  default-on prefill. Both branches driven against the real component.
- **T6 — mirror audit.** ~700 cases, 19 genuine mirrors (2.7%) in 3 files.
  Converted the reveal gate (the one that already bit us) to drive the real
  overlay page. Added a drift detector for the payment-path mirror, which cannot
  be cheaply converted without a funded wallet. Full ranking and the honest
  caveat in `docs/decisions/mirror-test-audit.md`.
- **T7 — clawback designed, not built.** `docs/decisions/post-release-clawback.md`.
  Recommends staged release (hold back ~20% to a maturity date), because it is
  the only option that turns "get money back" into "do not send it yet".

### Still open after this run
- **Nothing calls `storeClip` from any UI.** The routes exist and are gated; the
  contribute surface still has to record and upload. Filed rather than
  half-built — the recording UI is a product surface and this was not the run to
  invent one. **This is now the top blocker for the bounty mechanic.**
- **Contributions with no uploaded clip are refundable (`CLIP_NEVER_UPLOADED`)
  but nothing sweeps for them automatically.**
- **The platform match has no reversal story** in any refund or clawback path.
- **No post-release clawback** (T7 designed it; not implemented).
- **`_gate-mpp-clientpath.mjs` still mirrors the payment path.** Drift-checked,
  not converted. Needs a funded test wallet.
- Owner-blocked: paste a real webhook URL into `OPS_ALERT_WEBHOOK` and hit the
  test-fire route; confirm Railway is not set to sleep when idle.

## Bounty program — fan-facing build (2026-07-27, `feat/bounty-program`)

### Shipped this run (all behind BOUNTY_CLAIM, settlement still a stub)
- **Pledges/restaking**: one escrow across ≤3 streamers, guaranteed-first pool
  display, atomic first-claim-wins (synchronous resolution, raced over HTTP in
  the gate), contributor-set expiry with sweeper refunds via `PLEDGE_EXPIRED`.
- **Program page** (`/bounty`), **streamer pages** (`/bounty/s/:platform/:handle`),
  **record-and-send** (own recording context; pay at submit; min duration and
  rejection policy disclosed before payment), **contributor status page**
  (`/bounty/mine`), **approval queue** (default-on, sorted by moderation grade,
  decline-vs-policy split), linked from the footer ribbon and the landing
  left-rail campaign module.
- **Moderation**: shared `moderation.js` (letters delegates to it), graded
  clean/borderline/violation + confidence, triggered at upload never playback,
  verdict stored as clip evidence, frame density scales with clip length.
- **Rejection reputation**: first policy strike full refund; repeats 50%
  (config), withheld share to the STREAMER's pool via FORFEIT rows; unconfirmed
  flags never cost money; streamer declines never strike.
- **Real Twitch claim identity** (`BOUNTY_IDENTITY_REAL=1`) + **viewer-count
  evidence** (`VIEWER_SAMPLE`) captured at each twitch playback via Helix.

### Defects found BY the gates this run (all fixed)
- A DENIED claim wedged the handle in `CLAIM_PENDING` — an impostor could lock
  the real owner out by failing. Denied claims now release to `RESERVED`.
- A clip whose moderation call errors showed "in review" to the fan forever,
  even while sitting in the claimed streamer's queue. `pending_moderation` is
  now pre-claim only.
- My own UI verifier inherited the shell's real `MODERATION_API_KEY` and was
  one run from billing real OpenAI per gate run. Gate servers blank it now.

### Still open after this run
- **Fresh-account cost is ZERO — the rejection deterrent is weak.** The
  `contributor` field is an unauthenticated string; strikes attach to it.
  Anyone probing the classifier re-enters with a new string for free. Reported
  honestly rather than papered over: account-level reputation only deters once
  pledging requires a signed-in identity (Privy login is itself free/instant,
  so even then the cost is friction, not money). Options: require sign-in to
  pledge, or key strikes to the payment instrument once real settlement lands.
- **Bounty routes have NO auth generally** (pre-existing): approve/reject and
  admin routes are open. Fine for a flag-gated preview; must be closed before
  any public flag-on. The claim route is the only one with real identity now.
- **`_gate-p2-moderation.mjs` fails 6/4 ON TRUNK** — pre-existing, proven by
  stash/re-run showing identical results without this branch's changes. It
  drives real mainnet dust and its letter under test never uploads. Needs its
  own investigation; the shared moderation module is covered mock-driven in
  `_gate-bounty-program.mjs` G.
- **Twitch console registration remains owner-verifiable only** — see
  `docs/decisions/oauth-domain-audit.md` for the byte-for-byte URIs and the
  60-second test. The embed and app credentials are proven good.
- **Kick**: no credentials; stub + precise notes in the audit doc.
- Clip upload as an alternative to recording: deliberately out of scope.
- Post-release clawback: designed (docs/decisions/post-release-clawback.md),
  not built. Restaking makes staged release (its recommendation) MORE
  attractive, since contested wins concentrate money into single pools faster.

## Run B — real verification (2026-07-28, `feat/run-b-verification`)

### Resolved this run
- **The p2-moderation "pre-existing trunk failure" was a July-24 ZOMBIE
  server on :3222** — every gate run's real server died on EADDRINUSE with
  stdio:'ignore' eating the error, and the gate unknowingly tested the stale
  process. Plus two assertions stale against deliberate product changes.
  10/0 after. Lesson filed: port collisions + stdio:'ignore' = silently
  testing the wrong server.
- **Kick identity + channel reads real** (OAuth 2.1 PKCE, slug-keyed,
  two-host split pinned by gate); redirect to register:
  `https://megachat.fun/auth/kick/callback`.
- **Badge is machine-readable** (dot-matrix + registration ring, shared
  writer/reader table); **corpus** (84 frames, 7 conditions, script-generated);
  **deterministic decoder** with measured pixelHeight; **real FrameSources**
  (VOD-first, extractor seam, typed unavailability); **full distance over
  HTTP proven** — see docs/run-b-verification.md for the detection table.

### New/remaining
- **RESOLVED as a gate, deliberately not as weighting: stream context.**
  Playbacks inside the first 10 minutes of a broadcast do not count, and the
  stream must continue >=1 min past the last counted playback; both
  configurable, failures route to human review naming the condition. Payout
  is NOT weighted by viewer count and must not become so — the bounty amount
  is already a derivative of the streamer's audience, so gating on viewers
  charges twice and penalises mid-size streamers hardest. The absence is
  recorded in bounty-stream-context.js and asserted by _gate-stream-context.mjs
  so it cannot return under another name.
- **Broadcast start is captured at playback time, never at verify time.**
  Verification is VOD-first and runs after the stream ends, when the platform
  reports the channel offline and the start time is gone. Anything that needs
  live platform truth must be captured while the channel is observably live.
- **720p is the documented minimum verifiable quality** (480p marginal at 92%
  with confidence at the review threshold). Reviewers need this context, and
  streamers are now told at claim/setup and on any affected verification.
- **Kick VOD discovery has no official API** — live-first there; direct VOD
  URLs work when supplied. Unofficial v2 API deliberately not used.
- **The dress rehearsal awaits one real broadcast**: `node _rehearsal-run-b.mjs
  --handle <login>` with TWITCH_STREAM_KEY set (or --skip-push while live).
  Live-HLS grab + VOD discovery against a real channel are the only untested
  stages, and they are untestable without it.
- yt-dlp 2026.07.04 installed locally as the extractor; Railway needs it (or
  streamlink) in the image for production verification — the seam reports
  EXTRACTOR_UNAVAILABLE → review queue rather than failing, so this degrades
  honestly.

## Prove-and-clear run (2026-07-29)

### P0 — still open
- **RESOLVED: the real broadcast happened and verification PASSED.**
  jordandotfun, 2026-07-29T20:37:57Z, ~12 min RTMP, Helix-confirmed live, VOD
  2832201336. Final VOD verification: PASS, 4/4 clip playbacks, badge 27.7-28px.
  It found two P0s in the first ninety seconds (see DECISIONS) — the handle was
  never passed to the frame sources, and the media timeline is ~15-17s behind
  our wall clock. Both fixed. Re-run with
  `node _rehearsal-run-b.mjs --handle <login>`; TWITCH_STREAM_KEY lives in
  Railway variables, not in local .env by default.
- **RESOLVED: per-VOD calibration is built and measured.** The offset is
  recovered from each broadcast's own content (probe, decode, see which code is
  actually on screen). Stub gate: injected 4s/16s/24s recovered to 0.4s/0.0s/0.1s,
  6/6 clips each, residual window ±4.9s instead of a flat 20s. Real VOD
  2832201336 from a deliberately wrong 0ms prior: 13.2s from a 3-point cluster,
  4/4 clips, ±5.5s residual. The constant survives only as a loudly-logged
  fallback. Superseded note below kept for the reasoning.
- **SUPERSEDED: per-VOD calibration is the real fix, and is not built.** The VOD seek is
  corrected by a constant (`vodTimelineSkewMs`, default 16s) measured on ONE
  broadcast. The gate documents the fragility this leaves: a 4s residual still
  verifies but drops to AMBIGUOUS, sending a streamer who did the work to human
  review; a residual past the clip's own code coverage cannot verify at all,
  and no wider filter fixes it. Calibration is straightforward and already
  demonstrated — decode a frame against ALL of the session's codes, find which
  one is actually on screen, and derive the true offset. That is how the 16.7s
  figure was measured. Until it exists, treat the constant as provisional and
  expect short clips (the floor is 3s) to be the first casualties.
- **A live spot-check on Kick now matters more, not less.** Kick has no VOD, so
  the live path is the only path there, and the live delay measured 12-25s
  against a 4s rotation. The widened live allowance covers it, but Kick's live
  path has never been exercised against a real Kick broadcast.
- **A one-code corpus hid a ~50% miss rate at 720p, and would again.**
  Fixed this run (see DECISIONS), but the lesson generalises: every synthetic
  corpus in this repo fixes its sample at generation time. `_gate-decoder-codes.mjs`
  re-draws codes each run for the badge specifically. Any other measurement
  quoted from a fixed corpus deserves the same suspicion before it is used to
  make a promise to a streamer.
- **480p is now warned about, not fixed.** 92% detection with the badge median
  at 12.3px against a 12px floor. The streamer is told up front and on the
  verification, and marginal reads route to a human. Raising the badge size at
  low resolutions would actually fix it; nobody has.

### P1
- **`_gate-overlay.mjs` and `_gate-auth.mjs` assume a server already on :3000**
  rather than spawning one, so they hard-crash with ERR_CONNECTION_REFUSED in
  a clean checkout. Pre-existing and unrelated to this run's changes, but they
  are outside the `_gate-helpers.mjs` harness that the spawn audit adopted, so
  they are exactly as fragile as the suites that audit fixed. Adopt the
  harness.
- **An open review keeps its ORIGINAL reason and never learns the newer one.**
  On the real broadcast the session's open review still read "source
  unavailable: EXTRACTION_FAILED" while the current finding was "4 playbacks
  inside the 10-minute warmup". Dedup by `hasOpenReview` is right; silently
  discarding the newer, more relevant cause is not. Reasons should append.
- **The rehearsal plays clips immediately after going live**, which the warmup
  rule correctly rejects, so the harness can never produce a clean context
  pass. Either wait out the warmup or run it with a short
  BOUNTY_STREAM_WARMUP_MS and say so in the output.
- **`NO_VOD_COVERING_TS` is reported for an offline channel in LIVE mode.**
  There is a `CHANNEL_OFFLINE` state; yt-dlp's offline message just matches the
  wrong branch first. A reviewer sees the wrong reason.
- **The rehearsal's VOD wait prints `not yet (undefined)`** because a 500
  response has no `verification` to read a state from. It masked a real 500 as
  a patience problem.
- **Kick OAuth registration validity is still unproven.** The negative control
  confirmed Kick, like Twitch, renders its login page regardless of whether
  the redirect URI is registered — so a rendering login page proves nothing.
  Only a full round trip with a real Kick account will settle it. The
  app-token read path IS proven live in production (deepak, 510 concurrent
  viewers).
- **Admin routes remain open** (`/api/bounty/admin/*`, including the playback
  and override routes). Behind BOUNTY_CLAIM, but unauthenticated. Must not
  reach mainnet as-is.
- **Settlement is still a stub and Gate H still finds zero transfer calls.**
  Unchanged by design — supervised and separate.

## Calibration run (2026-07-29, later still)

### P1 — open
- **The stub calibration gate cannot construct offsets at/above ~30s.** Its
  fixture builds a VOD by chaining six `overlay` filters over a long timeline,
  and past ~30s of leading pad it stops rendering every badge reliably (2 of 6
  at 40s, even with `-loop 1` on the image inputs). Worse, the fixture
  self-check I wrote to catch exactly that was itself wrong — it reported 0/6
  readable at 4s/16s/24s, where calibration demonstrably reads 6/6 — so I
  deleted it rather than ship a check that lies. Inside the stub I could not
  separate fixture from product at those offsets, so the gate asserts only the
  three it can honestly construct. `_verify-calibration-real-vod.mjs` covers the
  range that matters against a real archive. Rebuilding the fixture by
  concatenating per-badge segments instead of chaining overlays would probably
  fix it, and would let the stub cover 30-45s.
- **One junk probe per real VOD appears to be normal.** The real broadcast
  produced 13.2s, 13.2s, 14.7s and 23.1s — the outlier most plausibly a probe
  that decoded a neighbouring clip's badge, since real clips run 30s with codes
  rotating every 4s. Handled by clustering rather than by tightening anything,
  but the *cause* is unconfirmed. If outliers turn out to be more common than
  one-in-four, the candidate ordering during calibration is the thing to look at.
- **The skew is treated as CONSTANT per VOD on two quantized samples.** Every
  point can only place the offset within ±codeValidityMs/2, so the data cannot
  distinguish a constant offset from a slow drift. If a longer broadcast ever
  shows an ordered progression across probes rather than scatter, that is drift
  and the model needs revisiting. The spread check would surface it as
  DISAGREEMENT first, which is the safe direction.
- **`_rehearsal-run-b.mjs` exits with a libuv assertion** (`!(handle->flags &
  UV_HANDLE_CLOSING)`) after its report prints. Pre-existing, cosmetic so far
  because it fires on the exit path, but it would eat a report if it ever moved
  earlier.

### Verified this run
- Rehearsal can now demonstrate a clean stream-context pass: `--warmup-s`
  (default 60s) plus a wait past it, with the override printed loudly so it is
  never mistaken for the production 10-minute rule. It also spawns through
  `_gate-helpers.mjs` now instead of a blind sleep.
- Root cause is carried up from calibration: a missing credential still reports
  `API_UNAVAILABLE`, not "could not calibrate", and the extractor's stderr
  travels in the detail.

## OBS one-click run (2026-07-29, night)

### Resolved
- **The two clean-checkout-crashing gates are fixed and green.** _gate-overlay
  spawns via the harness now; _gate-auth had three stacked rots (blind sleep,
  a 127.0.0.1 base that turned every POST into a GET via the passkey redirect,
  and a stale Arc token address triggering live on-chain validation inside a
  gate). Detail in the warm-up commit.

### Open
- **Real-OBS verification is owner-side by design.** The conformance mock and
  the in-browser UI gate cover everything deterministic; rows 8-14 of
  docs/obs-oneclick-checklist.md (mixer meter, audible monitoring, scene-switch
  persistence, virtual-cam eyeball checks) need the owner's machine —
  `node _verify-obs-oneclick.mjs` walks them as assertions.
- **Safari has no loopback mixed-content exemption**, so one-click cannot work
  there from the https site; Safari users land on the manual fallback, which is
  first-class by design. Not fixable from our side.
- **The monitoring toggle applies to the input named "MegaChat Overlay" only.**
  A streamer who renames the source in OBS breaks the toggle's live-apply (the
  next Add to OBS re-adopts by name). Minor; filed rather than chased.
- **OBS_ONECLICK is off by default** everywhere including production. Flip it
  after the owner's checklist passes on a real machine.

### OBS one-click — risk status (updated 2026-07-30)
- **RESOLVED: the setting keys are correct AND now self-verifying.** All six
  (`url`, `width`, `height`, `shutdown`, `restart_when_active`, `reroute_audio`)
  match obs-browser's own `browser_source_get_defaults`. More importantly the
  underlying hazard is closed structurally: obs_data is SCHEMALESS, so echoing
  our own values back could never have caught a wrong key. verifyOverlayInObs
  now calls `GetInputDefaultSettings({inputKind:'browser_source'})` and asserts
  every key we write is one THAT OBS declares — a readback our own input cannot
  satisfy, re-checked on each streamer's actual OBS version. Gated with a
  negative case proving the echo-back checks stay green while the new one fails.
- **Loopback transport is asserted, not proven.** `ws://127.0.0.1:4455` from an
  HTTPS page: Chrome's Private Network / Local Network Access rules have been
  tightening. May now prompt or block. Not fatal (manual fallback), but the
  one-click path may not be the default path. Verify before promising it.
- Both are settled by the owner running `node _verify-obs-oneclick.mjs` against
  REAL OBS — it reads settings back from OBS itself, so a wrong key name shows
  up as a failed check there and nowhere else.

## Platform parity and lockdown (2026-08-24, `feat/platform-parity`)

### Resolved
- **Verification no longer depends on platform VODs.** Self-capture holds a
  rolling window per air session and freezes the part covering each clip.
  Retention: ~60s of media (~22MB at 720p) per clip playback, kept 14 days,
  purged with its pledge and age-swept regardless.
- **Bounty routes authorize server-side**, enumerated in `bounty-auth.js` so a
  new route cannot ship without a tier. 34 routes: 8 public, 2 fan, 8 streamer,
  5 capability, 11 admin.
- **Pledging requires a signed-in account** and strikes attach to it.
- **`/api/bounty/my` no longer takes a contributor query string** — it was an
  enumeration hole as well as broken once contributions became account-keyed.

### Open
- **KICK IS STILL UNPROVEN.** `_rehearsal-kick.mjs` is shipped and its preflight
  is honest. To run it you need, in env: `KICK_STREAM_KEY` and `KICK_RTMP_URL`
  (both from Kick → Creator Dashboard → Stream Settings; the ingest URL is PER
  ACCOUNT and the harness refuses to guess), plus `KICK_CLIENT_ID` /
  `KICK_CLIENT_SECRET` locally — those exist in Railway but not in local `.env`.
  Then: `node _rehearsal-kick.mjs --slug <your-slug>`.
- **Fresh-account cost is friction, not money.** A new platform OAuth account
  resets strikes. Keying to the payment instrument is the only real fix and
  waits on settlement.
- **`BOUNTY_ADMIN_KEY` must be set in Railway before the flag is ever public.**
  Unset means admin routes refuse (503), which is safe but will look like a
  broken admin panel to whoever finds it first.
- **Self-capture has not run against a real broadcast.** It is gated against a
  stub live stream with real badges and the server doing the capturing, but the
  first real test is the Kick rehearsal — or a re-run of the Twitch one, which
  now captures as well.
- **Capture storage is unbounded across concurrent sessions.** Per-session cost
  is bounded (~22MB live, ~22MB per frozen clip), but nothing caps the total the
  way `clipStoreMaxBytes` caps clips. Fine at preview scale; needs a ceiling
  before a public flag-on.
- **X and pump.fun** — see `docs/platform-feasibility.md`. ~~Both parked~~
  **SUPERSEDED 2026-08-25: pump.fun serves plain pullable HLS and is un-parked
  on the video question.** X stays parked — see the capture-hardening section.

## Capture hardening + pump.fun (2026-08-25, `feat/capture-hardening`)

### Resolved
- **Self-capture verification actually worked end to end for the first time.**
  Four bugs in the shipped verify path each independently broke it for any
  session with more than one clip, and together made the PRIMARY verification
  path return `SOURCE_UNAVAILABLE / TIMELINE_UNCALIBRATED` every time:
  verify passed only `captures[0]`; `CaptureFrameSource` trusted ffprobe's
  container duration on a byte-concatenated TS (a 20s window measured 2s, so
  every seek clamped to zero); captures were named after the clip while their
  evidence row keyed on a null playback id, so the two could not find each
  other; and an input-side seek in a concatenated stream trusts a broken index.
  `_gate-capture-hardening.mjs` now verifies **3 clips off self-capture over
  HTTP** in three separate sessions.
- **OBS scene-item visibility (T1), overlay self-reports (T2) and confidence
  tiers (T4)** shipped. Tiers decide REVIEW ROUTING ONLY — the gate asserts the
  no-OBS streamer is paid the same as the OBS-corroborated one (10 vs 10).
- **A capture now enters at the live edge** on any playlist shape. Previously
  safe only by accident: both platforms we had happened to serve sliding
  playlists.
- **pump.fun un-parked on video.** It serves 1080p60 HLS from a public URL our
  server can pull with no credentials, with `EXT-X-PROGRAM-DATE-TIME` on every
  segment. The earlier "WebRTC only, stop" verdict was inference from docs.

### Open
- **P1 — pump.fun is blocked on IDENTITY, not on capture.** Streams are keyed to
  a coin mint, not to an account we can OAuth against, and MegaChat pays the
  VERIFIED OWNER of a handle. Everything downstream of "which human is this"
  already works; nothing upstream of it does. Do not start pump.fun work by
  writing a frame source — start by answering this.
- **P2 — pump.fun stream discovery is reverse-engineered.**
  `frontend-api-v3.pump.fun/coins/currently-live` answers "who is live" and the
  site's own frontend uses it, but it is undocumented and can change without
  notice. Acceptable for a probe; not something to put a payout behind.
- **P3 — pump.fun manifests are ~320 kB and re-fetched every poll.** Their
  playlist is append-only and grows (3,063 entries at 100 minutes in). At the
  2s default that is ~160 kB/s per air session on manifests alone. Size for it
  — or poll slower there — before enabling the platform.
- **P4 — the OBS scene check is CLIENT-REPORTED and cannot resist a determined
  cheat.** It is corroboration against ACCIDENT (hidden source, wrong scene,
  1×1 item) and a diagnosis for support. It is deliberately never the only
  thing holding a verification up, and `NO_CONNECTION` is blameless. If anyone
  later proposes requiring obs-websocket to get paid, that inverts the design.
- **P5 — `document.visibilityState` is recorded but deliberately not a
  warning.** Headless Chrome and any background browser tab report 'hidden'
  while rendering perfectly; making it a warning sent every session in the gate
  to review, including the clean ones. Revisit only with a signal that
  distinguishes "source stopped" from "not the foreground tab".
- **P6 — `_gate-phase5-oauth.mjs` IS STALE AND CRASHES. Pre-existing, not from
  this run.** It drives `#authTwitchBtn` on `/join`, which commit `3a8d55e`
  ("one front door — Privy does Twitch, so the second sign-in is deleted")
  removed on purpose. The gate has been asserting against deleted UI since
  then. Either retarget it at the Privy flow or delete it — a gate that
  crashes is indistinguishable from a gate nobody runs.
- **Still open from the previous run**, unchanged: Kick unproven
  (`KICK_STREAM_KEY`/`KICK_RTMP_URL` needed), `BOUNTY_ADMIN_KEY` unset in
  Railway, capture storage has no global ceiling, fresh-account cost is
  friction rather than money.
- **Self-capture STILL has not run against a real broadcast.** It is now much
  better gated — three real sessions, real badges, real decoder — but the stub
  live stream is still a stub. The four bugs above are exactly the kind that a
  stub hides and a real broadcast finds.

## Bounty: a streamer price floor to filter spam MegaChats (BACKLOG, 2026-08-29)

**Ask (owner):** a streamer claiming a bounty should be able to set a minimum
price so fans can't spam cheap clips. Worked example: the default lets a fan
buy a 30-second MegaChat for $1; a streamer should be able to say "10/second
minimum" and price that out.

**Today there is no such control anywhere in the bounty flow.** The only
claim-time input is a free-text payout account (`web/components/bounty/
claim-flow.tsx:103-111`), and the only amount check in the whole system is a
positivity test — `bounty-escrow.js:182`, `if (!(parseFloat(amount) > 0))`.
`escrow.contribute()` (`bounty-escrow.js:136-149`, reachable via
`POST /api/bounty/contribute`) validates the amount **not at all**. Every
other bounty threshold (`minClipSeconds`, `clipsPerHandleMax`, …) is a
process-env global in `bounty-claim.config.js`, never per-streamer.

**Where it goes when we build it:**
- *State:* add the floor to the `ReservedHandle` record (`bounty-store.js:145-154`);
  it is keyed `platform:handle`, survives the claim, and is already read on the
  pledge path. `updateReservedHandle` (`:160-167`) is a generic patcher, so it
  needs no change.
- *Enforcement:* BOTH `pledge()` (`bounty-escrow.js:182`, where the positivity
  check already lives — the per-target loop at `:189-193` already resolves each
  ReservedHandle) AND `contribute()` (`:136-149`). Covering only the first
  leaves `/api/bounty/contribute` as an open bypass.
- *Route:* prefer a new `guarded.post('/api/bounty/settings')` over folding it
  into the claim body, so it stays editable later. HARD REQUIREMENT: add the
  matching entry to `ROUTE_POLICY` in `bounty-auth.js:80-95` — `policyFor`
  throws on unlisted paths (`:238-245`) and `_gate-bounty-auth.mjs` diffs the
  table, so the route cannot register without it.
- *Bounds:* default + ceiling in `bounty-claim.config.js:91-103` (a streamer
  setting a 10,000 floor is a self-inflicted denial of their own pool). The
  per-handle VALUE rides on `pool-view` / `program` payloads
  (`bounty-routes.js:507-546`), typed on `PoolView`/`ProgramPool`
  (`web/lib/bounty-api.ts:183-196`) — not on `bountyClientConfig()`.
- *UI:* claim-time field under the payout input (`claim-flow.tsx:103-111`);
  ongoing edit next to `ApprovalQueue` (`streamer-page.tsx:173`); and — required
  by the project's own disclose-before-pay rule (`record-flow.tsx:9-16`) — the
  floor must be surfaced on the fan's amount input (`record-flow.tsx:246-250`),
  its client check (`:160`), and the multi-target chips (`:278-306`).

**Design decision to make first:** a pledge can name up to `pledgeMaxTargets`
(3) streamers, and the fan adds targets AFTER typing the amount. So a floor is
either "must clear the highest floor among all targets" or "reject only the
targets it misses" — the latter conflicts with the one-escrow-one-anchor model
at `bounty-escrow.js:195-201`. Pick one before writing code.

**Related, found while looking:** the approval queue is a post-hoc moderation
review (approve / "not for me" / "breaks the rules"), which fires *after* the
fan has already paid. A price floor is the pre-payment filter that queue
cannot be.
