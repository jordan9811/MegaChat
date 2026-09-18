# Glossary

Every term this project invented or reuses oddly, one line each, with the file where it is real. The second half is the git and agent vocabulary that shows up in the run reports.

## MegaChat terms

| Term | Meaning | Where |
|---|---|---|
| **Room** | A streamer's configured space: prices, seat count, layout, switches. One JSON record. | `rooms-store.js` |
| **Seat** | One viewer's metered place on camera inside a room; lives in memory while the viewer is connected. | `server.js`, `activeSeats` |
| **Live seat / Join Stream** | The live path: your camera on the stream, charged per second. | `server.js`, `/api/join/passkey` |
| **MegaChat / letter** | A short recorded clip a viewer pays a flat price to have played once on the stream. The code says *letter*. | `letters.js` |
| **Tick** | The metering unit: `passkeyTickPrice` every `passkeyTickSeconds` (default `0.001` / 1 s). | `getEnvDefaults`, `rooms-store.js` |
| **Session cap** | The most one seat can spend (`maxSession`, default 2); the amount approved up front. | `rooms-store.js` |
| **Pinned seat** | The streamer's co-host: rides above the paid cap, meter paused. Whitelisted guests are pinned seats granted at join. | `server.js`, `setSeatPinned`, `tryWhitelistJoin` |
| **Effective cap** | Configured seats plus active whitelist guests, capped at ten. What every surface reports. | `effectiveMaxSeats`, `server.js` |
| **The overlay** | The one browser source in OBS that draws tiles, MegaChats and the badge. | `public/overlay.html` |
| **Stinger** | The entrance/exit animation (and sound) on a tile. | `public/overlay.html`; `letters.js` `FLY_IN_OK` |
| **Layout** | Where tiles sit on the canvas: origin corner, direction, margin, tile size, gap. On the room record with a version. | `resolveLayout`, `rooms-store.js` |
| **Lazy connect** | The overlay holds a LiveKit connection only while a seat is being bought or held. Fixed a quota-draining leak. | `livekit-lazy.config.js` |
| **Burn breaker** | Refuses *new* LiveKit tokens past a budget read from signed webhooks; never cuts a live session. | `livekit-breaker.js` |
| **Handle** | The name a room lives at (`/<handle>`), or the name a person reserved by signing in. Two registries. | `rooms-store.js`, `identity-store.js` |
| **Owner key** | `provider:platformId` — the stable id of a signed-in account, stamped on rooms and whitelist lists. | `roomOwnerKey`, `auth.js` |
| **Guest whitelist** | A streamer's standing free list, keyed on the owner, pinned to identities. | `guest-whitelist.js` |
| **Follow my stream** | The room hides from discovery on the first dark reading and pauses after five minutes; resumes on live. | `followTick`, `server.js` |
| **Airing** | One record per broadcast a room went through, with moments (seat, seat_leave, megachat). | `airings-store.js` |
| **Moment** | The second something worth opening at happened, stored as absolute time plus offset. | `addMoment`, `airings-store.js` |
| **Poster** | One JPEG per room from the midpoint of the longest clip playback, or a typographic card when there is no capture. | `room-poster.js` |
| **Bounty / pool** | Money fans pool against a reserved handle, folded from the ledger on every read. | `bounty-store.js`, `bounty-escrow.js` |
| **Pledge** | One fan's money across up to three streamers, claimable by whichever goes live first. | `pledge`, `bounty-escrow.js` |
| **Reserved handle** | A streamer's name a pool sits against before they have claimed it. | `reserveHandle`, `bounty-store.js` |
| **Air session** | The span during which a claimant's overlay issues verification codes; capture runs only inside it. | `createAirSession`; `bounty-capture.js` |
| **Playback window** | One clip's airing inside a session, with its own codes; the payout unit. | `bounty-watermark.js` |
| **Badge / watermark / code** | The rotating dot-matrix code the overlay draws while a clip plays, bound to that playback. | `bounty-watermark.js`, `public/code-matrix.cjs` |
| **Self-capture** | MegaChat's own rolling recording of the *public* stream during an air session, frozen around each clip. | `bounty-capture.js` |
| **External capture** | Reading the platform's own replay or live HLS. Twitch archive, YouTube replay, pump.fun's append-only playlist. | `frame-sources.js` |
| **Freeze window / freeze delay** | 75 s of media held, frozen 51 s after a clip ends — sized to the measured spread of broadcast delays. | `bounty-claim.config.js` |
| **Calibration** | Measuring each broadcast's timeline offset from its own content rather than assuming one. | `bounty-timeline-calibration.js` |
| **Confidence / detection rate** | Read quality of the samples that read, and the fraction that read at all — two numbers, both gated. | `bounty-verifier.js`, `bounty-escrow.js` |
| **Confidence tier** | Which evidence backed a verification (1 external, 2 self-capture + OBS, 3 self-capture, 4 disagreement). Decides review routing, never amount. | `bounty-confidence.js` |
| **Stream context** | Warm-up and tail rules: nothing counts in the first ten minutes; the stream must continue past the last counted clip. A gate, not a dial. | `bounty-stream-context.js` |
| **Evidence chain** | The append-only log everything a payout is computed from is written to. | `bounty-evidence.js` |
| **Ledger** | The append-only money history with a checksum chain; pools are folded from it. | `bounty-ledger.js` |
| **Settlement (stub)** | The interface that would pay; the only implementation records an intent and moves nothing. | `bounty-settlement.js` |
| **Gate H** | The gate that requires every transfer to be accounted for: one settlement door for server-signed transfers, a config pin for the autonomous MPP settle, a call-site pin for client-signed paths — and, as its legacy section, zero transfer-shaped calls in the bounty modules. | `_gate-money.mjs`; `_gate-bounty-claim.mjs` section H |
| **NOT_SHOWN** | A playback whose required code was never observed; outranks any confidence number. | `bounty-verifier.js` |
| **SOURCE_UNAVAILABLE** | "We could not look" — routed to review, never a denial. | `frame-sources.js` |
| **Review queue** | Where ambiguous or disputed verifications wait for a person; blocks release. | `bounty-store.js`, `createReview` |
| **OBS one-click / Add to OBS** | The obs-websocket flow that writes every browser-source setting the badge depends on. | `web/lib/obs-oneclick.mjs` |
| **Scene check** | The streamer's browser asking their OBS whether the overlay is on screen; corroboration only. | `web/lib/obs-scene-check.mjs` |
| **Platform profile** | Per-platform: replay retry or not, sampling multiplier, and the sentence the streamer reads. | `PLATFORM_PROFILES`, `bounty-claim.config.js` |
| **Rehearsal** | A harness that broadcasts for real (ffmpeg push, real platform) and runs the whole path. | `_rehearsal-*.mjs` |

