# REPORT-DOCS — the docs pass (Pass B, Run 2)

Written as the run goes. The report proper is at the bottom; everything above
it is the working record the report is built from, in the order the spec asks
for it: inventory first, then gates.

Spec: `megachat-pass-b-and-docs.md`, "RUN 2: Docs pass, GitBook handbook".
Tree at start: `e0fda49` on `feat/real-broadcast` = `origin/v0-ui-migration`.

## 1. Inventory — what the repo says about itself

**The spec names `REPORT-*.md` as a primary source. No file by that name
exists anywhere in the tree** (`find . -name "REPORT-*"` → nothing outside
this file). The work-period record lives in other shapes, listed below. Every
page this pass writes cites one of these or the code; nothing else.

### 1a. Status and decision records (the project's memory)

| Source | What it is | Covers |
|---|---|---|
| `OPEN-ISSUES.md` (138 KB, 76 `###` entries, 16 `##` runs) | Append-only stubs, deferrals, gaps, findings, retractions. The single most load-bearing file. | 2026-07-25 → 2026-09-16 |
| `DECISIONS.md` (47 KB, 15 `##` runs) | Judgment calls: what / why / how to undo. | 2026-07-25 → 2026-09-05 |
| `docs/briefs/*.md` (14 briefs + README) | Owner-facing plain-English day summaries, with an explicit believed-vs-shown rule. | 2026-07-25 → 2026-09-05 |
| `docs/decisions/*.md` (5) | Design decisions with options weighed: clip storage, mirror-test audit, OAuth domain audit, post-release clawback, sub-3s residual. | 2026-07-25 → 2026-07-27 |
| `HANDOFF-BOUNTY.md`, `HANDOFF-LAZY-CONNECT.md`, `HANDOFF.md` | Run handoffs: what is real vs stubbed, one-line reverts, runbooks. | bounty Run A; lazy-connect; browse deck |
| `docs/pass-b-handoff.md` | Pass A → Pass B handoff: where capture lands, retention, airings seam, Run 1 result. | 2026-09-16 |
| `docs/run-b-verification.md` | Verification loop, detection-rate table (synthetic corpus), 720p floor. | 2026-07-28 |
| `docs/platform-feasibility.md` | X and pump.fun feasibility. **Disagrees with later commits** — see §3. | 2026-08-24/25 |
| `LIVEKIT-AUDIT.md`, `LIVEKIT_NOTES.md` | The connection-leak investigation; transport notes. | 2026-07 |
| `ROADMAP.md` | Product roadmap (join gating, integrations, rooms, moderation, stingers). | undated; partly superseded by shipped work |
| `DESIGN.md`, `docs/design/`, `docs/ui-overhaul/` | Design rules, copy bank, overhaul plan/audits/tokens. `docs/design/copy-bank.md` records the retired /bounty disclosure. | 2026-07 → 2026-09 |
| `docs/legacy/README.md` | Map of the pre-overhaul front end, still reachable; tag `legacy-ui-2026-08-29`. | 2026-08-29 |
| `*_TEST.md`, `*_CHECKLIST.md`, `PASS_NOTES.md`, `UX_*.md` (root, ~20 files) | Per-phase test records from the migration era (Arc, Tempo, passkeys, dashboard, join). | 2026-07-05 → 2026-07-19 |
| `TEMPO_NOTES.md`, `MIGRATION_TEMPO.md`, `ARC_MIGRATION.md` | Chain-migration notes. **Two chains appear in the tree** — see §3. | 2026-07 |
| `megachat-*-prompt.md`, `megachat-pass-*.md` (7) | The owner's run prompts. Intent, not fact; cited only as "what was asked". | 2026-08 → 2026-09 |
| `CLAUDE.md` (in the `mc-manage-room` worktree, not on this branch), `AGENTS.md` | Reporting standard; agent conventions (gates over claims, flags default safe, never strip `.env`, commit ≠ ship). | — |
| `README.md` | **Stale.** Titled "VDO.Ninja Stream Platform", describes a 0.01 USDC flow that predates every store in the tree. Not a source for anything but history. | pre-2026-07 |

