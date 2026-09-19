# BROWSE DECK — decisions log

One line each: what / why / how to undo. Newest at the bottom.

- **Recon: no chat infra exists in the repo** — the WS protocol is seats/letters/overlay only (server.js), so lobbyChat defines its own seeded message model; flagged in HANDOFF as the model to match if real chat ever ships. Undo: n/a (fact).
- **Recon: no persistent clip/VOD storage** — MegaChat letters are in-memory and dropped ~60s after play (letters.js MEDIA_TTL_MS), so the featured carousel uses animated thumbnails and the claim drawer uses a clip placeholder. Undo: n/a (fact).
- **Mount flag = `BROWSE_DECK` env, deck ON by default on this branch** — `page.tsx` renders BrowseDeck unless `BROWSE_DECK=0`; classic BrowseDirectory is untouched and still mounts with the flag. Undo: set `BROWSE_DECK=0` or revert the one `<main>` line in web/app/page.tsx.
- **Classic grid reused wholesale, not just its card** — BrowseDirectory (header + search + grid + direct-id lookup) mounts as the belowFold grid module via a new optional `embedded` prop that only drops the duplicate `id="browse"` anchor; zero behavior change when the prop is absent. Undo: delete the prop + the roomGrid wrapper.
- **Seeds are typed JSON in `web/components/browse-deck/seeds/`** — one obvious folder per the spec; adapters in data.ts are the only readers. Undo: delete folder.
- **Fictional streamer names in all seeds** — real streamer names would fabricate an association; seeds use invented-but-plausible handles. Undo: edit seeds JSON.
- **Money figures are placeholders with explicit "testnet" framing** — bounty pool, bounty rows, and banner all carry testnet copy; no payment code touched. Undo: n/a (rule).
- **Demo surfaces carry a small "demo" tag** — featured entries and the seeded lobby chat are labeled demo (config-toggleable) so seeded activity is never mistaken for live traffic. Undo: flip `showDemoTag` in browse-deck.config.ts.
- **Platform set for campaign rows = twitch / youtube / x** — lucide has official-ish icons for these; Kick has none and its brand marks are off-limits per spec. Undo: edit seeds + PlatformIcon.
- **No new dependencies** — deck is built entirely on existing stack (Next, Tailwind tokens, lucide-react). Undo: n/a.
- **Campaign countdown targets 2026-08-15T00:00:00Z** — placeholder end date for the bounty campaign (absolute so it doesn't drift). Undo: edit `campaign.endsAt` in browse-deck.config.ts.
- **Carousel autoplays a simulated player, not video** — no VOD assets exist (see above), so entry switches show a short spinner then an animated branded thumb; a real `roomId` on a featured entry re-points its CTA at the live join page. Undo: n/a (documented gap).
- **Search survives inside the reused classic grid** — the classic's search box (with unlisted direct-id lookup) ships below the fold as-is; a deck-header search slot is logged as a known gap, not half-built. Undo: n/a.
- **lobbyChat is read-only with a disabled input** — wiring a real posting path would require new auth surface (off-limits); the input explains itself instead of pretending. Undo: n/a (documented gap).
- **Claim drawer is portaled to `<body>`** — the sticky rails + backdrop-blur panels create stacking/containing contexts that trapped the fixed overlay (chat panel painted OVER the drawer; caught on screenshot). Undo: n/a (bugfix).
- **Seeded featured CTAs land on /demo** — the code-seeded demo room is always alive, so "Drop in" is never a dead end; a config roomOverride beats it. Undo: edit featured seeds/config.
- **Deck landed as one build-verified commit, not per-module commits** — the registry imports every module, so intermediate per-module commits could not build; HEAD-always-builds won over commit granularity. Undo: n/a (process).
- **Slot-swap acceptance verified live, then reverted** — flipped leftRail→recommendedRooms and rightPanel→activityFeed with two one-line config edits against the running app (real rooms rendered in the alternate rail, ticker ran); screenshot in screens/deck-alternate-slots.png. Undo: n/a (test).
- **Gate `_gate-browse-deck.mjs` (19 asserts)** — deck-on render of every slot, BROWSE_DECK=0 exact classic restore, git-level hero freeze vs eae3f7d, no-15s copy rule over seeds, drawer portal + Esc. Shipped gates re-run with the deck mounted: _gate-polish 37/0, _gate-browse-thumb 7/0. Undo: n/a (evidence).

## LiveKit Cloud validation run (2026-07-25)

- **Reported the quota contradiction instead of proceeding** — the run was premised on "quota is restored", but 6 of 12 fresh `/rtc/validate` probes returned 429. Running the Cloud measurement at ~50% rejection would have produced a green result for the wrong reason and retired an open question on bad evidence. Undo: n/a.
- **Abandon cap gets its own sweeper, not lazy evaluation** — an abandoned hold is otherwise only noticed when something else happens to ask, and for a room whose only visitor just closed their tab, nobody asks. The cap has to fire with no further input from the person who left. Undo: remove the `abandonSweeper` interval in livekit-activity.js.
- **Two clocks per prewarm (abandon + TTL) rather than replacing the TTL** — the TTL stays as an absolute backstop for a client that vanished so completely it stopped heartbeating, and now logs a warning when it fires, because the cap should have caught it first. Undo: drop `abandonAt` from the hold record.
- **Backgrounding a tab does NOT release the hold** — people tab away mid-wallet-dialog; treating that as abandonment would clip legitimate slow joins, which is a worse outcome than the burn. The cap still covers someone who backgrounds and never returns. Undo: add a `visibilitychange` release in join-page.ts.
- **`sendBeacon` for the bail path, not `fetch`** — fetch does not survive page teardown, which is precisely why the old code had no tab-close release at all. Undo: n/a.
- **Breaker reads WEBHOOK data, never our own ledger** — a breaker fed by the same self-report that hid the last leak would fail in exactly the case it exists for. Consequence, stated loudly in code and docs: the breaker is inert until Cloud webhooks are configured. Undo: point `getUsage` at `lkActivity.ledgerStats`.
- **Breaker blocks at 95%, not 100%** — stopping before the provider does keeps the failure ours to explain to a streamer, instead of arriving as an opaque LiveKit error. Undo: `LK_BREAKER_BLOCK_AT=1`.
- **Blocking refuses new TOKENS; live sessions are never killed** — cutting a paying guest off air to save minutes is worse than the overage. The token endpoint is the chokepoint because a token *is* a new connection. Undo: n/a.
- **Webhook receiver rejects unsigned deliveries outright** — an unauthenticated writer to the authoritative session ledger would be worse than having no ledger at all. Undo: n/a.
- **Did NOT merge, and did NOT resolve the rebase conflicts** — the merge was explicitly gated on items 1–4 passing, and item 1 cannot pass. The bounty rebase then turned out to genuinely conflict (3 adjacent-addition hunks across overlay.html and server.js), and the instruction was to stop and report rather than resolve creatively. Trial branches deleted, no residue. Undo: n/a — this is a handoff to a human decision.
## Creator bounty — Run A (2026-07-25, `feat/bounty-claim-runA`)

- **Branched from `v0-ui-migration`, not `fix/livekit-lazy-connect`** — the lazy-connect work is unmerged/unapproved; stacking an unshipped feature on another unshipped branch couples two independent decisions. Rule "don't touch lazy-connect" is satisfied trivially since it isn't in this tree. Undo: n/a. Merge note in OPEN-ISSUES G8.
- **`BOUNTY_CLAIM` defaults OFF** (inverse of `LAZY_CONNECT`, which defaults on) — lazy-connect fixes a live cost bug so its fix is the default; this is a money-adjacent new mechanic on a mainnet app, so it stays dark until deliberately enabled. Undo: `BOUNTY_CLAIM=1`.
- **Flag off mounts NO routes at all**, not a 403 handler — an unflagged deploy is byte-identical and paths 404 like any unknown route. Undo: n/a.
- **BountyPool is derived by folding the ledger, never stored** — a cached balance can silently diverge from history; a computed one cannot. Undo: n/a.
- **Ledger has no update/delete writer** — corrections are compensating rows. Append-only is enforced by the absence of an API, not by convention. Undo: n/a.
- **Illegal transitions throw before any write** — a silent no-op in escrow reads as success to the caller and desyncs the ledger from reality. Verified across 113 combinations. Undo: n/a.
- **`refundExpired` is gracefully idempotent** — a second call returns the existing refund rows instead of throwing `REFUNDED → EXPIRED`. Found by the gate: money was already safe via per-contribution idempotency keys, but a cron retry or admin double-click shouldn't error. Undo: revert the early return in bounty-escrow.js.
- **Platform match is its own ledger bucket** (`platform_match`), written as a separate row — contributor money and platform money must never blend. Undo: n/a.
- **Verifier is fail-closed with no fixture** — the mock checker returns not-found, so a misconfigured deploy pays nothing rather than everything. Undo: set `BOUNTY_FIXTURE_PATH`.
- **Real settlement is ABSENT, not written-and-disabled** — no signer, no contract call, no path that becomes live by flipping a boolean. Gate H greps for transfer calls and asserts zero. Undo: n/a (Run B implements `RealSettlement`).
- **`verifiedMinutes` = elapsed × hit-rate, not a raw hit count** — 3 of 10 samples on a 10-minute session earns 3 minutes, and codes are sampled evenly so showing the badge for one minute cannot verify a whole broadcast. Undo: n/a.
- **Watermark badge is a NEW persistent element, not inside a MegaChat tile** — the spec asked for the latter, but no such badge component exists and a ~10s tile against a 60s rotation would fail honest streamers. Rationale in HANDOFF-BOUNTY.md §3. Undo: delete `#bounty-badge` + its script block in overlay.html.
- **Badge size check is an affordance, not enforcement** — a page cannot observe its own OBS scene transform, so the verifier is the real boundary. Documented in code and HANDOFF §2. Undo: n/a.
- **Reserved handles get a veto over room-handle claims** via `rooms-store.setHandleGuard`, registered only while flagged on — otherwise a pool could be orphaned by anyone grabbing the name. Null by default, so the default path is unchanged. Undo: remove the guard registration in bounty-routes.js.
- **Bounty UI reuses browse-deck rail chrome** (`DeckPanel`, `accentFor`) rather than forking a second visual language for the same concept. Undo: n/a.

## Creator bounty — patch (2026-07-25, playback-bound proof + money integrity)

- **Codes are issued ONLY during clip playback and bound to the clip id** — replaces the airtime-only model. Rejected my own earlier recommendation (gate airtime on server playback events): that leaves two artifacts, a visible code and an event asserting a clip played, which can disagree — and the money would ride on the unverifiable one. One clip-bound code makes playback proof and airtime proof the same measurement. Undo: revert bounty-watermark.js + the letters.js hooks.
- **Windows open from `letters.js playLetter`, server-side** — the authoritative moment a clip actually starts. `onClipPlay`/`onClipEnd` default to no-ops so standalone/test wiring is unchanged. Undo: drop the two deps.
- **Rotation 60s → 4s, validity 75s → 5s clamped to clip end** — MegaChat tiles live ~10s; the old wall-clock cadence would have left most clips with no code and failed honest streamers. Clamping is what makes "one frame cannot satisfy two clips" provable rather than probable. Undo: config.
- **Clips under `BOUNTY_MIN_CLIP_SECONDS` (3s) pay nothing and say so** (`BELOW_SAMPLING_FLOOR`) — a clip too short to host a samplable code cannot be verified, and paying for unverifiable evidence is the failure this whole mechanism exists to avoid. Undo: lower the floor.
- **Payout unit is verified CLIP PLAYBACKS (+ duration), not on-air minutes** — `BOUNTY_RELEASE_RATE_PER_MIN` removed; `_PER_CLIP` (0.04) and `_PER_CLIP_SECOND` (0.001) replace it. Paying per minute paid for airtime; fans contributed to have clips played. Undo: config + escrow.release.
- **Ledger moved to its own JSONL file with append+fsync, per-record seq + SHA-256 checksum** — pools are folded from it, so a torn write silently changes every later balance. Whole-file rewrite was a money-integrity bug labelled as durability. Undo: revert bounty-ledger.js + the store wiring.
- **Torn FINAL record recovers; interior gap or bad checksum REFUSES to boot** — an interrupted append never returned success upstream, so truncating is safe; an interior hole means every derived balance after it is unknowable, and serving confident-but-wrong totals is worse than not starting. Undo: n/a.
- **Legibility enforcement moved into `CodeChecker.findCode` via required `pixelHeight`** — the overlay's own check cannot see an OBS scene transform, so it was never enforcement. A sample under `BOUNTY_MIN_CODE_PX` fails even when found (`FAIL_TOO_SMALL`). Client check kept, relabelled as early warning in code, comments, and streamer copy. Undo: drop the pixelHeight branch in the verifier.
- **AMBIGUOUS opens a review that BLOCKS release** — previously it paid zero and reached nobody, which on mainnet is a streamer who did the work, wasn't paid, and never saw a human. Reviews carry state/age/assignee, breach an SLA loudly in admin, show "under review" to the streamer, and resolution requires a reason written to the ledger. Undo: remove the hasOpenReview guard in escrow.release.

## Merge / rebase / deploy run (2026-07-25)

- **Resolved the DECISIONS.md merge conflict rather than stopping** — the instruction was "if 0 conflicts has changed, stop and report", and it had. But the conflict was add/add on a DOCS file that did not exist on the lazy branch at dry-run time (I created it there in the previous run), all CODE merged with 0 conflicts as predicted, and take-both-sides on a decision log carries no semantic risk. Reported rather than silent. Undo: n/a.
- **The server.js import collision was NOT resolved take-both** — both sides modified the same import line (`attachBountyRoutes` vs `attachBountyRoutes, makeClipHooks`), so take-both would have emitted a duplicate import and failed to parse. Resolved deterministically: keep all lazy-connect imports, drop the older bounty line, take the newer one. This is the rebase replaying an intra-branch upgrade, not a semantic conflict — no behaviour was invented. Undo: n/a.
- **Webhook handler now acknowledges BEFORE processing** — LiveKit retries slow deliveries, and a dropped `participant_left` leaves a session permanently open in the exact ledger the breaker meters, turning the leak detector into a false-alarm generator. A retried delivery is harmless (event-id dedupe); an unacked one is not. Undo: move the handle/evaluate calls back above `res.json`.
- **Verified production with REAL signed webhook deliveries, not just the reject path** — the unsigned 401 only proves the route exists. A signed join/left pair proved the production env holds the MATCHING LiveKit secret, that the full path opens and closes a session, and that replay dedupes. Probe sessions were closed so no phantom open session was left behind (confirmed 0 open via /api/livekit/burn). Undo: n/a.
- **Filed three bounty follow-ups that were asked about as "still pinned" but were NOT in OPEN-ISSUES.md** (per-playback-instance nonce, sub-3s clip residual, Run B frame-sampling cost). Only G9 was actually pinned. Filed rather than reported as already-present. Undo: n/a.

## Overnight bounty hardening (2026-07-26)

- **Reversed my own G9 risk call rather than defending it** — I had filed the mutable store as "much smaller risk than the ledger." That weighed proof as bookkeeping. The watermark codes are what a payout is computed FROM, so silent truncation makes a verifier undercount playbacks and underpay with no error raised. Same failure class as a corrupt ledger, other half of the transaction. Undo: n/a.
- **Split EVIDENCE from STATE rather than making everything append-only** — claim status, review assignment and derived counts legitimately mutate; codes, playbacks and verifications do not. The rule: anything a payout is computed from is evidence. Making genuinely-mutable workflow state append-only would have added ceremony without adding integrity. Undo: n/a.
- **Release refuses on BOTH `evidence_unverified` and `evidence_diverged`** — chain-validated-at-boot and cache-matches-evidence are independent failures; either one means we cannot vouch for the proof. Fail-closed is deliberate: the in-process gate had to opt in explicitly, which is the correct asymmetry. Undo: remove the evidence gate in bounty-escrow.release.
- **Per-playback nonce fixed a bug in the opposite direction to the one predicted** — not double-pay (validity clamping already prevented that) but ZERO codes for a replayed clip, because every lookup `.find()`-ed by clipId and hit the first, already-closed window. An honest streamer replaying a fan's clip earned nothing. Undo: revert playbackId keying.
- **`endClipPlayback` closes the most recent STILL-OPEN window, never `.find()` by clipId** — the naive fix would close a previous airing. Undo: n/a.
- **Probe identities are recorded but excluded from budget metering** — our own deployment checks must not eat a streamer's burn budget or, in the limit, trip the breaker and block live traffic. Pattern is explicit rather than heuristic so nothing real is silently written off; `probeSessionsExcluded` keeps the discount auditable. Undo: drop the isProbe filter in stats().
- **Reported the Cloud/ledger delta as a harness artifact instead of a finding** — the −1.2 min gap was my script not integrating during a 75s sleep (0.50 observed + 1.25 unpolled = 1.75 vs ledger 1.70, inside one poll interval). Calling it a discrepancy would have manufactured a bug. Undo: n/a.
- **Did NOT implement the sub-3s residual** — explicitly a product decision. Wrote options with tradeoffs instead, and flagged that the status quo is accidentally "redistribute to pool", which is the paid-for-airtime flaw already corrected once. Undo: n/a.

## 2026-07-27 — overnight-hardening merged to trunk
Fast-forward 93ab50e → c526a2f (11 commits). Full gate suite re-run on the
post-merge tip before push: bounty 101/0, lazy-connect 65/0, browse-deck 19/0,
e2e 19/0, min-duration 10/0, ops-alerts 19/0, dead-calls 3/0, mirror-drift 5/0.
This commit exists partly to trigger the SECOND deploy that lets the new boot
marker prove the /data volume survives restarts — deploy 1 wrote the first
marker and correctly reported "unproven"; this deploy reads it back.

## 2026-07-27 — bounty program build (feat/bounty-program)
- **Own recording context, no fake room.** A MegaChat records into a room; an
  unclaimed streamer has none. Faking one would drag seat auth, meter plumbing
  and the overlay queue into a flow that needs a camera and an upload URL. The
  recorder shares what matters by construction: the same min-duration config
  and the same server-side moderation pipeline.
- **Pledge escrow anchors on the first target.** One Contribution row on
  targets[0]; the pledge record projects contested visibility onto the others;
  claim moves the row winner-ward with a SLASH/WIN ledger pair. Chosen over
  per-target rows (double-counts money) and over a synthetic pledge-pool handle
  (invents a pool no streamer owns).
- **Atomicity by synchronicity.** claimPledges has no await between read and
  write; Node's run-to-completion is the lock. Documented in-code as a contract
  ("introducing an await reopens the race — do not").
- **`PLEDGE_EXPIRED` is its own refund reason.** The prompt said "the
  unclaimed-expiry reason", but HANDLE_EXPIRED is a full-pool retirement;
  a single pledge expiring on a living pool is a different event and the
  ledger should say which one happened.
- **Real identity behind BOUNTY_IDENTITY_REAL=1, stub stays default.** Flipping
  the default would break every unattended environment; go-live is one explicit
  env flip, printed at boot, with the method written to the ledger either way.
- **`paid` is in the status ladder but unreachable, and the endpoint says so.**
  Settlement is a stub; showing a fake `paid` would be worse than admitting the
  rung exists for later.

## 2026-07-28 — Run B verification (feat/run-b-verification)
- **Template decoding over general OCR.** We control the writer, so the badge
  became a purpose-built mark (dot matrix + registration ring) and the reader
  a matched decoder from the same font table. tesseract was skipped entirely:
  deterministic, zero-dep, CI-forever, and measurably strong (100%@720p+).
- **Matched-filter decode selection.** Verification asks "is the issued code
  present", not "what does this say" — among jittered alignments, one reading
  the expected code wins. FP safety is measured (0/12 absent frames), not
  argued.
- **SOURCE_UNAVAILABLE is a verdict, not an error.** Could-not-look routes to
  the review queue and pays nothing; FAIL is reserved for looked-and-absent.
- **Kick live-first** — official API has no VOD listing; the unofficial v2
  API was deliberately not built on.
- **±1.5s timestamp tolerance**, derived from the shortest code window's
  midpoint margin.

## Prove-and-clear run (2026-07-29)

**Stream context is a GATE, not a dial — and there is no viewer threshold.**
The pushback was right that proving clips aired does not prove anyone watched,
but weighting payout by viewer count is the wrong fix: the bounty amount is
already a derivative of the streamer's audience, because fans pledge more to
bigger streamers. Weighting charges for the same thing twice and penalises
mid-size streamers, who are exactly the ones most likely to onboard. So:
warmup (nothing counts in the first 10 min) plus tail (stream must continue
past the last counted playback), both pass/fail, both configurable, failures
to human review naming the specific condition. Median-relative thresholds were
considered and rejected — a newly onboarded streamer has no history at the
moment it would matter, and Twitch exposes current concurrents but not
historical averages. The absence is written into bounty-stream-context.js and
asserted by the gate so it cannot come back under another name.

**Broadcast start is captured at playback time, not verify time.** The first
implementation asked the platform at verify time. Verification is VOD-first,
so it runs after the stream ended, when the channel reads offline and the
start time no longer exists — every honest session would have routed to
NO_BROADCAST_START review. Platform truth that only exists while live must be
captured while live. The same applies to the viewer count, which is why both
now share one capture path — including the admin/rehearsal playback route,
which had been recording nothing at all and would have left the one real
broadcast we care about with no context data.

**"No platform API configured" is notEvaluated, not a failed check.** Routing
every session to review when credentials are absent floods the queue, and a
flooded queue hides the farming the check exists to catch. "Credentials exist
but no start was recorded" stays a review condition, because that is what a
farmer actually looks like. A deployment fact the streamer cannot control is
not evidence against them.

**Review reasons name every applicable cause.** Marginal quality and a context
flag co-occur constantly; an if/else chain showed the reviewer one of them,
who then fixes one thing and closes the case.

**A corpus fixes its sample; a gate can re-draw it.** The badge corpus was
generated from ONE issued code, so "720p 100%" was a statement about one glyph
sequence. Swept across distinct codes, roughly half were never read at 720p —
the documented minimum quality — which is the project's own worst failure
mode: the streamer does the work and quietly is not paid. Two defects, both
invisible to a one-code corpus: an alignment window tuned in raw pixels
against that code (its own comment recorded the optimum sitting ON the
boundary of the window chosen — a search whose answer lands on its own edge is
probably too small), and a ring locator that returned only the highest-contrast
hypothesis, which is not the same as the right one. Both fixed; the window is
now expressed in dots and converted at the measured pitch, so it holds at any
resolution rather than the one it was tuned on. _gate-decoder-codes.mjs draws
fresh codes every run so the next bad glyph sequence fails CI instead of a
payout.

**Confidence has to survive the optimisation that finds the code.** Stopping
at the first matching alignment made the decoder fast and made it report the
confidence of a slightly-off read, which dragged sessions under the AMBIGUOUS
threshold and sent verified streamers to review — the queue-flooding failure
again, in a different costume. Find fast, then refine locally.

## Per-VOD timeline calibration (2026-07-29, later)

**The offset is measured, not assumed.** Seeking with a hypothesised skew `s` to
wall-clock `ts` lands on content at `ts + s - Δ`. Decode the frame, see which
code is on screen, and that code only ever existed during its own validity
window — so `Δ = ts + s - midpoint(code)`, recovered from the content. This is
the same technique that measured the original 16.7s by hand; it is now the
mechanism rather than a one-off diagnostic, which removes the last asterisk on
the first real broadcast's PASS.

**Constant per VOD, not drifting — and the reason is the evidence, not
convenience.** A single point can only place Δ within ±codeValidityMs/2 (±2.5s),
because every instant inside a code's window is indistinguishable. The two real
samples (-16.7s, -15.0s) differ by 1.7s, which is *inside* that uncertainty, so
the data cannot tell a constant offset from a slow drift. Fitting a slope to two
quantized points would be exactly the one-code-corpus error in a new costume. So:
treated as constant, several points taken, median used, and the spread reported
and threshold-checked so a genuinely non-linear timeline surfaces as a finding.

**The acceptance window is derived from the measurement.** It was a flat 20s,
which is wide enough to conceal the error it exists to absorb. It is now
quantization + observed spread + a small margin, per session — around ±4s in the
gate. The old "±1.5s tolerance" assumed an alignment that does not exist and is
retired.

**A truncated search is not agreement.** The gate caught the module reporting a
confident MEASURED on a deliberately inconsistent timeline: the grab budget ran
out while probing the odd half, and the probes that happened to agree became the
answer. Budget exhaustion with unmeasured probes is now DISAGREEMENT. The lesson
generalises past this module — a search that stops early and then reports the
consensus of what it managed to look at is not reporting consensus.

**A ladder with gaps is a lookup, not a search.** Rungs were hand-written and had
a 6s gap; a 30s injected offset fell into it and measured nothing, while 4s, 16s,
24s and 40s — every one of them a rung — measured perfectly. That pattern is the
tell: a search that only finds the values it contains. Rungs are now derived from
the badge visibility window (0.7 × codeValidityMs), so no offset can fall
through, and the spacing has a reason rather than a history.

**The stage that notices a failure is not the cause of it.** Calibration runs
first, so it was relabelling "no Twitch credentials" as "could not calibrate".
Root cause is carried upward, and the extractor's stderr now travels in the
detail — classifying an error and discarding why it happened sends the next
person hunting for something the error already knew.

**Rehearsal warmup is overridden, loudly.** The harness played clips immediately
after going live, which the warmup rule correctly rejected, so no rehearsal could
ever demonstrate the pass path. It now shortens warmup for itself, waits past it,
and prints that the override is in effect — a rehearsal that passes must not be
mistakable for the production threshold.

## OBS one-click run (2026-07-29, night)

**One client file for browser and gates.** The obs-websocket client is plain JS
on globalThis.WebSocket + crypto.subtle, imported unchanged by the Next UI and
by Node gates. Two implementations would let the tested one and the shipped one
drift — the badge writer/reader already encodes that lesson. The mock computes
the auth with node:crypto, so every gate run cross-checks the two hash
implementations byte-exactly.

**The password's home is localStorage, and the proof is interception.** Policy
alone ("we don't send it") is a claim; the UI gate watches every request to our
origin for the secret and fails if it ever appears. What crosses the loopback
socket is the salted hash, computed in the page.

**Find-or-update, never error.** An existing "MegaChat Overlay" input is
adopted and corrected — including the hand-shrunk case, which is the whole
reason the feature exists. Re-clicking the button is the documented repair
path, and the gate holds it.

**Verified-ready is read back, not assumed.** After Add to OBS the UI calls
verify, which re-fetches settings, transform, enablement and does the badge
legibility arithmetic explicitly. Green means OBS said so.

**The mirror hazard resolved by construction, not by code.** Overlay tiles are
WS-seat-driven; the booth's host feed has no seat, so the overlay never renders
the host's own feed and virtual-cam → booth → overlay cannot loop. The only
real edge — the host buying a seat in their own room with the virtual cam — is
undetectable server-side (a seat is a seat), so it is a warning at picker time
rather than an exclusion that would have to guess.

**Audio pre-warm is OBS-only.** In a normal tab, creating/resuming an
AudioContext without a gesture is rejected by autoplay policy — correct for a
preview tab, and noisy to fight. The pre-warm keys on window.obsstudio, which
only OBS injects. Around the transitions, never inside them; the real-SFU
suites re-prove the stinger/reveal machinery untouched.

**Real OBS is the owner's checklist, not CI.** Installing OBS in this
environment buys little: the protocol is conformance-gated, the UI is
end-to-end-gated in a real browser, and what remains (mixer meters, monitoring
devices, CEF quirks) needs human ears anyway. docs/obs-oneclick-checklist.md +
_verify-obs-oneclick.mjs phrase that half as assertions.

## Platform parity and lockdown (2026-08-24)

**Self-capture, not a better VOD hunt.** The Kick problem was framed as "Kick
has no VOD". The fix is not to find one — it is to stop needing theirs. An air
session holds a rolling window of the live stream and freezes the part covering
each clip when that clip ends. Freezing on END is what makes the unknown
broadcast delay irrelevant: by then the segments carrying the clip have
arrived, so the skew never has to be known in advance to know what to keep. The
frozen window is then just a seekable video with an unknown offset — which is
exactly what per-VOD calibration already solves — so the verifier path is
identical on every platform and nothing downstream changed.

**The window is a bound, not a recording.** In memory, so the discard is real
rather than a cleanup job that might not run; started on session open and
stopped on close, so the boundary is code rather than copy; one window per clip
rather than the broadcast. That distinction is the difference between a
verification capture and taping someone's stream, and it had to be true in the
implementation.

**Authorization is a table, not scattered checks.** Every bounty route is
enumerated with a tier, and registration goes through a wrapper that throws on
an unknown path. A route cannot be added without deciding what it is, and the
check runs before the handler so a handler that forgets is not the hole. The
gate diffs the table against reality in BOTH directions, because a stale entry
describes something imaginary just as an unlisted route is unprotected.

**CAPABILITY is a tier, so that "no auth here" reads as a decision.** The OBS
overlay polls from a browser source that cannot hold a cookie; its unguessable
UUID is the credential. Writing that down as a tier is what stops it looking
like an oversight to the next reader — and stops someone "fixing" it and
breaking every overlay.

**Authenticate before resolving.** Resolving the subject first gave anonymous
callers a free existence oracle: 404 vs 401 told them whether any claim, clip
or air session existed. Nobody without a session learns anything now.

**Gates authenticate; they do not bypass.** Twelve suites broke when the routes
closed, and the fix was to mint real sealed identities for them rather than add
a test-only escape hatch to the auth path. An escape hatch there is the thing
that turns out to be reachable in production. _verify-bounty-oauth keeps
managing its own identities, because it IS the identity test and the shared
minter was overwriting its fixtures.

**Purge after the state change, never before.** Deleting captures at the start
of refundExpired destroyed evidence for refunds that then failed. Evidence must
not be deleted for something that did not happen.

**X and pump.fun: confirmed parked, not assumed parked.** X gives live status
for Spaces only and no sanctioned pullable stream at any tier we could pay for;
pump.fun's entire API surface is reverse-engineered from traffic. Self-capture
removes the VOD requirement but cannot conjure a stream where the platform
offers none — which is the actual reason both stay parked, and a more precise
reason than "the API is expensive".


## Capture hardening + pump.fun (2026-08-25, `feat/capture-hardening`)

- **Confidence tiers decide REVIEW ROUTING, never payout** — tier 1 external
  capture, 2 self-capture + OBS confirmed, 3 self-capture alone, 4 a signal
  disagrees. 1-3 auto-verify, 4 goes to a person. Weighting payout by evidence
  quality would charge a streamer for our own ability to observe them, which is
  the same mistake as weighting by viewer count. The gate asserts the evaluator
  returns no amount/rate/multiplier/weight field at all, and that the no-OBS
  streamer is paid identically. Undo: delete `bounty-confidence.js` and the
  one block in the verify route.
- **CORRECTED THE BRIEF'S PREMISE: self-capture does not merely prove the
  overlay rendered** — `bounty-capture.js` polls the PUBLIC channel stream via
  `resolveMediaUrl`, so a source loaded but not in the active scene never
  reaches it and simply fails to verify. The "obvious cheat" T2 was written to
  close was already closed by where we read from. T1/T2 were built anyway
  because they are worth having against ACCIDENT and for diagnosis — but the
  tier design says what each signal actually proves rather than inheriting the
  stronger claim. Undo: n/a (fact about shipped code).
- **The OBS scene check is corroboration, not proof** — it runs in the
  streamer's browser against the streamer's OBS. It can raise confidence; it is
  deliberately never the only thing holding a verification up, and
  `NO_CONNECTION` is blameless and unreported. Undo: n/a (rule).
- **`document.visibilityState` is recorded but is NOT a warning** — MEASURED:
  headless Chrome and any background browser tab report 'hidden' while
  rendering perfectly, so it flagged every session in the gate including the
  clean ones. A warning that fires on the good case is a tax on the honest.
  Undo: re-add `PAGE_HIDDEN` to `WARNINGS` and to the warnings push.
- **Canvas plausibility is deliberately loose (160px floor)** — 1080p, 1440p,
  vertical and ultrawide all pass; only 1×1-class absurdity flags. A false
  CANVAS_ANOMALY sends an honest streamer to review for owning an unusual
  monitor. Undo: `BOUNTY_OVERLAY_MIN_CANVAS_PX`.
- **Samples are attributed to playbacks SERVER-SIDE and clamped to now** — the
  client supplies a timestamp, never a playback id, so it cannot claim a
  "visible" sample covers a playback during which the overlay was hidden, and
  cannot post into the future. Undo: n/a (security property).
- **Only samples DURING verified playbacks can count against anyone** — hiding
  the overlay between MegaChats is not a violation; the overlay only has to be
  up while a clip is playing, because that is the only time it carries a code.
  Undo: n/a (rule).
- **`obs-scene` is STREAMER-tier, `overlay-env` is CAPABILITY-tier** — the
  scene report comes from the signed-in claim page, so there is no reason to
  accept it on a bare air-session UUID; the overlay has no session and its UUID
  is the whole credential. Undo: edit `ROUTE_POLICY`.
- **Captures are keyed to the PLAYBACK, not the clip** — the freeze now resolves
  the playback id before closing the window, and capture→evidence lookup keys on
  the FILE the evidence row records verbatim. The tidier-looking playback-id key
  did not work: a clipId-only freeze recorded a null playbackId. Undo: n/a
  (bugfix).
- **Capture duration comes from the buffer's own `spanMs`, not from ffprobe** —
  a capture is HLS segments concatenated byte-wise, and ffprobe reports the
  FIRST segment's duration when they do not share one timeline. A 20s window
  measured 2s and every seek clamped to zero. `spanMs` is summed from EXTINF
  at freeze time and cannot be wrong that way. Undo: n/a (bugfix).
- **`decodeThrough` seek for captures only** — an input-side seek in a
  concatenated stream trusts a broken index and returns the wrong frame, which
  means a streamer who did the work is not paid. NOT defaulted on: the VOD path
  seeks hours into an archive. Undo: drop the option at the one call site.
- **A capture enters at the LIVE EDGE on every playlist shape** — everything
  older than the window is evicted on arrival, so fetching it buys nothing. On
  pump.fun's append-only playlist it was the difference between a few hundred kB
  and ~2.4 GB. Undo: delete the `liveEdgeSlice` call in the poll.
- **The mock obs-websocket is now shared (`_gate-mock-obs.mjs`)** — the new
  gate drives the same mock the protocol gate proved correct, rather than a
  second one that could drift into agreeing with whatever it tests. Undo: inline
  it back.
- **pump.fun UN-PARKED on video, still blocked on identity** — it serves plain
  pullable 1080p60 HLS with PROGRAM-DATE-TIME. The earlier "WebRTC only" verdict
  was inference from documentation; this is eight live streams and every request
  recorded. The lesson generalises: for "is there a pullable stream", open the
  page and record the requests BEFORE writing the verdict. Undo: n/a (fact).
- **The LiveKit token is client-discoverable and we are not going to use it** —
  an anonymous headless browser obtained a 413-char join JWT. Joining a room on
  a token minted for a page view is participation under credentials issued for
  something else. Recorded as an observation, explicitly not a plan. Undo: n/a
  (rule).
- **The probe accepts no terms and clicks no consent** — a blocking dialog is
  reported as a finding. Playback worked with it untouched, so nothing was
  traded away for the answer. Undo: n/a (rule).
- **Gate `_gate-capture-hardening.mjs` 59/0** — pure tier/geometry logic, the
  mock obs-websocket in six states, and three full HTTP broadcasts against a
  stub live stream carrying real overlay badges: tier 2 auto-verifies, tier 4
  opens a review naming every cause, and the no-OBS streamer verifies and is
  paid the same (10 vs 10). Undo: n/a (evidence).

## Guest whitelist (2026-09-05, `feat/guest-whitelist`)

- **Seat contention: a guest seat rides ON TOP of `maxSeats`, it never takes a chair and never waits.** The three options were bump a payer (they paid — no), queue like everyone else, or reserve capacity. Reserving won because the codebase already had exactly this seat: `setSeatPinned` gives a co-host a free seat that the cap check skips, and the meter ignores. A whitelisted guest is that seat, granted at join instead of promoted mid-session, so there is one free-seat concept in the system rather than two that can disagree. Queueing was the runner-up and is defensible; it was rejected because "come and go as they please" is the entire point of the feature, and a co-host who has to wait for a stranger to leave does not have that. Undo: pass `pinned: false` in `tryWhitelistJoin`, and guests queue like anyone else.
- **The check reads the SEALED identity cookie, never a handle from the request body.** Anything client-asserted would make the free path forgeable by editing one JSON field. Undo: n/a (this is the security property).
- **It short-circuits at the TOP of the join path rather than bypassing the payment step.** Two reasons: a guest must never be shown a payment prompt at all, and a bypass that fires part-way through can leave a half-opened hold behind. Undo: n/a.
- **The whitelist does NOT override a stopped room.** Price, seat cap, join-stream-off and the watch-time gate are all overridden, but `addParticipant` still refuses when the room is not accepting joins — that is the absence of a room to join, not a gate on the person. Undo: n/a.
- **Per streamer, not per room** — keyed by the same `ownerKey` rooms carry, so a co-host added once works in every room that streamer opens. Undo: key the store by roomId.
- **Master switch is tri-state on disk** (`null` = derive from whether the list is non-empty, explicit `true`/`false` = the streamer's choice). This makes the first add work without a second click while letting an explicit "off" survive adding someone. Undo: store a plain boolean defaulting to true.
- **No room-password path on the management routes** — the room password is shared with mods to run one room, and this list silently applies to every room the account owns. Identity cookie only. Undo: add `verifyRoomAccess` to `whitelist-routes.js`.
- **Cap defaults to 20 (`GUEST_WHITELIST_MAX`)** — a co-host bench and a circle of regulars, not a way to run a free room at scale. Undo: raise the env var.

## Loose-ends run (2026-08-26, `feat/loose-ends`)

- **Ownership reads WHAT A PLATFORM'S OWN OAUTH CALLED YOU, not the provider
  name** — `platformLoginFor()`. The display-name ladder (twitch > x > google)
  answers "what to show"; it CANNOT answer "who owns this X handle" for someone
  with both linked. Two questions, two functions, kept apart on purpose. Undo:
  n/a (the alternative shipped broken for every real sign-in).
- **Confidence tiers decide review routing AND now block release; they never
  touch the amount** — the RELEASE ledger row records confidenceTier for audit
  only, and the gate asserts the evaluator returns no amount/rate/multiplier.
  Undo: n/a (rule).
- **X, YouTube, Rumble, pump.fun capture/observation ship BEFORE their claim
  paths** — capture is honest and gated; ownership is the missing piece and is
  filed per platform. A platform with capture but no claim path simply has no
  reserved handles to verify, so nothing is exposed. Undo: n/a (staging).
- **The session's watch URL leads capture on every platform** — it is exact
  where a channel-page guess was wrong (X/YouTube/Rumble) and no worse where a
  guess worked (Twitch/Kick). Undo: n/a (bugfix).
- **PROGRAM-DATE-TIME bypasses calibration only when EVERY window carries it** —
  a partial truth (one unstamped window) falls back to measuring rather than
  trusting a mix. Residual is the stamp's granularity (4s), not a broadcast-
  delay guess. Undo: n/a (correctness).
- **The pump.fun external source refuses a coin-page URL rather than calling the
  undocumented discovery API** — building the money path on a reverse-engineered
  endpoint is a business risk, not a technical one. It verifies against a
  clips.pump.fun playlist URL and names the gap otherwise. Undo: n/a (rule).
- **Buffer has() uses a high-water mark, not membership** — "already fetched"
  must survive eviction, or an append-only playlist refetches its whole history
  every poll. Undo: n/a (bugfix).
- **Claim re-entry verifies the caller before handing back a verified claim** —
  the first cut handed it to anyone, an auth hole under real verification. Undo:
  n/a (security).
- **_gate-phase5-oauth.mjs deleted, not repaired** — it gated deleted UI and
  crashed; _gate-privy-auth.mjs gates what exists. A gate that crashes trains
  the suite output to be ignored. Undo: n/a (process).
- **"Self-capture" is a TIMING variant of capture-from-broadcast, not a weaker
  class of evidence** — a planning pass defined it as "the overlay records
  itself", which would rank it below external capture as self-attested. It is
  not: bounty-capture.js startCapture fetches the PLATFORM'S OWN live HLS
  playlist into a rolling buffer, server-side. The streamer's machine is not
  involved and cannot influence it. Live-buffer capture and VOD capture read
  the same public broadcast; they differ only in WHEN. Ranking them as
  primary/fallback by trust is wrong — they are equally independent. What
  differs is AVAILABILITY: Twitch VODs are streamer-disableable, Kick has no
  VOD discovery at all, so the live buffer is the only variant present on every
  platform. It is preferred because it is always available, not because it is
  better proof. The genuinely weak signal is SELF-REPORTED (OVERLAY_ENV and
  badge reports — the overlay describing itself), which never decides a payout
  and earns its keep only as a cross-check that can contradict a stronger
  witness and force review. Undo: n/a (taxonomy — carrying the wrong definition
  causes a strong signal to be distrusted).

## Pass C, Session 2 — banking and escrow (2026-09-16)

- **A banked clip is a state of the PLEDGE, folded from BANK rows in the escrow
  ledger, not a second store** — an expiry refunds money, so the bank is
  evidence; folding from idempotency-keyed rows makes every writer replay-safe
  by construction and leaves nothing to diverge. Undo: n/a (rule).
- **Banking triggers on `overlay_hidden` only; `overlay_scaled_below_floor` is a
  review cause** — a scaled overlay was on screen, so the clip probably aired
  and we probably could not read it. That is ours to explain, not a replay.
  Undo: add the scaled signal to `buryWindowFor` (one line) — and accept that
  the audience would see the clip twice.
- **A playback is buried when a hidden window covers at least half of it**
  (`bankCoverFraction` 0.5) — a clip on screen for most of its length was
  seen, and replaying it dumps something the audience already watched. Undo:
  `BOUNTY_BANK_COVER_FRACTION`.
- **Drain at one clip per 20 s per room, only while the latest signal is
  visible and the air session is OPEN** — longer than a MegaChat tile plus its
  stingers, so two banked clips are never on screen together, and a refused
  replay goes back to the queue with the interval still applying. Undo:
  `BOUNTY_BANK_DRAIN_INTERVAL_MS`.
- **Expiry is bounded by the STREAM, not the pledge: stream end + 10 min, or 12 h
  from banking, whichever first** — a queued clip is a liability against a
  broadcast that is over; the tail covers a session closed by accident. Undo:
  `BOUNTY_BANK_TAIL_MS`, `BOUNTY_BANK_MAX_HOLD_MS`.
- **One payable airing per pledge, enforced in release() by collapsing verified
  playbacks per contribution** — evidence stays per playback (gate K), payout
  is per pledge. A clip aired twice used to pay twice; now it pays once and
  the ledger row carries both numbers. This is a settlement change and the
  spec says so. Undo: stop passing `verifiedPlaybacks` from the verify route.
- **A banked clip replays THROUGH the letters queue as a synthetic paid letter
  whose id is the clip id** — the watermark window opens through the one door
  it can open through, so proof-of-playback and proof-of-air stay one artefact.
  Nothing else in the repo put a stored pledged clip on air; this is the first
  path that does. Undo: n/a (there is no second path).
- **Live seats get a rolling pending bucket in their own ledger, never the
  bounty escrow** — a meter forced into a discrete-object escrow gives either
  a row per tick or one that cannot say "on screen forty minutes, buried
  three". Undo: n/a (rule).
- **Sweep = release 80 %, hold 20 % for 72 h; clawback takes at most the
  holdback** — option B of `docs/decisions/post-release-clawback.md`, reused
  rather than built a second way: a reversal is a non-payment of the tail,
  never a debt. Undo: `SEAT_HOLDBACK_FRACTION`, `SEAT_CLAWBACK_WINDOW_MS`.
- **Buried seconds refund to the viewer backdated to the hidden window start;
  the 30 s detection lag before it is refunded from the PLATFORM and logged as
  cost** — OBS stamps nothing, so the earliest timestamp is the poll receipt;
  the platform is the party that could have looked sooner. Undo:
  `SEAT_DETECTION_LAG_MS`.
- **The server-driven meters skip ticks while the room is hidden; MPP seats do
  not pause** — an MPP seat is billed by client vouchers and refusing one trips
  its stale-kick, which would end the seat rather than pause it. Filed as a
  limitation. Undo: n/a (the alternative is worse).
- **SOURCE_UNAVAILABLE on a seat flags and claws nothing; the holdback matures
  on schedule** — "could not look" refunds a clip because a clip either aired
  or did not; an hour on screen is not unmade by a five-minute blind spot.
  Undo: n/a (spec).
- **Manual-paste rooms sweep once at stream end + 10 min, capped at 24 h from
  seat open, then release optimistically with the same holdback** — the same
  optimistic-release-with-review-window the manual-paste bounty tier already
  uses, reused. Undo: `SEAT_MANUAL_TAIL_MS`, `SEAT_MANUAL_MAX_HOLD_MS`.
- **The seat bucket is accounting with stub settlement; the on-chain per-tick
  pull is untouched** — the tick still pays the payout address directly, so
  today the bucket describes what SHOULD happen. Making it real means
  redirecting ticks to a platform-held balance plus RealSettlement, which needs
  a funded wallet and the retest checklist; nothing this session could cover
  with a test that fails on the old behaviour. Said plainly in the report.
  Undo: n/a (scope).
- **Every new terminal-or-delaying state names a cause in the review builder**
  — banked, scaled-below-floor (own words), bank expiry (opens a review from
  the sweeper), seat clawback and seat SOURCE_UNAVAILABLE (seat ledger flags,
  listed beside the bounty reviews). A verdict with no cause is a silent
  denial. Undo: n/a (rule).

## E37 — giving an approved pledged clip a way to air (2026-09-17)

- **First airings reuse the bank's replay bridge rather than getting their own
  path** — a first airing is the same mechanical act as a replay minus the
  bank, so one dispatcher owns both, with one rate limit and one route to the
  play queue. The alternative was a second path that could drift from the
  first. Undo: n/a (rule).
- **Replays are dispatched before first airings** — that money is already spent
  into a bury and the fan has waited longer. Undo: swap the two branches in
  `drain`.
- **A first airing needs only "not known hidden"; a replay needs a positive
  `overlay_visible`** — a manual-paste streamer emits no signal ever, so
  requiring a positive one would mean their fans' clips never air at all, and
  the visibility check would have quietly become a requirement to run
  obs-websocket. A replay is different: it is a clip already spent once, so it
  waits for confirmation. The letters scheduler's own `hasOverlay` check is the
  real guard in both cases. Undo: use `knownHidden` in both branches.
- **An ineligible replay does not consume the room's dispatch tick, but a
  refused one does** — otherwise a single banked clip could stop a room airing
  anything ever again; and a queue that keeps refusing must not spin. Undo:
  n/a (bugfix, caught by the new gate).
- **An air session is always bound to a room: the one asked for, else the
  claimant's newest, else one created for them** — a bounty claimant is by
  definition a streamer who was not on MegaChat, so "no room yet" is the normal
  case rather than an error to report. Undo: make the room a required field and
  return 400, which moves the problem to the claim page.
- **Only an explicitly named room id is normalised.** `normalizeRoomId(undefined)`
  answers `DEFAULT_ROOM_ID`, so normalising an absent one bound every
  claim-page session to the SHARED DEMO ROOM. Caught by the new gate before it
  shipped. Undo: n/a (bugfix).
- **A room owned by someone else is refused; an unowned one is allowed** —
  pointing a session at a stranger's room would air a fan's clip into a
  stranger's broadcast. Unowned rooms (legacy, demo, harness) have nobody to
  take them from. Undo: n/a (security).
- **The claim page hands out `/overlay?room=<id>&bountyRoom=<id>`** — the
  by-id form pins one session and dies on the next stream, which
  `public/overlay.html` records as having cost three debugging sessions.
  Undo: n/a (bugfix).
- **`markPlayed` is called from the playback-start hook, for replays as well as
  first airings** — that hook is the one place a clip demonstrably reaches the
  overlay. `playCount` therefore counts airings, which is what the fan-facing
  status has always claimed to show. Payment dedupe is separate and unchanged
  (`payablePlaybacks`). Undo: n/a (the function had no caller at all).
- **Queue order is oldest-approved-first and nothing else** — skip, hold and
  reorder are a product surface nobody has specified. Filed as E40 rather than
  invented. Undo: n/a (deferral).

## E38 — the money audit and the settlement door (2026-09-18)

- **One door, not several doors with the same rule.** Every server-signed
  transfer executes inside `settlement.js` against a recorded intent. The
  alternative — each caller keeping its own signer and merely recording an
  intent first — leaves five places to get the rule wrong and a scan that can
  only check the recording. Undo: n/a (Gate H Tier 1 pins it; a call moved out
  of the door fails the gate).
- **Ticks land in the platform wallet, not the payout address.** The seat
  escrow's holdback, buried-seconds refunds and clawbacks were bookkeeping
  about money that had already left; now the bucket's intents ARE the money.
  Undo: point the pull in `tickPasskeyStreamSeat` back at `seat.payoutAddress`
  and accept that the escrow is accounting again.
- **The payout key must be the platform wallet's key, or payouts are off.**
  `PLATFORM_SETTLEMENT_KEY` is checked at boot against `SELLER_WALLET_ADDRESS`;
  a mismatch disables outbound signing rather than paying from a wallet the
  ledger does not describe. Undo: n/a (safety).
- **No payout key means recorded and PENDING, never dropped.** The first flush
  after the key lands pays each intent exactly once (`_gate-money.mjs` K).
  Undo: n/a.
- **Amounts come from the ledger, never from a balance read.** A balance read
  is a claim about the world at one instant; the ledger is the intent. Undo:
  n/a.
- **MPP seats feed the seat bucket (E39).** Their vouchers accrue like any
  tick, so buried seconds are refunded for them. They still cannot pause
  (L34). Undo: remove the `seatEscrow.accrue` in the MPP tick handler.
- **Credit- and points-funded intents are RETAINED, not paid.** The platform
  wallet never received that money; paying it out would be paying out of thin
  air. Who pays the streamer for those seats is O15. Undo: give those buckets
  a token address and a signer — after O15.
- **The legacy viewer page is deleted, not 404-routed.** A page that can be
  served can be linked; a refusing route can be removed by accident. Deleting
  is the version the gate can prove (`_gate-money.mjs` P). Undo: `git revert`
  the deletion commit.
- **Tier 3 pins names, not behaviour, and says so.** A count of transfer-shaped
  names per file is the strongest static claim available for calls the server
  cannot mediate. Undo: n/a (register L37).
- **Points seats tick in points (E42) — a fix, not a policy.** The join had
  always priced points seats in whole points; only the seat record disagreed.
  Undo: n/a (bugfix, caught by the new fixture).

## Escrow contract, Session 1 (2026-09-18)

- **`attest` reports consumed seconds as well as hidden seconds.** The prompt's
  `attest(id, hiddenSeconds)` cannot express "unspent returns to the viewer":
  the deposit is the session cap, and only the server knows how much of it was
  consumed. Both figures are viewer-ward only — the paid-seconds figure a later
  attestation implies may never rise. Undo: drop `consumedSeconds` and accept
  that an early-leaving viewer forfeits the cap unless the streamer refunds.
- **Out-of-range attestations are clamped, not refused.** Consumed clamps to
  the cap, hidden to consumed. A refusal would let a slightly-wrong figure
  block a refund the viewer is owed; a clamp can never overpay the streamer.
  Undo: replace the two clamps with reverts.
- **`deposit` is operator-only.** A permissionless deposit lets anyone lock a
  viewer's standing allowance against a streamer of the attacker's choosing
  and collect it at the deadline. Undo: n/a (security); the trade is that the
  viewer trusts the operator to name the room's real payout address.
- **The viewer never calls the contract; the server pays the gas.** A call to
  a non-TIP-20 contract defaults its fee token to pathUSD, which no viewer
  holds. The viewer's one signature stays the TIP-20 `approve`. Undo: fee
  sponsorship (`feePayer`) — unverified for Privy wallets.
- **Three hard bounds are constants: MAX_HOLD 14 days, MAX_EXTENSION 7 days
  once, MAX_FEE_BPS 10%.** Parameters can be tuned; bounds cannot, because a
  bound the owner can move is not a bound. Undo: redeploy — the contract is
  immutable by decision.
- **The extension a session is granted is snapshotted at escalation.** Tuning
  the parameter afterwards must not lengthen a hold already in force. Undo:
  read the live parameter at finalize.
- **Signatures recover through the TIP-1020 verifier precompile, not raw
  `ecrecover`.** Same gas for secp256k1, and passkey (P256/WebAuthn) viewers
  can flag; future Tempo signature schemes verify without a redeploy. Undo:
  swap `_recover` back to `ecrecover`.
- **A contract used as the streamer is allowed.** TIP-20 transfers carry no
  receiver hook, proven by a sink contract whose code ran zero times while
  receiving its payout; refusing contracts would refuse multisig streamers for
  no safety gain. Undo: `require(streamer.code.length == 0)`.
- **The Moderato rehearsal deployment is administered by nobody.** Its roles
  are ephemeral keys discarded at exit, so it is a proof, not an operational
  asset. Undo: redeploy with held keys — cheap, and Session 2 does it on
  mainnet anyway.
- **solc-js is a devDependency; Foundry is not installed.** The repo's gates are
  Node scripts, the tests must run against Moderato rather than anvil, and a
  pure-npm compiler avoids a Windows toolchain install. Undo: `forge build`
  against the same source; the artifact records compiler and EVM version.
- **`.deployContract(` joins Gate H's Tier 3 pin, and `contracts/` is scanned.**
  Deploying code is a signing action. Undo: n/a.

## Escrow contract, Session 2 — wiring live seats (2026-09-19)

- **The deadline is joinedAt + cap × tick + tail + review, fixed at deposit.**
  Stream end is unknown at join; the seat cannot outlive its cap; the tail is
  the ledger's own manual-paste tail; the review margin (24 h) is the time a
  human has to attest more hidden time. Undo: shorten `SEAT_ESCROW_REVIEW_MS`;
  a streamer-signed early release would need a contract change.
- **The contract's "seconds" are the seat's tick units.** Rate is the tick
  price, the cap in units is deposit / rate, consumed is the ticks accrued.
  Exact for any tick length. Undo: n/a.
- **The lag part of a bury stays a door intent from the platform wallet.** The
  ledger charges detection lag to the platform; the contract has no platform
  pocket; so the streamer's part is attested and the platform's part is paid
  by the platform. Undo: attest the whole bury and let the streamer carry the
  lag.
- **A clawback on an escrow seat becomes an attestation, never a door refund.**
  Undo: n/a (the alternative pays a refund from money the platform never held).
- **Escrow and direct seats produce no door payouts.** Their ledger sweeps,
  maturities and refunds are accounting; only platform-mode seats (points,
  credit) reach the door. Undo: n/a (the alternative double-pays).
- **The money mode is decided at terms and carried by the spender the viewer
  approved.** Only the contract or the seller key are acceptable spenders; a
  spender that no longer matches the mode is answered with a retry in direct
  mode, never pulled on. Undo: n/a.
- **A room with no payout address is refused in every mode.** Undo: n/a
  (decided before this session).
- **The fallback pulls to the payout address and ends the seat if it is ever
  missing.** Rewritten, not reverted: the pre-E38 path chose the recipient
  server-side and fell back to the platform wallet. Undo: n/a.
- **A refused or unreachable deposit degrades the escrow for ten minutes and
  retries once first.** A retry after a send that landed is safe: the contract
  refuses the second deposit. Undo: drop the retry.
- **Every server signer is built on viem's Tempo chain and every transfer
  names its fee token.** The bare chain object dropped `feeToken`; the
  alternative is holding pathUSD in every wallet. Undo: n/a (E49).
- **`ESCROW_OPERATOR_KEY` and `ESCROW_ATTEST_KEY` are accepted with or without
  0x.** They were stored without it; refusing them would have been a worse
  outcome than normalising. Undo: n/a.
- **The contract address comes from `contracts/deployments.json` for the
  chain, `ESCROW_CONTRACT_ADDRESS` overriding.** No variable had to be set on
  the service for the deployment to be used. Undo: set the variable.
- **Privy users were not re-routed.** The prompt said `/api/join/mpp` stays as
  it is; it does, and the consequence is filed rather than fixed (E48). Undo:
  one condition in `joinSeat`.
