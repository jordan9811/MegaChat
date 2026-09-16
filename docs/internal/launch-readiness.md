# Launch readiness

**MegaChat is deployed and in stealth. There are no users. No real money has moved on anyone's behalf. A full retest of every money path is required before public launch.** Each sentence is a fact about the repo, not a mood, and each is expanded below with its source.

## The state, plainly

| Statement | Basis |
|---|---|
| Deployed | Railway auto-deploys `v0-ui-migration`; the live origin is polled after every push (`AGENTS.md`, "Commit ≠ ship"; `REPORT-DOCS.md`, the deploy poll). |
| Stealth, no users | `megachat-pass-b-and-docs.md`, "The app is deployed but in stealth. There are no users. Every session on prod so far has been a rehearsal or a gate." Every real-broadcast entry in `OPEN-ISSUES.md` names the operator's own channel (`jordandotfun`, `jordanyeakley523`, `@darkkirbyfi`). |
| No real money moved on anyone's behalf | Seat metering has run on mainnet dust from the operator's wallets only (`_gate-tempo-phase2.mjs`, `_gate-tempo-phase3.mjs`, `_gate-p1-features.mjs`, `_gate-phase3-letters.mjs` headers). Bounty settlement is a stub with no transfer path — Gate H, `_gate-bounty-claim.mjs`; `bounty-settlement.js`. |
| Full retest required before launch | This page's checklist. It is a documented step, not an assumption (`megachat-pass-b-and-docs.md`, "A full retest of every money path happens before public launch"). |

## The underpay fix, and why nobody is owed anything

`bounty-verifier.js` once averaged confidence over every sampled frame, misses included, so an honest broadcast with a legible badge scored ~0.5 against a 0.6 bar and released nothing (`OPEN-ISSUES.md`, "P0 — CONFIDENCE IS AVERAGED OVER MISSES"). The fix — confidence over **read** samples, with detection rate split out as its own gated number — landed on `feat/real-broadcast` in `6e29bae` (2026-08-26, "confidence was read quality TIMES presence, silently") and sat on that branch until Pass A merged it to prod in `1191daf` (2026-09-15). Between those dates production ran the old arithmetic.

**No payouts are owed for that window** because no real session ran on it: the app was in stealth, every verification on prod was a rehearsal by the operator, and settlement was (and is) a stub that moves nothing (`bounty-settlement.js`). The gate that proves the corrected math pays a miss-heavy but legible sample set is `_gate-confidence-split.mjs` (17/0, runs real misses through the mean).

## Retest checklist

Every path that touches escrow, settlement, payout, verification, the whitelist, the effective cap, and the whitelist identity migration. For each: the gate or rehearsal that proves it today, and whether that proof is against a fixture, a rehearsal harness, or a real broadcast. **Everything below must be re-run on the launch build, in order, with results recorded in this table, before the pre-launch snippet is removed from the public pages.**