### 1b. Contracts (interface and type files)

| File | Defines |
|---|---|
| `web/lib/api.ts` | Client types: `Room`, `Seat`, `RoomSession`, `RoomConfigPatch`, `RoomLayout`, `RoomPoster`, `RecentAiring`, `PublicRoomCard`, `MyRoomCard`, `LetterAdminItem`, `GuestEntry`, `GuestList`, `LinkedAccount`, and every dashboard/whitelist call. |
| `web/lib/bounty-api.ts` | `BountyClientConfig`, `ProgramPool`, the bounty client calls. |
| `rooms-store.js` | Room record + config normalizer (`resolveRoomConfig`, `resolveLayout`, `resolveLetters`, `joinStreamGatesFor`, `letterPriceFor`), handles, ownership, passwords. |
| `airings-store.js` | `openAiring`/`closeAiring`/`addMoment`/`attachRecording`/`listAirings`/`recentAirings`. |
| `bounty-store.js`, `bounty-escrow.js` (`STATES`, `ALLOWED_TRANSITIONS`), `bounty-ledger.js`, `bounty-evidence.js` (`EVIDENCE_TYPES`), `bounty-settlement.js` (`SettlementInterface`, `StubSettlement`) | The bounty data model and its state machine. |
| `bounty-claim.config.js` | Every bounty threshold and `PLATFORM_PROFILES` (per-platform verification bargain, one source for verifier and copy). |
| `bounty-verifier.js` (verdict ladder in the header), `frame-sources.js` (`SOURCE_STATES`, ±1.5 s tolerance derivation), `bounty-capture.js` | Verification pipeline and its interfaces. |
| `guest-whitelist.js`, `whitelist-routes.js`, `identity-store.js` | Whitelist store + API; identities and handles. |
| `server.js` | Every HTTP route (`/api/config`, `/api/join*`, `/api/seats`, `/api/rooms/*`, `/api/livekit/*`, `/api/health*`, overlay, `/:handle`), the seat lifecycle, the follow loop, `effectiveMaxSeats`. |
| `.env.example` (52 names) + `process.env.*` reads across root modules (~190 names) | The configuration surface. Names only ever appear in docs. |

### 1c. Test methodology (the gates)

68 scripts: 65 `_gate-*.mjs`, `_smoke-obs-overlay.mjs`, `_migrate-whitelist-identity.mjs`, plus shared harnesses `_gate-helpers.mjs`, `_gate-mock-obs.mjs`, `_gate-identity-helper.mjs`. Each is a self-contained assertion script against real infrastructure (a spawned `server.js --prod`, a local LiveKit SFU, real Chrome via puppeteer-core, real ffmpeg, mainnet dust for the payment legs). The convention, from `AGENTS.md`: behaviour is proven by a gate, not asserted in a commit message.

Gate H (inside `_gate-bounty-claim.mjs`): 16 `bounty-*.js` modules scanned for `sendTransaction|writeContract|transferFrom|.transfer(|signTransaction|privateKeyToAccount|walletClient` — must be 0; `bounty-settlement.js` must contain "NO FUNDS MOVE" and "TODO(run-b)". Baseline at start of this run: 0 hits, both markers present.

Gate results at the start of this run (fresh build, this tree): `_gate-bounty-claim` 102/0 (incl. new G0 build-freshness check), `_gate-room-poster` 20/0, `tsc --noEmit` 0, `npm run build` clean.

### 1d. What the app itself claims (public surfaces)

