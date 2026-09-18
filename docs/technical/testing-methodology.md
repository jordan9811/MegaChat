# Testing methodology

MegaChat is verified by **gates**: standalone scripts that stand up real infrastructure, assert behaviour, print `PASS`/`FAIL` per assertion and a `RESULT` line, and exit non-zero on any failure. The convention is written down in `AGENTS.md` ("Gates over claims. Behaviour is proven by a `_gate-*.mjs` script that runs against real infrastructure, not asserted in a commit message. If you change behaviour, extend the gate."). There is no unit-test framework; there are 65 `_gate-*.mjs` scripts, one smoke test and one migration at the repo root, plus three shared harnesses.

## What a gate is

Each gate is self-contained: it sets `DATA_DIR` to a scratch directory, imports the modules under test directly for server-side sections, and for HTTP or browser sections spawns `node server.js --prod` on a private port and drives it — with real Chrome through `puppeteer-core`, a real local LiveKit SFU for media gates, real `ffmpeg` for capture and poster gates, and mainnet dust for the payment legs (`_gate-lk-phase1.mjs`, `_gate-tempo-phase2.mjs`, `_gate-room-poster.mjs`, headers). Money gates say so in their first line ("REAL MAINNET MONEY", `_gate-tempo-phase2.mjs`).

## The standards, and what each one caught

Every rule below exists because a gate once passed for the wrong reason. The incident is cited; the rule is the fix.

| Standard | Incident | Where it lives now |
|---|---|---|
| **Spawn a server you can trust is yours.** Port precheck, early-exit watch, readiness poll instead of a blind sleep, and a nonce echoed by `/api/health` so the responder is provably the process just started. | A three-day-old zombie held the port; every later gate died on `EADDRINUSE` with `stdio: 'ignore'` swallowing it, drove the stale process, failed 6/4 for days and was written off as "pre-existing" (`dfb7a38`; `63ccf45`). | `_gate-helpers.mjs`, `startGateServer` |
| **A browser gate is only as fresh as the last build.** Refuse to judge a page rendered from a `web/.next` older than the newest source under `web/`. | `_gate-bounty-claim` reported green for two weeks on a line the merged source no longer produced, because the `.next` on disk predated the merge (`OPEN-ISSUES.md`, 2026-09-16, "GREEN AGAINST A STALE BUILD"). | `_gate-bounty-claim.mjs`, section G0. Eleven other browser gates have the same exposure and are listed in that entry. |
| **Prove a test discriminates by running the old behaviour alongside.** A fix's gate replays the pre-fix ladder inline and asserts the two disagree. | Without it a "fix" that changes nothing passes the same. | `_gate-missed-code-authoritative.mjs` (old ladder vs `NOT_SHOWN`); `_gate-decoder-codes.mjs`; `561a9ce` ("proven by regression") |
| **Stubs must lag like a broadcast.** Every HLS stub published instantly; three delay-dependent bugs passed green for a month. | `OPEN-ISSUES.md`, the 2026-08-26 real-broadcast entries; the freeze-window derivation in `bounty-claim.config.js`. | `_gate-broadcast-delay.mjs` |
| **A fixed corpus hides what it holds fixed.** The badge corpus used one code and hid a ~50% miss rate at 720p. | `5ebd643`; `OPEN-ISSUES.md`, "the corpus measured one code". | `_gate-decoder-codes.mjs` sweeps codes |
| **A dead recorder is not an absent badge.** | A stalled capture ring was scored as the streamer failing to show the badge (`OPEN-ISSUES.md`, 2026-08-29, FIXED). | `_gate-stale-capture.mjs`, `_gate-capture-stall.mjs` |
| **Authorization is structural.** Every bounty route registers through a guard that looks the path up in a policy table and throws on an unknown one; the gate diffs the mounted routes against the table. | Routes had been added without deciding who could call them (`74291c8`). | `bounty-auth.js`; `_gate-bounty-auth.mjs` |
| **Gates authenticate like a user.** Credentials for a gate are minted the way a streamer's are — a sealed identity cookie — never a test-only bypass in the auth path. | "a test-only escape hatch in the auth path is the thing that later…" (`_gate-helpers.mjs`, `mintBountyAuth`). | `_gate-helpers.mjs`, `_gate-identity-helper.mjs` |
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

Each is `node _gate-<name>.mjs`; a few have npm aliases (`package.json`, `gate:*`). Browser gates need Chrome at `C:/Program Files/Google/Chrome/Application/chrome.exe` (`_gate-bounty-claim.mjs`, `puppeteer.launch`) and a fresh `npm run build`. Media gates need a local LiveKit SFU. Money gates spend real dust and say so in their header — read it before running one. The two money gates that spend nothing are `_gate-money.mjs` (the door against a counting fake chain) and `_gate-meter-pause.mjs` (a seat that pays in points); a gate-booted server still reads `.env`, so the seller and reward-pool keys are present in every HTTP gate and only the fixture's payment mode keeps it off-chain (register L40).
