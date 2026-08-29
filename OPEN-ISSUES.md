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
- **P6 — RESOLVED (2026-08-26).** `_gate-phase5-oauth.mjs` deleted;
  `_gate-privy-auth.mjs` (16/0) replaces it, gating the real front door's
  rejection wall (forged/junk/missing tokens mint nothing — asserted by
  byte-comparing the identity store before and after) and asserting the
  deleted second sign-in stays deleted.
- **Still open from the previous run**, unchanged: Kick unproven
  (`KICK_STREAM_KEY`/`KICK_RTMP_URL` needed), `BOUNTY_ADMIN_KEY` unset in
  Railway, capture storage has no global ceiling, fresh-account cost is
  friction rather than money.
- **Self-capture STILL has not run against a real broadcast.** It is now much
  better gated — three real sessions, real badges, real decoder — but the stub
  live stream is still a stub. The four bugs above are exactly the kind that a
  stub hides and a real broadcast finds.

## Loose-ends run (2026-08-26, `feat/loose-ends`)

### Resolved
- **The fan front door is PROVEN.** `record-flow.tsx` was already built;
  what was missing was proof it works. `_gate-record-flow.mjs` (23/0) drives
  real Chrome with the fake camera end to end and asserts on what LANDED — a
  real 183KB webm in the store, keyed to the pledge's contribution, the pool
  grown by the amount typed in the browser, pay-at-submit proven by ABSENCE
  (a discarded take leaves ledger and store byte-identical).
- **The confidence tiers now DECIDE the money**, not just describe it. Tier 4
  and the tier-3 forced-review knob block the release (skipped=pending_review);
  the RELEASE ledger row records confidenceTier for audit. `_gate-capture-
  hardening` 59 → 67/0.
- **YouTube + Rumble external capture**, stub-gated (`_gate-yt-rumble` 28/0):
  frame sources, live-status APIs, verifier profiles, per-platform observation
  unified through `liveLookerFor()`. Offsets proven by pixel.
- **X ownership** via Privy's twitter_oauth handle, proven not assumed
  (`_gate-x-claims` 16/0). SUPPORTED += x; X verifies on self-capture +
  obs-websocket with no external stream.
- **pump.fun capture** with PROGRAM-DATE-TIME replacing timeline calibration
  (`_gate-pumpfun-pdt` 17/0): known offset, zero probe grabs, external
  PDT-indexed lookup downloading one segment.

### Found and fixed while building (each the "clean number, single case" class)
- **THE STRUCTURAL ONE: real identity verification was broken for EVERY
  streamer who signed in through the front door.** Both ownership checks
  required identity.provider === platform, which no Privy identity satisfies —
  so with `BOUNTY_IDENTITY_REAL=1`, no real streamer could claim or pass a
  STREAMER route on ANY platform. Invisible because gates mint legacy
  provider-shaped identities. Fixed with `platformLoginFor()`.
- **The rolling buffer refetched evicted segments forever on append-only
  playlists** — 205 fetches of 40 segments in ten seconds; sliding playlists
  hid it. Fixed with a high-water mark.
- **self-capture guessed twitch.tv/<handle> for every non-Kick platform** — an
  X/YouTube/Rumble session would have recorded the wrong site. Now leads on the
  session's own watch URL.
- **Claim re-entry handed the claim back BEFORE verifying the caller** (an auth
  hole I wrote yesterday) — any signed-in account could re-enter any verified
  claim. Caught by _gate-x-claims B5. Now verifies first.
- **The verified-owner claim wall**: a failed session-open left the handle in
  AWAITING_AIRTIME and re-claiming 409'd with escrow jargon — the claim UI
  retries claim+session together, so it hit the wall on the second try.

### Still open (unchanged — genuinely need a credential or a broadcast)
- **KICK still unproven** — `KICK_STREAM_KEY`/`KICK_RTMP_URL` needed.
- **`BOUNTY_ADMIN_KEY` unset in Railway** — admin routes refuse (503) until set.
- **Capture storage has no global ceiling** — per-session is bounded, the total
  is not.
- **SELF-CAPTURE STILL HAS NOT RUN AGAINST A REAL BROADCAST.** Better gated
  than ever (pump.fun's PDT path, YouTube's actualStartTime, three real
  sessions in capture-hardening), all against stubs. The bugs found this week
  are exactly what a stub hides.

### Attack surface, reasoned through and one hole closed THIS run
- **The watch URL is unbound from the identity — closed for the platforms that
  are claimable today.** Broadening `watchUrl` to lead capture (needed for
  YouTube/pump.fun, which have no channel page) briefly let a TWITCH/KICK
  streamer point our recorder at a stream other than their own: run the codes
  on a throwaway broadcast, hand us that URL, never overlay the real audience
  stream. Fixed — `captureSourceUrl()` pins Twitch/Kick to the channel page
  derived from the PROVEN handle; the watch URL is honoured only where no such
  page exists, and those platforms are not claimable yet. Gated in
  _gate-self-capture (6).
- **The residual, for whoever builds YouTube/Rumble/pump.fun claims:** their
  watch URL will be the sole capture address, so binding it to the verified
  identity is REQUIRED before those claims ship. YouTube's Data API already
  returns the video's `channelId` — assert it equals the claimant's channel.
  Rumble's creator URL and pump.fun's mint are the identity by construction
  (see the ownership filings). Do not ship a claim path that reads a
  client-supplied capture URL without this check.
- **What stays closed:** hiding the overlay (self-capture reads the public
  stream), dumping to nobody (stream-context warmup+tail), shrinking the badge
  (verify-time pixel floor), forging the OBS "visible" report (it only raises
  tier 2 vs 3 — both pay the same and both auto-verify, so forging buys
  nothing), claiming another's handle (OAuth ownership, now including X).

### New, filed precisely
- **pump.fun ownership is unsolved and NOT built this run.** Streams key to a
  coin mint, not an account. What it would take: (1) wallet-signature binding —
  the streamer signs a server nonce with the wallet that created the mint (the
  creator address is on-chain, verifiable with NO pump.fun cooperation),
  yielding platformLogins-style proof keyed `pumpfun:<mint>`; buildable today.
  (2) sanctioned mint→playlist discovery — today reverse-engineered only.
  (3) a product decision on whether MegaChat wants coin-keyed payouts, since
  the "handle" a fan pledges to would be a mint address, not a name. Only (1)
  is engineering.