`web/app/how-it-works/page.tsx` (13 step titles + 7 FAQ), `web/app/layout.tsx` (site description: "Viewers pay per-second in USDC … One-tap passkey … unused balance refunds automatically"; keywords include "Arc network"), `web/components/landing/landing.tsx`, `web/components/bounty/bounty-program.tsx`. Public docs must not claim more than these do, and must not repeat a claim the code contradicts.

## 2. Coverage map — which source feeds which page

Public (`docs/` top level):

| Page | Primary sources |
|---|---|
| `README.md` | `layout.tsx` description, `how-it-works/page.tsx`, `rooms-store.js` |
| `concepts/*` | `rooms-store.js`, `server.js` seat lifecycle, `letters.js`, `identity-store.js`, `airings-store.js`, `public/overlay.html` |
| `features/live-seats.md` | `server.js` (`/api/join*`, `effectiveMaxSeats`, `removeParticipant`), `meter-mpp.js`, `passkey-meter.js`, `livekit*.js` |
| `features/megachats.md` | `letters.js`, `moderation.js`, `/api/config.letters` |
| `features/create-room-and-layout.md` | `rooms-store.js` (`resolveLayout`), `web/components/create-room/*`, `public/overlay.html` |
| `features/obs-setup.md` | `web/lib/obs-*.mjs`, `_smoke-obs-overlay.mjs`, `docs/obs-oneclick-checklist.md` |
| `features/follow-my-stream.md` | `server.js` (`followTick`, `hiddenByBroadcast`), `twitch-api.js`, `_gate-follow-stream.mjs` |
| `features/guest-whitelist.md` | `guest-whitelist.js`, `whitelist-routes.js`, `_gate-guest-whitelist.mjs`, `_migrate-whitelist-identity.mjs` |
| `features/bounty-program.md` | `bounty-routes.js`, `bounty-escrow.js`, `bounty-settlement.js`, `HANDOFF-BOUNTY.md`, `docs/design/copy-bank.md` |
| `features/recent-rooms.md` | `room-poster.js`, `airings-store.js`, `web/components/booth/recent-rail.tsx`, `docs/pass-b-handoff.md` |
| `features/platform-support.md` | `bounty-claim.config.js` `PLATFORM_PROFILES`, `docs/platform-feasibility.md`, commits `2f6e5d4`, `9f02254`, OPEN-ISSUES T8/T9 |
| `verification/README.md` (the hard page) | `bounty-verifier.js` header, `frame-sources.js` header, `bounty-capture.js`, `bounty-routes.js` (`frameOrigin`), `docs/run-b-verification.md`, OPEN-ISSUES 2026-08-26 → 09-03 entries |
| `verification/limitations.md` | OPEN-ISSUES (open entries), `docs/run-b-verification.md`, `bounty-claim.config.js` |
| `technical/*` | `server.js`, stores, `.env.example`, `_gate-helpers.mjs`, `AGENTS.md`, memory of the OneDrive lock (`OPEN-ISSUES.md` 2026-09-15 entries) |

Internal (`docs/internal/`):

| Page | Primary sources |
|---|---|
| `launch-readiness.md` | Spec §"Stealth"; gates list; `OPEN-ISSUES.md`; commit `6e29bae` (underpay fix) and merge `1191daf` |
| `work-history/*` | `DECISIONS.md` runs, `OPEN-ISSUES.md` runs, `docs/briefs/*`, `HANDOFF-*.md`, git log `origin/v0-ui-migration` |
| `roadmap.md` | `ROADMAP.md`, `web/app/roadmap/page.tsx`, OPEN-ISSUES backlog entries, memory-recorded wishlist is NOT a source (not in repo) |
| `outstanding.md` | `OPEN-ISSUES.md` "open"/"still open" subsections, reconciled entry by entry |
| `limitations-register.md` | OPEN-ISSUES assumptions, `docs/run-b-verification.md` "what remains", `docs/pass-b-handoff.md` "explicitly not built" |
| `needs-a-status-call.md` | every UNCLEAR raised while writing |

## 3. Disagreements between sources (found during inventory; cited both ways in the pages)