## Git and agent vocabulary

| Term | Meaning here |
|---|---|
| **Gate** | A standalone script that stands up real infrastructure, asserts behaviour and exits non-zero on failure. Behaviour is proven by a gate, not asserted in a commit message (`AGENTS.md`). |
| **Green / red** | A gate's result. Green on a stale server or a stale build is a claim about the past — see [Testing methodology](technical/testing-methodology.md). |
| **Fixture** | Synthetic input a gate runs against (a stub HLS stream, a generated badge corpus). A fixture pass is not a real-broadcast pass. |
| **Stub** | A stand-in implementation: a mock OBS, an instant-publish HLS stream, the settlement stub. Every stub hides whatever it does not model. |
| **Fail-open / fail-closed** | On error, allow (open) or refuse (closed). Money paths here fail closed; alerting and moderation fail open and say so. |
| **Discrimination** | Proof that a test would fail if the fix were reverted, by running the old behaviour alongside. |
| **Branch** | A named line of commits. `v0-ui-migration` is what production deploys from. |
| **Ahead / behind** | How many commits one branch has that another lacks, and vice versa. "3 ahead, 0 behind" means it can fast-forward. |
| **Fast-forward** | Moving a branch pointer along a straight line of commits with no merge commit. `git push origin <branch>:v0-ui-migration` does this to prod. |
| **Merge** | Combining two lines of history into a commit with two parents; conflicts are places both sides changed the same lines. |
| **Conflict resolved by recency** | Taking the newer side of a conflict. The Pass A rule: check whether the other side held a fix with a matching signature before doing so. |
| **Silent revert** | A merge or checkout that quietly puts an older version of a file back — the thing the worktree audit in Pass A prevented. |
| **Worktree** | A second checkout of the same repository in another directory, on its own branch. Several exist for this repo; two stale registrations are OneDrive-locked. |
| **Stash** | Uncommitted changes set aside by git. One stash in this repo is not the agent's and is recorded by SHA, untouched. |
| **Commit ≠ ship** | A commit on `v0-ui-migration` is live only once Railway has deployed it and the live URL serves it. |
| **HEAD always builds** | Every commit must build; an intermediate commit that cannot build is not made (`megachat-pass-a-prompt.md`; `DECISIONS.md`, "Deck landed as one build-verified commit"). |
| **Owner action** | A step only the person with the accounts, credentials or product authority can take. Listed on the internal *Outstanding* page. |
| **Status call** | A question the repo does not answer and the owner must; tagged `UNCLEAR` until decided (`scripts/docs-check.mjs` enforces the tag discipline; the list is the internal *Needs a status call* page). |
