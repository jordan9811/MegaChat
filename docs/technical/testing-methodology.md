# Testing methodology

MegaChat is verified by **gates**: standalone scripts that stand up real infrastructure, assert behaviour, print `PASS`/`FAIL` per assertion and a `RESULT` line, and exit non-zero on any failure. The convention is written down in `AGENTS.md` ("Gates over claims. Behaviour is proven by a `_gate-*.mjs` script that runs against real infrastructure, not asserted in a commit message. If you change behaviour, extend the gate."). There is no unit-test framework. At the repo root there are 101 `_gate-*.mjs` files (96 gates and 5 shared modules), 17 `_verify-*.mjs`, 6 `_rehearsal-*.mjs`, 1 `_setup-*.mjs` and 2 `_diag-*.mjs` scripts, and 8 more in `scripts/`; the [gate catalogue](#gate-catalogue) below lists every one of them with what it costs to run. **Some of them spend real money or LiveKit Cloud minutes, or go live on the owner's channels: read the [owner-run list](#owner-run-only) before running anything.**

## What a gate is

Each gate is self-contained: it sets `DATA_DIR` to a scratch directory, imports the modules under test directly for server-side sections, and for HTTP or browser sections spawns `node server.js --prod` on a private port and drives it — with real Chrome through `puppeteer-core`, a real local LiveKit SFU for media gates, real `ffmpeg` for capture and poster gates, and mainnet dust for the payment legs (`_gate-lk-phase1.mjs`, `_gate-tempo-phase2.mjs`, `_gate-room-poster.mjs`, headers). Money gates say so in their first line ("REAL MAINNET MONEY", `_gate-tempo-phase2.mjs`).

## The standards, and what each one caught

Every rule below exists because a gate once passed for the wrong reason. The incident is cited; the rule is the fix.

| Standard | Incident | Where it lives now |
|---|---|---|
| **Spawn a server you can trust is yours.** Port precheck, early-exit watch, readiness poll instead of a blind sleep, and a nonce echoed by `/api/health` so the responder is provably the process just started. The precheck connects on 127.0.0.1 and ::1, so a server bound on every address counts as a holder. | A three-day-old zombie held the port; every later gate died on `EADDRINUSE` with `stdio: 'ignore'` swallowing it, drove the stale process, failed 6/4 for days and was written off as "pre-existing" (`dfb7a38`; `63ccf45`). The precheck that followed bound 127.0.0.1 only, which Windows allows beside a running `server.js`, so it never saw one (audit harness-3, 2026-10-24). | `_gate-helpers.mjs`, `startGateServer`; `_verify-gate-harness.mjs` creates each failure, the old probe beside the new one |
| **A gate server holds no live key.** Every name in `SENSITIVE_ENV`, and every name ending `_KEY`, `_SECRET`, `PRIVATE_KEY` or `TOKEN` in the gate's environment or `.env`, starts blank in the child; a gate that needs a real one names it in `keepEnv`, which makes it an owner-run gate. | The child inherited every key in `.env`: signers, LiveKit Cloud, the moderation key, the platform secrets. `_gate-first-airing.mjs` asked the real Twitch API about a fixture streamer on every run, and its review case depended on the answer (audit harness-9, 2026-10-24). | `_gate-helpers.mjs`, `SENSITIVE_ENV` and `startGateServer`; `_verify-gate-harness.mjs` case 5 |
| **A browser gate is only as fresh as the last build.** Refuse to judge a page rendered from a `web/.next` older than the newest source under `web/`, or than the build config. | `_gate-bounty-claim` reported green for two weeks on a line the merged source no longer produced, because the `.next` on disk predated the merge (`OPEN-ISSUES.md`, 2026-09-16, "GREEN AGAINST A STALE BUILD"). | `_gate-helpers.mjs`, `assertFreshBuild`, which watches `web/app`, `web/components`, `web/lib` and `web/next.config.mjs`, `web/postcss.config.mjs`, `web/tsconfig.json`, `web/package.json`. Every gate that renders a Next page calls it before it boots anything (the Build check column of the catalogue). |
| **Prove a test discriminates by running the old behaviour alongside.** A fix's gate replays the pre-fix ladder inline and asserts the two disagree. | Without it a "fix" that changes nothing passes the same. | `_gate-missed-code-authoritative.mjs` (old ladder vs `NOT_SHOWN`); `_gate-decoder-codes.mjs`; `561a9ce` ("proven by regression") |
| **Stubs must lag like a broadcast.** Every HLS stub published instantly; three delay-dependent bugs passed green for a month. | `OPEN-ISSUES.md`, the 2026-08-26 real-broadcast entries; the freeze-window derivation in `bounty-claim.config.js`. | `_gate-broadcast-delay.mjs` |
| **A fixed corpus hides what it holds fixed.** The badge corpus used one code and hid a ~50% miss rate at 720p. | `5ebd643`; `OPEN-ISSUES.md`, "the corpus measured one code". | `_gate-decoder-codes.mjs` sweeps codes |
| **A dead recorder is not an absent badge.** | A stalled capture ring was scored as the streamer failing to show the badge (`OPEN-ISSUES.md`, 2026-08-29, FIXED). | `_gate-capture-stall.mjs`. `_gate-stale-capture.mjs` held the second half on the real 2026-08-29 capture files; those files are gone from this host, so it FAILS (it used to skip) until a real stalled capture is kept under the repo. |
| **Authorization is structural.** Every bounty route registers through a guard that looks the path up in a policy table and throws on an unknown one; the gate diffs the mounted routes against the table. | Routes had been added without deciding who could call them (`74291c8`). | `bounty-auth.js`; `_gate-bounty-auth.mjs` |
| **Gates authenticate like a user.** Credentials for a gate are minted the way a streamer's are — a sealed identity cookie — never a test-only bypass in the auth path. | "a test-only escape hatch in the auth path is the thing that later…" (`_gate-helpers.mjs`, `mintBountyAuth`). | `_gate-helpers.mjs`, `_gate-identity-helper.mjs` (which seals with the gate's own secret or refuses; it no longer falls back to the public dev constant). The one remaining escape hatch, `BOUNTY_IDENTITY_STUB=1` (the claims of the files marked **stub** below), is refused on a Railway box: `bounty-routes.js` with `runtime-env.js` `isRailway()`, proven in `_gate-bounty-claim-audit.mjs` case I. |
| **Gate H: every transfer is accounted for.** Until 2026-09-17 this row read zero transfer calls in the bounty modules — a scan of the sixteen `bounty-*.js` files and nothing else, so every green Gate H in the history below meant only that the bounty feature is inert, never that the money which actually moves (seat ticks, seat and MegaChat refunds, reward payouts, the MPP channel settle) was accounted for. That scan is kept as the LEGACY section. The gate now has three tiers, described under [Gate H: three tiers](#gate-h-three-tiers). | E38 (`OPEN-ISSUES.md`, 2026-09-18): the old row implied coverage it never had. | `_gate-money.mjs`; `_gate-money.pins.mjs`; `_gate-bounty-claim.mjs` section H (the legacy scan, still run) |
| **Real broadcasts are the arbiter.** A synthetic pass is a claim; the first real broadcast found two P0s that nothing else could (`347ac4b`). | Twitch, Kick, pump.fun, YouTube and X each have a real-broadcast entry in `OPEN-ISSUES.md` with what it found. | The rehearsal harnesses (`ca7970c`, `736f0f9`, `d40276d`) |

## Gate H: three tiers

Every transfer the app can cause falls into one of three tiers, and the gate says for each what it proves and what it cannot (`_gate-money.mjs`, header). Until 2026-09-17 Gate H was a scan of the sixteen `bounty-*.js` modules and nothing else (E38, `OPEN-ISSUES.md`, 2026-09-18).

| Tier | What moves | What the gate proves | What it cannot prove |
|---|---|---|---|
| **1 — server-signed** | The per-tick seat pull into the platform wallet; seat sweeps, buried-seconds refunds, clawbacks and holdback maturities; MegaChat refunds; reward-pool payouts; the MPP channel settle | Every transfer-shaped call in the server modules lives in one file, `settlement.js`, and that file executes only against a recorded intent keyed by `ref`: no ref is refused, the same ref twice is one intent, flush twice transfers once, a restart reconciles a SENT row by receipt instead of re-sending, a reverted send is FAILED and never retried, and with no payout key every intent is recorded and stays PENDING. An intent whose token has no address (earned credit, points) is RETAINED, never signed (`_gate-money.mjs` T1, R, K, E). | That the chain did what the receipt says; that the platform wallet is funded. |
| **2 — autonomous** | The MPP SDK settles a channel on the schedule it is handed; there is no call site in our source | The schedule is configured in exactly one file, `meter-mpp.js`; a schedule configured anywhere else fails the scan (`_gate-money.mjs` T2) | It cannot see the settle happen. This tier is a config assertion and says so (register L36). |
| **3 — client-signed and operator-run** | A viewer's session-cap approve and channel open in their own wallet; the dust-spending gates' and probes' own transfers | The SET of call sites is pinned: `_gate-money.pins.mjs` counts transfer-shaped names per file and the gate diffs the count against a map committed in `_gate-money.mjs`; a new site or a new file fails until someone updates the pin on purpose (`_gate-money.mjs` T3) | Anything about behaviour. The server does not hold these keys, so no server door can mediate them (register L37). |

Each tier's discrimination is proven inside the gate by running the scanner over a synthetic offender and requiring it to fail (`_gate-money.mjs`, the DISCRIMINATES assertions). The legacy assertion — zero transfer-shaped calls across the bounty modules, bounty settlement still the stub — is the gate's first section and still runs on every pass (`_gate-money.mjs` LEGACY; `_gate-bounty-claim.mjs` H).


## What green means, and what it does not

- A gate that passes proves the assertions it makes against the infrastructure it stood up. It does not prove the deployed build: **commit ≠ ship** (`AGENTS.md`), and the deploy is confirmed by polling the live URL for a marker only the new build carries.
- A gate is only as good as its stub. The methodology's own record shows stubs hiding delay bugs, a corpus hiding a decoder bug, and a stale build hiding a copy regression. The pages in this handbook therefore say *fixture*, *rehearsal* or *real broadcast* for every proof, never just "tested".
- Green on a **merged** tree is the requirement before merging; green on a branch is not transferable (the Pass A rule, `megachat-pass-a-prompt.md`).

## The docs are part of the chain

Three scripts run with the gates on every docs change and are documented as methodology because they encode the same idea — claims need a source:

- `npm run docs:check` — a claim keyword with no citation nearby fails on an authored page (`scripts/docs-check.mjs`).
- `npm run docs:sync` — cited source sections are hashed; a page whose sources changed since the last sync is flagged; embedded interface regions are refreshed from source with `--write` (`scripts/docs-sync.mjs`).
- `npm run docs:gitbook-check` — the table of contents, links, assets and public/internal boundary are validated (`scripts/docs-gitbook-check.mjs`).

## Running the gates

Each is `node _gate-<name>.mjs`; a few have npm aliases (`package.json`, `gate:*`). Run every gate in the foreground (puppeteer gates fail from a background task) and one at a time unless the [ports](#ports-that-collide) say otherwise. Browser gates need Chrome at `C:/Program Files/Google/Chrome/Application/chrome.exe` (`_gate-bounty-claim.mjs`, `puppeteer.launch`) and a fresh `npm run build`; each refuses a stale build itself. Media gates need a local LiveKit SFU on :7880 (`tools/livekit-server.exe --dev`), except `_gate-booth-audio.mjs`, which starts and kills its own and refuses to run if :7880 is already held, because its S10 restarts the SFU mid-call. Before running anything, check the [owner-run list](#owner-run-only): those spend money or minutes or go live, and an agent never runs them.

A server booted by `startGateServer` (`_gate-helpers.mjs`) starts with every live key blank, so an HTTP gate cannot reach a funded signer, LiveKit Cloud, the moderation endpoint or a platform API unless it names the key in `keepEnv` (register L40, closed 2026-10-24). The two money gates that spend nothing are `_gate-money.mjs` (the door against a counting fake chain) and `_gate-meter-pause.mjs` (a seat that pays in points). A gate that spawns `server.js` itself (Boot **bare spawn** in the catalogue) does not get that protection; every one outside the owner-run list either names the local SFU or blanks LiveKit by hand (`LIVEKIT_URL: ''`), so `rooms-store.js` reading LiveKit lazily cannot move its rooms onto LiveKit Cloud. Moving them to `startGateServer` is an open item.

## Gate catalogue

Every harness file at the repo root (`_gate-*`, `_verify-*`, `_rehearsal-*`, `_setup-*`, `_diag-*`) and in `scripts/`, from a static read of each file on 2026-10-24 (the audit's `gate-manifest.json`, regenerated after that day's fixes). **Read the Cost column before running anything.**

- **Cost:** *free* means local only. *MAINNET* means it signs real transfers on Tempo mainnet. *LK Cloud, prod* means it uses LiveKit Cloud minutes on the production project. *third party* means real third-party HTTP, a testnet, a real broadcast on the owner's channel, or the owner's real OBS.
- **Boot:** *startGateServer* is the shared harness (scratch data dir, readiness poll, nonce, no live keys). *bare spawn* means it spawns `server.js` itself, with a fixed sleep and no identity check. *hand-started server* means it drives whatever already answers on its port. *in-process* means it imports modules directly.
- **Data:** *scratch* is a temp dir. *repo data/* means it reads or writes the repo's real `data/`. *that server's* means whatever the hand-started server uses.
- **Auth:** *real* means minted credentials (`mintBountyAuth` or a sealed session) or a real OAuth round trip. *stub* means claims go through `BOUNTY_IDENTITY_STUB=1`, the auto-approve identity stub (refused on Railway).
- **Build check:** *yes* means it refuses a `web/.next` older than its source (`assertFreshBuild`). *-* means it renders no Next page.
- **Status:** *live* loads and targets current code. *stale* asserts something the product no longer does. *unknown* needs hand-started or external state that was not checked.

Rules that follow from the table:
- An owner-run row runs only with the owner present, and not from an agent.
- A **bare spawn**, **repo data/** or **stale** cell is a defect to fix, not a property to preserve.
- A new gate takes a port no other row lists and adds its own row.

<a id="owner-run-only"></a>
### Owner-run only (23)

These spend money or minutes, go live on the owner's channels, touch the owner's OBS, or are meant to stay running. They run only with the owner present, and not from an agent.

| File | What it proves | Cost | Boot | Data | Auth | Ports | Build check | Status |
|---|---|---|---|---|---|---|---|---|
| `_gate-escrow-seat.mjs` | a live seat through the escrow contract, END TO END ON TEMPO MAINNET. | **MAINNET** | startGateServer | scratch | real | 3331, 3332 | - | live |
| `_gate-free-megachat.mjs` | free-room MegaChat send, end to end through the REAL UI: open stage → record (synthetic cam+tone) → Send → upload → queued. | third party | **bare spawn** | scratch | - | 3221 | yes | live |
| `_gate-lk-phase1.mjs` | LiveKit Phase 1: core pipeline, against a REAL local SFU (tools/livekit-server.exe --dev on :7880) + REAL mainnet meter dust. A. flag… | **MAINNET** | **bare spawn** | scratch | - | 3215, 3216, 7880 | yes | **unknown** |
| `_gate-lk-phase2.mjs` | LiveKit Phase 2: return feed + letter parity, real local SFU + real mainnet dust for the letter payment. A. host token auth:… | **MAINNET** | **bare spawn** | scratch | - | 3215, 7880 | yes | **stale** |
| `_gate-lk-phase3.mjs` | LiveKit Phase 3: reconnect grace + quality + simulcast. Real local SFU + real mainnet meter dust. The joiner's network is killed for ~5s… | **MAINNET** | **bare spawn** | scratch | - | 3215, 7880 | yes | **unknown** |
| `_gate-mpp-clientpath.mjs` | MPP client path over a WALLET-SHAPED provider (the bug Privy exposed). The join page builds its mppx session over the wallet's EIP-1193… | **MAINNET** | **hand-started server** | that server's | - | 3211 | - | **unknown** |
| `_gate-p1-features.mjs` | POLISH P1: per-feature pricing + gates. Real mainnet dust. A. MegaChats-only room: joins 403, join page hides the live path, the… | **MAINNET** | **bare spawn** | scratch | - | 3220 | yes | **unknown** |
| `_gate-p2-moderation.mjs` | POLISH P2: AI moderation for MegaChats. REAL MAINNET PAYMENTS — three 0.01 USDC MegaChats from TEST_VIEWER_KEY per run, this gate spends… | **MAINNET** | startGateServer | scratch | - | 3221, 3222, 3997 | - | live |
| `_gate-phase3-letters.mjs` | MEGA Phase 3: letter mode. REAL MAINNET DUST for the payment leg. A. auto-play room: record a real webm in a browser (canvas+oscillator… | **MAINNET** | **hand-started server** | that server's | - | 3212 | yes | **unknown** |
| `_gate-polish.mjs` | FIX + POLISH pass, all seven items, on the real built app. 1. tx errors: viem InsufficientBalance wall → ONE clean sentence with… | **MAINNET** | **bare spawn** | scratch | real | 3218 | yes | live |
| `_gate-tempo-phase2.mjs` | Tempo migration Phase 2 (MPP session meter). REAL MAINNET MONEY (dust prices: 0.001 USDC.e per second, cap = min(balance, 2)). Drives a… | **MAINNET** | **hand-started server** | that server's | - | 3000 | - | **unknown** |
| `_gate-tempo-phase3.mjs` | Tempo migration Phase 3 (feature parity sweep). REAL MAINNET, dust. Full flow: create room (password) → per-room auth → payout wallet… | **MAINNET** | **hand-started server** | that server's | - | 3000 | - | **unknown** |
| `_rehearsal-kick.mjs` | KICK DRESS REHEARSAL — one command, one real Kick broadcast, a real verdict. | third party | startGateServer | scratch | **stub** | 3308 | - | **unknown** |
| `_rehearsal-pumpfun.mjs` | PUMP.FUN DRESS REHEARSAL — one command, one real broadcast, a real verdict. | third party | startGateServer | scratch | **stub** | 3309 | - | **unknown** |
| `_rehearsal-rumble.mjs` | RUMBLE DRESS REHEARSAL — one command, one real broadcast, a real verdict. | third party | startGateServer | scratch | **stub** | 3310 | - | **unknown** |
| `_rehearsal-run-b.mjs` | DRESS REHEARSAL — the full Run B loop against a REAL Twitch broadcast, one command, unattended: node _rehearsal-run-b.mjs | third party | startGateServer | scratch | real | 3306 | - | **unknown** |
| `_rehearsal-x.mjs` | X (TWITTER) DRESS REHEARSAL — one command, one real X broadcast, a real verdict, on the platform with the LEAST room for error. | third party | startGateServer | scratch | **stub** | 3312 | - | **unknown** |
| `_rehearsal-youtube.mjs` | YOUTUBE DRESS REHEARSAL — one command, one real YouTube broadcast, a real verdict. | third party | startGateServer | scratch | **stub** | 3313 | - | **unknown** |
| `_setup-overlay.mjs` | OVERLAY SETUP HELPER — keeps a badge on screen so the operator can SEE it. | free | startGateServer | scratch | **stub** | 3309 | - | live |
| `_verify-obs-oneclick.mjs` | OWNER'S WALKER — the real-OBS five-minute checklist, as assertions. | third party | in-process | - | - | - | - | **unknown** |
| `_verify-webhook-delivery.mjs` | TASK 2 — verify real webhook delivery end to end against PRODUCTION. | **LK Cloud, prod** | **production** | - | - | - | - | live |
| `scripts/deploy-escrow.mjs` | Deploy contracts/MegaChatEscrow.sol and record the deployment. | **MAINNET** | in-process | - | - | - | - | live |
| `scripts/fund-escrow-roles.mjs` | Send a small amount of the escrow token from the seller wallet to an escrow role wallet so it can pay gas. | **MAINNET** | in-process | - | - | - | - | live |

These root scripts outside the catalogue's file patterns belong with them:

- `_cloud-idle-measure.mjs`: measures idle burn against LiveKit Cloud.
- `_smoke-obs-overlay.mjs`: talks to the owner's real OBS.
- `_probe-pumpfun.mjs`: opens real pump.fun streams.

A gate that is owner-run because it needs a real key names that key in `keepEnv`: `_gate-p2-moderation.mjs` (the seller signer), `_gate-escrow-seat.mjs` (the seller and both escrow role signers), `_rehearsal-run-b.mjs` (the Twitch client secret). The other rehearsals and `_verify-calibration-real-vod.mjs` pass their platform credential explicitly in `env`.

Retired on 2026-10-24 and deleted (named without their extension here, since they no longer exist to cite): `_gate-phase1`, `_gate-phase2` and `_gate-ui-part-a` (they asserted the Arc chain, the passkey bundle and the pre-Next dashboard, and left a live `server.js` behind on the repo's `data/`; their `gate:phase2` and `gate:ui-a` aliases went with them), `_gate-gas-floor`, `_gate-pin`, `_gate-stability` and `_verify-join` (they imported Arc fee helpers `token-utils.js` no longer exports, so none of them could load), and `scripts/probe-tempo-write` (a one-time mainnet signer probe with no confirmation flag).

### Shared modules, not gates (5)

| File | What it proves | Cost | Boot | Data | Auth | Ports | Build check | Status |
|---|---|---|---|---|---|---|---|---|
| `_gate-helpers.mjs` | SHARED GATE HARNESS — spawn a server you can TRUST is the one you started. | free | in-process | scratch | real | - | - | live |
| `_gate-identity-helper.mjs` | Mint a REAL sealed mc_identity cookie for gates. | free | in-process | - | real | - | - | live |
| `_gate-mock-obs.mjs` | MOCK obs-websocket v5 SERVER — shared by every gate that needs one. | free | in-process | - | - | - | - | live |
| `_gate-money.pins.mjs` | GATE H, TIER 3 — the scanner for client-signed and operator-run transfer call sites. | free | in-process | - | - | - | - | live |
| `_gate-rpc-standin.mjs` | A JSON-RPC node STAND-IN for the money gates: an HTTP server on 127.0.0.1 that answers only the methods a gate hands it. | free | in-process | - | - | - | - | live |

### Gates and verifies (101)

| File | What it proves | Cost | Boot | Data | Auth | Ports | Build check | Status |
|---|---|---|---|---|---|---|---|---|
| `_diag-decoder-fan.mjs` | is the decoder's alignment search window too small? | free | startGateServer | scratch | **stub** | 3315 | - | live |
| `_diag-ui-shots.mjs` | Capture every core screen, desktop + mobile, for a cold-eyes visual audit. | free | **bare spawn** | scratch | real | 3222 | yes | live |
| `_gate-airing-poster.mjs` | a finished broadcast has a real picture of itself on the board, and only one the owner's rule allows: "a frame from when the MegaChat or… | free | startGateServer | scratch | real | 3291, 3292 | - | live |
| `_gate-airings-store.mjs` | airings-store.js: moments stop rewriting the whole file, a damaged file is not read as empty, and a deleted room's airings go (stores-9,… | free | in-process | scratch | - | - | - | live |
| `_gate-auth-secret.mjs` | a production box without AUTH_SECRET never seals with the public dev constant (OPEN-ISSUES K7, 2026-10-24). | free | startGateServer | scratch | real | 3361, 3362, 3363, 3364 | yes | live |
| `_gate-auth.mjs` | Auth gate — per-room passwords replace global dashboard key. | free | startGateServer | scratch | - | 3005 | - | live |
| `_gate-bank-and-seats.mjs` | Pass C Part 3: banking, live-seat escrow, review causes. This is the first pass permitted to change settlement, under four conditions,… | free | startGateServer | scratch | real | 3284 | - | live |
| `_gate-board-fold.mjs` | the board's hierarchy, measured in a real browser at the owner's screen sizes. | free | startGateServer | scratch | real | 3293, 3294 | yes | live |
| `_gate-booth-audio.mjs` | echo cancellation: the streamer hears guests as before, guests never hear themselves, and no guest is ever silent or doubled on stream. | free | startGateServer | scratch | - | 3337, 7880 | yes | live |
| `_gate-booth-picture.mjs` | no screen ever shows a picture that is not the streamer, and the live controls rise to the top of the manage page when someone joins. | free | startGateServer | scratch | - | 3336, 7880 | yes | live |
| `_gate-bounty-auth.mjs` | every state-changing bounty route authorizes, server-side. | free | startGateServer | scratch | real | 3360 | - | live |
| `_gate-bounty-board.mjs` | bounty-store.js: the board is written atomically, refuses a damaged file, and stops rewriting itself per code (stores-2, stores-9,… | free | in-process | scratch | - | - | - | live |
| `_gate-bounty-claim-audit.mjs` | the bounty money path's audit fixes (2026-10-24), each against the behaviour it replaced. | free | in-process | scratch | real | - | - | live |
| `_gate-bounty-claim.mjs` | creator bounty (Run A). Covers every item in the prompt's "verification before you call it done", plus the rule that matters most on a… | free | startGateServer | scratch | real | 3250, 3251 | yes | live |
| `_gate-bounty-program.mjs` | bounty program (fan-facing build). | free | startGateServer | scratch | **stub** | 3301, 3998 | - | live |
| `_gate-broadcast-delay.mjs` | self-capture against a stub that LAGS, the way a real broadcast does. | free | startGateServer | scratch | **stub** | 3410, 3411 | - | live |
| `_gate-browse-deck.mjs` | browse deck (feat/browse-deck). A. deck ON (default): /legacy#browse mounts the full deck — banner, bounty board, featured carousel,… | free | startGateServer | scratch | - | 3220, 3221 | yes | live |
| `_gate-browse-thumb.mjs` | browse-card stream thumbnail. The whole point of the server-side liveness check: Twitch 302s an OFFLINE or nonexistent channel to a gray… | third party | startGateServer | scratch | - | 3219 | yes | live |
| `_gate-cam-autoswitch.mjs` | booth camera picker device discovery + auto-upgrade WIRING. | free | startGateServer | scratch | - | 3218, 7880 | yes | **stale** |
| `_gate-campaigns.mjs` | targeted reward campaigns (campaign-engine.js and everything around it). | free | startGateServer | scratch | real | 3351, 3352 | yes | live |
| `_gate-capture-hardening.mjs` | capture hardening: OBS scene visibility, overlay self-reports, and the confidence tiers that decide whether a human looks. | free | startGateServer | scratch | **stub** | 3390, 3391 | - | live |
| `_gate-capture-stall.mjs` | THE RECORDER MUST NOTICE ITS OWN DEATH. On 2026-08-29 the rolling buffer ingested a real pump.fun broadcast cleanly for thirty minutes,… | free | in-process | scratch | - | - | - | live |
| `_gate-cohost-booth.mjs` | Co-host booth: auto-armed host camera, real local SFU, FREE room (wallet-less join → no payments needed to exercise the loop). A. booth… | free | startGateServer | scratch | - | 3216, 7880 | yes | **stale** |
| `_gate-confidence-split.mjs` | confidence is READ QUALITY; presence is a second, separate number. | free | in-process | scratch | - | - | - | live |
| `_gate-cross-cutting.mjs` | cross-cutting housekeeping (audit 2026-10-24, cc-2 / cc-4 / cc-9 / cc-39). | free | in-process | scratch | - | - | - | live |
| `_gate-dashboard-phase1.mjs` | Phase 1 streamer dashboard automated gate. | free | startGateServer | scratch | - | 3002 | - | live |
| `_gate-dashboard-update.mjs` | the dashboard's room save is all or nothing, and seat balances are shown in the seat's own token (stores-7, server-7). | free | in-process | scratch | - | - | - | live |
| `_gate-decoder-codes.mjs` | CODE SWEEP — does detection depend on WHICH code was issued? | free | startGateServer | scratch | **stub** | 3314 | - | live |
| `_gate-docs-link.mjs` | the docs link renders nowhere until it is configured, and everywhere it should once it is. | free | in-process | - | - | - | - | live |
| `_gate-echo.mjs` | echo is found and named, on both sides, and OBS's audio setup is checked, so "This tab" just works for a streamer who configures nothing. | free | startGateServer | scratch | - | 3357, 7880 | yes | live |
| `_gate-escrow-chain.mjs` | escrow-chain.js, deposit / attest / finalize, with NO chain and NO funds. | free | in-process | scratch | - | - | - | live |
| `_gate-escrow-contract.mjs` | the non-custodial seat escrow, adversarially, on Moderato testnet. | third party | in-process | - | - | - | - | live |
| `_gate-first-airing.mjs` | E37: an approved pledged clip can actually air. THE DEFECT THIS HOLDS CLOSED. `markPlayed` had no caller anywhere in the repo's history.… | free | startGateServer | scratch | real | 3319 | - | live |
| `_gate-follow-stream.mjs` | "Follow my stream status" actually follows the stream. | free | startGateServer | scratch | - | 3287, 3288 | - | live |
| `_gate-guest-whitelist.mjs` | GUEST WHITELIST Proves the streamer's standing free list over real HTTP against a real server process: no store-level shortcuts, no… | free | startGateServer | scratch | real | 3420, 3421 | - | live |
| `_gate-howl-guard.mjs` | the booth's howl guard (web/lib/howl-guard.ts) cuts a feedback loop at the streamer's mic, and leaves speech and real room tones alone. | free | startGateServer | scratch | - | 3347, 7880 | yes | live |
| `_gate-identity-account.mjs` | the canonical account: one person, N linked platforms. | free | startGateServer | scratch | real | 3341, 3342 | - | live |
| `_gate-integration.mjs` | the audit round's integration changes (2026-10-24): the server.js handoffs from every lane, and the cross-file fixes nobody else held. | free | startGateServer | scratch | real | 3441 | - | live |
| `_gate-lazy-connect.mjs` | LiveKit lazy connect. Proves the fix for the leak documented in LIVEKIT-AUDIT.md: the overlay used to open a subscriber connection on… | free | **bare spawn** | scratch | - | 3230, 3231, 7880 | yes | live |
| `_gate-livekit-state.mjs` | the LiveKit metering state survives a torn write, forgets stale stashes, and the breaker reads its budgets through env-num.js (stores-2… | free | in-process | scratch | - | - | - | live |
| `_gate-media-timeline.mjs` | the media timeline is not our clock. | free | in-process | scratch | - | - | - | live |
| `_gate-megachat-producer.mjs` | the producer's desk: approving does not air, and the pile survives. | free | startGateServer | scratch | real | 3343 | - | live |
| `_gate-meter-pause.mjs` | L35: the meter STOPS while the overlay is hidden, driven, not read. Pass C Session 2 wired `if (!seatEscrow.shouldCharge(room))… | free | startGateServer | scratch | real | 3321 | - | live |
| `_gate-migrations-boot.mjs` | the two data migrations are importable, idempotent functions the server can run at boot (stores-6, DECISIONS D6). | free | in-process | scratch | - | - | - | live |
| `_gate-missed-code-authoritative.mjs` | MISSES ARE AUTHORITATIVE. A code we never saw is NOT_SHOWN, and no confidence number gets to argue with it. WHY THIS GATE EXISTS. The… | free | in-process | scratch | - | - | - | live |
| `_gate-money.mjs` | GATE H — every transfer is accounted for. | free | startGateServer | scratch | - | 3322 | - | live |
| `_gate-no-wallet-prompt.mjs` | opening a room never pops a wallet chooser, and sign-in still works. | third party | startGateServer | scratch | - | 3295 | yes | live |
| `_gate-obs-protocol.mjs` | obs-websocket v5 conformance, against a mock that speaks the real protocol. | free | in-process | - | - | 4460, 4461, 4462, 4463, 4464, 4499 | - | live |
| `_gate-obs-ui.mjs` | the OBS one-click UI, end to end on the REAL claim page. | free | startGateServer | scratch | real | 3350, 4455 | yes | live |
| `_gate-overlay-first-guest.mjs` | the FIRST guest of a session is played once, not twice. | free | startGateServer | scratch | - | 3338, 7880 | yes | live |
| `_gate-overlay-layout.mjs` | the layout reaches the overlay, and the badge never sits under a tile. | free | startGateServer | scratch | - | 3276 | yes | live |
| `_gate-overlay-room.mjs` | the overlay URL must survive the next stream. | free | startGateServer | scratch | **stub** | 3317 | - | live |
| `_gate-overlay-visibility.mjs` | the overlay visibility check, and the signals it produces. | free | startGateServer | scratch | real | 3278, 4481 | - | live |
| `_gate-overlay.mjs` | overlay restyle (Part 1) + stingers (Part 2, when args passed). | free | startGateServer | scratch | - | 3009 | - | live |
| `_gate-phase1-embed.mjs` | MEGA Phase 1: embedded target stream + watch-to-earn surface. 1. twitchChannel round-trips: create room with channel + rewards → config… | third party | **hand-started server** | that server's | - | 3212 | yes | **unknown** |
| `_gate-phase2-hostfeed.mjs` | MEGA Phase 2: true-live return feed. Two real browser pages against the local server + real vdo.ninja: HOST publishes a fake camera to… | third party | **hand-started server** | that server's | - | 3212 | yes | **unknown** |
| `_gate-phase4-handles.mjs` | MEGA Phase 4: persistent handles, /<handle> permanence, demo room. Handles moved from /r/<handle> to bare /<handle>; the old prefix must… | free | startGateServer | scratch | - | 3212 | yes | live |
| `_gate-privy-auth.mjs` | the Privy front door's REJECTION WALL, plus proof the deleted in-house OAuth flow stays deleted. | free | startGateServer | scratch | real | 3225, 3226 | - | live |
| `_gate-pumpfun-pdt.mjs` | pump.fun capture: PROGRAM-DATE-TIME ANCHORS timeline calibration. | free | startGateServer | scratch | **stub** | 3402, 3403 | - | live |
| `_gate-quality-and-platform.mjs` | the two things a streamer must be TOLD, over real HTTP routes. | free | startGateServer | scratch | **stub** | 3313 | - | live |
| `_gate-record-flow.mjs` | the fan record-and-send surface, driven IN A REAL BROWSER. | free | startGateServer | scratch | real | 3240 | yes | live |
| `_gate-replay.mjs` | an offline room plays the replay of its broadcast, on the page. | free | startGateServer | scratch | real | 3296, 3299 | yes | live |
| `_gate-rewards-auth.mjs` | watch-to-earn pays the SIGNED-IN account, in bounds, once (money-1), and a seat id alone cannot take a seat (N1). | free | startGateServer | scratch | real | 3347 | - | live |
| `_gate-rewards-part-b.mjs` | Part B rewards gate — optional per-room rewards must not break pay-to-join. | free | startGateServer | scratch | - | 3348 | - | live |
| `_gate-room-poster.mjs` | the recent-rail poster. Three things worth holding, all of which are easy to get wrong in a way that looks fine: | free | in-process | scratch | - | - | - | live |
| `_gate-rooms-store.mjs` | rooms-store.js: the room store keeps what it is given (stores-1, 2, 7, 10, 11, 13, 14, 15). | free | in-process | scratch | - | - | - | live |
| `_gate-run-b-ocr.mjs` | OcrCodeChecker vs the synthetic corpus. Reads every labeled frame the corpus generator produced from the REAL overlay page and… | free | in-process | - | - | - | - | live |
| `_gate-run-b-pipeline.mjs` | the WHOLE verification distance, over HTTP, with the REAL decoder. | free | startGateServer | scratch | real | 3305 | - | live |
| `_gate-self-capture.mjs` | self-capture, so verification stops depending on platform VODs. | free | startGateServer | scratch | **stub** | 3380, 3381 | - | live |
| `_gate-site-settings.mjs` | the site owner's hidden settings page (/dev), and the three settings it moves, live. | free | startGateServer | scratch | real | 3306, 3309 | yes | live |
| `_gate-stale-capture.mjs` | A DEAD RECORDER MUST NEVER BE SCORED AS AN ABSENT BADGE. This is the most expensive failure this system can produce, because it is… | free | in-process | scratch | - | - | - | **stale** |
| `_gate-store-atomic.mjs` | json-store.js: a JSON store can no longer wipe itself (stores-2). | free | in-process | scratch | - | - | - | live |
| `_gate-x-token-store.mjs` | x-token-store.js: a torn x-tokens.json blocks writes instead of being saved over; the dead-row rules (Y1, ci-10). | free | in-process | scratch | - | - | - | live |
| `_gate-stream-context-http.mjs` | stream context over REAL HTTP ROUTES, end to end. | free | startGateServer | scratch | **stub** | 3311, 3312 | - | live |
| `_gate-stream-context.mjs` | stream-context enforcement. The requirement: the streamer genuinely went live and played the clips as part of a real broadcast, rather… | free | in-process | - | - | - | - | live |
| `_gate-tempo-phase1.mjs` | Tempo migration Phase 1 (chain + wallet layer). Verifies against a RUNNING server (npm run dev): 1. /api/config serves Tempo mainnet… | third party | **hand-started server** | **repo data/** | - | 3000 | - | **unknown** |
| `_gate-theme.mjs` | PART 4 light/dark rendering on landing, dashboard, join. | free | **hand-started server** | that server's | - | 3000 | yes | **unknown** |
| `_gate-tokens-phase2.mjs` | Phase 2 pluggable token gate — dry-run decimals + config exposure. | free | in-process | - | - | - | - | live |
| `_gate-typecheck.mjs` | the web app type-checks, and the one file the type check cannot see has no undefined names (audit web-13, 2026-10-24). | free | in-process | scratch | - | - | - | live |
| `_gate-ui-local-polish.mjs` | Unit: display formatting, guest names, bounty examples vs the DEMO_TARGETS seed (esbuild of web/lib), plus an optional page section… | free | in-process | - | - | 3210 | - | live |
| `_gate-visibility-index.mjs` | overlay-visibility.js answers the meter from memory, and a damaged chain stays refused (stores-3 + server-1, DECISIONS D4's meter half). | free | in-process | scratch | - | - | - | live |
| `_gate-vod-calibration.mjs` | per-broadcast timeline calibration, over real HTTP routes. | free | startGateServer | scratch | **stub** | 3320, 3321 | - | live |
| `_gate-web-fixes.mjs` | the web fix round of 2026-10-24 (audit fix-web), each fix proven where it runs: the letters route at module level, the built artifacts… | free | startGateServer | scratch | real | 3367, 4455, 7880 | yes | live |
| `_gate-whitelist-store.mjs` | guest-whitelist.js: reads do not write, and a damaged list is not read as an empty one (stores-12, stores-2). | free | in-process | scratch | - | - | - | live |
| `_gate-x-claims.mjs` | X ownership through the Privy identity, PROVEN not assumed. The prompt behind this run asked one sharp question: does Privy genuinely… | free | startGateServer | scratch | real | 3242 | - | live |
| `_gate-yt-rumble.mjs` | YouTube + Rumble external capture, against LOCAL STUBS only. Three layers: A. the API modules parse what the stubs serve — and the stubs… | free | startGateServer | scratch | **stub** | 3396, 3397 | - | live |
| `_gate-zero-pricing.mjs` | Unit: an explicit zero MegaChat price survives normalisation and an empty one derives from the live-seat rate (rooms-store pure functions). | free | in-process | - | - | - | - | live |
| `_verify-bounty-e2e.mjs` | the ENTIRE creator-bounty chain, over HTTP, against a real server. | free | **bare spawn** | scratch | **stub** | 3299 | - | live |
| `_verify-bounty-oauth.mjs` | Task 8's build half. A. REAL identity verification (BOUNTY_IDENTITY_REAL=1) over HTTP: a claim is approved only when the requester's… | free | startGateServer | scratch | real | 3303, 3999 | - | live |
| `_verify-bounty-ui.mjs` | the fan-facing bounty UI, driven on the REAL pages in a REAL browser with a fake camera. | free | **bare spawn** | scratch | **stub** | 3302 | yes | **unknown** |
| `_verify-calibration-real-vod.mjs` | calibration against the REAL VOD of the real broadcast. | third party | startGateServer | scratch | real | 3340 | - | **unknown** |
| `_verify-gate-harness.mjs` | the gate harness refuses to be fooled by a stale server. | free | startGateServer | scratch | real | 3461, 3462, 3463, 3464, 3465, 3467 | - | live |
| `_verify-identity-followups.mjs` | the three follow-ups from the per-instance identity fix. | free | in-process | - | - | - | - | live |
| `_verify-min-duration.mjs` | a sub-threshold MegaChat is rejected over real HTTP and, critically, is never charged for. | free | startGateServer | scratch | - | 3282 | - | live |
| `_verify-mirror-drift.mjs` | mirrored test logic has not DRIFTED from the code it mirrors. | free | in-process | - | - | - | - | live |
| `_verify-no-dead-calls.mjs` | no route calls a module function that does not exist. | free | in-process | - | - | - | - | live |
| `_verify-ops-alerts.mjs` | alarms actually reach a destination. | free | in-process | - | - | - | - | live |
| `_verify-overlay-id-fallback.mjs` | the overlay identity stays stable across reloads WITH SESSIONSTORAGE BLOCKED, driving the REAL overlay page. | free | **bare spawn** | scratch | - | 3297, 7880 | - | live |
| `_verify-persistence-check.mjs` | the persistence check reports EVIDENCE, not configuration. | free | **bare spawn** | scratch | - | 3291, 3292, 3293, 3294, 3295 | - | live |
| `_verify-twitch-prefill.mjs` | connected Twitch is adopted by default and is VISIBLE. | free | **bare spawn** | scratch | real | 3280 | yes | live |
| `_verify-twitch-thumbnail.mjs` | the connected Twitch channel actually RENDERS as a thumbnail in the browse grid, not merely that the setting saves. | free | **bare spawn** | scratch | - | 3298 | yes | live |
| `_verify-two-overlays.mjs` | Two overlays on one livekit room against the local SFU (minified one-off; no header). | free | **bare spawn** | scratch | - | 3271, 7880 | - | live |

### scripts/ (6)

| File | What it proves | Cost | Boot | Data | Auth | Ports | Build check | Status |
|---|---|---|---|---|---|---|---|---|
| `scripts/docs-check.mjs` | docs:check — the honesty check. Prose has no test suite, so overclaiming creeps back in through the words that sound strongest. This… | free | in-process | - | - | - | - | live |
| `scripts/docs-gitbook-check.mjs` | docs:gitbook-check — is the repo side ready for GitBook Git Sync? | free | in-process | - | - | - | - | live |
| `scripts/docs-summary.mjs` | docs:summary — MERGE the docs/ tree into docs/SUMMARY.md. SUMMARY.md is GitBook's table of contents: a markdown file that is not listed… | free | in-process | - | - | - | - | live |
| `scripts/docs-sync.mjs` | docs:sync — currency by construction. Docs rot because the code they describe moves and nothing notices. This script makes that… | free | in-process | - | - | - | - | live |
| `scripts/generate-og.mjs` | Generate the Holler brand rasters and save them to web/public/: og.png 1200x630 social card — the full mark, large, on the night ground… | free | in-process | - | - | - | - | live |
| `scripts/play-endpoint.ps1` | Plays a WAV into one chosen Windows playback endpoint (the OBS-monitoring stand-in for the AEC probes). | free | in-process | - | - | - | - | live |

<a id="ports-that-collide"></a>
### Ports that collide

Two files on one fixed port cannot run at the same time. Between two `startGateServer` gates a collision is loud (the second refuses, naming the port); with a bare spawn or a hand-started server it is silent. Pairs as of 2026-10-24:

- 3000: `_gate-theme.mjs`, `_gate-tempo-phase1.mjs`, `_gate-tempo-phase2.mjs`, `_gate-tempo-phase3.mjs` (all drive a hand-started server there).
- 3212: `_gate-phase1-embed.mjs`, `_gate-phase2-hostfeed.mjs`, `_gate-phase3-letters.mjs` (hand-started) and `_gate-phase4-handles.mjs`.
- 3215 and 3216: `_gate-lk-phase1.mjs`, `_gate-lk-phase2.mjs`, `_gate-lk-phase3.mjs`; 3216 also `_gate-cohost-booth.mjs`.
- 3218: `_gate-cam-autoswitch.mjs`, `_gate-polish.mjs`. 3220: `_gate-browse-deck.mjs`, `_gate-p1-features.mjs`. 3221: `_gate-browse-deck.mjs`, `_gate-free-megachat.mjs`, `_gate-p2-moderation.mjs`. 3222: `_diag-ui-shots.mjs`, `_gate-p2-moderation.mjs`.
- 3291 to 3295: `_verify-persistence-check.mjs` against `_gate-airing-poster.mjs`, `_gate-board-fold.mjs` and `_gate-no-wallet-prompt.mjs`.
- 3299: `_gate-replay.mjs`, `_verify-bounty-e2e.mjs`. 3321: `_gate-meter-pause.mjs`, `_gate-vod-calibration.mjs`. 3347: `_gate-howl-guard.mjs`, `_gate-rewards-auth.mjs`.
- 3306, 3309, 3312, 3313: `_gate-site-settings.mjs`, `_gate-stream-context-http.mjs` and `_gate-quality-and-platform.mjs` against the rehearsals and `_setup-overlay.mjs`.
- 4455: `_gate-obs-ui.mjs` and `_gate-web-fixes.mjs` both put a mock obs-websocket on the real OBS default port; neither runs beside the owner's OBS.
- 7880: every media gate shares the one local SFU; `_gate-booth-audio.mjs` owns it for its run.

`_gate-guest-whitelist.mjs` moved from 3390/3391 to 3420/3421 on 2026-10-24: it collided with `_gate-capture-hardening.mjs`, and both are in the main suite. `_verify-gate-harness.mjs` moved to 3461-3467 (it shared 3396/3397 with `_gate-yt-rumble.mjs`).

### Known stale rows

- `_gate-stale-capture.mjs`: fails, see the standards table above.
- `_gate-cam-autoswitch.mjs`, `_gate-cohost-booth.mjs`, and the owner-run `_gate-lk-phase2.mjs`: their browser steps unlock a room through a "room id + password" form (`#manage-room-id`) the dashboard no longer has. Their boots are current; their UI drivers need rewriting.
- `_verify-bounty-ui.mjs` (unknown): loads `/bounty/mine?me=…`, a parameter the product removed.
