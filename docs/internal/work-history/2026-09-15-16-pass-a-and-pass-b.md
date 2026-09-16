# 2026-09-15 → 09-16 — Pass A, Pass B, and the gate history reconciled

Sources: `megachat-pass-a-prompt.md`, `megachat-pass-a-finish.md`, `megachat-pass-b-and-docs.md` (the asks); `OPEN-ISSUES.md` (the four 2026-09-15/16 entries at the top of the file); `docs/pass-b-handoff.md`; `REPORT-DOCS.md`; commits `d35599d` → `03aabc0` on `origin/v0-ui-migration`, including merges `1191daf` and `c2c3807`.

## Pass A — reconcile the tree, ship the P0s, land the layout editor

**What shipped**

- **The worktree tree reconciled.** Five worktrees audited; one (`mc-ui-overhaul`) would have silently reverted work and was stashed, fast-forwarded and popped with every foreign edit preserved; two stale worktree registrations could not be deleted because OneDrive holds the files (reported, not forced); a stash that was not mine was recorded by SHA and neither restored nor dropped (`OPEN-ISSUES.md`, "STASHED EDITS … NOT MINE TO RESTORE").
- **`feat/real-broadcast` merged to prod** (`1191daf`): the self-capture proofs, the confidence/detection-rate split — **the underpay fix** — and the freeze window re-derived from the measured delay spread (`b3ccf8b`: 75 s / 51 s with L, D_min, D_max stated). Nine conflict hunks resolved deliberately; `bounty-store.js` kept prod's case-sensitive platforms *and* the branch's pump.fun mint check.
- **`NOT_SHOWN` is a verdict** (`d35599d`): a playback whose required code was never observed outranks how clearly the rest read; proven to discriminate by replaying the old ladder inline (`_gate-missed-code-authoritative.mjs`, 16/0).
- **Guest whitelist hardened and merged** (`2443b22`, `c2c3807`): six gaps closed — the cap raised as one value (`effectiveMaxSeats`), `MAX_SEATS = 3` killed in the overlay, the fail-open toggle made strict-boolean, handle squatting closed by pinning `identityKey`, the account-page pricing copy made to match the code, the gate extended 53 → 63 with a real second join and the guest rendering on the overlay past the cap.
- **The layout editor** (`94b0a23`): overlay grid as room config with a version, quarter-scale canvas, clamps, the ten-tile ceiling derived from the canvas and the badge floor.
- **The OBS smoke test** (`cd9806e`): ask a running OBS whether the overlay is on the programme scene and visible.
- **The whitelist identity migration** written and exercised locally; not run on prod (owner action).

**What it found, including the near-misses**

- **The prompt's P0 #2 was wrong and I built the wrong fix faithfully.** The owner corrected it: the real P0 was the underpay, already fixed on the branch. My `NOT_SHOWN` *review-cause* branch would have blocked payouts (`bounty-escrow.js` `pending_review`) and its justifying comment was false. Reverted; NOT_SHOWN opens review only where AMBIGUOUS would have (option 3).
- **The 90 s / 60 s freeze pair could not be justified** ("justify or size down"); resized to 75 s / 51 s with the derivation written out — and Run 2 found the comment's tail still describing the old pair, corrected then.
- **The enumeration-lockdown near-miss.** Three bounty UI files had conflicts resolved toward prod by recency; typecheck caught that prod's `getMyContributions(contributor)` predated the server-side lockdown that removed the argument because it was an enumeration hole. Reverted to the branch versions; the owner's rule recorded: "if you resolve any conflict toward one side by recency, check whether the other side held a fix with a matching signature." The three components render in the pre-Nerve skin as a consequence (logged as a front-end task).
- **`git add -A` swept 3,368 files** (a stale repo copy) into a commit; reset, recommitted eleven files, `.gitignore` hardened.
- The flaky section G of `_gate-bounty-claim` (fixed sleep, `stdio: 'ignore'`) recorded.

## Pass B Run 1 — posters for recent rooms (`d4cae00`)

`room-poster.js`: one JPEG per room at air-session close from the midpoint of the longest clip playback, stored in `data/room-posters/` so the 14-day capture purge cannot take it (gate C ages a capture 30 days, purges, and the poster survives); a typographic card for rooms with no capture, distinguishable by `poster.kind`; `attachRecording()` finally called; the rail reads one field off the room record. `_gate-room-poster.mjs` 19/0. Handoff updated. **Also in that commit: the retired `/bounty` disclosure was put back — a mistake, corrected below.**

## The gate history reconciled (`e578394`, `e0fda49`)

The owner asked which was true: Part 2's `_gate-bounty-claim` 101/0, or "red on the disclosure since 2a0cd60". Neither, exactly:

- Part 2's 101/0 was real output, judged on a `web/.next` built **before** the merge — section G served pre-merge HTML that still carried the line the merge had removed. The server-side sections stand; only G was judging the past. Parts 3–6 never ran that gate, so their greens stand. **G0** now refuses to run section G against a build older than the source, proven to discriminate (95/1 with G skipped on the stale build; 102/0 after `npm run build`).
- The line had been removed **on purpose** (`6386a2c`, 2026-09-01, at the owner's call). "Red since 2a0cd60" was wrong; the gate's assertion had simply never been updated for the decision. Run 1 fixed the wrong side; the reconciliation took the line out again and flipped the gate to hold the decision. Eleven other browser gates share the stale-build exposure and are listed.
- `seat_leave` moments added so peak seat count is derivable; leaves filtered off the wire and out of card counts (`_gate-room-poster.mjs` D6, 20/0). Pushed and confirmed live (536 s).

## Pass B Run 2 — this handbook

Gates 0–3 of `megachat-pass-b-and-docs.md`; the run log is in `REPORT-DOCS.md`. Found while citing: the stale freeze-delay comment (above); the bounty badge's corner does not follow the layout origin ([Outstanding](../outstanding.md), [limitations register](../limitations-register.md) L13).

## Verification result

Pass A: `_gate-bounty-claim` 101/0 (see the reconciliation — G judged a stale build), `_gate-missed-code-authoritative` 16/0, `_gate-guest-whitelist` 63/0, `_gate-follow-stream` 18/0, overlay gates, Gate H 0 offenders, `tsc` 0, build clean, live at `3bdef1b`. Pass B: `_gate-room-poster` 20/0, `_gate-bounty-claim` 102/0 on a fresh build, live at `e0fda49`.
