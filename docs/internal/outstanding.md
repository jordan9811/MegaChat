# Outstanding

Every known-broken item, open decision and deferred thing, reconciled against `OPEN-ISSUES.md` entry by entry (every `### ` heading and every "open" bullet there was read for this page). Each row says where it is blocked and what would unblock it. Items that `OPEN-ISSUES.md` records as RESOLVED, RETRACTED or SUPERSEDED are not repeated here; the [work history](work-history/README.md) carries them.

Blocked-on codes: **owner** (a credential, an account, a dashboard toggle, a decision), **broadcast** (needs a real stream with the operator present), **engineering** (nothing external needed), **decision** (a product call).

## On the owner

| Id | Item | Where it is blocked | What unblocks it | Source |
|---|---|---|---|---|
| O1 | Run `_migrate-whitelist-identity.mjs --write` against the production volume; entries written before `identityKey` match on handle alone until then | owner | one command on prod data, after reviewing the report-mode output | `_migrate-whitelist-identity.mjs`; [Guest whitelist](../features/guest-whitelist.md) |
| O2 | Set `BOUNTY_ADMIN_KEY` in Railway; admin routes answer 503 until it exists | owner | Railway variable | `OPEN-ISSUES.md`, unchanged since 2026-08-24 |
| O3 | Configure LiveKit Cloud webhooks (`participant_joined`, `participant_left` → `/api/livekit/webhook`); the burn breaker meters zero and is inert without them | owner | Cloud dashboard step | `OPEN-ISSUES.md` L3 (2026-07-25); real delivery was verified once on 2026-07-26 — confirm the setting still holds |
| O4 | Confirm Railway's app-sleep toggle is OFF; a slept container drops `participant_left` and leaves sessions open in the breaker's ledger | owner | dashboard check | `OPEN-ISSUES.md` L7 |
| O5 | Paste a real `OPS_ALERT_WEBHOOK` and fire `POST /api/livekit/burn/test-alert` | owner | one variable, one request | `OPEN-ISSUES.md`, 07-27 "Owner-blocked" |
| O6 | Decide the sub-3 s residual (options written) | decision | the owner's call | `docs/decisions/sub3s-residual.md`; `OPEN-ISSUES.md` P2 |
| O7 | Decide whether MegaChat wants coin-keyed (pump.fun mint) payouts at all | decision | product call | `OPEN-ISSUES.md`, "pump.fun ownership is unsolved" (3) |
| O8 | Decide the two `.claude/worktrees/` scratch branches (one commit ahead each), and the stash `f7219f416b99e59e9188b1cf1e9a988fa6e6fc73` that is not mine | owner | inspect, then keep or drop | `OPEN-ISSUES.md`, "STASHED EDITS" |
| O9 | The bounty admin `/bounty/admin` and its policy table are behind the flag; before any public flag-on, O2 and the retest checklist | owner | [Launch readiness](launch-readiness.md) | — |
| O10 | Flip `OBS_ONECLICK=1` in production only after the owner's real-OBS checklist passes on a real machine | owner | `node _verify-obs-oneclick.mjs` rows 8–14 | `OPEN-ISSUES.md`, "OBS_ONECLICK is off by default" |
| O11 | Set `MODERATION_API_KEY` and `CONTACT_URL` in Railway | owner | two variables | `OPEN-ISSUES.md`, "Pre-existing, unrelated" (07-25) |
| O12 | Two stale worktree registrations (`create-room-ui`, `mc-guest-whitelist`) print `Permission denied` on every commit because OneDrive holds the files | owner | pause OneDrive sync for the folder, then `git worktree prune` | Pass A report; `REPORT-DOCS.md` |

## Needs a real broadcast

