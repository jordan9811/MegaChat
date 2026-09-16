# 2026-09-05 — Guest whitelist

Sources: `DECISIONS.md` ("Guest whitelist"), `OPEN-ISSUES.md` ("Guest whitelist", W1–W6), `docs/briefs/2026-09-05.md`, `megachat-guest-whitelist-prompt.md` (the ask); commits `a620c83` → `93c8519`, `ce1624c`, `3f4da17`. Hardening and merge came in Pass A ([2026-09-15 → 16](2026-09-15-16-pass-a-and-pass-b.md)).

## What shipped

A per-streamer list of MegaChat handles that join free, any time: the store (`guest-whitelist.js`), the free-join short circuit at the head of the join path, the account-scoped management API (`whitelist-routes.js`), the account-page UI, and a 53-assertion gate over HTTP (`11b70da`).

## What it found

- **No literal "invite-only mode" exists** for the whitelist to supersede; the nearest real settings (Join Stream off; the enforced watch-time gate) are covered and asserted separately (W1).
- **Guests exempt from the cap can push a LiveKit room to 3 + 20 publishers** — a real cost surface with only the breaker in front of it (W2). Pass A later capped the effective total at ten, derived from the canvas and the badge floor.
- **Several gates spawn a dev server and sleep a fixed 2.5–9 s** before their first request; on this machine a warm dev server takes 132 s to answer, and `_gate-dashboard-phase1` had *appeared* to pass on trunk only because a stale server still held its port — the zombie-server failure `_gate-helpers.mjs` exists to prevent (W5). Affected list recorded; fix is mechanical and not yet done.
- **Two false greens inside the new gate while writing it** (W6): `RPC_URL` pointed at the mock while the server reads `TEMPO_RPC_URL`, so "zero transfer calls" first passed against zero recorded calls; the cap section filled the list to the limit without attempting the add that should be refused. Both now assert positively.

## Judgment calls

- A guest seat **rides on top of `maxSeats`**, never takes a paid chair, never waits — chosen over queueing because "come and go as they please" is the feature (`DECISIONS.md`). Implemented as the existing pinned co-host seat so there is one free-seat concept, not two that can disagree.
- The check reads the sealed identity cookie, never a handle from the request body.
- Short-circuits at the **top** of the join path rather than bypassing the payment step, so a guest sees no payment prompt and no half-opened hold is left behind.
- Does not override a stopped room — that is the absence of a room, not a gate on the person.
- Per streamer, not per room; tri-state master switch on disk; no room-password path on management; cap 20 by default.

## Verification result

53/0 on `feat/guest-whitelist`, unmerged at the end of this period. Six gaps were closed and the gate extended to 63/0 before the merge in Pass A.