- **YouTube/Rumble/pump.fun CLAIMS are not in SUPPORTED** — capture and
  observation are wired and gated, but ownership verification for these is not
  built (Google OAuth yields an email not a channel; Rumble's URL-capability
  and pump.fun's wallet-signature designs are filed above). Capture activates
  the moment a claim path does.
- **Rumble's Live Stream API response shape is docs-derived, UNPROVEN on a real
  wire** — rumble-api.js and its gate both say so. First real creator URL is
  the test that counts, exactly as Kick was.

## Real-broadcast testing run (2026-08-26, `feat/real-broadcast`)

### THE FINDING: self-capture could never have worked on a real broadcast

Two independent, deterministic bugs, both living entirely in the gap between a
stub stream and a real encoder. Neither is flaky — both fail every real
broadcast, every time, on every platform whose only evidence path is
self-capture (Kick, Rumble, X).

- **Capture never started.** The real order is claim → open air session → go
  live. At session open the channel is offline, the extractor answers "the
  channel is not currently live", and the single-shot resolve treated that as
  permanent. Verification then fell back to a VOD path Kick/Rumble/X do not
  have. FIXED: retries on a 15m budget, stops early if the session closes.
- **The freeze kept the wrong 60 seconds.** The buffer holds the newest media
  the PUBLIC stream has published — D = 12-25s behind wall clock. Freezing when
  a clip ENDS kept media up to (end − D), so a clip of length L retained only
  L−D seconds of itself and a clip shorter than the delay retained nothing.
  Unrecoverable by seeking: the missing tail needs a NEGATIVE skew and the
  calibration ladder is non-negative by construction. FIXED: freezes are
  scheduled D + a segment past the clip's end; session close and verification
  both settle pending freezes first.

**Why 23 green gates missed both:** every stub publishes a segment
milliseconds after writing it, so D ≈ 0, ladder rung 0 is correct, and
freezing at playback end happens to keep the right media. `_gate-broadcast-delay.mjs`
(10/0) is the missing test — a stub where content is stamped when CREATED and
appears in the playlist D later. **This is the fourth green-test-hiding-a-broken-path
bug in a month.** The first three were: one corpus code hiding a ~50% decoder
miss rate; a gate asserting verification RAN rather than FOUND; a stub server
that was stale. The pattern is now conclusive and structural, not bad luck.

### Rumble: the live-status URL is a BROADCAST credential

Measured on the real wire, not inferred. Our docs-derived field assumptions
(`livestreams[]`, `is_live`, `watching_now`, `created_on`, `title`) were all
CORRECT. What the docs never said: every livestream entry carries
`server_url` + `stream_key` in plaintext, so possession of the creator's API
URL confers the power to BROADCAST AS that channel. `rumble-api.js`'s note that
"possession is transferable in a way OAuth is not" was right and far too mild.
No active leak (the parser copies four scalars by name; the URL never reaches a
client, config, evidence or persistence) — but it was one debug line away.
Gated: `_gate-yt-rumble` A4 asserts no `stream_key`/`server_url` in the result
and exactly four keys.

### Rehearsal harnesses had been dead for weeks

- **Twitch**: `args: ['--prod']` REPLACED the helper default rather than
  appending, so it spawned `node --prod` with no script (exit 9). Broken since
  the harness moved onto the shared gate harness. Invisible because rehearsals
  need a real broadcast and so are not in the gate suite.
- **Twitch**: sent no credentials at all since the 2026-08-24 route lockdown —
  pledge 401'd and `undefined` flowed into the literal URL
  `http://localhost:3306undefined`. Now uses `bountyAuth` + `srv.headers()`,
  with a `must()` helper that stops at the rejected call.
- **Both**: hardcoded 3 clips — EXACTLY `calibrationMinPoints`, zero margin,
  against a documented ~1-junk-probe-in-4 rate. Now `--clips`, default 5.
  **Two clips can never verify anything** on a platform without PROGRAM-DATE-TIME.
- **Twitch**: the mid-broadcast live spot-check ran the FULL verify+release
  route — it could open a review blocking every later release, or consume the
  session's one `release:<id>` idempotency key on a single clip. Now opt-in.

### Open — needs a credential or a decision, not engineering

- **YouTube: UNTESTED.** Every `YOUTUBE_*` credential was blank. Not stubbed
  around, not guessed — skipped and reported, per the brief.
- **pump.fun: CANNOT BROADCAST.** No ingest/RTMP URL was supplied and the repo
  contains zero pump.fun ingest references. A stream is addressed by coin mint,
  so streaming requires launching a coin — a Solana transaction. The wallet
  supplied is a PUBLIC address; the ownership-signature path needs a PRIVATE
  key that only the human can use, in their own wallet UI. Both correctly out
  of scope for an agent.
- **Rumble ingest mismatch, unresolved.** The supplied `RUMBLE_RTMP_URL`
  (`rtmp://rtmp.rumble.com/live`) does not match what Rumble's own API returns
  for the live stream (`rtmp://ls__.live.rmbl.ws/slot-__`). Pushing to the
  wrong host is the "streams nowhere, silently" failure. The API's values are
  authoritative and per-livestream; a Rumble harness should read them from the
  API rather than env.
- **No Rumble rehearsal harness exists.** Adapting the Kick one needs: plain
  RTMP not RTMPS, live status from the creator URL not an OAuth API, and no
  slug — the identity is a username (`type: "user"`, `channel_id: null`).
- **`BOUNTY_ADMIN_KEY` still unset in Railway** — admin routes answer 503.
- **Capture storage still has no global ceiling.**

### Hazard: the git branch moved mid-run

The working tree was switched to `feat/ui-overhaul @ 24c1996` by something
outside this run, mid-audit. That branch is missing ~710 lines of verification
work, and a broadcast nearly went out on pre-T3 code. If more than one session
or person works this repo, pin the SHA at the top of any broadcast script and
abort on mismatch.

### THE REAL BROADCAST, and the money bug it found

`jordandotfun` on Twitch, 12 minutes, 5 clips, real codes, real encoder.
Verdict: **AMBIGUOUS, 4 of 5 clips verified, confidence 0.484**, badge heights
`[28, 28, 28, 28, 27.7, 28, 28, 28, 28, 4.1]`. **Release: 0 of 25.**

Two things came out of it.

**1. External capture WORKS on a real encoder.** 4 of 5 clips read back off the
platform's own VOD, 9 of 10 samples at a clean 28px — exactly the height the
design predicts (DOT=4 → 28px). No detection gap versus the synthetic corpus at
this resolution: the corpus claims ~100% at 1080p/720p and the real encoder
delivered legible badges on every sample but one. The one 4.1px outlier is a
single frame sampled mid-transition, not a systemic shortfall.

**2. P0 — CONFIDENCE IS AVERAGED OVER MISSES, SO IT PAYS AN HONEST STREAMER
ZERO.** `avgConfidence` is the mean of `confidence` across EVERY sampled frame
(`bounty-verifier.js` — `checks.push(sample)` runs whether or not `res.found`),
and a frame that found no code contributes ~0. Codes rotate every 4s and
samples land where they land, so roughly half of any real sample set finds
nothing — that is normal sampling, not evidence against anyone. The mean lands
near 0.5, under `minConfidence` 0.6, so `escrow.release` returns
`skipped: 'low_confidence'` and the run pays **nothing**.

That is exactly the outcome the config comments call the worst failure this
system has: *"underpaying someone who did the work."* It happened on the very
first real broadcast, at full badge legibility, with the streamer having done
everything right.

The measurement conflates two different things. `hitRate` (4/5 = 0.8) already
answers "how many clips did we cover". Confidence should answer "how sure are
we of the reads we actually got" — i.e. the mean over FOUND samples, or the
per-clip confidence of verified clips only. A miss is a sampling artifact.
**Not fixed in this run** — it is a money-path change and deserves its own
gate proving a miss-heavy-but-legible sample set still pays.

**3. Minor: captures key on clipId, not playbackId, when a clip runs its full
declared duration.** The files landed as `<session>__REHEARSAL1.ts` rather than
`__REHEARSAL1#<nonce>`. `openWindowFor` filters `w.endsAt > now`, and a clip
that runs exactly its declared `durationS` has `endsAt ≈ now` at the end call,
so the window does not resolve and `playbackId` is null. Capture→playback
routing then falls back to nearest-by-time instead of exact. Degrades
precision, not correctness.

### KICK'S FIRST REAL BROADCAST — and self-capture measurably underperforms

`jordandotfun` on Kick, 10 minutes, 5 clips. **LIVE confirmed by Kick's own API**
(started 19:28:39Z) — the first time Kick has ever met a real broadcast.
All 5 self-captures recorded. Stream context OK.

**Verdict: AMBIGUOUS, 1 of 5 clips verified, confidence 0.234.** Badge heights
`[28,28,28,4.1,28,28,0,28,28,28,28,4.1,28]` — 10 of 13 at a clean 28px.

**The badge was legible and the clips still did not verify.** That rules out
legibility and points squarely at the seek: self-capture's wall-clock→media
mapping is an ESTIMATE (`frozenAt` minus the code's issue time, corrected by a
searched skew), whereas the Twitch VOD path anchors on the archive's own start
time. Same broadcast quality, same overlay, same decoder:

| path | platform | clips verified |
|---|---|---|
| external capture (VOD) | Twitch | **4 / 5** |
| self-capture | Kick | **1 / 5** |

That gap IS the finding. Tonight's two fixes made self-capture *work at all* —
it records, it freezes the right window, the badge is in the file. They did not
make it *reliable*. Self-capture is the only evidence path Kick, Rumble and X
have, and at 1/5 it is not good enough to pay people on.

**P0 — `BOUNTY_CAPTURE_FREEZE_DELAY_MS` defaults to 51s against a 60s window.**
Derived as `liveBroadcastDelayMs (45s, deliberately generous) + 6s`, but the
freeze delay is not the acceptance window and should not inherit its slack.
At 51s the buffer holds `[end−9s, end+51s]`: for a 30s clip at a real 12-25s
delay that loses the clip's first several seconds, leaving fewer code
opportunities for calibration to land on. Should be `max observed delay + one
segment` ≈ 30s, which holds `[end−30s, end+30s]` and covers a 30s clip whole.
This is the most likely single cause of 1/5 vs 4/5 and is a one-line change —
but it needs a delay-aware gate run to prove, not a guess.

### Kick DOES have VODs — our wording was misleading, and it matters

Corrected on the operator's push-back, and they were right. Kick publishes VODs
in its UI. What does not exist is a way for us to FIND them:

- `GET api.kick.com/public/v1/videos` → **404, the endpoint does not exist**.
- `yt-dlp https://kick.com/<handle>` resolves as `kick:live` ONLY and 404s the
  moment the channel is offline.
- yt-dlp DOES ship a `kick:vod` extractor — it just needs a direct
  `kick.com/video/<id>` URL.

So the accurate statement is "no VOD **discovery**", not "no VODs", and several
comments and the platform profile read as the latter. **This is actionable:**
`KickFrameSource` already accepts `vodUrl` + `vodStartMs`, and the `watchUrl`
plumbing added this run is exactly the channel for it. If a Kick streamer
supplies their VOD link, Kick could verify on the archive path that scored 4/5
on Twitch instead of the self-capture path that scored 1/5. Worth doing before
any more self-capture tuning.

### The obs-websocket path is still untested against real OBS

Tonight could not test it and no unattended harness can: the harnesses broadcast
by piping the overlay through ffmpeg, so there is no OBS process to hold a
websocket connection. It remains gated against a mock in six states only.

Testing it needs a human: OBS running with the overlay as a browser source,
obs-websocket enabled, the operator going live themselves, and the harness run
with `--skip-push`. Lowest-stakes of the open gaps — the tier design makes
obs-websocket corroboration worth nothing on its own (tier 2 and tier 3 pay
identically), so a bug there cannot cost anyone money.

### Rumble: ingest PROVEN, playback URL is the blocker

Tested against the real service on 2026-08-26. Two corrections to what was
filed earlier tonight.

**1. The `.env` ingest values are STALE and would have failed silently.**
Supplied: `rtmp://rtmp.rumble.com/live` + `r-4qdjv0-rwk0-jkyn-625e6d`.
Rumble's own API returns `rtmp://ls18.live.rmbl.ws/slot-23` + a 14-char key.
Pushing a test pattern to the API's pair took the channel LIVE (`is_live: true`
confirmed by the same API) — so ingest works, and the harness must read
`server_url`/`stream_key` from the live-status response rather than from env.
Rumble's per-livestream slots are assigned dynamically; an env-pinned ingest is
wrong by construction, not merely out of date.