| Id | Item | What would settle it | Source |
|---|---|---|---|
| B1 | obs-websocket path against a real OBS during a real broadcast, with verification reading the result | operator live with OBS, `--skip-push`, `_smoke-obs-overlay.mjs` | `OPEN-ISSUES.md`, "The obs-websocket path is still untested against real OBS"; R8 |
| B2 | Kick re-measured on the 75 s / 51 s freeze window | a Kick rehearsal (`_rehearsal-kick.mjs`) — needs `KICK_STREAM_KEY`, `KICK_RTMP_URL` locally | `OPEN-ISSUES.md`, "KICK IS STILL UNPROVEN" → run #5 PASS predates `b3ccf8b` |
| B3 | Twitch "every SECOND code of a window misses" (T5b) — likely subsumed by the overlay polling fix, **to be confirmed, not assumed** | a fresh Twitch broadcast with the refreshed overlay; the 2026-08-30 run (det 1.000) is consistent with it being fixed | `OPEN-ISSUES.md` T5b, "ROOT CAUSE FOUND" |
| B4 | Does pump.fun's playlist outlive the broadcast? Verification runs after the fact | measure after a stream ends | `OPEN-ISSUES.md` T8 |
| B5 | pump.fun self-capture vs external on one broadcast, after the coin-page fix (both columns were the same capture on 08-29; genuinely different on 08-30 — confirm it holds) | re-run `_rehearsal-pumpfun.mjs` | `OPEN-ISSUES.md`, pump.fun P2, "BOTH READ PATHS PROVEN" |
| B6 | Rumble end to end — needs a fresh livestream slot and the watch URL from the address bar while live | operator | `OPEN-ISSUES.md` R5, "Rumble: ingest PROVEN" |
| B7 | `timelineSpreadMs` across several real broadcasts, to decide R1/R2/R3 | several broadcasts on any platform; the value is recorded on every verification now | `OPEN-ISSUES.md` R1–R3 |
| B8 | Kick calibration close to a reliability boundary — how often does an honest Kick streamer land in manual review? | operational tracking | `OPEN-ISSUES.md`, "golden loop" retest, Kick run #5 |

## Engineering, no external dependency

