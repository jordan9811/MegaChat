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
| 13 | Verification ladder: misses authoritative (`NOT_SHOWN`), confidence vs detection rate split, unreadable samples held against our source | `_gate-missed-code-authoritative.mjs` 16/0, `_gate-confidence-split.mjs` 17/0, `_gate-capture-stall.mjs` (a stalled recording is marked stale on its evidence row, never frozen as fresh). **2026-10-24:** `_gate-stale-capture.mjs`, cited here before, replayed the preserved real captures of 2026-08-29; they are gone, and it now fails by design (`OPEN-ISSUES.md` X4). Do not tick on it | fixture (with real misses), a stalling fetch stand-in; no real capture until a stalled one is kept under the repo | ☐ |
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
| 26a | **The browser gates that assert against the replaced UI** must be re-pointed before their results mean anything — `_gate-polish`, `_gate-browse-deck`, `_gate-browse-thumb`, `_gate-cam-autoswitch`. **`_gate-free-megachat` is off this list as of 2026-09-19:** its remaining red was not UI drift but the join page's suggested guest name being appended to rather than replaced (`OPEN-ISSUES.md` P5); it passes 12/0 on a fresh build | none for the remaining four — they are red on a fresh build for UI drift, not staleness | — | ☐ |
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
| 50 | **Producer mode holds:** in an `approve` room an approved MegaChat lands in `ready` and the scheduler never drains it; a mod airing it explicitly is the only way it reaches the stream — with the same clip run through an `auto` room, which airs it unaided, to show the two disagree | `_gate-megachat-producer.mjs` 22/0; the approve → hold → air loop also driven through the real dashboard | real HTTP + real browser, spends nothing | ☐ |
| 51 | **Nothing is held forever:** a clip waiting on a person is refunded at `LETTER_HOLD_TTL_MS`, `review_expired` and `never_aired` kept apart, and the payer made whole | `_gate-megachat-producer.mjs` (a PAID clip seeded into `meta.json` before boot, so the refund is proven with zero spend) | fixture | ☐ |
| 52 | **Clips and the queue survive a restart:** media under `DATA_DIR/letters/media/`, rows in `letters/meta.json`; a clip interrupted mid-playback returns HELD, not replayed, and a row whose media is gone is refunded | `_gate-megachat-producer.mjs`; confirmed live — three clips, a real server restart between them, all three restored with media (`[letters] restored 3 MegaChat(s)`) | real restart, local volume — **not yet on the production volume** | ☐ |
| 53 | **No screen shows a picture that is not the streamer:** the booth's preview and the guest's page show the host's picture only once the booth confirms it moves; OBS's "virtual camera not started" placeholder from the first frame is shown ZERO times on either side (sampled every 100ms, with the probe proven to be watching); a moving picture then appears by itself; a non-OBS still is held and named as a stopped camera; the placeholder mid-session is held within ~1s | `_gate-booth-picture.mjs` A–D, against the real `placeholder.png` from the OBS install | real browser, local SFU, **not yet against a live OBS Virtual Camera** | ☐ |
| 54 | **The live controls rise when someone joins:** seat table, MegaChat queue and booth move above the stream preview the moment a seat exists, and the booth is not remounted by the move (same node, still armed, still on air) | `_gate-booth-picture.mjs` L1–L3 | real browser | ☐ |
| 55 | **Echo: the booth carries the guests.** The booth plays each guest's voice in its tab and claims it only while it really plays; the overlay mutes guest voices on that claim and on nothing else; the setting off, or the booth tab closing, hands them straight back to the overlay; exactly one overlay audio element per guest | `_gate-booth-audio.mjs` E1–E7 | real browser, local SFU — **the cancelling itself is not measured: needs a live session with a speaker, and OBS Desktop Audio capturing the booth's output** | ☐ |
| 56 | **Where the streamer hears guests:** This tab by default (the booth plays live seats only, audio only, with the ordinary canceller, and claims exactly those seats; the overlay mutes exactly those); OBS · headphones and OBS · speakers ('all') hand the guests to the overlay with no silent gap; 'all' refused or throwing → This tab; a mic restart without 'all' gets it back or hands the guests over; a replaced tab stands down; a crashed booth's claim is dropped once the SFU reports the link lost; the FIRST guest is played once (no audio element outside the page); for every guest exactly one of booth/overlay plays them throughout (sampled, with a negative control) | `_gate-booth-audio.mjs` (52/0); `_gate-overlay-first-guest.mjs` (4/0 — the ab8a5f9 overlay fails F2/F3); `_probe-aec-doubletalk.mjs`; `_probe-aec-loopback.mjs` | real browser, local SFU; **what the streamer hears, a real room's echo, and OBS 31's double count in the OBS modes are live-only** | ☐ |
| 57 | **The board's order and its pictures:** nothing live → Recently aired under the featured card, above the rooms, one row, above the fold; live → after the rooms; tiles ≤ 320px; in the first HTML; each finished broadcast with a seat or MegaChat shows a real picture of itself (kept live preview picked from when a guest was on, else the recording thumbnail), a restart neither stretches a seat nor leaves a broadcast open, previews only for owned rooms and cleaned up | `_gate-board-fold.mjs` (29/0; the pre-change build fails F1, F2, F3, F5, F6); `_gate-airing-poster.mjs` (28/0; six mutations each caught) | real browser, fake Twitch; **real Twitch previews against the 12 KB floor and a guest seated under five minutes are live-only** | ☐ |
| 58 | **Board density, the featured tier, and no wallet popup:** ≤ 4 tiles share one row at 300–520px (only where each gets 300px), else ~236px tiles; a big stream (BOARD_BIG_VIEWERS, owner-linked channel only) gets the big card, two share the row; an impostor naming a famous channel gets neither; opening a room or the board never calls window.ethereum; returning MetaMask viewers still registered silently; Privy still becomes ready | `_gate-board-fold.mjs` (108/0; ownership, width-floor and alignment mutations each caught); `_gate-no-wallet-prompt.mjs` (8/0 local; W4 on the deployed site; the pre-change build fails W1, W3) | real browser, fake Twitch, fake wallets; **the owner's real MetaMask + Phantom, and a real big stream, are live-only** | ☐ |
| 59 | **Replays on the room page:** an offline room plays its broadcast's recording 20s before the MegaChat (else the first guest), each moment in the recording that covers it; a kept MegaChat when the recording is gone; the picture when nothing is left; a live room keeps its live player and switches to it when a stream starts; kept clips only for completed plays on proven channels, never bounty, removed on refund or by the owner, served as exactly video/webm with nosniff | `_gate-replay.mjs` (23/0; clip-hook, lead, keep-rule and id-first mutations each caught) | fake Twitch; **Twitch's real player and a real VOD are live-only** | ☐ |
| 60 | **The owner's settings page:** `/dev` opens only for the owner's account (pinned on first use by a linked Twitch login on SITE_ADMIN_TWITCH) and is a plain 404 for everyone else, API included, and for a second account with the same Twitch name; no room can take the handle "dev"; the big-stream threshold features a live stream at once and the follow loop keeps it; the replay days are what the fan is told and never exceeded, a shorter setting, off, or a Reset asks and then deletes kept clips at once; quiet broadcasts (5 min+, proven channel, recording found) appear only when switched on, with a replay from the start | `_gate-site-settings.mjs` (37/0; ten planted defects each caught — `OPEN-ISSUES.md` S7) | fake Twitch, gate-minted accounts; **the owner's own sign-in on megachat.fun is live-only** | ☐ |
| 61 | **No feedback loop through the booth (supersedes row 56's "exactly one of booth/overlay throughout"):** the overlay is never audible for a guest while a booth mic without 'all' is open — sampled from before the first guest, zero samples; This tab plays every live guest in the booth (silent ≤ 3 s at a join); Through OBS hands them to the overlay only on a confirmed 'all'; a stored "OBS · headphones" reads as This tab; a booth with no mic lets the overlay play after 8 s; the howl guard cuts a loop in < 1.5 s, leaves speech alone, cuts a steady whistle once | `_gate-booth-audio.mjs` (52/0; the old overlay rules turn INV-ECHO red); `_gate-howl-guard.mjs` (9/0) | real browser, local SFU, synthetic audio; **the acoustic test on real speakers with real guests is live-only** (`OPEN-ISSUES.md` F7) | ☐ |
| 62 | **Echo found and named; OBS audio checked; no choice to make:** the booth's picker folded away (This tab by default); a guest whose mic sends the host back (speakers or a stream tab up to 30s behind) is warned on their page and named on the booth; a booth whose mic picks up a guest says so with its cure; unrelated talk is never reported (0 in 45 simulated min at 30s of delays); a steady echo never flickers; the OBS check speaks only on positive evidence and offers only fixes that cannot double the audio | `_gate-echo.mjs` (21/0; the first-shipped decision logic false-alarms 8 times in U2; server-drop and booth-never-watches defects each caught) | synthetic speech, local SFU, fake OBS; **real devices and rooms are live-only** (E80) | ☐ |
| 63 | **Railway variables, names only (2026-10-24):** delete or fill `PLATFORM_SETTLEMENT_KEY` and `ESCROW_CONTRACT_ADDRESS`, both present but empty. An empty `ESCROW_CONTRACT_ADDRESS` means the recorded deployment (`contracts/deployments.json`), not off, and both escrow role keys are set: escrow mode is live. **Before filling `PLATFORM_SETTLEMENT_KEY`:** list the PENDING `seat:*:buried:*` intents in `data/settlement.jsonl`, compare each with its seat's once-only refund (the pre-round refund bug recorded several times the real figure), and pay or void each by hand, so the first flush does not pay them blind | `OPEN-ISSUES.md` K8, U2; `seat-escrow.js` `refundedThrough` | **prod; owner action** | ☐ |
| 64 | **Every seat route requires the seat's token:** `POST /api/leave/:seatId`, the LiveKit publisher token, `/api/seat/quality`, `/api/seat/echo`. Today a visitor who reads a seat id from `/api/seats` can end any seat, or publish to LiveKit as a paid guest. Open, HIGH. **Landed 2026-10-24 (integration pass):** all four answer 403 `seat_token_mismatch` without it, and the join page sends it (`web/lib/join-page.ts`, same commit). Retest on the launch build: a bare seat id is refused on each; the seat's own token leaves it | `OPEN-ISSUES.md` U3; `server.js` `seatTokenMatches` (the WebSocket half is done); `_gate-integration.mjs` A8 | **no proof: open** until 2026-10-24; real HTTP since | ☐ |
| 65 | **`AUTH_SECRET` set on Railway** (also step 4 below). It signs everyone out once more, because sessions minted before this round carry no `iat` (`auth.js` `SESSION_MAX_AGE_MS`); every overlay URL becomes keyed, so each streamer re-copies the OBS overlay URL from the dashboard. Check after: a session survives a redeploy | `_gate-auth-secret.mjs` 44/0; `OPEN-ISSUES.md` K7 | **prod; owner action** | ☐ |
| 66 | **Bounty claims use the real identity verifier.** `BOUNTY_IDENTITY_STUB` is unset on Railway (names only; `BOUNTY_IDENTITY_REAL` is inert). On the live URL: a signed-out claim → 401; the channel owner's own sign-in → approved; another account → `REAL_HANDLE_MISMATCH`. **2026-10-24 (harness lane):** the code now refuses the stub on Railway whatever the variable says (`runtime-env.js` `isRailway`; one `[bounty] BOUNTY_IDENTITY_STUB=1 is set on Railway — REFUSED` error line). Keep the names-only check as hygiene; the retest is the boot log showing `PlatformIdentityVerifier` | `_gate-bounty-auth.mjs` section 4 (51/0; 52/0 since 2026-10-24); `_gate-bounty-claim-audit.mjs` I; `bounty-routes.js` `PlatformIdentityVerifier` | real HTTP locally; **the prod retest is an owner action** | ☐ |
| 67 | **YouTube, Rumble and pump.fun handles cannot be claimed** (`REAL_UNSUPPORTED_PLATFORM`) until each platform has an ownership check, the FlockFantasy demo pool included. Retest: a claim on each is refused with that reason | `OPEN-ISSUES.md` R2; `bounty-routes.js` | real HTTP | ☐ |
| 68 | **Stub-era claims reviewed:** every ledger `IDENTITY_CHECK` row with `stubbed: true` on production is voided (`/api/bounty/admin/override`) or rebound by the real owner's re-entry | `OPEN-ISSUES.md` R3; `data/bounty-ledger.jsonl` on the volume | **prod; owner action** | ☐ |
| 69 | **Cash watch-to-earn:** `REWARDS_CASH_ALLOWLIST` set (creator account ids; `*` = every owned room; unset = cash off), with `REWARDS_MAX_EARN`, `REWARDS_MAX_CAP` and `REWARDS_MIN_INTERVAL_S`, BEFORE the reward pool is funded or topped up (~0.07 USDC today). A signed-out viewer earns no cash; the payee is the account's payout wallet | `_gate-rewards-auth.mjs`; `rewards.js` | real HTTP + WebSocket | ☐ |
| 70 | **After the first deploy of this round, read the deploy log:** no `REFUSING WRITES` line (`json-store.js`), no `[lk-webhook] ⚠ metering state` line, no `[lk-session] ⚠ … is <state>` line for its ledger file, no `[env] ` line (`env-num.js`). Each names a damaged file on the volume (repair or move it aside, restart) or a variable that is set but unusable (fix it in Railway) | boot log; `livekit-webhooks.js`, `livekit-activity.js` | **prod** | ☐ |
| 71 | **Migrations at boot:** every boot logs `[migrate]` lines saying what the account and whitelist-identity migrations would change; nothing applies unless `MIGRATE_AT_BOOT` names it. The account migration has not run on production. To apply: set `MIGRATE_AT_BOOT=accounts,whitelist-identity`, deploy, read the `[migrate]` lines; leaving it set is harmless (a second run writes nothing) | `_gate-migrations-boot.mjs` 11/0; `_migrate-accounts.mjs` | fixture; **prod is an owner action** | ☐ |
| 72 | **The default room's password (stores-15):** open the default room's dashboard on production and try `changeme`. If it unlocks, set a real password there; rotating `ROOM_DEFAULT_PASSWORD` never re-hashes a room that has one. Never probe production from an agent | `rooms-store.js` `migrateLegacyRoomPasswords` | **prod; owner only** | ☐ |
| 73 | **Sign-ahead on chain (dust, owner-run):** `_gate-escrow-seat` (escrow deposit, attest, finalize) and `_gate-tempo-phase2` (a signed-ahead outbound transfer), after both send the seat token. Until then sign-ahead is proven against stand-ins only | `_gate-money.mjs` R5, `_gate-escrow-chain.mjs` E1; `OPEN-ISSUES.md` U7, N18 | stand-in; **mainnet dust is the owner's call** | ☐ |
| 74 | **Checksum v2 writer flip,** one deploy after this round ships: write `sumV: 2`, only once this build's reader is the rollback floor (rolling back past it after v2 rows exist stops every money ledger) | `bounty-ledger.js`; `OPEN-ISSUES.md` U6 | engineering, next deploy | ☐ |
| 75 | **Escrow seats across a redeploy:** a seat live during a redeploy is never attested, and at finalize the contract pays the streamer the whole cap. Open, not fixed, and escrow mode is live on production | `OPEN-ISSUES.md` U4; `escrow-chain.js` | **no proof: open** | ☐ |
| 76 | **Decide where Holler refunds come from:** the platform wallet, as today (then account for it as a platform cost, with a cap), or held at the door until the upload lands and refunded from the hold | `OPEN-ISSUES.md` U5; `letters.js` | **decision** | ☐ |
| 77 | **Decide where bounty forfeits go (7(c)):** today the withheld half of a repeat policy rejection goes to the pool of the streamer who rejected it | `OPEN-ISSUES.md` R4; `bounty-claim.config.js` `rejectionRefundFraction` | **decision** | ☐ |
| 78 | **Decide the capture disk budget before real playbacks freeze (bounty-4):** a retention period or a byte cap on `bounty-captures/` (one freeze ≈ 28 MB) | `OPEN-ISSUES.md` R5; `bounty-claim.config.js` `BOUNTY_CAPTURE_RETENTION_MS` | **decision** | ☐ |
| 79 | **A Call in across a deploy (owner-run, live LiveKit webhooks):** join a Call in campaign seat with the camera on while the room is on air; push so Railway redeploys mid-call; rejoin. The rejoin reserves (not `already_claimed`), and 61 s on camera on air makes the claim owed, with one payout intent. Repeat with the stream ended before the rejoin: the old seat's slot is back (claim `eligible`) | `_gate-campaigns.mjs` C11; `campaign-engine.js` | **real broadcast + live LiveKit** | ☐ |
| 80 | **A Call in from the preview (owner-run, live LiveKit):** in an on-air room, join a Call in campaign seat and let the preview run past `minSeconds` without GO LIVE: the claim stays `recorded`, nothing owed. Press GO LIVE and stay on camera `minSeconds`: owed, one payout intent | `_gate-campaigns.mjs` C11.7; `web/lib/join-page.ts` `publishLivekitTracks` | **real broadcast + live LiveKit** | ☐ |
| 81 | **The paid halves of web-2 and web-4 (owner-run, dust):** one MPP join that goes live through a dropped socket (LIVE, the meter and the publish start only on the server's answer), and one paid Holler whose first upload fails, then retries: one payment | `_gate-web-fixes.mjs` J1–J3, J6, L1–L8 (a free room; the stub payment step); `OPEN-ISSUES.md` V12 | mechanism only; **mainnet dust is the owner's call** | ☐ |
| 82 | **One real Privy sign-in on Railway after the deploy** (web-1: the lazy bridge, and Privy's domain allowlist), including a returning session adopted without a modal | `web/components/providers/privy-bridge.tsx`; `OPEN-ISSUES.md` V1 | **prod; owner action** | ☐ |
| 83 | **The Space Mono readouts, signed off by the owner:** 375 px screenshots of the header wallet chip, the on-camera table, the account room link and the OBS URL rows (Space Mono is wider than Jakarta: look for truncation); eyeball the /join, /how-it-works and design-system pages headings | `web/app/globals.css` `--font-mono`; `DECISIONS.md`, the coordinator's calls | screenshots from the fresh build | ☐ |
| 84 | **The campaign screens, before campaigns go public:** `_gate-web-fixes.mjs` (campaign section) after a fresh build; by hand on Railway, a fund that answers `needsApproval` twice comes back as a new approve, not a disabled "Approved" (web-25) | `_gate-web-fixes.mjs`; `web/components/campaigns/approve-step.tsx` | real browser + by hand | ☐ |
| 85 | **After the first deploy of this round:** `/api/health` shows `thisBootAt` later than the push, every `ledgers` entry `ok`, `moneyHalted: null`. In the boot log, read any `[migrate]` line (a report until `MIGRATE_AT_BOOT` names it), any `[visibility] the overlay-visibility chain cannot be read`, any `[env]` line | `server.js` `/api/health`; `OPEN-ISSUES.md` W1; row 70 | **prod** | ☐ |
| 86 | **The SIGTERM flush, from the deploy log:** after a deploy that had held store writes, the log shows `[shutdown] wrote N held store change(s)`. It cannot be proven on this machine: Node on Windows cannot send a child SIGTERM | `json-store.js` `flushPendingWrites`; `server.js`; `OPEN-ISSUES.md` W2 | **prod log** | ☐ |
| 87 | **Reward bounds on a dashboard save:** a room whose cash or credit reward is enabled above `REWARDS_MAX_EARN` / `REWARDS_MAX_CAP` answers 400 `rewards_out_of_bounds` on every save until its amounts are lowered (or the owner raises the bounds). The dashboard's defaults now sit inside them; a room saved earlier with rewards on at the old 0.1 / 5 does not | `dashboard-routes.js`; `web/components/room-provider.tsx`; `OPEN-ISSUES.md` W8 | real HTTP | ☐ |
| 88 | **Owner-run gates changed by reading only:** `_gate-p2-moderation`, `_gate-escrow-seat` and `_rehearsal-run-b` keep their keys by name (`keepEnv`); `_gate-free-megachat`, `_gate-lk-phase1/2/3` and `_gate-p1-features` got a scratch `DATA_DIR`; the dust gates got the seat token. None was run after the change: each one's first owner run is its proof | `_gate-helpers.mjs` `startGateServer`; `OPEN-ISSUES.md` X8, T7 | **owner-run, dust** | ☐ |
| 89 | **Three browser gates drive a room-unlock form that is gone:** `_gate-cam-autoswitch`, `_gate-cohost-booth` and `_gate-lk-phase2` type into `#manage-room-id`, which no page renders (the form is `web/components/room-recovery.tsx` now); `_gate-booth-audio`'s unlock helper is unverified on a fresh build. Their red is not a product result until they are re-pointed | `OPEN-ISSUES.md` X3, P12 | **none: re-point first** | ☐ |
| 90 | **`_gate-stale-capture` is red by design:** its 2026-08-29 captures are gone, and it fails rather than skips. Not a regression, and row 13 no longer rests on it; keeping a real stalled capture under the repo brings it back | `_gate-stale-capture.mjs`; `OPEN-ISSUES.md` X4 | — | ☐ |
| 91 | **The boot log prints the generated demo-room password when `DEMO_ROOM_PASSWORD` is unset:** `server.js` writes the value into the boot line so an operator can find it, which puts a password into Railway's retained logs. Set `DEMO_ROOM_PASSWORD` on the service (the line then prints nothing), or decide the demo room needs no fixed password | `server.js` (demo-room boot block); `OPEN-ISSUES.md` Y7 | **owner: set the variable** | ☐ |

## What leaving stealth changes in these docs

When the app launches: remove the text of `docs/_snippets/pre-launch.md`, run `npm run docs:sync --write` (every page's snippet region empties), record the retest results in the table above, and change this page's first paragraph. The rule is written in `CONTRIBUTING-DOCS.md`.

## Switching on real-money campaigns

The order matters; each step is a gate for the next. Env var names only.

1. The four fix rounds are green: `_gate-campaigns.mjs` 0 fail, `_gate-money.mjs`
   86/0 (38/0 before the 2026-10-24 audit round widened it), and the four attack
   scripts (judge-money/break, break-2, break-3 and break-4, kept in the session
   scratchpad, not in the repo) refuse every attack (`OPEN-ISSUES.md` N, N19–N25).
2. Rotate K1 and K2 (`OPEN-ISSUES.md` K), including `AUTH_SECRET`,
   `X_TOKEN_KEY`, `LIVEKIT_API_SECRET`, `BOUNTY_ADMIN_KEY`.
3. Set `CAMPAIGN_SPENDER_KEY` to a fresh key used nowhere else; fund its address
   with a little USDC for fees; confirm on chain nothing has approved it yet.
4. Confirm: `PLATFORM_SETTLEMENT_KEY` resolves to `SELLER_WALLET_ADDRESS`;
   `TEMPO_CHAIN_ID`, `TEMPO_RPC_URL`, `TEMPO_USDC_ADDRESS` correct;
   `CAMPAIGN_FEE_TOKENS` empty (USDC only); `X_BEARER_TOKEN`, `LIVEKIT_URL`,
   `LIVEKIT_API_KEY`, `DATA_DIR` set; `CAMPAIGN_FUNDING` still unset.
   **`AUTH_SECRET` is REQUIRED** (`OPEN-ISSUES.md` K7; it was unset on
   production until 2026-10-24, and every session cookie was sealed with the
   public dev constant). Without it (and without `MPP_SECRET_KEY`) a
   production server now seals sessions with a per-boot random secret, so
   every restart or deploy signs everyone out, logs
   `[auth] AUTH_SECRET (or MPP_SECRET_KEY) is not set in production`, and
   derives no overlay key at all, so no campaign Holler can count as aired
   (`runtime-env.js`, `overlay-key.js`). Setting it is a one-time cost, said
   to streamers in advance: everyone is signed out once, and every room's
   overlay URL becomes keyed, so each streamer re-copies the OBS overlay URL
   from the dashboard (an OBS scene still on the old URL keeps rendering but
   counts nothing as aired). Setting it also turns on stored X tokens unless
   `X_TOKEN_KEY` is set separately. This round's session change costs the same
   once more: a session now carries `iat` and lasts 30 days (`auth.js`), and
   sessions minted before it carry none, so ship it in the same deploy as the
   secret (retest row 65).
5. Deploy and read the boot log: `[settlement] payout signer ready: <addr>`
   equals `SELLER_WALLET_ADDRESS`; no `CAMPAIGN_SPENDER_KEY … seller key`,
   `unusable` or `PLATFORM_SETTLEMENT_KEY … DISABLED` lines;
   `[campaigns] … funding off`; `/api/health` shows the `/data` volume
   (a lost campaign store strands budgets); after one real LiveKit delivery, no
   `webhook token carries no issue time`.
6. Set `CAMPAIGN_FUNDING=1`, push, poll the live URL until the log says
   `funding ON`. Commit is not ship.
7. One dust campaign end to end, owner-approved ($1): approve, sign, fund, open,
   one Holler, pay, close, refund. Reconcile on chain: Transfer logs creator →
   platform equal `funding.atomic`; payouts + refund + retained x-cost equal
   funded; the spender's allowance from the creator is 0; the door has no
   FAILED rows.
8. On that first dust campaign, also check N18: the `PULL_SENT` row's hash is
   the transaction on the explorer, and the stuck-funding sweep finds its
   Transfer log (neither path has run against the real chain yet).
9. Watch the ledger for `funding-unknown` and `needsPerson` for the first week.

**Corrections from the cold review (round 4, 2026-10-23).** Derived from that
review's findings B1–B5 and its unlock / overlay-key finding; they amend the
steps above.

1. (step 4) Railway runs exactly **one** replica of the service. The lock that
   keeps two campaign pulls from signing one nonce is in-process
   (`settlement.js` `SERIAL_PULL_SLOTS`); a second replica would bring the race
   back, and only the drop rule would clean up after it.
2. (step 4) `AUTH_SECRET` is set. In production without it (or
   `MPP_SECRET_KEY`) there is no overlay key and no campaign Holler can count as
   aired (`overlay-key.js`); step 5's boot log must carry no
   `[overlay-key] … DISABLED` line.
3. (step 4) `CAMPAIGN_FEE_TOKENS` stays empty. A token that delivers less than
   it was asked to move now leaves the campaign `funding_pending` with a
   shortfall for a person; that path has only run against a mock.
4. (step 7) Reconcile the funding from the receipt's **own** logs: one Transfer
   creator → platform equal to `funding.atomic` (= `funding.receivedAtomic`),
   in that transaction, and the receipt's hash equal to the `PULL` row's
   `txHash`. The ledger has no `funding-receipt-foreign`, `funding-short` or
   `funding-unproven` row.
5. (step 8) The `PULL_SENT` row carries the signing `nonce`, equal to the
   explorer's nonce for that transaction, and the `PULL` row has no `nodeHash`.
   Also exercise one Call in: it counts while the room is on air (an open
   airing) and a camera published off air does not (`offAir` on the claim).
6. (step 9) Also watch for `funding-receipt-foreign`, `funding-short`,
   `funding-unproven`, and a `fundingFailures` entry saying a pull "can no longer
   land" (the drop rule ran): each means the chain disagreed with what the
   server expected, and a person should read it.

**The cold review's own list, checked against the derived corrections above
(2026-10-23).** Items 1, 3, 4, 5 and 6 above cover its B1–B5 points. Three it
raised are not above and matter in practice:

7. (step 2) Rotating `AUTH_SECRET` re-derives every room's overlay key
   (`overlay-key.js`): every streamer's OBS link becomes the unkeyed one and
   campaign Hollers silently stop counting until they re-copy the link from
   the dashboard. Rotate it BEFORE the first campaign, and tell every
   streamer with a room to re-copy; the creator view must say the overlay is
   `keyed` before a campaign opens. Rotating `X_TOKEN_KEY` makes stored X
   tokens unreadable, so list members must re-link X or `followedByFromSet`
   falls back to the paid path.
8. (step 4) Confirm the Tempo RPC answers `eth_getLogs` over a 20,000-block
   window; if it refuses, the stuck-funding sweep (`campaign-engine.js`,
   `droppedPullVerdict` and the Transfer-log search it relies on) cannot
   resolve a funding on its own — safe, but every stuck one needs a person.
9. (new, before step 6) Write the "needs a person" runbook: today a
   `funding_pending` campaign flagged for a person (`funding-short`,
   `funding-unproven`, a hash no node knows) is resolved only by the admin
   resolve route or by hand on the production `/data` volume. The runbook
   names who reads it, what to check on the explorer, and which route to call.

**Additions from the audit fix round (2026-10-24).**

10. (step 4) `PLATFORM_SETTLEMENT_KEY` is present but empty on Railway today
    (`OPEN-ISSUES.md` K8). Before it is filled, audit the PENDING buried-seat
    refunds (retest row 63): the first flush pays every PENDING intent.
11. (step 4) One replica also because a Call in's seat check reads
    `activeSeats`, which is per process (`OPEN-ISSUES.md` S7).
12. (step 1) Run `_gate-campaigns.mjs` in full, in the foreground; its C11
    cases cover this round, and its E section accepts Gate H at 38 cases or
    more with 0 failing.
13. (step 9) For the first week after `CAMPAIGN_FUNDING=1`, watch
    `campaign-ledger.jsonl` for repeated rows: one `funding-unknown` per stuck
    funding per reason, one `funding-unconfirmed` per hash
    (`campaign-engine.js` `askPerson`). Many rows for one ref means the
    once-only guard regressed.