1. **Which chain.** `server.js` `/api/config` reports `chainName: 'Tempo'` and the tree carries `meter-mpp.js` (TIP-1034 channels on Tempo); `web/app/layout.tsx` keywords still say "Arc network" and `ARC_*` env names remain in `.env.example` beside `TEMPO_*`. Prod history (`17a5f09`, `189d6eb`, 2026-07-07) shows the MPP/Tempo rebuild landed on `v0-ui-migration`. → Documented as: metered seats run on Tempo via MPP session channels (SHIPPED, cited); Arc/Circle passkey path present in code (`passkey-meter.js`, `CIRCLE_*`), status UNCLEAR whether it is a live mode or a retained fallback.
2. **X.** `docs/platform-feasibility.md` (2026-08-24): "X — park it. Confirmed, not assumed." Commit `2f6e5d4` (2026-09-03): "X self-capture proven on a real broadcast — no fallback exists, so it had to work", and `PLATFORM_PROFILES.x` describes a working (capture-only) bargain. → Both cited; the feasibility doc is about *platform API access*, the commit is about *self-capture of our own RTMPS push*. They do not contradict on the facts, only on the verdict; the page says so.
3. **Kick VOD.** OPEN-ISSUES 2026-08-29 records that "Kick has no VOD" was written twice and is false; `PLATFORM_PROFILES.kick.notice` still reads "Kick has no VOD we can read". → The copy is what streamers see and is cited as such; the correction is cited next to it. Filed UNCLEAR: which wording is intended.
4. **Bounty disclosure.** `HANDOFF-BOUNTY.md` and `_gate-bounty-claim.mjs` (before this run) required a "no funds move" line on /bounty; `6386a2c` + `docs/design/copy-bank.md` retired it. Resolved this run in favour of the recorded decision (see OPEN-ISSUES 2026-09-16). Docs cite the decision.
5. **README.md** describes a VDO.Ninja-era product. Everything else in the tree postdates it. Treated as historical; the docs landing page replaces its role.

## 4. Run log

### Gate 0 — layout (1 iteration) — committed 625a117

`.gitbook.yaml` (root ./docs/, structure block, empty redirects). `scripts/docs-summary.mjs`: merge semantics as specified — preserves every existing entry, repairs a dead link only when exactly one same-named page exists, appends missing pages to their group, `--public-only`, `--check`.

Decision: the seven pre-existing docs/ directories and four root-level record files are grouped under Internal IN PLACE (one set, `INTERNAL_DIRS`) rather than moved, because OPEN-ISSUES.md, AGENTS.md, DECISIONS.md and the pages themselves link to those paths and this pass does not edit pages it did not write. This deviates from "one directory, trivially separable"; stated in docs/internal/README.md, and a later `git mv` plus editing the set restores it. Notes are excluded from `--public-only` as well as Internal (owner scratch should not leak by default).

Exit: SUMMARY lists every page, `--check` current, both variants valid, assets dir present.

### Gate 1 — public docs (1 iteration)

25 authored pages: landing, 7 concepts, 9 features, the verification hard page and its limitations, section indexes, the shared pre-launch snippet. Every feature page carries one status tag and a "What this does NOT do" section; money pages carry the snippet between `<!-- snippet:pre-launch -->` markers. GitBook has no include directive, so `docs:sync --write` re-stamps the markers from `docs/_snippets/pre-launch.md` — removal at launch is one edit plus one command. ASSUMPTION: GitBook preserves HTML comments on sync; not verifiable offline.

`scripts/docs-check.mjs` was written early to enforce this gate's exit. First run: 5 uncited claims in authored pages (four cited, one nav-table label rephrased) and 194 advisory hits across the 46 pre-existing record pages (never failures; collapsed to one line per page, `--verbose` lists them).