**2. THE ACTUAL BLOCKER: the playback URL is not discoverable.** Self-capture
needs a URL to READ the public stream from, and Rumble exposes none:
- the live-status API carries `id`, `server_url`, `stream_key` — publishing
  credentials only, no watch/playback URL field anywhere in the response;
- `rumble.com/user/<name>` resolves through yt-dlp's `RumbleChannel` extractor
  as a PLAYLIST of past videos ("Downloading 0 items"), never the live stream —
  and it exits 0 with EMPTY stdout, so `resolveMediaUrl` would classify it as
  `EXTRACTION_FAILED` rather than `CHANNEL_OFFLINE`, missing the retry-until-live
  path added for Kick. A second distinct failure shape for the same situation.
- `rumble.com/embed/v<id>/` DOES exist (HTTP 200, derivable from the API's `id`
  as `v` + id), but yt-dlp's `RumbleEmbed` extractor gets **403 Forbidden** on
  its metadata endpoint, with and without a browser User-Agent, both while the
  channel was live and while offline.

So Rumble is NOT blocked on credentials — it is blocked on obtaining a readable
playback URL. The operator can supply one trivially (it is the browser address
bar while live); automated discovery needs either a working embed extraction or
a Rumble API that returns a watch URL, and neither exists today.

**Slot consumed.** Pushing to the livestream ended it: the API now returns zero
livestreams. A fresh one must be created in Rumble Studio before another
attempt, which also means the ingest pair rotates again — reinforcing that it
must be read live, never pinned.

