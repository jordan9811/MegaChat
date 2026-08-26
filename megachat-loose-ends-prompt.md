# MEGACHAT: SOLO RUN — CLOSE THE LOOSE ENDS, BUILD THE FRONT DOOR

/goal

Nobody is available and no new credentials exist. Everything here runs without a stream key, without a live broadcast, and without any human decision. Push the product as far as it can go on what is already in the repo and in env.

Branch `feat/loose-ends` off trunk after the merge in T0. Commit per unit, HEAD always builds. Log judgment calls in `DECISIONS.md`.

**Standing constraints:** no settlement, Gate H zero transfer calls, `BOUNTY_CLAIM` off by default, real pages not mirrors, gates exercise HTTP routes not just stores, zero external API spend inside gates. LiveKit budget 20 minutes, report actual.

**Read this before starting.** Self-capture was found this week to have never once worked, and it went unnoticed because a gate asserted verification *ran* rather than that it *found something*. Three separate times now, a clean number in this project has described a single case: one corpus code, one timeline alignment, one gate driving a stale server. Assume the same class of fault is still hiding. Where you write a gate, assert on the count and content of what was found, never on the fact that a function was called.

---

## T0: Merge and clean

- Merge `feat/capture-hardening` into `v0-ui-migration`. Full suite against the post-merge tip, SHAs reported. This auto-deploys, so confirm the deploy is live and serving before continuing.
- `_gate-phase5-oauth.mjs` has been crashing since the sign-in buttons it drives were deleted. Retarget it to the current auth surface or delete it. Do not leave a permanently red gate in the suite; it trains everyone to ignore red.

## T1 (P0): The fan record-and-send surface

**This is the single highest-value item in the repo and it has been the blocker for weeks.** Escrow, watermarking, verification, moderation, payouts and refunds all exist. Nothing calls `storeClip` from any UI. A fan cannot record a MegaChat for a streamer who is not on the platform, which means the entire bounty mechanic has no front door.

Build the approved flow, in this order:

`record → preview → re-record if unhappy → set contribution amount → set expiry → pay → submit`

- **Its own recording context.** A MegaChat records into a room; an unclaimed streamer has none. Do not fake a room to reuse the existing path unless that turns out genuinely cleaner, and say why if it does.
- **Pay at submit, never at record.** Nobody pays for a take they are about to discard.
- **Minimum duration** enforced from the same derived config, surfaced before recording starts rather than after.
- **Rejection policy disclosed before payment**, machine-readable off the pledge route.
- **Status page** with the full ladder: pending moderation, approved, awaiting claim, claimed, played, paid, expired, refunded, rejected. Each state says what happens next.
- Reachable from the bounty program page and from an individual streamer's bounty page.

Gate it end to end over HTTP in a real browser: record, submit, and assert the clip actually lands in the clip store and its evidence row keys correctly against the pledge. That last assertion is exactly the class of bug that hid in self-capture.

## T2 (P0): Wire the confidence tiers to release

The tiers exist as a table. Make them decide something.

- Tier 1 (external capture confirms) and Tier 2 (self-capture plus obs-websocket scene-item confirms) auto-release.
- Tier 3 (self-capture alone) auto-releases if stream-context passes.
- Tier 4 (any signal disagrees) routes to the review queue with every failing cause named.
- **Payout is identical across all passing tiers.** Assert in the gate that the evaluator returns no amount, rate, or multiplier field at all, and that a no-OBS streamer receives the same figure as an OBS-corroborated one.
- Wire the obs-websocket scene-item query to run during air sessions and record its result as evidence, not just as a live UI check.

## T3 (P1): YouTube and Rumble external capture

Both are straightforward and neither needs a broadcast to build.

- **YouTube:** `FrameSource` via yt-dlp, live and VOD. Live status and concurrent viewers via the Data API. Note the quota shape: we never hunt for a stream, the streamer opens an air session and hands us the watch URL, so this is a cheap confirm of a known video id, not an expensive search.
- **Rumble:** `FrameSource` via yt-dlp (it has three dedicated extractors). Live status and viewer count via Rumble's free Live Stream API, where the creator generates a URL embedding their own id and key. That single URL is both ownership proof and live-status feed. Treat possession of it as a capability, and say plainly in the handoff that possession is transferable in a way OAuth is not.
- Both behind interfaces, both gated against local stubs, zero external calls inside gates.

## T4 (P1): X ownership wiring

`privy-identity.js` already maps `twitter_oauth` to a real username. The claim layer's `SUPPORTED` set is `{twitch, kick}`. Add X.

- Verify by reading the code that Privy genuinely returns the handle rather than an opaque id, and prove it in a gate rather than assuming.
- X still has no pullable stream, so X claims land on the self-capture plus obs-websocket path. Make sure the tier logic handles that correctly rather than falling through to an error.

## T5 (P2): pump.fun capture

pump.fun serves standard HLS, measured across eight live streams, pullable server-side with no auth.

- Add the `FrameSource`. Its playlist is append-only, so enter at the live edge, which the recorder now handles.
- Use `EXT-X-PROGRAM-DATE-TIME`, present on every segment, to skip most of the timeline calibration work. Prove in a gate that calibration is bypassed when a wall clock is available, and that it falls back correctly when one is not.
- Ownership stays unsolved: streams key to a coin mint, not an account. Do not build wallet-signature ownership in this run. File it with a precise description of what it would take.

---

/loop

Iterate T0 through T5 until every gate passes and the full suite is green with no regressions. Stop and report if the same gate fails three times rather than grinding.

---

## Hand back

- Merge result and deploy confirmation.
- Whether the fan can now actually record and submit a clip, proven over HTTP in a real browser.
- What the tiers decide, and the assertion that payout does not vary across them.
- YouTube, Rumble, pump.fun capture status, and what remains unproven pending a real broadcast.
- Whether Privy really returns the X handle, proven not assumed.
- What you would attack first if you were trying to get paid without playing clips, given everything now in place.
- Gate SHAs, LiveKit minutes, external spend, updated `OPEN-ISSUES.md`, brief per convention.

Decide rather than ask. If something needs a credential or a live broadcast, stub it honestly, file exactly what is needed, and keep moving.