Found while citing: the tail of the `captureFreezeDelayMs` comment in `bounty-claim.config.js` still described the 90s/60s pair that Pass A replaced with 75s/51s, and claimed 60s "survives D = 0" — at 75s/51s the right bound at zero delay is 45s, so it does not. Comment corrected, including the honest statement that the zero-delay stubs pass only because their clips are short. Comment only; no behaviour change.

Dead links at this commit: 9, all into internal pages Gate 3 creates (outstanding, limitations-register, launch-readiness, work-history, roadmap). Gate 3 resolves them.

Status calls raised: U1 (which seat payment route is live — narrowed by source to "is /api/join/mpp reachable from any UI"; the join page calls only /api/join/passkey), U2 (Kick VOD wording).

### Gate 2 — technical docs (1 iteration)

10 pages: architecture (layer diagram, seams, what runs where, the two loops, deliberately-not-here), interfaces, data model (rewritten documents / append-only files / binary artefacts / memory-only, plus the deliberately-absent list with the reason the code gives for each), four key flows as step tables with the source and the failure exit per row, testing methodology (every standard paired with the incident that produced it), running it (setup, env names by group with absent-behaviour, deploy, hazards incl. OneDrive locks and the stale local prod ref).

`scripts/docs-sync.mjs` was written in this gate rather than Gate 4 because the Interfaces page is built from it: 15 source-embedded regions (`<!-- source:file#Symbol -->`) filled by `--write` from `web/lib/api.ts`, `bounty-escrow.js`, `bounty-settlement.js`, `bounty-confidence.js`, `bounty-claim.config.js`, `airings-store.js` — a symbol is taken from its declaration (with a leading JSDoc block) to the next top-level declaration. Citation hashes recorded for all 35 authored pages. First report run flagged 33 "cites X which does not exist": all were runtime data files named in the data-model page (`rooms.json`, `bounty-ledger.jsonl`, …), not sources; the tool now skips a `.json`/`.jsonl` name that is not in the repo. Remaining reported drift is legitimate and closes in later gates: `scripts/docs-gitbook-check.mjs` (Gate 5), `docs/internal/launch-readiness.md` (Gate 3), `CONTRIBUTING-DOCS.md` (Gate 4).

docs:check: 2 hits on first run (both fixed: one cited, one rephrased).

Exit: interface regions match source by construction; a new contributor has setup, env, ports, modes and hazards on one page; the deliberately-absent list is checked against every store module's header.

### Gate 3 — internal docs + the honesty check (1 iteration)

Read in full for this gate: `DECISIONS.md` (all 15 runs) and `OPEN-ISSUES.md` (all 76 entries, 2,168 lines). 18 pages: launch-readiness with a 27-row retest checklist (each row names its gate or rehearsal and whether the proof is fixture / rehearsal / real broadcast); a work-history index and 12 period pages (2026-07-05 → 09-16) built from the decision log, the issue log, the briefs and the git log — Pass A's page carries the enumeration-lockdown near-miss and the reverted NOT_SHOWN cause branch as asked; roadmap (46 items, one tag each, dependencies named; the B6-vs-stream-context disagreement recorded rather than resolved); outstanding (12 owner items, 8 needing a broadcast, 32 engineering items, reconciled entry by entry — every open bullet in OPEN-ISSUES.md maps to a row or to a RESOLVED/RETRACTED/SUPERSEDED marker in the file); limitations register (L1–L29, stable ids); needs-a-status-call (U1–U6).

FOUND WHILE WRITING, and filed: **the bounty badge does not follow the layout origin.** ROADMAP.md specced "the barcode takes the diagonally opposite corner automatically"; Pass A shipped the layout editor with `#bounty-badge` still fixed at `left:16px; bottom:16px` and nothing reading `layout.origin`. A bounty room with a bottom-left origin stacks tiles over the badge, which the badge's own CSS comment says must never happen, and an occluded badge is an honest streamer unpaid. Default origin is top-right, so unedited rooms are unaffected. Appended to OPEN-ISSUES.md (2026-09-16), registered as L13 / E1 / U4, added to the public limitations page and the create-room feature page. No behaviour changed (Run 2 rule).