## Real broadcast testing — multi-platform (2026-08-26, `feat/real-broadcast`)

### The finding of the night

Every bug below was invisible to the whole gate suite for the same reason:
**every HLS stub publishes a segment the instant it writes it**, so the
broadcast delay D between encoder and public playlist is ~0. Anything whose
behaviour depends on D passes green. Third occurrence this month.
`_gate-broadcast-delay.mjs` exists specifically to stamp content at CREATE time
and reveal it D later — extend that one rather than trusting an instant-publish
stub.

Measured, real encoders, 720p: corpus 100%, Twitch 4/5, Kick 5/5 (was 0/5).

### Resolved this run (with evidence)

- **PROGRAM-DATE-TIME was treated as a calibration BYPASS, not an anchor.**
  PDT marks when a segment was PACKAGED; the overlay rendered its code one D
  earlier. `wallClockSkew()` returned `{skewMs: 0, "offset known, not
  measured"}` and skipped calibration, so D was never measured. Cost three Kick
  broadcasts (1/5, 0/5, 0/5) with the badge legible at 28px throughout. Also
  the code asserted "Twitch and Kick stamp none" — **Kick stamps every
  segment**, which is why two fixes aimed at a branch Kick never executes. PDT
  is now the seek anchor and calibration measures D on top. 0/5 → 5/5.
- **`confidence` was read quality TIMES presence, silently.** `bounty-ocr.js`
  returns a glyph-match margin on a read and `0.2 x` a junk-ring decode on a
  miss, so the mean over all samples was identically `q*d + m*(1-d)`. Run #4:
  `q 0.8430, m 0.2000, d 0.6154 -> 0.5957`, reported 0.596 against a 0.6 bar.
  An honest 5/5 broadcast released NOTHING. Split into `confidence` (read
  quality) and `detectionRate` (presence), both gated — in the verdict ladder
  and again in escrow, because splitting without the second gate would help a
  cheater. `_gate-confidence-split.mjs` (17/0) runs REAL misses through the
  mean, which no fixture had ever done (they are all-found or all-miss).
- **`KickFrameSource` never set `calibratable`** — undefined is falsy, so a
  Kick VOD skipped calibration and used the 16s constant.
- **Kick and Rumble discarded the measured skew** — both calibratable, both
  handed the result to a `getFrames` with no `opts` parameter. Kick's VOD
  branch seeked by a raw `(ts - vodStartMs)` with no skew term at all.
- **Kick never marked live frames `live`**, so live grabs were judged against
  the tight post-calibration residual instead of the broadcast delay.
- **`recordVerification` was a fixed whitelist that ate six fields** — the five
  `timeline*` values and `detectionRate`. The latter is a RELEASE GATE, so a
  verification record was gating a payout on a number it did not store.
- **`openWindowFor` filtered `endsAt > now`**, so a clip playing for exactly
  its declared duration resolved no playbackId at the boundary and its capture
  was filed under the clip id. Only 3 of 5 Kick windows were measurable.
- **Rumble's live-status response embeds the channel's INGEST CREDENTIALS**
  (`server_url`, `stream_key`) in plaintext. Stripped before the value leaves
  `rumble-api.js`; the catch clause reports `e?.name`, never `e.message`,
  because a fetch failure can embed the URL — which IS the credential.

### New / still open

