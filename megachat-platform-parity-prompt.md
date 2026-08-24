# MEGACHAT: PLATFORM PARITY AND LOCKDOWN — paste into Claude Code from repo root

/goal

Remove the platform dependency that makes Twitch the only workable verification target, close the two things gating a public flag-on, and answer two feasibility questions without building on them. Frontend work comes after this run.

Branch `feat/platform-parity` off trunk. Commit per unit. HEAD always builds. Log judgment calls in `DECISIONS.md`.

**Standing constraints:** no settlement, Gate H finds zero transfer calls, `BOUNTY_CLAIM` off by default, real pages not mirrors, gates exercise HTTP routes, zero external spend inside gates. LiveKit budget 20 minutes, report actual.

---

## T0 — Housekeeping

A previous session left a dev server on :56440, appended `OBS_ONECLICK=1` to local `.env`, and left `_dev-mock-obs.mjs` untracked. Stop the server, revert the `.env` change, commit the mock properly or delete it. Report what you cleaned.

## T1 (P0) — Self-capture, so verification stops depending on platform VODs

Verification is VOD-first, which works on Twitch and nowhere else. Kick has no VOD listing in its official API, so Kick is live-only with no retry: one failed grab and an honest streamer goes unverified. X has the same shape.

We do not need their VOD. We need **a** recording, and we can make our own.

- During an air session, maintain a **rolling buffer** of the last ~60s of HLS segments in memory, continuously discarded as it ages. When a clip playback ends, freeze the window covering it and persist only that window.
- The rolling buffer is what avoids racing the 15-25s broadcast delay, and it means the skew does not need to be known in advance to know what to keep.
- Expose as a `FrameSource` implementation so Twitch and Kick both use it and the verifier path is unchanged. Self-capture becomes primary; Twitch keeps its VOD source as secondary.
- Persist captures as evidence with the same append-only treatment the clip index and ledger use. Retention configurable. Captures purge when their pledge does.
- **Capture only while an air session is open, never for the whole broadcast.** The session lifecycle already gives that boundary. This is a verification capture, not a recording of someone's stream, and that has to be true in the code, not just the copy. State in the handoff how much video is retained per session and for how long.

Gates: buffer holds only the configured window and discards beyond it; a playback freezes the correct window under a realistic delay; captures verify through the existing decoder; captures purge with their pledge; capture does not run outside an air session.

## T2 (P1) — Prove Kick end to end

Kick's live path has never faced a real Kick broadcast. Twitch is proven, Kick is inferred.

- Build the Kick equivalent of the rehearsal harness so a real broadcast verifies in one command.
- If a Kick stream key is in env, run it unattended (~12 min), same as the Twitch rehearsal. If not, ship the harness, say plainly that Kick is unproven pending one broadcast, and state exactly what is needed. **Do not loop on this.**
- Report detection on Kick's real encoder versus the synthetic corpus at the same resolution.

## T3 (P2) — X and pump.fun feasibility, investigate only

Do not build either. Answer one question each in `docs/platform-feasibility.md`, then stop. **This task is not part of the loop.**

- **X:** what do live-status and stream access actually cost and require at current API tiers, and is there any path short of an enterprise agreement? My understanding is no, and that X should be parked. Confirm rather than assume.
- **pump.fun:** is there a documented API surface exposing live status and a pullable stream? If yes, what would integration take. If undocumented or unstable, say so and stop.

## T4 (P0) — Lock down the bounty routes

Bounty routes have no auth. Approve, reject, and admin are open. This must close before the flag is ever public.

- Streamer-scoped actions (approve, reject, delay, claim status) require the authenticated claimant for that handle.
- Admin actions require an admin credential, not obscurity.
- Every state-changing route authorizes server-side, not in the UI.
- Gate it so unauthenticated and wrong-user requests are rejected on every state-changing route, with the gate enumerating routes so a new one cannot be added without a matching case.

## T5 (P1) — Sign-in to pledge

`contributor` is an unauthenticated string, so strikes are shed by picking a new name and probing the classifier is free.

- Require an authenticated identity to pledge; attach strikes to it.
- Keep friction as low as possible while still costing something to recreate.
- Report what a fresh account costs after this change.

---

/loop

Iterate T0, T1, T4, T5 until every gate for those tasks passes and the full existing suite is green with no regressions. T2 exits after one real run or an honest blocked report. T3 exits after the writeup. Do not loop on anything waiting on a credential or an external answer.

Stop and report if the same gate fails three times in a row rather than grinding.

---

## Hand back

- Housekeeping cleaned.
- How much video is retained per air session and for how long.
- Whether Kick ran for real or is pending, with exactly what is needed.
- X and pump.fun findings, plainly.
- Route auth gate coverage: which routes, how enumerated.
- Fresh-account cost after the sign-in change.
- Gate SHAs, LiveKit minutes, external spend, updated `OPEN-ISSUES.md`, brief per convention.

Decide rather than ask. If a platform surface fights past 45 minutes, isolate behind its interface, stub honestly, file it, keep moving.
