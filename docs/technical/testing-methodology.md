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
| **Gate H: zero transfer calls in the bounty modules.** Scan all sixteen `bounty-*.js` for `sendTransaction`, `writeContract`, `transferFrom`, `.transfer(`, `signTransaction`, `privateKeyToAccount`, `walletClient`; require zero; require `bounty-settlement.js` to say `NO FUNDS MOVE` and carry `TODO(run-b)`. | The standing rule for a money-adjacent feature on a mainnet app (`HANDOFF-BOUNTY.md`). | `_gate-bounty-claim.mjs`, section H |
| **Real broadcasts are the arbiter.** A synthetic pass is a claim; the first real broadcast found two P0s that nothing else could (`347ac4b`). | Twitch, Kick, pump.fun, YouTube and X each have a real-broadcast entry in `OPEN-ISSUES.md` with what it found. | The rehearsal harnesses (`ca7970c`, `736f0f9`, `d40276d`) |

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

Each is `node _gate-<name>.mjs`; a few have npm aliases (`package.json`, `gate:*`). Browser gates need Chrome at `C:/Program Files/Google/Chrome/Application/chrome.exe` (`_gate-bounty-claim.mjs`, `puppeteer.launch`) and a fresh `npm run build`. Media gates need a local LiveKit SFU. Money gates spend real dust and say so in their header — read it before running one.
