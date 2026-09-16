# 2026-08-24 → 08-25 — Platform parity and lockdown, capture hardening, pump.fun

Sources: `DECISIONS.md` ("Platform parity and lockdown", "Capture hardening + pump.fun"), `OPEN-ISSUES.md` (the two matching sections, P1–P6), `docs/platform-feasibility.md`, `docs/briefs/2026-08-24-platform-parity.md`, `docs/briefs/2026-08-25.md`; commits `9a60ddc` → `f53bea1` (merge).

## What shipped

- **Self-capture** (`bounty-capture.js`): verification stops depending on the platform keeping a VOD. A rolling window of the public live stream is held in memory during an air session and the part covering each clip is frozen to disk when the clip ends. "The window is a bound, not a recording."
- **Bounty routes authorize server-side, as a table** (`bounty-auth.js`): 34 routes enumerated with a tier; registration throws on an unknown path; the gate diffs the table against reality in both directions. `CAPABILITY` is a tier so "no auth here" reads as a decision (the overlay's UUID is its credential).
- **Pledging requires a signed-in account**; strikes attach to it. `/api/bounty/my` stops taking a contributor query — it was an enumeration hole.
- **Gates authenticate rather than bypass**: twelve suites broke when the routes closed and were fixed by minting real sealed identities (`_gate-helpers.mjs`, `mintBountyAuth`).
- **OBS scene-item visibility, overlay self-reports, confidence tiers** (`bounty-confidence.js`): tiers decide review routing only; the gate asserts the no-OBS streamer is paid identically (10 vs 10).
- **The Kick dress-rehearsal harness**, shipped with an honest preflight; Kick still unproven at this point.
- **pump.fun un-parked on video**: eight live streams opened and every request recorded — plain pullable 1080p60 HLS with `PROGRAM-DATE-TIME` on every segment. The earlier "WebRTC only" verdict had been inference from documentation.

## What it found

- **Self-capture verification had never worked end to end**: four independent bugs in the verify path (only `captures[0]` passed; ffprobe trusted on a byte-concatenated TS so a 20 s window measured 2 s; captures named by clip while evidence keyed on a null playback id; an input-side seek on a broken index) together returned `SOURCE_UNAVAILABLE` on the primary path every time. `_gate-capture-hardening.mjs` now verifies three clips off self-capture over HTTP.
- **Authenticate before resolving**: resolving the subject first gave anonymous callers a free existence oracle (404 vs 401).
- **Purge after the state change, never before**: deleting captures at the start of `refundExpired` destroyed evidence for refunds that then failed.
- `document.visibilityState` is not a warning — headless Chrome and background tabs report `hidden` while rendering perfectly.
- A capture must enter at the live edge on every playlist shape; on pump.fun's append-only playlist it was the difference between a few hundred kB and ~2.4 GB.
- The LiveKit join token is client-discoverable — recorded as an observation, explicitly not a plan.

## Judgment calls

- **"Self-capture does not merely prove the overlay rendered"** — it reads the public channel stream, so a source not in the active scene never reaches it. The brief's premise was corrected in the decision log rather than built on (`DECISIONS.md`, "CORRECTED THE BRIEF'S PREMISE").
- Confidence tiers never touch the amount — "weighting payout by evidence quality would charge a streamer for our own ability to observe them" (`DECISIONS.md`, "Confidence tiers decide REVIEW ROUTING, never payout").
- X and pump.fun **confirmed** parked, not assumed — then pump.fun reversed within a day by opening the page. "For 'is there a pullable stream', open the page and record the requests BEFORE writing the verdict."
- The pump.fun external source refuses a coin-page URL rather than calling the undocumented discovery API — a business risk, not a technical one.

## Verification result

`_gate-capture-hardening.mjs` 59/0 (three full HTTP broadcasts against a stub live stream with real badges); merged to prod in `f53bea1`. Self-capture still not run against a real broadcast — "the four bugs above are exactly the kind that a stub hides and a real broadcast finds" — which the next period proved right.
