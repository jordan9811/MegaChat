# Verification — how a bounty is proven to have aired

The bounty program's central claim: **a streamer is paid only for MegaChats that actually aired on their public broadcast.** This page states what that rests on, what each piece of evidence proves, and what none of them prove. It is written for someone deciding whether to trust a payout or dispute one.

<!-- snippet:pre-launch -->
{% hint style="warning" %}
**Pre-launch.** MegaChat is deployed but in stealth with no users. This money path has been verified against fixtures, local infrastructure and rehearsal broadcasts run by the project's own operator — not production traffic. No real money has moved through it on anyone's behalf. See `docs/internal/launch-readiness.md`.
{% endhint %}
<!-- /snippet -->

## The threat model, plainly

The thing being defended against is a claimant being paid for a clip that did not reach their audience — because the overlay was in a hidden scene, scaled to nothing, never loaded, or because the "a clip played" event was fabricated. The thing being defended *for* is the honest streamer whose setup, platform or network made evidence hard to collect: they must be routed to a person, not to a denial (`frame-sources.js`, "'we could not look' must never cost a streamer money the way 'we looked and it was not there' does").

## The mechanism

1. **Codes exist only while a clip is playing, and each is bound to that clip.** When a MegaChat plays in an air session the server issues a short code, rotating every ~4 s, valid ~5 s and clamped to the clip's own end, from an alphabet with no look-alike glyphs (`bounty-watermark.js`; `codeRotateMs`, `codeValidityMs`, `bounty-claim.config.js`). A frame carrying code X therefore proves clip Y aired at that second, because X only existed inside Y's playback window. A parked overlay with nothing playing issues no codes and accrues nothing.
2. **The overlay draws the code** as 5×7 dot-matrix glyphs inside a white registration ring, from one font table shared by writer and reader (`public/code-matrix.cjs`; `docs/run-b-verification.md`).
3. **Everything is logged before anything is judged.** Codes issued, playbacks started and ended, viewer-count samples, capture freezes, OBS scene samples and overlay environment reports go to an append-only evidence chain (`bounty-evidence.js`); a release refuses to run unless the chain validates (`release()`, `bounty-escrow.js`).
4. **The broadcast is captured.** While the session is open a rolling window of the *public* stream is held in memory and frozen to disk around each clip when it ends — `captureWindowMs` = 75 s, frozen `captureFreezeDelayMs` = 51 s after clip end, sized so one freeze delay covers the whole measured spread of broadcast delays (`bounty-capture.js`; the derivation above `captureWindowMs` and `captureFreezeDelayMs` in `bounty-claim.config.js`).
5. **The verifier samples inside each playback window** at code-validity midpoints, pulls frames from the capture (or the platform's replay), and decodes them with a deterministic reader that also measures the glyphs' rendered height (`bounty-verifier.js`; `bounty-ocr.js`; `frame-sources.js`). The timeline of each source is calibrated per broadcast rather than assumed (`bounty-timeline-calibration.js`).
6. **A verdict per session, from a fixed ladder** (`bounty-verifier.js`, header): `PASS`, `PARTIAL`, `AMBIGUOUS`, `NOT_SHOWN`, `FAIL_TOO_SMALL`, `FAIL`, `NO_FRAMES`, `SOURCE_UNAVAILABLE`, `NO_PLAYBACK`. Misses are authoritative: a playback whose required code was never observed is `NOT_SHOWN` regardless of how well the other clips read, and that outranks any confidence number (`_gate-missed-code-authoritative.mjs`).
7. **Release is proportional to verified airtime**, capped per session, idempotent by key (`release()`, `bounty-escrow.js`). And then the settlement stub records who would be paid and moves nothing (`bounty-settlement.js`).

## What each piece of evidence proves

From `bounty-confidence.js`, which exists to keep this straight:

| Evidence | Where it is read | Proves | Does not prove |
|---|---|---|---|
| **External capture** — the platform's own replay or live HLS | server-side, from the platform | the code aired publicly, and a third party can re-check it without trusting MegaChat | that the platform will still have it later (deleted, sub-only, unprocessed are typed states — `frame-sources.js`, `SOURCE_STATES`) |
| **Self-capture** — MegaChat's recording of the public stream | server-side, from the channel page, not the overlay | the code aired publicly (a source not in the active scene never reaches the public stream, so the cheat of "loaded but hidden" is closed by where we read from) | that the artefact is independent — an auditor has to trust MegaChat recorded what it says it did |
| **OBS scene check** | the streamer's browser asking their OBS | nothing, on its own — it is client-reported | it corroborates: catches the *honest* streamer's hidden or zero-size source and turns "no badge found" into a diagnosis |
| **Overlay environment** — canvas size, visibility | the overlay page reporting on itself | "misconfigured" vs "we could not look" | anything about the broadcast |
| **Viewer-count samples** | Helix / Kick channel reads at playback | that the channel had an audience at that second | nothing about payout — deliberately never used to weight it |

Tiers 1–3 (external, self-capture with OBS corroboration, self-capture alone) all prove the clip aired; they differ in how independently that can be checked later. Tier 4 is the case where the evidence disagrees with itself, and a person looks. **Every tier that passes pays the same amount** — weighting payout by evidence quality would charge a streamer for MegaChat's own ability to observe them (`bounty-confidence.js`, "NOT PAYOUT SCALING").

## What none of them prove

- **That a human watched.** Viewer counts are recorded, not relied on.
- **That the clip was audible, or unobstructed by the streamer's own layout.** The badge is what is read; a clip whose badge was legible while the video was covered would verify.
- **That the platform's copy will exist tomorrow.** Self-capture exists precisely because it often does not (`bounty-capture.js`, header).
- **That verification happened in the same conditions a paying stranger would produce.** Every real-broadcast proof so far was the operator's own channel or a rehearsal harness (`OPEN-ISSUES.md`, the 2026-08-26 → 09-03 entries; `docs/internal/launch-readiness.md`).

## What can go wrong, and what happens

| Situation | Outcome | Source |
|---|---|---|
| Badge rendered under the 12 px reading floor (source scaled down) | `FAIL_TOO_SMALL` — located everywhere, read nowhere; the streamer is told the floor before going live and *Add to OBS* exists to prevent it | `bountyConfig.minCodePixelHeight`; `web/lib/obs-oneclick.mjs` |
| Stream below 720p | detection degrades toward the floor; 720p is the stated minimum | `docs/run-b-verification.md`, "Minimum verifiable stream quality: 720p" |
| Replay deleted, sub-only, or not yet processed; no extractor on the host | `SOURCE_UNAVAILABLE` → review queue, never a denial | `frame-sources.js`, `SOURCE_STATES` |
| MegaChat's own recorder stalled mid-session | detected by distinct-segment freshness; a dead recorder is never scored as an absent badge | `_gate-stale-capture.mjs`; `OPEN-ISSUES.md`, "A DEAD RECORDER WAS SCORED AS AN ABSENT BADGE (FIXED)" |
| Some clips read well, one clip's code never seen | `NOT_SHOWN` — the miss wins | `_gate-missed-code-authoritative.mjs` |
| Signals disagree (capture says aired, OBS says hidden) | tier 4 → a person looks | `bounty-confidence.js` |
| Evidence chain corrupt | release refuses (`evidence_unverified`) | `release()`, `bounty-escrow.js` |

## Limitations

The [limitations page](limitations.md) lists the things this pipeline cannot see, each with its mitigation and residual risk. The two that matter most: verification has never scored a stranger's stream, and self-capture on a zero-delay source would lose the head of a 30-second clip (`bounty-claim.config.js`, "WHAT 51s DOES NOT COVER").

## What this does NOT do

- **It does not move money on a verdict.** A `PASS` produces a ledger row and a recorded intent (`bounty-settlement.js`).
- **It does not trust the overlay's word.** Overlay self-reports are diagnostics; the read is of the public stream (`bounty-confidence.js`).
- **It does not scale payout by confidence.** Confidence decides whether a human looks, nothing else (`bounty-confidence.js`).
- **It does not run outside an air session** — no session, no codes, no capture (`bounty-watermark.js`; `bounty-capture.js`).
