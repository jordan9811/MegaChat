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
| 12 | Gate H, legacy section: zero transfer calls in the `bounty-*.js` modules; bounty settlement says NO FUNDS MOVE | `_gate-money.mjs` LEGACY; `_gate-bounty-claim.mjs` H | static scan | ☐ |
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
| 24 | Settlement: **the door exists (E38).** Every server-signed transfer executes only against a recorded intent in `settlement.js`; with no `PLATFORM_SETTLEMENT_KEY` — production today — outbound intents are recorded and stay PENDING. Bounty settlement (rows 8–12) is still the stub. What remains is a funded run: Part 4, an anvil fork of Tempo first, then a capped mainnet confirmation. | `settlement.js`; `_gate-money.mjs` T1, R, K (idempotent, replay-safe, key-later) | fake chain — **never funded** | ☐ |
| 25 | OBS one-click and scene check against a real OBS during a real broadcast | `_smoke-obs-overlay.mjs`, `docs/obs-oneclick-checklist.md` | **never run live** | ☐ |
| 25a | Overlay visibility signals (`overlay_hidden` with each of its four reasons, `overlay_scaled_below_floor`) against a real OBS — including which direction real OBS orders `sceneItemIndex` | `_gate-overlay-visibility.mjs` 32/0 | mock only; **never run live** | ☐ |
| 25b | The layout a streamer saves is the layout the broadcast renders, and the badge is never under a tile | `_gate-overlay-layout.mjs` 33/0 (real browser, all 16 origin/direction combinations at the ceiling) | real browser, synthetic seats | ☐ |
| 25c | A layout that would bury the badge is refused on both write paths, and the streamer is told why | `_gate-overlay-layout.mjs` A4–A6, B1–B2 | fixture | ☐ |
| 26 | Browser gates re-run against a fresh build (G0 rule) | **DONE 2026-09-16 (Pass C):** `assertFreshBuild` in `_gate-helpers.mjs`, wired into all eleven, each proven to refuse a stale build | — | ☑ |
| 26a | **The five browser gates that assert against the replaced UI** must be re-pointed before their results mean anything — `_gate-polish`, `_gate-browse-deck`, `_gate-browse-thumb`, `_gate-cam-autoswitch`, `_gate-free-megachat` | none — they are red on a fresh build for UI drift, not staleness | — | ☐ |
| 27 | The whole gate suite from one entry point | none — `OPEN-ISSUES.md` T2: "no single runnable entry point" | **must be built before a launch claim of 'suite green'** | ☐ |
| 28 | **Banking:** a pledged clip buried under a hidden overlay is QUEUED, replays once the overlay is back at one clip per 20 s with a fresh per-playback code, and refunds with `BANKED_CLIP_EXPIRED` at stream end + tail or the 12 h cap | `_gate-bank-and-seats.mjs` A–E, H1–H7 | fixture + real HTTP | ☐ |
| 29 | **One payable airing per pledge:** the same pledge verified twice pays once; two pledges pay twice; the old arithmetic paid twice | `_gate-bank-and-seats.mjs` F1–F6; the old-vs-new run recorded in `OPEN-ISSUES.md` (Pass C Session 2) | fixture | ☐ |
| 30 | **Seat escrow:** the meter stops while hidden, buried seconds refund backdated with the detection lag charged to the platform, 80/20 sweep, holdback matures after 72 h, clawback ≤ holdback, `SOURCE_UNAVAILABLE` claws nothing — and since E38 the bucket's intents are the money: ticks land in the platform wallet and every sweep, refund and maturity reaches the door | `_gate-bank-and-seats.mjs` G1–G8, J1; `_gate-money.mjs` E1–E3 (a sweep and a maturity arrive as intents for exactly the ledger's figures, paid once) | fixture + fake chain | ☐ |
| 31 | **Manual-paste hold:** a room with no visibility signal sweeps at stream end + 10 min, capped at 24 h, and the manage page says why | `_gate-bank-and-seats.mjs` G7; `web/components/overlay-health-card.tsx` | fixture | ☐ |
| 32 | **Review causes:** banked, scaled-below-floor (own words), bank expiry, seat clawback and seat could-not-look are each named, never silent | `_gate-bank-and-seats.mjs` H6, H9–H11 | real HTTP | ☐ |
| 33 | **Gate H, three tiers (E38):** every server-side transfer-shaped call lives in `settlement.js` and the door refuses, dedupes, reconciles and retains as specified; the MPP settlement schedule is configured in one place; the client-signed and operator-run call sites match the pinned map; the Arc-era /index.html and its bundle answer 404; each tier proven to discriminate on a synthetic offender; the legacy bounty scan kept as the first section | `_gate-money.mjs` 36/0 | static scan + fake chain + real HTTP | ☐ |
| 34 | **First airing (E37):** an approved pledged clip reaches a REAL overlay with only the dispatcher driving it, opens a window with a fresh per-playback nonce, `markPlayed` fires, and verification counts the playback | `_gate-first-airing.mjs` C1–C8 (real browser overlay on the room-keyed URL) | real browser | ☐ |
| 35 | **The session is bound to a room:** opened the way the claim page opens it (no room id) it still binds — to the streamer's own room, never the shared default — and a room owned by someone else is refused | `_gate-first-airing.mjs` B1–B4 | real HTTP | ☐ |
| 36 | **The meter pause, driven (L35):** a points-funded seat ticks under the real loop, stops on `overlay_hidden`, resumes on `overlay_visible` with a resume, a buried-seconds refund and a sweep, and is never kicked | `_gate-meter-pause.mjs` 14/0 | real HTTP + WebSocket, points | ☐ |
| 37 | **Points seats tick in points (E42):** the old seat record priced them in USDC atomics and kicked every one on its first tick; the same gate step failed with 0 ticks before the fix and passes with 3 after | `_gate-meter-pause.mjs` step 3; `OPEN-ISSUES.md` E42 (the pre-fix trace) | real HTTP | ☐ |
| 38 | **Credit- and points-funded intents are RETAINED (E43):** never a payable USDC intent from the platform wallet | `_gate-money.mjs` T1 (E43); `_gate-meter-pause.mjs` 5b (the refund at the door, read from disk) | fake chain + real HTTP | ☐ |
| 39 | **The door on the deployed build:** with the key unset, the boot log says `[settlement] door open — pull:true payout:false` and no outbound row is ever SENT; with the key set, the first flush pays each PENDING intent exactly once | boot log; `data/settlement.jsonl` on the volume | **prod; the key is an owner action** | ☐ |
| 40 | **The escrow contract refuses every adversarial move:** finalize early, attest after finalize, oversized attestation (clamped), any attestation that would favour the streamer, duplicate deposit, over-refund, non-streamer refund, ineligible / duplicate / forged flags, a second escalation; a stranger's finalize pays the streamer; server silence strands nothing; reentrancy has no hook to enter through; the full lifecycle balances match the ledger to the atomic unit | `_gate-escrow-contract.mjs` 60/0 | **Moderato testnet**, real precompiles, throwaway faucet keys | ☐ |
| 41 | **A live seat through the escrow on mainnet (Session 2):** terms name the contract, the cap is deposited at join, the seat meters off-chain with zero pulls, a bury pauses the meter, the attester writes the ledger figures, the sweeper finalizes after the deadline, the streamer receives exactly (consumed − hidden) × rate and the viewer the rest, the door never pays | `_gate-escrow-seat.mjs` 29/0, steps 3–8 | **mainnet dust** (0.05 cap, 0.01 to the streamer), real OBS signals still mocked (25a) | ☐ |
| 42 | **The direct fallback:** an escrow that fails preflight makes terms name the seller key, every tick is a real pull viewer → the streamer's payout address, the seller wallet gains nothing, no escrow rows, no door intents | `_gate-escrow-seat.mjs` 29/0, steps 9–11 | **mainnet dust** (7 ticks, 0.007) | ☐ |
| 43 | **The hard stop:** a room with no payout address is refused with `409 no_payout_address` in escrow mode AND in direct mode — never a silent fallback to the platform wallet | `_gate-escrow-seat.mjs` step 2 | real HTTP | ☐ |
| 44 | **Gate H, two doors:** every server-side transfer-shaped call lives in `settlement.js` or `escrow-chain.js`; the escrow door writes through one function with the fee token explicit; `server.js` itself never signs; a transfer added anywhere else is still flagged | `_gate-money.mjs` 38/0 | static scan | ☐ |
| 45 | **Door transfers pay their fee (E49):** `transfer` / `transferFrom` name their fee token and every server signer is built on viem's Tempo chain; proven by the direct fallback's pulls landing on mainnet | `_gate-escrow-seat.mjs` step 11 | **mainnet dust** | ☐ |
| 46 | **The canonical account:** a first sign-in creates one account; a second provider attaches to it rather than minting a person; a platform login already linked elsewhere is refused and nothing moves; switching primary leaves the handle, the /username link, the room slug and the overlay URL unchanged; the room stays owned by the account id | `_gate-identity-account.mjs` 49/0, sections A–D | mock IdP through the real OAuth routes | ☐ |
| 47 | **The handle cannot be squatted:** moving a handle leaves the old one reserved to the same account, a stranger's claim is refused, and only an explicit release frees it — with the old rule replayed alongside to show they disagree | `_gate-identity-account.mjs` section E | fixture | ☐ |
| 48 | **Attributes never block a sign-in:** a failed profile fetch leaves `attributes: null` and the account is still created; attributes are captured in the same OAuth round trip when it succeeds | `_gate-identity-account.mjs` sections F–G | mock IdP | ☐ |
| 49 | **The classifier lands every tier with its reasons, is pure, and checks the allowlist first** | `_gate-identity-account.mjs` section H, 10 fixtures | fixture | ☐ |
| 36 | **A first airing into a hidden overlay banks** rather than vanishing, and the pledge still pays exactly once however it got on air | `_gate-first-airing.mjs` D3, C11, E1–E2 | real browser + HTTP | ☐ |

## What leaving stealth changes in these docs

When the app launches: remove the text of `docs/_snippets/pre-launch.md`, run `npm run docs:sync --write` (every page's snippet region empties), record the retest results in the table above, and change this page's first paragraph. The rule is written in `CONTRIBUTING-DOCS.md`.