- **R1. The calibration residual exceeds the code validity.** Run #4 measured
  `residualMs 6521 = validity/2 (2500) + spread (2521) + margin (1500)` against
  `codeValidityMs 5000`. Consequence: two samples per session land outside
  their clip (in the previous playback's tail, reading a legible badge carrying
  the NEIGHBOURING window's code) and are charged to the streamer's detection
  rate — 8/13 instead of 10/13. **The reducible term is the spread.**
  `sampleInstantsForWindow` now shifts instants clear of the window edge by the
  residual, but this does NOT fix it and was not claimed to: with the residual
  above the validity there is nowhere safe to shift to. HIGHEST-VALUE remaining
  work on the verification path.

  **Possible reframing, n=1, do not act on it without more samples.** The
  spread (2521) came out almost exactly `validity/2` (2500). If that holds
  across broadcasts it means the measured points already agree to within ONE
  quantization unit — the spread would be at its floor rather than loose, and
  the residual would be structurally

      validity/2 + validity/2 + margin  ~=  codeValidityMs + margin

  i.e. GUARANTEED to exceed codeValidityMs, for every session, by construction.
  That would make "tighten the calibration" the wrong lever entirely; the real
  ones would be `codeValidityMs` itself (shorter codes are harder to catch, so
  this trades against detection) or giving each probe sub-code resolution so a
  point's estimate is no longer quantized to its whole validity window.
  ONE sample is not evidence for a structural claim — collect
  `timelineSpreadMs` across several real broadcasts first. It is recorded on
  every verification now.
- **R2. `minDetectionRate` is 0.55 on a 0.05 margin either side.** It sits
  between a knowingly-broken 4s-residual fixture (0.50) and a broadcast proven
  honest (0.6154) — only 0.115 apart, because of R1. Raise it only from a
  measured distribution across several real broadcasts; `_gate-run-b-ocr.mjs`
  is the right source. Erring HIGH is correct: too high sends an honest session
  to review (recoverable), too low silently auto-pays (not).
- **R3. `validity/2` may be over-conservative for a MEDIAN of N points.**
  Independent quantization errors shrink with sqrt(N). Deliberately NOT changed
  — altering a payment-critical tolerance on statistical reasoning without
  measurement is what produced three of this run's bugs. Now measurable:
  `timelineSpreadMs` and `timelineResidualMs` persist on every record.
- **R4a. pump.fun ingest is a LIVEKIT INGRESS and appears SESSION-SCOPED.**
  The URL is `rtmps://pump-prod-<id>.rtmp.livekit.cloud/x` + key. Pushing to it
  after the operator's own stream had ended failed at the TLS layer —
  `IO error: -10053` (WSAECONNABORTED) and *"The specified session has been
  invalidated for some reason."* The same credentials had worked minutes
  earlier while the operator was live. NOT PROVEN, but the leading explanation
  is that pump.fun provisions a LiveKit ingress when the creator clicks "go
  live" and tears it down when the stream ends — unlike Twitch and Kick, where
  a stream key is persistent and reusable indefinitely. If so, **unattended
  broadcasting is not possible on pump.fun**: someone must mint an ingress and
  the run has to happen inside that window, or `--skip-push` must be used with
  the operator live. Confirm by capturing a fresh key immediately before a run.
- **R4b. pump.fun reports `isLive: true` for a stream publishing NOTHING.**
  RESOLVED in code, filed here because it is a platform fact worth knowing.
  The aborted push above still flipped `isLive` true within seconds, with no
  media directory and no derivable playlist — the flag tracks INGRESS STATE,
  not content. `liveLookerFor` now narrows it to `live && !!playlistUrl` at the
  single point that knows the quirk, because `captureBroadcastObservation`
  records the flag as viewer-sample evidence and stream context gates payout.
  Gate E4 covers both directions.
- **R4. pump.fun is blocked on ingest only.** Discovery is SOLVED —
  `livestream-api.pump.fun/livestream?mintId=<mint>` returns live status,
  viewers, start, creator wallet and the derivable HLS master, unauthenticated.
  The endpoint is READ-ONLY and carries no ingest fields, so `PUMPFUN_RTMP_URL`
  and the coin mint must come from the operator. `PUMPFUN_STREAM_KEY` and
  `PUMPFUN_WALLET_PUBLIC_ADDRESS` are already set. `_rehearsal-pumpfun.mjs` is
  written and is the only harness that tests BOTH capture paths on one
  broadcast. Ownership: the API's `creatorAddress` is half the check for free;
  proving CONTROL still needs a signature over our nonce.
- **R5. Rumble needs a new livestream slot** (the old one was consumed) plus
  the watch URL from the address bar while live. Ingest itself is PROVEN — the
  API's credentials worked and the channel went live.
- **R6. Rumble's VOD skew has never been checked against a real VOD.** The
  constant is derived from Twitch. The calibrated value can now override it.
- **R7. YouTube untested** — 24-hour livestream activation wait.
- **R8. obs-websocket untested against real OBS** — needs the operator present
  with OBS running and the harness run with `--skip-push`.

### Found by a full-suite sweep, NOT caused by this run

- **T1. `_gate-theme` is RED: dark mode renders a WHITE background.**
  `GATE FAIL (3)` — `dark/landing`, `dark/dashboard` and `dark/join` all
  measure background luminance 1.00, i.e. pure white, where dark is expected.
  Light mode passes and text contrast passes; it is specifically the dark
  background that is not applying.
  NOT FROM THIS RUN: no CSS or theme file changed in the 18 hours of this
  session, and only one commit in the whole reviewed range touched `web/` at
  all (`0e6071b`, earlier work). The gate was last edited by `5202c93`
  ("part 4: light mode fix"), so dark mode broke sometime after that and
  nothing surfaced it.
  Clearing `web/.next` (the known stale-Turbopack-cache remedy for this repo)
  does NOT fix it, so it is not a cache artifact. Left unfixed deliberately —
  it is a front-end bug well outside a broadcast-testing run, and it deserves
  its own look rather than a late-night guess at someone else's CSS.

- **T2. The gate suite has no single runnable entry point, and that hid T1.**
  Gates report in at least four different formats — `RESULT: N pass, M fail`,
  a bare `GATE PASS`, `GATE FAIL (n)`, `PART B GATE FAILED (n)`, and
  `Phase 2 token gate PASSED` — so any grep-based sweep silently misclassifies
  a large fraction. A sweep of all 55 gates classified only 28. Several others
  crashed with `ECONNRESET` / `fetch failed` purely from running server-starting
  gates back to back, and pass individually (`_gate-self-capture` 22/0,
  `_gate-run-b-pipeline` 12/0 on retry), so a sweep also needs isolation or
  retry to be trustworthy. Until both are fixed, "the suite is green" is a
  claim nobody can actually check in one command.

### From an adversarial review of this run's payment path (18 agents, 14 findings, 11 survived refutation)

FIXED in this run: the too-small-badge silent zero (quality median filtered on
`counted`, which excluded the very samples it exists to notice), the
client-supplied air-session `platform` spoof, the pump.fun PDT bypass left on
`PumpFunFrameSource` after it was deleted from `CaptureFrameSource`, the
`getStreamByMint(mint, this.log)` options-object bug, and two gate assertions
that passed for the wrong reason.

STILL OPEN:

- **A1. X is claimable, but its self-capture address is still client-supplied
  and unbound to the X identity.** (high) `captureSourceUrl` pins the URL only
  for the literal strings 'twitch' and 'kick'; every other platform falls
  through to `session.watchUrl`. Deriving `platform` from the claim (done this
  run) closes the case where a twitch claimant DECLARES another platform, but
  not the case where an X claimant supplies a watchUrl pointing at a stream
  they control. Either pin X to a handle-derived URL the way twitch and kick
  are, or require an ownership proof on the URL itself before capture trusts
  it. The comment above `captureSourceUrl` still says these platforms "are not
  claimable yet" — that sentence is now false and is load-bearing.

- **A2. One degraded Privy fetch permanently deletes `platformLogins`.** (high)
  `privy-identity.js:191`. A single failed or partial account fetch overwrites
  the stored logins, and those are a streamer's ONLY ownership proof on every
  STREAMER-tier route — so a transient upstream problem silently revokes access
  to their own claim, and nothing restores it. Relates to the known
  SDK-drops-newer-accounts behaviour: the merge must be additive, and an empty
  or failed fetch must never be written.

- **A3. The `recordVerification` whitelist widening has no test.** (medium)
  `detectionRate` and the five `timeline*` fields are persisted now, and
  `detectionRate` is a release gate, but nothing asserts they survive the
  round-trip. They were silently dropped for months precisely because that
  destructure is a fixed whitelist with no coverage. Verified by hand against a
  real session this run; that is not the same as a gate.

- **A4. Gate E4 tests the gate's own copy of the pump.fun live-narrowing.**
  (low) It re-implements `live && !!playlistUrl` inline and asserts against the
  re-implementation, so it would still pass if the shipped narrowing were
  reverted. Same flaw as the first version of the section-F property test,
  which was fixed by exporting the real function — do the same here.

METHOD NOTE, worth more than any single finding: three of the 14 were REFUTED
on inspection, including one whose failure scenario was inverted (the fallback
constant it complained about was protecting that path, not breaking it). The
refutation pass is what made the other eleven trustworthy. A review that only
generates findings generates confident wrong ones.

### From the "golden loop" retest (2026-08-27), Kick run #5

FIXED: the field-loss regression on `recordVerification` came back (see the
commit "bounty-store: the field-loss regression came back, caught by a live
Kick retest"). Now backed by a round-trip gate (`_gate-confidence-split.mjs`
section H) that was proven, not assumed, to catch it — run against the broken
code it fails 5/5.

NEW EVIDENCE for R1 (calibration residual near codeValidityMs), not a new
issue: this run's calibration came back DISAGREEMENT, not MEASURED. Five
estimates: 6.9s, 15.3s, 19.4s, 6.9s, 15.4s. The median clusters {15.3, 15.4}
as inliers (2 points, need 3); {6.9, 6.9} sit ~8.4s away — almost exactly TWO
code rotations (`codeRotateMs` x 2 = 8.0s), the signature of a probe decoding
a neighbouring rotation's code near a boundary. 19.4s missed the inlier
tolerance by 100ms. This is the majority-cluster safety mechanism working
AS DESIGNED — it correctly refused to call the timeline measured and opened a
review rather than risk a bad payout — but it is the SECOND real broadcast
(after run #4's tight residual margin) suggesting Kick calibration sits close
to a reliability boundary. Worth tracking as an operational question (how
often does an honest Kick streamer get routed to manual review?) — not a
correctness bug, and not something to guess a fix for on two data points.

Otherwise CONFIRMED GOOD on a fresh broadcast, against every payment-path
commit made tonight after run #4: result PASS, verifiedClips 5/5, confidence
0.857 (matches the 0.843 offline replay within real-capture variance),
self-capture froze 5/5 windows.

### From the "golden loop" retest, Twitch run #2 (2026-08-27) -- NOT GOLDEN YET

A fresh Twitch broadcast (VOD 2857568019), the first real test of the
confidence/detectionRate split and sample clamp on this platform: **FAIL**,
verifiedClips 0, confidence 0. Nine of ten samples read a real, legible 28px
badge that matched no expected code -- the signature of a genuine seek
problem, not noise. Diagnosed by pulling real frames off the actual VOD at a
spread of offsets and reading them directly (fine-grained sweeps, then
visually confirmed the rendered badge text), not by theorizing.

**T5a. FIXED — the clamp pulled past the real rotation floor.** See the commit
"verifier: the sample clamp pulled past the real rotation floor, not just the
window edge". `sampleInstantsForWindow` was pulling window-edge samples up to
`codeValidityMs` (5000ms, OCR acceptance tolerance) into a code, but
`currentOrRotate()` only guarantees a code stays current for `codeRotateMs`
(4000ms) -- a full second tighter. Fixed: the pull is now capped at
`codeRotateMs - calibrationResidualMarginMs`; `codeValidityMs` still governs
final acceptance. Validated against the real VOD offline: every FIRST code of
a window now decodes correctly (3/3, was 0/3).

**T5b. NOT FIXED — every SECOND code of a window still misses (3/3).** This is
NOT the same bug and is NOT a targeting-margin problem: no window-edge pulling
even occurs for these samples (mid-code already sits comfortably inside the
window, untouched by any clamp), yet the decode still misses. Concrete
evidence, window1 of this run:

  - c1 (76-4KVR, issuedAt=T+0, nominal validity [T+0, T+5000])
  - c2 (76-6END, issuedAt=T+18986, nominal validity [T+18986, T+23986])

Sweeping the REAL VOD (skewMs=25480, independently measured and confirmed
correct for this window by 3 cleanly-matching calibration probes) shows:

  - 76-4KVR genuinely on screen from  ~T+0    to ~T+3750..4000  (close to
    codeRotateMs, consistent with T5a's fix)
  - 76-6END genuinely on screen from ~T+4000  to at least T+18000 (14+
    real seconds -- HELD ON SCREEN LONG PAST its own 5000ms nominal
    validity, starting nearly 15 SECONDS BEFORE its own recorded issuedAt)
  - the NEXT window's own first code is already showing by T+20000, roughly
    10 seconds before that window's recorded startedAt

So the badge visually rotates to c2 almost immediately after c1's real
window closes (~T+4000), but the SERVER does not record c2 as issued until
T+18986 -- a ~15-second gap between when a code is REALLY on screen and when
its `issuedAt` timestamp says it was issued. c2's own nominal midpoint
(T+21486) lands in territory the real broadcast has ALREADY moved past (the
next window's own content).

The likely mechanism, not yet confirmed by reading the actual code: the
overlay's own client-side polling of `currentOrRotate()` may not be
frequent, so once a code rotates client-side, the SERVER-recorded `issuedAt`
(stamped when the server call happens to land) can trail the true on-screen
change by however long the client waited to poll again. `codeRotateMs` is a
floor on how SOON the server will hand back a fresh code, not a promise
about when the overlay actually asks. **This was not chased further tonight
because the actual mechanism lives in the overlay's own client-side
rendering/polling code, which was not read this session** -- confirming it
needs reading that code, not another guess at the server-side timing
constants.

**T5c. Kick likely carries the same T5b defect, silently.** Kick's own
run #5 (same night) measured detectionRate 0.615 (8/13, 5 misses) -- a
similar-shaped loss to what T5b would produce -- but still verified 5/5
because Kick's windows sample enough codes that even a lost second-code
miss per window still leaves `clipHits > 0` from the first code alone.
Worth re-examining once T5b's real cause is understood: the loss may be
larger than it looks precisely because it never causes an outright
platform failure to force it into view.

**Not golden**: Twitch verification, on the code as it stands, will still
fail or under-detect on any window whose SECOND-code sample is the one that
mattered. T5a is shipped, tested, and validated for real; T5b is real,
evidenced, and open.

### T6. pump.fun's "hollow live" fix is INSUFFICIENT — it publishes a real placeholder video (2026-08-29)

R4b/E4 narrowed pump.fun's live flag to `live && !!playlistUrl`, on the finding
that `isLive` flips true on ingress creation before any frame arrives. MEASURED
TODAY: that is not enough. With an ingress open and NO encoder connected,
pump.fun serves a **complete, reachable HLS playlist carrying a real video** —
its own placeholder screen (the OBS logo over a blue gradient with a
camera-disabled icon). So:

    live: true          <- ingress open
    playlistUrl: set    <- real playlist
    playlist reachable  <- real segments, real frames
    viewerCount: 2      <- and it accrues viewers

...for a stream broadcasting nothing but a stock image. Every signal we
currently gate on says "genuinely broadcasting". Confirmed by pulling a live
frame and LOOKING at it, which is the only check that caught it.

CONSEQUENCE: a session can open against a placeholder, air its whole clip
schedule, self-capture placeholder frames, and verify 0/5 — indistinguishable
from a capture bug. It cost a real streamer's session today: the operator had
gone live in the pump.fun studio without pointing OBS at the ingest, every
API signal read healthy, and I asserted "your OBS settings are already
correct" on the strength of those signals. They were not.

WHY THIS IS HARD TO FIX PROPERLY, and why nothing was changed today: there is
no API field distinguishing "placeholder" from "real content". The honest
signals are all in the pixels — a static frame that never changes, or a
literal match against pump.fun's placeholder image. Both are heuristics, and a
heuristic that wrongly decides a real broadcast is a placeholder would refuse
to pay someone who did the work, which is the failure mode this project
weights heaviest. Options worth considering, none implemented:

  - Sample two frames a few seconds apart at session open; if they are
    byte-identical (or near-identical by a cheap perceptual hash), the stream
    is almost certainly static. Cheap, but a genuinely static scene (a
    "starting soon" card) would trip it — so it should ROUTE TO REVIEW, never
    auto-fail.
  - Keep a reference hash of the known placeholder and match against it.
    Precise, but brittle: pump.fun changes the asset and it silently stops
    working, which is the same class of failure as the PDT assumption.
  - Do nothing at session open, and instead make the 0/5 REPORT
    distinguishable: if no sampled frame in the entire session ever contained
    a badge AND the frames are static, say "your stream appears to be showing
    a placeholder" rather than "verification failed". Cheapest, and it fails
    in the safe direction.

The last option is probably right, and it belongs with T5b (both are about a
0/5 that does not explain itself). Filed, not guessed at.

### Spend

Zero LiveKit minutes (neither rehearsal harness references LiveKit or sets
`LIVEKIT_URL`). $0 external — Twitch/Kick/Rumble ingest is free and no pump.fun
test coin was created.

### T7. The setup helper's expiry is indistinguishable from a broken overlay (2026-08-29)

`_setup-overlay.mjs --minutes N` exits when its window closes, taking its
server with it. The overlay then renders nothing — which is EXACTLY what a
misconfigured browser source looks like. During pump.fun setup the operator
refreshed OBS, saw the badge appear, and reported it visible; by the time the
stream was checked the helper had hit its 35-minute limit and died, so the
badge had vanished and the evidence pointed at an OBS problem that did not
exist. Roughly twenty minutes went into diagnosing a working configuration.

Cheap fixes, none implemented yet:
  - print a loud countdown ("helper stops in 5 minutes") and a final line
    saying the badge is ABOUT to disappear and why
  - on exit, leave the server up for a grace period, or exit only on an
    explicit interrupt rather than a timer
  - have the overlay itself render a visible "server unreachable" state
    instead of silently blanking, so a dead backend never looks like a
    misconfigured source

The third is the real fix and applies to production too: a streamer whose
MegaChat backend becomes unreachable mid-broadcast currently sees the badge
quietly disappear, with no way to tell that from having set the overlay up
wrong. Related to T5b and T6 — all three are cases where a zero, a blank, or
a silence fails to say WHICH failure it is.

### pump.fun PROVEN on a real broadcast (2026-08-29) — with three caveats

First successful pump.fun run, after six setup failures (none of them in the
video pipeline). Full path confirmed end to end: overlay -> OBS -> pump.fun
ingest -> public HLS -> our capture -> OCR decode -> escrow release.

    canary        FOUND CF-UE3G at 28px, broadcast delay ~10s
    result        PARTIAL
    verifiedClips 7
    confidence    0.937   (highest of any platform: Twitch 4/5, Kick 0.857)
    detectionRate 0.778
    stream ctx    OK
    release(stub) 6.25 of 25   <- FIRST non-zero release on a real broadcast

This is also the first real-broadcast exercise of the confidence/detectionRate
split all the way through to money moving.

**P1. verifiedClips counts SETUP clips.** 7 verified for a 5-clip run: the
canary clip and the warmup badge-holder clips carry valid codes and are aired
inside the session, so they verify like any other. Not false — they really did
air — but it inflates the payout unit, and payouts are per verified clip. The
warmup/canary clips need a marker that excludes them from verifiedClips and
from the release computation, without excluding them from the evidence log.

**P2. Self-capture STILL did not run, so the two columns are the same
capture.** 0/5 windows froze, so both "self-capture" and "external" ran the
external path and reported identical numbers. The yt-dlp coin-page fix is
committed but this server was started before it applied. pump.fun remains the
only platform that CAN compare two independent captures of one broadcast, and
that comparison has still never actually happened. Re-run to get it.

**P3. detectionRate 0.778 with the first two samples at px 0.** Consistent
with the measured ~10s broadcast delay putting the earliest sampled instants
before the badge reached the public stream. Same family as T5b/R1 — the
sampler does not yet account for a platform's real delay when choosing WHERE
in the window to sample.

### T8. External capture is not dependable, and the two "externals" are different things

Raised by the operator, confirmed in code. "External capture" means two
materially different mechanisms, and one of them is disableable by the
streamer:

  TWITCH   a genuine VOD ARCHIVE (frame-sources.js:158,
           /videos?user_id=..&type=archive). A streamer with VODs turned
           off, past their retention window, or who deleted the VOD,
           yields NO_VOD_COVERING_TS. External capture is then IMPOSSIBLE
           and self-capture is the only path that can ever work.
  KICK     no VOD discovery API at all -> self-capture MANDATORY.
  PUMP.FUN not a VOD: the LIVE playlist is append-only (MEDIA-SEQUENCE:0,
           825 segments retained across ~27 minutes), so we seek backwards
           through the live stream itself. Nobody can switch that off --
           but whether it SURVIVES THE STREAM ENDING is unmeasured, and
           verification runs after the fact.
  RUMBLE   no VOD discovery; needs an operator-supplied URL.

CONSEQUENCE: external capture cannot be treated as a dependable fallback.
It is platform-dependent, streamer-disableable on Twitch, and of unknown
durability on pump.fun. The code already makes SELF-CAPTURE PRIMARY
(bounty-routes.js, "SELF-CAPTURE FIRST"), which is correct -- but
self-capture is currently PROVEN ON ONE PLATFORM OF FOUR:

    Kick      PROVEN   5/5 windows frozen, 85.8MB
    Twitch    UNPROVEN every Twitch verification to date used the VOD path
    pump.fun  UNPROVEN was structurally broken (yt-dlp handed a coin page);
                       fixed, under test now
    Rumble    UNPROVEN blocked on a live slot

Today's pump.fun success ran ENTIRELY on external capture -- i.e. the
fallback carried a run while the primary was broken, and nothing in the
result said so. Worth measuring: does pump.fun's playlist outlive the
broadcast? If not, pump.fun external verification only works during or
shortly after the stream, which is a different product than "verify
later".

### T9. pump.fun ships NATIVE co-streaming with viewer join requests (2026-08-29)

Observed on a real pump.fun test stream: a viewer ("ComfyL") requested to join
the broadcast and pump.fun surfaced a native yes/no approval prompt, alongside
its own Clip button, mic/cam controls and a record control.

CONFIRMED NOT OURS. The codebase contains no "wants to join", "request to
join", "join request" or "raise hand" string anywhere. Our co-host machinery
uses different wording and has no join-approval prompt or Clip button. This is
pump.fun's own feature.

WHY IT MATTERS: this overlaps directly with MegaChat's core mechanic. pump.fun
already has viewer-initiated co-streaming, approval, and clipping built into
the platform, for free, with no OBS setup. Anything MegaChat offers a pump.fun
streamer has to be worth more than a feature they already have natively.

NOT a technical blocker and nothing here needs changing. Filed because it is a
product/positioning fact discovered by accident during verification testing,
and it should not be lost in a chat log. Worth a deliberate look at what
pump.fun's native version does and does not do (payouts to the guest? bounty
clips? verification of what aired?) before assuming the overlap is fatal or
irrelevant.

**T9 addendum — what pump.fun's native version does NOT do.** Three
differentiators, all load-bearing and all already built here:

  - NOT CROSS-PLATFORM. It is a pump.fun feature for pump.fun streams. The
    whole point of this verification work is that one mechanic pays out on
    Twitch, Kick, Rumble, YouTube and X too.
  - NO PRE-RECORDED CLIP. Their join request puts a live person on stage.
    MegaChat's unit is a fan's RECORDED clip, submitted and paid for in
    advance -- a different product, not a worse version of the same one.
  - NO PAY-BY-SECOND. Confirmed in bounty-escrow.js:704 --
    releaseRatePerClip * clips + releaseRatePerClipSecond * verifiedClipSeconds.
    Today's real pump.fun broadcast released 6.25 on that formula. Their
    feature has no payment rail at all.

So the overlap is the surface (a viewer appears on a stream), not the
mechanic (a fan pays to have a specific recorded clip aired, and the streamer
is paid per verified second it was actually on screen). Keeping T9 filed as a
positioning fact worth knowing, not as a threat to the thesis.

### ROOT CAUSE FOUND: the overlay polled every 15s while codes rotate every 4s (2026-08-29)

Fixed in "overlay: the poll interval captured a placeholder and froze at 15s".

    let rotateMs = 60000;                            // placeholder
    poll();                                          // async, has not returned
    setInterval(poll, Math.max(5000, rotateMs / 4)); // reads 60000 -> 15000ms

setInterval captured the placeholder before the first poll returned, so the
overlay asked for a new code every 15 SECONDS while the server rotated every
4. Every code sat on screen ~4x longer than the system believed. A second bug
sat on top: the max(5000, ...) floor is slower than a 4s rotation even once
re-armed.

WHY IT BROKE VERIFICATION RATHER THAN JUST LOOKING STALE. Calibration
estimates the broadcast delay by seeing which code is on screen and comparing
against that code's NOMINAL midpoint. A code held 4x too long makes an on-time
stream look ~10s delayed. Measured on a real pump.fun broadcast:

    codes issued 17s apart      (codeRotateMs = 4s)
    calibration -> skew 10366ms (true offset near zero)
    every sample seeked ~10s wide, found a REAL badge at 28px carrying the
    WRONG code, and the broadcast verified 0/9

MEASURED IN A BROWSER, hashing the badge canvas once a second for 40s:
~15s per code before, 5.7s after, against a 4s server rotation.

THIS LIKELY SUBSUMES SEVERAL OPEN ITEMS -- to be confirmed, not assumed:
  T5b  Twitch "every SECOND code in a window misses". Exactly what a 15s hold
       produces: the first code of a window is still displayed when the second
       code's sample instant arrives.
  R1   calibration residual exceeding codeValidityMs. The residual is inflated
       by the same phantom delay.
  P3   pump.fun detectionRate 0.778 with early samples reading px 0.

NOT YET VALIDATED END TO END. The saved captures cannot prove it: they were
recorded BY the buggy overlay and physically contain codes held ~15s. Only a
fresh broadcast with a refreshed overlay page can confirm it, which is running
now.

### TWITCH PROVEN ON BOTH CAPTURE METHODS, AND THEY AGREE (2026-08-29)

First run after the overlay polling fix, driven unattended (ffmpeg push +
puppeteer overlay, no OBS involved -- so it exercises the fix cleanly with no
cached page or refresh timing to get wrong).

    VOD capture   PASS 5/5  confidence 0.881  detectionRate 1.0
                  timeline MEASURED skew 14910ms spread 1927ms
    Self-capture  PASS 5/5  confidence 0.886  detectionRate 0.9
                  timeline MEASURED skew  9972ms spread 1935ms
    release(stub) 6.25 of 25

THE POLLING FIX IS VALIDATED. detectionRate 1.0 on the VOD path, with all ten
samples reading 28px and ZERO misses. Every prior run had scattered 0-height
samples: Twitch 4/5 before, Kick 0.615, pump.fun 0.667-0.778. The 15s-vs-4s
poll was costing samples on every platform, not just breaking pump.fun.

FIRST REAL CROSS-CHECK. Two independent recordings of ONE broadcast, verified
separately, agreeing on 5/5 with confidence within 0.005. The differing skew
is correct rather than a discrepancy: the VOD timeline and the capture's PDT
anchor are different clocks, and calibration measured each with a tight spread
(~1.9s both).

TWITCH SELF-CAPTURE WAS NEVER EXERCISED BEFORE TODAY. It matters most here of
all platforms: Twitch VODs are streamer-disableable, so self-capture is the
only path for those users, and it was entirely unproven until now.
