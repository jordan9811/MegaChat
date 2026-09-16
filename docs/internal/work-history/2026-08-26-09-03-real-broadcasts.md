# 2026-08-26 → 09-03 — Loose ends, then real broadcasts on five platforms

Sources: `DECISIONS.md` ("Loose-ends run"), `OPEN-ISSUES.md` (from "Loose-ends run" through "YOUTUBE SELF-CAPTURE PROVEN" — the longest stretch in the file, including the retraction), `docs/briefs/2026-08-26.md`, `docs/briefs/2026-08-26-real-broadcast.md`; commits `2f6e5d4`, `9f02254`, `6433b82`, the 2026-08-29/30 verification commits, `7ee7426`.

## What shipped

- **The fan front door proven** in real Chrome with a fake camera: a real 183 KB webm lands in the store, keyed to the pledge; pay-at-submit proven by absence (`_gate-record-flow.mjs`, 23/0).
- **Confidence tiers decide the money**: tier 4 and the tier-3 review knob block release; the ledger row records the tier for audit.
- **YouTube and Rumble external capture, stub-gated; X ownership through Privy's linked account, proven not assumed; pump.fun capture with PROGRAM-DATE-TIME replacing calibration.**
- **The dead-recorder fixes**: `grabFrame` asserts the output file exists (exit 0 is not proof); `CAPTURE_GAP` is per-sample; an unreadable sample is held against our source and excluded from the detection-rate denominator; a stalled ring is logged, re-derived, and stamped `stale`; all nine `grabFrame` call sites funnel through one handler after the first version of the fix broke calibration on four platforms (`_gate-vod-calibration` caught it).
- **The overlay polling fix**: the overlay asked for a new code every 15 s against a 4 s rotation because `setInterval` captured a placeholder before the first poll returned. Every code sat on screen ~4× longer than the system believed; calibration then read an on-time stream as ~10 s delayed. Measured in a browser: ~15 s per code before, 5.7 s after (`5f793f3`, `2fe633e`).
- **The confidence / detection-rate split** (`6e29bae`): `confidence` was read quality *times* presence, silently; an honest 5/5 broadcast released nothing. Split, and gated in both the verdict ladder and escrow. This is the underpay fix that reached prod in Pass A ([Launch readiness](../launch-readiness.md)).
- `frameOrigin` returned from the server so a harness can no longer mislabel which frames a verdict read.

## What it found — in order of cost

1. **Self-capture could never have worked on a real broadcast.** Two deterministic bugs living entirely between a stub and a real encoder: capture never started (the channel is offline at session open and the single-shot resolve treated that as permanent), and the freeze kept the wrong sixty seconds (media up to end − D, so a clip retained only L − D of itself). Every stub publishes at D ≈ 0, so 23 green gates missed both. **"The fourth green-test-hiding-a-broken-path bug in a month … conclusive and structural, not bad luck."** `_gate-broadcast-delay.mjs` is the missing test.
2. **A dead recorder was scored as an absent badge.** Eight identical capture files with one md5, every presence check green, replayed as FAIL 0/5 — our outage recorded as the streamer having no badge. "THE COUNTER PROVES NOTHING, ON ANY PLATFORM. Read a passing verification as the proof; never the freeze count."
3. **A retraction.** A row labelled "self-capture" on Twitch was two external reads; the rehearsal harness passed a `sourceMode` on every verification, and 'live'/'vod' both force the external path. Left in the file, marked, with the reasoning that got it wrong. Twitch self-capture was then genuinely proven on 2026-08-30 (capture PASS 5/5, external PASS 5/5, both clocks measured tight).
4. **Kick DOES have VODs** — "no VOD" was written twice and corrected twice by the operator. The accurate form: VOD exists, discovery does not.
5. **The structural identity bug**: both ownership checks required `identity.provider === platform`, which no Privy identity satisfies, so with real identity on, no real streamer could claim on any platform. Invisible because gates mint legacy-shaped identities. Fixed with `platformLoginFor()`.
6. **Rumble's live-status response carries the channel's ingest credentials in plaintext** — possession of the creator URL confers the power to broadcast as that channel; stripped at the API boundary, asserted by the gate.
7. **A live YouTube copyright interruption** arrived on a synthetic sine-tone test signal; future harnesses should use silence.
8. **Rehearsal harnesses had been dead for weeks** (`OPEN-ISSUES.md`, "Rehearsal harnesses had been dead for weeks") — `args: ['--prod']` replaced the helper default and spawned `node --prod`; credentials were never sent after the lockdown; three hard-coded clips at exactly the calibration minimum.
9. **pump.fun's "hollow live"** (`OPEN-ISSUES.md` T6): an open ingress with no encoder serves a complete HLS playlist of a placeholder image, and every signal reads healthy. Options written, none implemented — a heuristic that wrongly calls a real broadcast a placeholder refuses to pay someone who did the work (T6).
10. The adversarial review of the payment path: 18 agents, 14 findings, 11 survived refutation; four still open (A1–A4).

## The platform results this period produced

| Platform | Best result | Source |
|---|---|---|
| Twitch | capture PASS 5/5 conf 0.874, external PASS 5/5 conf 0.863, 2026-08-30 | `OPEN-ISSUES.md`, "BOTH READ PATHS PROVEN" |
| Kick | PASS 5/5 conf 0.857, run #5 (after 1/5, 0/5, 0/5) | "golden loop" retest 2026-08-27 |
| pump.fun | PARTIAL 6/7 both paths, 2026-08-30; first non-zero stub release 2026-08-29 | as above |
| YouTube | PASS 5/5 conf 0.866 after two real bugs (yt-dlp's broken default extraction; a sign error in the no-PDT calibration branch) | `9f02254` |
| X | PASS 5/5 conf 0.878, self-capture only | `2f6e5d4` |
| Rumble | ingest proven; playback URL not discoverable | "Rumble: ingest PROVEN, playback URL is the blocker" |

## Judgment calls

- "Self-capture is a timing variant of capture-from-broadcast, not a weaker class of evidence" — corrected a planning pass that would have ranked a strong signal as self-attested.
- Capture leads on the session's watch URL, pinned to the proven handle for Twitch and Kick; the residual for platforms whose only capture address is client-supplied is filed (A1).
- A per-sample failure stays per-sample — every place one bad sample became a session verdict produced a wrong answer.

## Verification result

Seven gates across every platform's calibration and capture path swept after the YouTube fix: 140 assertions, 0 failures (`OPEN-ISSUES.md`, 2026-09-03). Real broadcasts as tabled above.
