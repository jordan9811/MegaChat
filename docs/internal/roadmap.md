# Roadmap

Every item the repo names as future work, with exactly one status tag and its dependencies. Sources: `ROADMAP.md` (the product spine; "Overlay placement" pinned 2026-09-06), the backlog entries in `OPEN-ISSUES.md`, the design decisions under `docs/decisions/`, `docs/pass-b-handoff.md`, and the "TODO(run-b)" in `bounty-settlement.js`. Nothing here is invented; where the repo is ambiguous the item is `UNCLEAR` and listed on [Needs a status call](needs-a-status-call.md).

## Money

| Item | Status | Depends on | Source |
|---|---|---|---|
| Real settlement (`RealSettlement`): a funded operator wallet, an escrow contract, an idempotent on-chain submit keyed off the ledger row id | `SPECCED` | the retest checklist; Gate H stays zero until then | `bounty-settlement.js`, "TODO(run-b)"; `HANDOFF-BOUNTY.md` B5 |
| Post-release clawback — staged release recommended (hold back ~20% to a maturity date) | `SPECCED` | real settlement | `docs/decisions/post-release-clawback.md` |
| Sub-3 s clip residual — where the money for an unpayable clip goes | `SPECCED` (decision pending, owner) | — | `docs/decisions/sub3s-residual.md`; `OPEN-ISSUES.md` P2 |
| Platform-match reversal when contributor money is refunded | `IDEA` | real settlement | `OPEN-ISSUES.md`, "What the hold-release path does NOT cover" |
| Streamer price floor on bounty pledges (per reserved handle, enforced in both `pledge()` and `contribute()`, own guarded route) | `SPECCED` | a design decision on multi-target pledges | `OPEN-ISSUES.md`, "Bounty: a streamer price floor" |
| Scaffolding clips (canary, setup) excluded from `verifiedClips` | `SPECCED` | — | `OPEN-ISSUES.md`, pump.fun P1 |
| Viewer-count-proportional payout | `IDEA`, and argued against in code | product decision | `OPEN-ISSUES.md` B6 vs `bounty-stream-context.js`, "DELIBERATELY NOT HERE" — the two disagree; the code's position shipped |

## Verification

| Item | Status | Depends on | Source |
|---|---|---|---|
| Kick VOD retry from a streamer-supplied URL (`KickFrameSource` already accepts `vodUrl` + `vodStartMs`) | `SPECCED` | UI to collect the URL | `OPEN-ISSUES.md`, "Kick DOES have VODs" |
| Rumble verification — a readable playback URL | `SPECCED` (blocked on discovery) | a Rumble API that returns a watch URL, or an operator-supplied one | `OPEN-ISSUES.md`, "Rumble: ingest PROVEN, playback URL is the blocker" |
| pump.fun claims — wallet-signature ownership over the coin mint's creator address | `SPECCED` (engineering is one of three parts; the other two are a sanctioned discovery API and a product decision on coin-keyed payouts) | product decision | `OPEN-ISSUES.md`, "pump.fun ownership is unsolved" |
| YouTube / Rumble claim paths (capture is wired; ownership is not) | `SPECCED` | binding the watch URL to the verified identity — required before those claims ship | `OPEN-ISSUES.md`, "The residual, for whoever builds YouTube/Rumble/pump.fun claims" |
| Bind X's self-capture address to the X identity (A1) | `SPECCED` | — | `OPEN-ISSUES.md`, adversarial review A1 |
| Calibration residual vs code validity (R1); `minDetectionRate` from a measured distribution (R2) | `SPECCED` (measure first) | `timelineSpreadMs` across several real broadcasts | `OPEN-ISSUES.md` R1–R3 |
| Placeholder-stream detection on pump.fun (say "your stream appears to be showing a placeholder" rather than "verification failed") | `SPECCED` (option chosen, not built) | — | `OPEN-ISSUES.md` T6 |
| Overlay renders a visible "server unreachable" state instead of blanking | `SPECCED` | — | `OPEN-ISSUES.md` T7 |
| Log discarded calibration probes and surviving cluster size on every calibration | `SPECCED` | — | `OPEN-ISSUES.md`, "Calibration once swallowed an injected DISAGREEMENT" |
| Global ceiling on capture storage across concurrent sessions | `SPECCED` | — | `OPEN-ISSUES.md`, "Capture storage is unbounded" |

## Rooms, seats, overlay