The honesty check ran on every authored page; hits fixed by citing. Advisory hits on the 46 pre-existing record pages remain advisory.

Exit: docs:check green on authored pages; every source document has a work-history page (the migration-era `*_TEST.md` records are covered by one page and say so); the outstanding list reconciles against OPEN-ISSUES.md.

### Gate 4 — currency by construction (1 iteration) — committed 6946671

`scripts/docs-sync.mjs` (written in Gate 2 for the Interfaces page) is the mechanism: citation hashes over normalised source sections in `docs/.docs-manifest.json`; `<!-- source:file#Symbol -->` regions refreshed from source; `<!-- snippet:name -->` regions re-stamped from `docs/_snippets/`. **Proven to detect a deliberate edit:** one comment line appended to `room-poster.js` → `docs:sync` flagged the six pages that cite it (airings-and-evidence, recent-rooms, data-model, running-it, roadmap, the Pass A/B history page); reverted byte-for-byte → cleared. Embedded regions proven in Gate 2 (15 refreshed on first `--write`). `npm run docs:verify` = check + sync + gitbook-check, added to the chain and to AGENTS.md. `CONTRIBUTING-DOCS.md` written, including the four-step stealth exit. Runtime data files named in prose (`rooms.json`, …) are excluded from drift, and a bare basename cite is resolved against docs/ and the citing page's directory as well as the repo root.

### Gate 5 — GitBook connection readiness (1 iteration) — committed f3ff572

`scripts/docs-gitbook-check.mjs`: .gitbook.yaml (minimal reader), SUMMARY resolution both ways, images under .gitbook/assets, the public→internal boundary (one set shared with docs:summary), relative links, and the deep-link slug registry against SUMMARY. First run found 11 public pages linking into the internal half (Outstanding, the status-call page, the limitations register) — all rewritten as plain references; the public limitations page now links nowhere internal and the features index links the public limitations page instead of the register. Result: 0 errors, 2 advisory warnings (`docs/design/README.md`, pre-existing, links to files outside docs/ that GitBook cannot serve). `CONNECTING-GITBOOK.md` written with the eight steps, the branch to sync, and both warnings.

### Gate 6 — link the docs from the app (1 iteration)

`NEXT_PUBLIC_DOCS_URL` added to `.env.example` with the comment that it is a BUILD-time value (Next inlines `NEXT_PUBLIC_*`), unset by this pass. `web/lib/docs-url.mjs` (+ `.d.mts`, the obs-client pattern so a Node gate imports the real module): `docsUrl(slug?)` returns null when unset or for an unknown slug — never a guess. `web/lib/docs-slugs.json` maps 12 slugs to pages; `docs:gitbook-check` cross-checks them against SUMMARY. Placement matches the existing chrome rather than inventing furniture: the shared `FooterNav` (site-footer.tsx), the product headers on the account, how-it-works and join pages, `ProductShell`, and the landing footer — each a "Docs" link rendered only behind a null check. Two deep links where a page exists for the concept being explained in prose: the layout editor's floor/ceiling hint → `features/create-room-and-layout`; the guest-list card → `features/guest-whitelist`.

**Asserted, not described.** `_gate-docs-link.mjs` (27/0): layer A imports the real helper — unset → null for root and every slug; set → every slug under the base, README folds into its section, unknown slug still null, whitespace-only is unset. Layer B: every slug is a SUMMARY entry; every surface's `docsUrl` use is behind a guard and no placeholder href exists. Layer C, the build-time truth: built WITH the fixture URL, the href is in 14 server-bundle files; built WITHOUT, none in 343 files scanned. `web/.next` was left in the WITHOUT state, which is what production is. `tsc --noEmit` 0.

