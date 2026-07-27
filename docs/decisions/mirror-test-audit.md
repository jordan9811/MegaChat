# Mirror-test audit

**Date:** 2026-07-27
**Trigger:** the black-OBS-tile regression shipped green because the gate tested
a *copy* of the overlay's reveal logic rather than the overlay.

## What counts as a mirror

A gate case that reimplements our own logic and then tests the reimplementation.
The copy can drift from the original, at which point the test still passes and
means nothing.

Three things that are **not** mirrors, and were excluded:

- **Black-box tests against a real server.** Most gates spawn `server.js` (or hit
  an already-running one, as the tempo gates do) and drive it over HTTP/WS or a
  real browser page. That is the strongest form, not the weakest — no imports
  needed. An early pass of this audit wrongly flagged all 3 tempo gates (48
  cases) on "no project imports"; they drive real mainnet flows.
- **Test doubles for EXTERNAL dependencies.** `MockFrameSource`, `MockCodeChecker`,
  `StubSettlement`, the fake Privy provider. Standing in for Twitch or a chain is
  correct; there is nothing of ours being copied.
- **Comments describing a feature** ("gates mirror the MegaChat gate") or an
  external system's behaviour (Arc's ERC-20 mirroring native balance).

## Result

**Total gate/verify cases across the suite: ~700. Genuine mirrors: 19 (2.7%),
in 3 files.** Ranked by what a stale copy would cost:

| # | Where | Cases | Mirrors | Risk if it drifts | Status |
|---|---|---|---|---|---|
| 1 | `_gate-mpp-clientpath.mjs:144` | 11 | `normalizeTempoTx`, `WALLET_ONLY_METHODS` from `web/lib/join-page.ts` | **Payment path.** A stale copy passes while real payments break. | **Drift detector added** |
| 2 | `_gate-lazy-connect.mjs` D+E | 6 | the overlay's reveal gate — comment said "Mirror of the overlay's reveal gate" | **This is the one that already bit us** (black OBS tile). | **CONVERTED** |
| 3 | `_gate-lk-phase3.mjs:170,214` | 2 | the client's meter pause/resume on reconnect | Billing continues while disconnected, or stops when it should not. | Filed |
| 4 | `_gate-tempo-phase3.mjs:182` | ~1 | client tick behaviour inside a mainnet parity sweep | Lower — the surrounding flow is real and would fail loudly. | Filed |

## What was done

**#2 converted.** The D+E block no longer calls `page.setContent('<div id="stage"></div>')`
and reimplement the gate. It loads `/overlay` and calls the page's own
`markStingerRevealPoint` / `lkAttach` / `maybeReveal` against its own `lkReveal`
map and real DOM. Drift is now impossible by construction. Case count went 6 → 7
(gained: the real tile actually drops `.lk-holding`, which the mirror could not
see because it had no DOM). Cost: the block now needs a server, which it did not
before. Worth it.

**#1 given a drift detector rather than a conversion.** Converting it means
driving the real `ensureMppSession` with a funded wallet on a live chain, which
is exactly why it was copied. Instead `_verify-mirror-drift.mjs` compares the
copy against the original directly, so the day someone edits one and not the
other, a test fails instead of quietly meaning nothing. Currently identical.
Negative-tested: removing one method from the copy fails the check and names it.

**#3 and #4 filed, not converted.** Both are small, both sit inside gates whose
surrounding flow is real, and #4's mainnet sweep would fail loudly on real
divergence anyway. Converting them was not worth the churn tonight.

## The honest caveat

A drift detector is weaker than a conversion. It proves the copy still matches
today's original; it does not prove either one is correct. #1 remains the
riskiest untested-for-real path in the suite, and the real fix is a browser-driven
payment gate against a funded test wallet. That needs a wallet that does not
exist here.