| Id | Item | Source |
|---|---|---|
| E1 | **The bounty badge does not follow the layout origin** — fixed at bottom-left; a `bottom-left` origin stacks tiles over it, breaking the never-over-video invariant and risking an honest streamer's verification. Found by this docs pass. | `public/overlay.html`, `#bounty-badge`; `ROADMAP.md`, "The barcode takes the diagonally opposite corner"; [limitations register](limitations-register.md) L13 |
| E2 | A1: bind X's client-supplied self-capture URL to the X identity; the comment above `captureSourceUrl` saying those platforms "are not claimable yet" is false and load-bearing | `OPEN-ISSUES.md`, adversarial review A1 (high) |
| E3 | A2: one degraded Privy fetch permanently deletes `platformLogins` — the merge must be additive and an empty fetch must never be written | `OPEN-ISSUES.md` A2 (high); `privy-identity.js` |
| E4 | A3: no round-trip test for the widened `recordVerification` whitelist (`detectionRate`, the `timeline*` fields) — partially covered by `_gate-confidence-split.mjs` H after the regression came back once | `OPEN-ISSUES.md` A3; "golden loop" retest |
| E5 | A4: gate E4 asserts against its own copy of the pump.fun live-narrowing; export the real function | `OPEN-ISSUES.md` A4 (low) |
| E6 | `verifiedClips` counts scaffolding (canary, setup) windows — inflates the payout unit | `OPEN-ISSUES.md`, pump.fun P1; "STILL OPEN" under the dead-recorder entry |
| E7 | An open review keeps its original reason and never learns the newer one; reasons should append | `OPEN-ISSUES.md`, P1 (07-29) |
| E8 | `NO_VOD_COVERING_TS` reported for an offline channel in live mode — the wrong classifier branch matches first | `OPEN-ISSUES.md`, P1 (07-29) |
| E9 | Capture storage has no global ceiling across concurrent sessions | `OPEN-ISSUES.md`, repeated since 08-24 |
| E10 | pump.fun manifests (~320 kB, append-only) re-fetched every 2 s poll — size for it or poll slower before enabling the platform | `OPEN-ISSUES.md` P3 (08-25) |
| E11 | Placeholder-stream detection on pump.fun (T6) — the cheap, fail-safe option chosen, not built | `OPEN-ISSUES.md` T6 |
| E12 | Overlay renders "server unreachable" instead of blanking; setup helper prints a countdown (T7) | `OPEN-ISSUES.md` T7 |
| E13 | Log discarded calibration probes and cluster size on every calibration | `OPEN-ISSUES.md`, "Calibration once swallowed an injected DISAGREEMENT" |
| E14 | The stub calibration fixture cannot construct offsets ≥ ~30 s; rebuild by concatenating per-badge segments | `OPEN-ISSUES.md`, calibration P1 |
| E15 | `_rehearsal-run-b.mjs` exits with a libuv assertion after its report | `OPEN-ISSUES.md`, calibration P1 |
| E16 | Contributions with no uploaded clip are refundable (`CLIP_NEVER_UPLOADED`) but nothing sweeps them | `OPEN-ISSUES.md`, 07-27 "Still open" |
| E17 | The platform match has no reversal story; no post-release clawback (designed) | `OPEN-ISSUES.md`, 07-27; `docs/decisions/post-release-clawback.md` |
| E18 | `_gate-mpp-clientpath.mjs` still mirrors the payment path (drift-checked, not converted) | `OPEN-ISSUES.md`, 07-27 |
| E19 | Port the fixed-sleep gates to `startGateServer` (list recorded in W5); lift G0 into the helper and adopt it in eleven browser gates | `OPEN-ISSUES.md` W5; 2026-09-16 |
| E20 | One runnable entry point for the gate suite, with isolation or retry (T2) | `OPEN-ISSUES.md` T2 |
| E21 | `_gate-theme.mjs` reported red for dark mode on 2026-08-26 (T1); not re-checked since the Nerve skin — [U3](needs-a-status-call.md) | `OPEN-ISSUES.md` T1 |
| E22 | The three bounty components (`my-pledges`, `record-flow`, `streamer-page`) render in the pre-Nerve skin; reapply the restyle on top of the lockdown, contributor from the session only | `OPEN-ISSUES.md`, "THE BOUNTY COMPONENTS LOST THE NERVE SKIN" |
| E23 | `_gate-bounty-claim.mjs` section G still uses a fixed sleep and `stdio: 'ignore'` (flaky); port to `startGateServer` | `OPEN-ISSUES.md`, "SECTION G IS A FIXED-SLEEP RACE" |
| E24 | Handles are reassignable by design at the identity layer; every consumer that stores a handle must pin the identity — the durable fix belongs in `identity-store.js` | `OPEN-ISSUES.md`, "A HANDLE IS NOT AN AUTHORIZATION TOKEN" |
| E25 | G4/G5: competing claimants not modelled; MegaChat handles are 3–20 chars against Twitch's 3–25 | `OPEN-ISSUES.md`, "Known gaps still open" (Run A) |
| E26 | Kick OAuth registration validity unproven (a rendering login page proves nothing); needs a full round trip with a real Kick account | `OPEN-ISSUES.md`, P1 (07-29) |
| E27 | The Safari manual fallback for OBS one-click (no loopback mixed-content exemption) is by design; the monitoring toggle applies to the input named *MegaChat Overlay* only | `OPEN-ISSUES.md`, OBS one-click "Open" |
| E28 | Rumble: the harness must read `server_url`/`stream_key` from the live-status API, never env; no Rumble rehearsal harness exists | `OPEN-ISSUES.md`, "Rumble: ingest PROVEN" |
| E29 | `docs/design/copy-bank.md` retired the `/bounty` disclosure; `web/components/bounty/record-flow.tsx` and `web/components/bounty/claim-flow.tsx` still carry sibling preview notices | `docs/ui-overhaul/copy-principles.md`, line 265 |
| E30 | Delete a room from the UI (`deleteRoom` has no caller) | `docs/ui-overhaul/baseline/ideal-paths-local.md` T8 |
| E31 | LiveKit capacity figures remain models, not measurements (L4); no programmatic access to Cloud usage numbers (L2) | `OPEN-ISSUES.md` L2, L4 |
| E32 | `/api/join/mpp` is mounted and gated but unreachable from the join page — retained code or a live mode? ([U1](needs-a-status-call.md)) | `web/lib/join-page.ts`; `server.js` |

## Reconciliation note

`OPEN-ISSUES.md` has 76 `###` entries across 16 runs (as of `03aabc0`). Every open bullet found in it maps to a row above or to a `RESOLVED`/`RETRACTED`/`SUPERSEDED` marker in the file itself. Two items in the file are recorded with both an "open" and a later "resolved" form (L1, L5, L6, G9, P6, the Twitch self-capture claim); the resolved form governs and they are omitted here. New in this pass: E1.