ASSUMPTION carried into the code comment and CONNECTING-GITBOOK step 8: GitBook page URLs follow file paths under Git Sync; confirm one deep link after the first sync and add a redirect if not.

### Call options (2 of 3 taken)

**B. Glossary** — `docs/glossary.md`: 42 project terms with the file where each is real, and 17 git/agent terms the owner asked to have explained (ahead/behind, fast-forward, silent revert, stash, worktree, gate, fail-open, discrimination, commit ≠ ship, owner action, status call). Public, root-level; `docs-summary.mjs` now names the four pre-existing root-level record files explicitly so a new root page is public by default.

**A. Diagrams** — one Mermaid flowchart on the architecture page (browser/OBS → the one process → the stores, with LiveKit, Tempo and the platforms), text-sourced beside the ASCII version. Not extended to the flow pages: each flow is already a step table with a source per row, and a diagram would restate it without adding a citation.

**C. Public-only branch** — not taken. `docs:summary --public-only --out` produces the seed; creating and maintaining a second branch is the owner's call once a space exists (U5 asks whether Notes belong in it).

## 5. Report (Run 2)

**Verdict: the handbook is on the branch GitBook will sync, every claim in it cites its source, the honesty check and the GitBook check are green, and the app links to it only once the owner sets one variable — nothing is at risk in production, and the one thing this pass found that IS at risk (the bounty badge pinned under a bottom-left layout) is filed, not fixed, because Run 2 changes no behaviour.**

### What shipped (live at `a90604a` on `v0-ui-migration`; DEPLOYED after 539s: the layout-editor docs-link string is in the served bundle (31 chunks))

- **53 authored pages** under `docs/` in the GitBook layout (`.gitbook.yaml`, `SUMMARY.md`, `.gitbook/assets`): a landing page, 7 concepts, 9 status-tagged features, the verification hard page and its limitations, 10 technical pages with interfaces embedded from source, 18 internal pages (launch readiness with a 27-row retest checklist, 12 work-history periods, roadmap, outstanding, a stable-id limitations register, six status calls), a glossary, and `docs/notes/` for you. 46 pre-existing record pages are listed under Internal, untouched.
- **Four scripts** — `docs:check`, `docs:sync`, `docs:summary`, `docs:gitbook-check` — and `docs:verify` as the chain; `CONTRIBUTING-DOCS.md`, `CONNECTING-GITBOOK.md`.
- **The docs link in the app**, behind `NEXT_PUBLIC_DOCS_URL`, with a 27-assertion gate that proves absence and presence against real builds.
- **Two fixes outside the docs**, both small and both verified: the stale tail of the freeze-delay derivation comment (`bounty-claim.config.js`, comment only), and `_gate-bounty-claim` section G moved onto the readiness-polling harness after it raced twice under build load (102/0 after).

### What I decided

- **The pre-existing engineering record stays where it is** (briefs, decisions, design, legacy, reference, ui-overhaul, four root files) and is grouped under Internal by one set in `docs-summary.mjs` — because `OPEN-ISSUES.md`, `AGENTS.md` and the pages themselves link to those paths and the pass does not edit pages it did not write. This deviates from "one directory, trivially separable"; a `git mv` plus one set edit restores it. Notes are excluded from `--public-only` too (U5).
- **Public pages do not link into the internal half at all** — eleven links rewritten as plain references after the checker caught them. The sidebar still shows Internal in the same space; a second, public-only space is call option C, not taken.
- **The shared pre-launch notice is a stamped region, not an include** (GitBook has none): `docs:sync --write` re-stamps it from one file; leaving stealth is one edit and one command. HTML-comment markers are an assumption about GitBook's normaliser (L28).
- **Call options A and B taken** (a Mermaid architecture diagram; the glossary with the git/agent vocabulary you asked for), **C not** (a public-only branch needs a space to publish to first).
- `docs:sync` skips `.json`/`.jsonl` names that are not in the repo — runtime data files named in prose, not sources.

