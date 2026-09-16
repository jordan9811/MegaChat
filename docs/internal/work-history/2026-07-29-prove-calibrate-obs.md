# 2026-07-29 — Prove-and-clear, per-VOD calibration, OBS one-click

Three runs in one day. Sources: `DECISIONS.md` ("Prove-and-clear run", "Per-VOD timeline calibration", "OBS one-click run"), `OPEN-ISSUES.md` (the three matching sections and "OBS one-click — risk status"), `docs/briefs/2026-07-29.md`, `docs/briefs/2026-07-29-calibration.md`, `docs/briefs/2026-07-29-obs-oneclick.md`, `docs/obs-oneclick-checklist.md`; commits `ca7970c` → `40f587d`.

## What shipped

**Prove-and-clear.** Rehearsal preflight; stream-context enforcement as a gate (warm-up: nothing counts in the first 10 minutes; tail: the stream must continue past the last counted playback; failures to review naming the condition; **no viewer threshold, by design**); broadcast start and viewer count captured at playback time because they no longer exist at verify time; platform health proving app-token reads where the credentials actually live; the spawn audit — "gates can no longer be fooled by a stale server" (`63ccf45`); the decoder fixes below.

**The first real broadcast** — `jordandotfun`, ~12 minutes, Helix-confirmed, VOD 2832201336: **PASS, 4/4 clip playbacks, badge 27.7–28 px.** It found two P0s in the first ninety seconds that nothing else could: the handle was never passed to the frame sources, and the media timeline sits ~15–17 s behind the wall clock (`347ac4b`).

**Per-VOD calibration** (`bounty-timeline-calibration.js`): the offset is measured from each broadcast's own content — probe, decode, see which code is on screen, derive Δ — rather than a constant measured once. Constant per VOD with a median over several points and a spread check; the acceptance window derived from the measurement (~±4 s) instead of a flat 20 s; a truncated search reported as DISAGREEMENT, never as agreement; ladder rungs derived from the badge visibility window so no offset falls through a gap.

**OBS one-click**: an obs-websocket v5 client shared byte-for-byte by the browser UI and the Node gates; *Connect OBS* and *Add to OBS* in the claim flow, proven in-browser; audio around the transitions; Virtual Camera in the booth; the owner's fourteen-row real-OBS checklist and `_verify-obs-oneclick.mjs`.

## What it found

- **A one-code corpus hid a ~50% miss rate at 720p** (`5ebd643`). Two defects invisible to a corpus generated from one code: an alignment window tuned in raw pixels against that code, and a ring locator that returned only the highest-contrast hypothesis. Fixed; `_gate-decoder-codes.mjs` draws fresh codes every run.
- Confidence was being reported from the first matching alignment rather than a refined one, dragging sessions under the AMBIGUOUS threshold — "find fast, then refine locally".
- Asking the platform for broadcast start at verify time would have sent every honest VOD-verified session to review.
- The stub calibration gate cannot construct offsets above ~30 s (a fixture limitation, honestly recorded rather than a check that lies); one junk probe per real VOD appears normal and is handled by clustering.
- `_gate-overlay.mjs` and `_gate-auth.mjs` assumed a server on :3000 and crashed on a clean checkout; fixed the same night.

## Judgment calls

- **Stream context is a gate, not a dial, and there is no viewer threshold.** Weighting payout by viewers charges twice for the same thing and penalises mid-size streamers; the absence is written into `bounty-stream-context.js` and asserted by a gate so it cannot come back under another name.
- Skew treated as constant per VOD: two quantised samples cannot distinguish a constant from a slow drift, and fitting a slope would be the one-code-corpus error again.
- Real OBS is the owner's checklist, not CI — what remains after the conformance mock and the in-browser gate needs human ears.
- The obs-websocket password lives in localStorage and the gate proves by interception that it never crosses to our origin (`DECISIONS.md`, "The password's home is localStorage").

## Verification result

Real broadcast PASS 4/4; calibration on the real VOD from a deliberately wrong 0 ms prior recovered 13.2 s from a 3-point cluster; OBS protocol and UI gates green; setting keys later made self-verifying against OBS's declared defaults (`ae59e2e`, 2026-08-06).
