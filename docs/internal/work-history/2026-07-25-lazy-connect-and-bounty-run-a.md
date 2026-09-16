# 2026-07-25 — Lazy connect, and bounty Run A

Sources: `DECISIONS.md` ("LiveKit Cloud validation run", "Creator bounty — Run A", "Creator bounty — patch", "Merge / rebase / deploy run"), `OPEN-ISSUES.md` (the lazy-connect and Run A sections, L1–L7, B1–B5, G1–G9), `HANDOFF-LAZY-CONNECT.md`, `HANDOFF-BOUNTY.md`, `LIVEKIT-AUDIT.md`, `docs/briefs/2026-07-25.md`, merges `525c8d2` and the bounty commits `933300d` → `312ca30`.

## What shipped

**Lazy connect.** The overlay used to open a LiveKit connection on page load and never close it, burning ~43,200 participant-minutes a month per streamer against a 5,000-minute tier (`LIVEKIT-AUDIT.md`; `livekit-lazy.config.js`). Shipped: connect only while a seat is being bought or held, a grace window after the last seat, an abandon cap with its own sweeper (a hold whose visitor closed the tab is released at ~90 s, not the 5-minute TTL), `sendBeacon` on the bail path, a webhook receiver that becomes the authoritative session ledger, and a burn circuit breaker that reads webhook data and refuses *new* tokens at 95% of budget without ever cutting a live session. Gate 49/0 then 65/0 against the real local SFU.

**Bounty Run A.** The data model, append-only ledger, escrow state machine (113 illegal transitions verified to throw and write nothing), watermark issuance, the verifier pipeline with mocked frame sources, the HTTP surface, the overlay badge, the board/claim/admin UI. `BOUNTY_CLAIM` off by default, mounting nothing. **Settlement absent by design** — no signer, no contract call, no path that becomes live by flipping a boolean; Gate H greps for transfer calls and asserts zero (`bounty-settlement.js`; `HANDOFF-BOUNTY.md`).

**The patch, same day.** Codes issued only during clip playback and bound to the clip (playback proof and airtime proof become one artefact); rotation 60 s → 4 s, validity clamped to clip end; clips under 3 s pay nothing and say so; payout per verified clip playback rather than per minute; the ledger moved to append-only JSONL with sequence + checksum (torn tail recovers, interior gap refuses to boot); legibility enforced in the verifier via measured `pixelHeight`; AMBIGUOUS opens a review that blocks release (`DECISIONS.md`, "Creator bounty — patch").

## What it found

- The Cloud validation could not run honestly: 6 of 12 `/rtc/validate` probes returned 429 — quota, not rate limiting, as the next day proved (`OPEN-ISSUES.md` L1, L6). Reported rather than measured at 50% rejection.
- `refundExpired` was not idempotent; found by the gate, money already safe via idempotency keys, fixed so a retry cannot error (`DECISIONS.md`).
- The bounty rebase genuinely conflicted at three adjacent-addition hunks; stopped and reported rather than resolved creatively, then resolved deterministically in the merge run.
- Three bounty follow-ups had been asked about as "pinned" and were not in `OPEN-ISSUES.md` at all — filed (P1 per-playback nonce, P2 sub-3s residual, P3 frame-sampling cost).

## Judgment calls

- The breaker reads **webhook** consumption, never the overlay's self-report — "a breaker fed by the same self-report that hid the last leak would fail in exactly the case it exists for" (`DECISIONS.md`, "Breaker reads WEBHOOK data").
- Backgrounding a tab does not release a hold; people tab away mid-wallet-dialog.
- `BOUNTY_CLAIM` defaults off (money-adjacent, mainnet) while `LAZY_CONNECT` defaults on (fixes a live cost bug) — the asymmetry is deliberate.
- The watermark badge is a separate persistent element, not inside a MegaChat tile, because a ~10 s tile against a 60 s rotation would have failed honest streamers.

## Verification result

Lazy-connect gate 65/0; bounty gate 33/0 → 49/0 after the patch; merged to prod (`525c8d2`), webhook route verified live with real signed deliveries (`DECISIONS.md`, "Verified production with REAL signed webhook deliveries").