### What I found

- **The bounty badge does not follow the layout origin.** `ROADMAP.md` specced "the barcode takes the diagonally opposite corner automatically"; Pass A shipped the editor with `#bounty-badge` still fixed bottom-left. A bounty room with a bottom-left origin stacks tiles over the badge the verifier reads. Default origin is top-right, so no unedited room is affected; no rooms have chosen bottom-left in stealth. Filed: OPEN-ISSUES entry, L13, E1, U4. Not fixed — Run 2 rule.
- **The freeze-delay comment still described the 90 s / 60 s pair** Pass A replaced with 75 s / 51 s and claimed 60 s "survives D = 0", which 51 s does not (right bound 45 s at zero delay). Corrected, including that zero-delay stubs pass only because their clips are short.
- **Sources that disagree**, cited both ways on the pages rather than resolved: which chain (Tempo per `server.js`/`rooms-store.js`; "Arc network" still in `layout.tsx` keywords and `ARC_*` in `.env.example`); X parked (`platform-feasibility.md`) vs X proven on self-capture (`2f6e5d4`) — different questions, both true; Kick "no VOD" in the streamer-facing notice vs the recorded correction; viewer-proportional payout specced in B6 vs refused in `bounty-stream-context.js`; `README.md` describing a VDO.Ninja-era product.
- **No `REPORT-*.md` files exist**, despite the spec naming them as a primary source; the record lives in `DECISIONS.md`, `OPEN-ISSUES.md`, the briefs and the handoffs, all read in full.
- **Section G of `_gate-bounty-claim` raced twice in a row** (`0,0,0`) after two builds — the fixed 9 s sleep, not the product. On the harness: 102/0, routes answering `404,404,404`.

### The UNCLEAR list (docs/internal/needs-a-status-call.md)

U1 — is `/api/join/mpp` a live seat-payment mode or retained code? (The join page calls only `/api/join/passkey`.) · U2 — Kick VOD wording shown to streamers vs the recorded correction. · U3 — is dark mode still broken (`_gate-theme` red 2026-08-26, not re-run since the Nerve skin)? · U4 — badge follows the layout origin, or the editor refuses bottom-left? · U5 — do your Notes belong in the public half? · U6 — viewer-proportional payout: dead or deferred?

### Verification

`docs:check` 0 uncited claims in authored pages (194 advisory hits across 46 record pages, never failures) · `docs:sync` 0 drifts (proven to detect a deliberate edit: 6 pages flagged, cleared on revert) · `docs:gitbook-check` 0 errors, 2 advisory · `docs:summary --check` current · `_gate-docs-link` 27/0 including the two real builds (href in 14 server files with the fixture, 0 of 343 without) · `tsc --noEmit` 0 · existing suite at baseline: `_gate-bounty-claim` 102/0, `_gate-room-poster` 20/0, `_gate-missed-code-authoritative` 16/0 · Gate H 0 offenders · live `/how-it-works` renders no Docs link (variable unset in Railway), as designed.

### What's on you

1. **Connect GitBook** — `CONNECTING-GITBOOK.md`, eight steps, sync `v0-ui-migration`. Then set `NEXT_PUBLIC_DOCS_URL` in Railway and trigger a build (build-time variable); confirm one deep link (step 8).
2. **Six status calls** above; each is one tag change on one page.
3. **The badge/layout collision (U4)** — decide which fix; either is small and gate-able.
4. **The retest checklist** on `docs/internal/launch-readiness.md` is the launch gate: 27 rows, three of them owner actions already on the outstanding list (identity migration on prod, `BOUNTY_ADMIN_KEY`, LiveKit webhooks), one that must be built (a single suite entry point), one that does not exist (real settlement).
5. **Two stale worktree registrations** still print `Permission denied` on every commit — pause OneDrive for the folder and `git worktree prune`.