| # | Path | Proof today | Fixture / rehearsal / real | Retest result |
|---|---|---|---|---|
| 1 | Seat metering: approve → per-tick `transferFrom` → `out_of_funds` → nothing refundable | `_gate-tempo-phase2.mjs` (mainnet dust), `_gate-tempo-phase3.mjs` | real chain, operator wallets | ☐ |
| 2 | Seat metering: MPP channel open, voucher ticks, settle on leave | `_gate-tempo-phase2.mjs` | real chain, operator wallets — and the join page does not call this route ([U1](needs-a-status-call.md)) | ☐ |
| 3 | Earned-credit seats (`credit_stream`, `points_stream`) | `_gate-rewards-part-b.mjs` | fixture | ☐ |
| 4 | MegaChat pay-at-submit, upload deadline refund, reject refund | `_gate-phase3-letters.mjs` (mainnet dust), `_gate-free-megachat.mjs` (real UI) | real chain / real browser | ☐ |
| 5 | Whitelist short-circuit ahead of every payment step; guest never metered | `_gate-guest-whitelist.mjs` 63/0 | real HTTP + real browser | ☐ |
| 6 | Effective cap: raised not exempt; browse card and `/api/seats` agree; ten-tile ceiling | `_gate-guest-whitelist.mjs` E2b/E2c | real HTTP | ☐ |
| 7 | Whitelist identity migration on the production volume | `_migrate-whitelist-identity.mjs` (report mode; `--write` exercised locally) | **not run on prod** — owner action | ☐ |
| 8 | Escrow state machine: 113 illegal transitions throw and write nothing | `_gate-bounty-claim.mjs` A | fixture | ☐ |
| 9 | Ledger integrity: torn tail recovers, interior gap refuses | `_gate-bounty-claim.mjs` J | fixture | ☐ |
| 10 | Evidence gate on release (`evidence_unverified`, `evidence_diverged`) | `_gate-bounty-claim.mjs`; `_gate-capture-hardening.mjs` | fixture | ☐ |
| 11 | Release math: per verified clip + per second, capped, idempotent, platform match separate | `_gate-bounty-claim.mjs` B | fixture | ☐ |
| 12 | Gate H: zero transfer calls in 16 `bounty-*.js`; settlement says NO FUNDS MOVE | `_gate-bounty-claim.mjs` H | static scan | ☐ |
| 13 | Verification ladder: misses authoritative (`NOT_SHOWN`), confidence vs detection rate split, unreadable samples held against our source | `_gate-missed-code-authoritative.mjs` 16/0, `_gate-confidence-split.mjs` 17/0, `_gate-stale-capture.mjs` | fixture (with real misses), preserved real captures | ☐ |
| 14 | Self-capture against a lagging broadcast (freeze window covers the clip) | `_gate-broadcast-delay.mjs` | lagging stub | ☐ |
| 15 | Verification on Twitch (both read paths) | `OPEN-ISSUES.md` 2026-08-30: capture PASS 5/5, external PASS 5/5 | **real broadcast** (operator's channel) | ☐ |
| 16 | Verification on Kick (self-capture) | `OPEN-ISSUES.md` 2026-08-27 run #5: PASS 5/5 | **real broadcast**, before the Pass A freeze-window re-derivation — re-measure | ☐ |
| 17 | Verification on YouTube | `OPEN-ISSUES.md` 2026-09-03: PASS 5/5 | **real broadcast** | ☐ |
| 18 | Verification on pump.fun (both paths) | `OPEN-ISSUES.md` 2026-08-30: PARTIAL 6/7 both paths | **real broadcast**; scaffolding-clip inflation open | ☐ |
| 19 | Verification on X (self-capture only, no fallback) | `2f6e5d4`: PASS 5/5 | **real broadcast** | ☐ |
| 20 | Stream-context gate (warm-up, tail) routes to review, never denial | `_gate-stream-context-http.mjs` | fixture | ☐ |
| 21 | Review queue blocks release until a human resolves | `_gate-bounty-claim.mjs` | fixture | ☐ |
| 22 | Bounty route authorization: policy table diffed against mounted routes both ways | `_gate-bounty-auth.mjs` | real HTTP | ☐ |
| 23 | `BOUNTY_ADMIN_KEY` set in Railway; admin routes answer 200 with it and refuse without | `OPEN-ISSUES.md` (unset as of 2026-08-26) | **owner action** | ☐ |
| 24 | Settlement: **does not exist.** `RealSettlement` must be written, gated, and re-run against rows 8–12 before any of this pays anyone. | `bounty-settlement.js`, `TODO(run-b)` | — | ☐ |
| 25 | OBS one-click and scene check against a real OBS during a real broadcast | `_smoke-obs-overlay.mjs`, `docs/obs-oneclick-checklist.md` | **never run live** | ☐ |
| 25a | Overlay visibility signals (`overlay_hidden` with each of its four reasons, `overlay_scaled_below_floor`) against a real OBS — including which direction real OBS orders `sceneItemIndex` | `_gate-overlay-visibility.mjs` 32/0 | mock only; **never run live** | ☐ |
| 25b | The layout a streamer saves is the layout the broadcast renders, and the badge is never under a tile | `_gate-overlay-layout.mjs` 33/0 (real browser, all 16 origin/direction combinations at the ceiling) | real browser, synthetic seats | ☐ |
| 25c | A layout that would bury the badge is refused on both write paths, and the streamer is told why | `_gate-overlay-layout.mjs` A4–A6, B1–B2 | fixture | ☐ |
| 26 | Browser gates re-run against a fresh build (G0 rule) | **DONE 2026-09-16 (Pass C):** `assertFreshBuild` in `_gate-helpers.mjs`, wired into all eleven, each proven to refuse a stale build | — | ☑ |
| 26a | **The five browser gates that assert against the replaced UI** must be re-pointed before their results mean anything — `_gate-polish`, `_gate-browse-deck`, `_gate-browse-thumb`, `_gate-cam-autoswitch`, `_gate-free-megachat` | none — they are red on a fresh build for UI drift, not staleness | — | ☐ |
| 27 | The whole gate suite from one entry point | none — `OPEN-ISSUES.md` T2: "no single runnable entry point" | **must be built before a launch claim of 'suite green'** | ☐ |

## What leaving stealth changes in these docs

When the app launches: remove the text of `docs/_snippets/pre-launch.md`, run `npm run docs:sync --write` (every page's snippet region empties), record the retest results in the table above, and change this page's first paragraph. The rule is written in `CONTRIBUTING-DOCS.md`.
