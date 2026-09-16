# 2026-07-26 → 07-27 — Hardening, and the fan-facing bounty program

Sources: `DECISIONS.md` ("Overnight bounty hardening", "2026-07-27 — overnight-hardening merged to trunk", "bounty program build"), `OPEN-ISSUES.md` ("Webhook cleanup + min-duration + refunds", "Overnight closeout", "Bounty program — fan-facing build"), `docs/briefs/2026-07-26.md`, `docs/briefs/2026-07-27.md`, `docs/briefs/2026-07-27-evening.md`, `docs/decisions/bounty-clip-storage.md`, `docs/decisions/post-release-clawback.md`, `docs/decisions/sub3s-residual.md`, `docs/decisions/mirror-test-audit.md`, `docs/decisions/oauth-domain-audit.md`; merge `5811b45`, commits `93ab50e` → `e72a440`.

## What shipped

- **Real webhook delivery verified end to end** on the production LiveKit project: a genuine participant for 15.6 s, join and left delivered, session opened and closed, the breaker metering non-zero from webhook data for the first time (`OPEN-ISSUES.md`, 2026-07-26).
- **Minimum clip duration derived from the verifier's sampling floor**, rejected client-side before any wallet prompt and enforced server-side above the payment handshake; deliberately absent from `RoomConfigPatch` so a dashboard cannot configure a room below the provable floor.
- **Refunds generalised**: one `escrow.refund()` with enumerated reasons, idempotent per contribution, actor and reason written to the ledger.
- **The evidence chain** (`bounty-evidence.js`): codes, playbacks and verifications split from mutable state into an append-only JSONL with the ledger's own integrity primitives; release refuses on `evidence_unverified` or `evidence_diverged`.
- **Per-playback nonce**: a replayed clip resolved to the first airing's closed window and issued zero codes — an honest streamer replaying a fan's clip earned nothing. Fixed by keying windows and codes on `playbackId`.
- **Persistence proven, not configured**: a boot marker written and read across deploys, so `/api/health` reports `proven` or `unproven` and never claims a volume from an env var alone.
- **Ops alerts to a human** (`ops-alerts.js`): webhook posts on budget warn/block, long session, clip-storage pressure; no-op when unset, never throws into a caller, rate-limited per condition.
- **The content layer** (`bounty-clips.js`): append-only index, content-addressed media, purge appends a reason. Before it, the bounty mechanic had **no clips at all** — `letterRef` was write-only and no route touched media (T2, "the finding of the night").
- **The fan-facing program**: pledges across up to three streamers with atomic first-claim-wins, the program page, streamer pages, record-and-send in its own recording context, the contributor status page, the approval queue sorted by moderation grade, rejection reputation with graduated refunds, real Twitch claim identity behind `BOUNTY_IDENTITY_REAL=1`, viewer-count evidence at each playback.

## What it found

- **The mechanic was dead at go-live** (T8): `/api/bounty/air-session` called a function the playback-bound redesign had deleted; every call threw. Nothing caught it because every gate created sessions through the store, not the route. `_verify-no-dead-calls.mjs` now resolves every cross-module call statically.
- The daily cap was deploy-resettable (webhook state was memory-only); duplicate overlays billed twice; the prefix whitelist failed open; the sessionStorage fallback rebuilt the original leak — all four fixed (T1, T4a–c).
- `/api/health` overstated what it knew about persistence — `!!process.env.DATA_DIR` proves a variable was set, nothing more.
- A DENIED claim wedged the handle in `CLAIM_PENDING`; a moderation error showed "in review" forever; the UI verifier inherited the shell's real `MODERATION_API_KEY` and was one run from billing real OpenAI per gate run. All three found by the gates and fixed.
- The mirror audit: ~700 cases, 19 genuine mirrors (2.7%) in 3 files; the reveal gate converted to drive the real overlay page.

## Judgment calls

- **Reversed my own G9 risk call**: the mutable store had been filed as "much smaller risk than the ledger" — that weighed proof as bookkeeping. The codes a payout is computed from are evidence.
- Split evidence from state rather than making everything append-only; workflow state legitimately mutates.
- Clawback designed, not built — staged release (hold back ~20% to a maturity date) recommended because it turns "get money back" into "do not send it yet" (`docs/decisions/post-release-clawback.md`).
- The sub-3 s residual left as a product decision with options written (`docs/decisions/sub3s-residual.md`); the status quo is accidentally "redistribute to pool".
- `paid` is in the status ladder but unreachable, and the endpoint says so — a fake `paid` would be worse than admitting the rung exists for later.

## Verification result

Fast-forward merge to trunk (`93ab50e` → `c526a2f`) with the full suite re-run on the post-merge tip: bounty 101/0, lazy-connect 65/0, browse-deck 19/0, e2e 19/0, min-duration 10/0, ops-alerts 19/0, dead-calls 3/0, mirror-drift 5/0 (`DECISIONS.md`). The bounty-program build's own gate covered the moderation module mock-driven; `_gate-p2-moderation.mjs` failed 6/4 on trunk for a reason found the next day ([Run B](2026-07-28-run-b-verification.md)).

## Still open from this period

No clawback; the platform match has no reversal story; contributions with no uploaded clip are refundable but nothing sweeps them; fresh-account cost was zero (later closed by requiring sign-in to pledge); bounty admin routes had no auth (closed 2026-08-24).