| Item | Status | Depends on | Source |
|---|---|---|---|
| Overlay placement: corner, direction, tile size, gap, editable with a live preview | `SHIPPED` (`94b0a23`) | — | `rooms-store.js` `resolveLayout`; `ROADMAP.md`, "Overlay placement" |
| The bounty badge takes the corner diagonally opposite the tiles, automatically | `KNOWN-BROKEN` — the badge is fixed at bottom-left (`public/overlay.html`, `#bounty-badge`) whatever the layout origin; a bottom-left origin stacks tiles over it | — | [limitations register](limitations-register.md) L13; `ROADMAP.md`, "The barcode takes the diagonally opposite corner" |
| Clamp or warn when `maxSeats × (tile + gap)` exceeds the source height | `SPECCED` | — | `ROADMAP.md`, "Guardrails" |
| Join gating: minimum watch time | `SHIPPED` | — | `checkFeatureGates`, `server.js` |
| Join gating: followers-only, subscribers-only | `SPECCED` — stored, shown as unenforced | platform verification | `ROADMAP.md`; `checkFeatureGates` |
| Reputation-score gate | `IDEA` | — | `ROADMAP.md` |
| Persistent room names | `SHIPPED` (handles, `/<handle>`) | — | `rooms-store.js`, `setRoomHandle` |
| Sybil-resistant bans keyed on wallet + platform identity | `IDEA` | platform identity on seats | `ROADMAP.md` |
| Delete a room from the UI | `SPECCED` (`deleteRoom` exists, no caller) | — | `docs/ui-overhaul/baseline/ideal-paths-local.md` T8 |
| A smaller cap on *simultaneously live* whitelist guests | `IDEA` (the ten-tile ceiling now bounds it) | — | `OPEN-ISSUES.md` W2 |
| Invite-by-link for guests without a claimed handle | `IDEA` | — | `OPEN-ISSUES.md` W3 |
| Follow room state on Kick / YouTube / pump.fun / X | `IDEA` | per-platform liveness APIs | `followTick`, `server.js` (Twitch only) |

## Recent rooms and replays

| Item | Status | Depends on | Source |
|---|---|---|---|
| Resolve a platform VOD onto an airing (`vodUrl`) | `IDEA` — explicitly not built | — | `docs/pass-b-handoff.md`, "Explicitly not built" |
| Switch the poster rule to peak seat count | `SPECCED` — now derivable; not measured whether it disagrees with the midpoint rule | a real capture with both rules compared | `room-poster.js`, "WHICH FRAME" |
| Real chat on the browse board | `IDEA` — no chat infrastructure exists | — | `DECISIONS.md`, "Recon: no chat infra" |

## Stingers, rewards, integrations

| Item | Status | Depends on | Source |
|---|---|---|---|
| Stinger catalogue with a default | `SHIPPED` | — | `public/overlay.html`; `letters.js` `FLY_IN_OK` |
| Stinger marketplace | `IDEA` | — | `ROADMAP.md` |
| Watch-to-earn drops (per room) | `SHIPPED-PARTIAL` — earn/credit exists; credits are in memory and lost on restart | persistence | `rewards.js`, `reward-credits.js` |
| Real Twitch Drops OAuth (credit external watch time) | `IDEA` | — | `ROADMAP.md` |
| Twitch / Kick OAuth for gates and discovery | `SHIPPED` for identity only | — | `auth.js`, "IDENTITY ONLY" |

## Testing and operations

| Item | Status | Depends on | Source |
|---|---|---|---|
| One runnable entry point for the whole gate suite, with isolation or retry | `SPECCED` — "until both are fixed, 'the suite is green' is a claim nobody can actually check in one command" | — | `OPEN-ISSUES.md` T2 |
| Port the fixed-sleep gates to `startGateServer` | `SPECCED` — the list is recorded | — | `OPEN-ISSUES.md` W5 |
| Lift G0 (build freshness) into `_gate-helpers.mjs`; adopt in eleven browser gates | `SPECCED` | — | `OPEN-ISSUES.md`, 2026-09-16 |
| `_gate-mpp-clientpath.mjs` converted from a mirror | `SPECCED` | a funded test wallet | `OPEN-ISSUES.md`, "Still open after this run" (07-27) |
| LiveKit webhooks configured in the Cloud dashboard (breaker inert until then) | owner action — see [Outstanding](outstanding.md) | — | `OPEN-ISSUES.md` L3 |
| Publish the public half to a second GitBook space (`docs-public`) | `IDEA` (call option C of this pass) | the owner's GitBook space | `megachat-pass-b-and-docs.md` |
