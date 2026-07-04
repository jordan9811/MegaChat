# NIGHT_CHECKLIST — night pass 2026-07-04

All four parts landed, gated, and committed separately. `.env` untouched.

| Part | Commit | Gate |
|------|--------|------|
| baseline | `aa52ae4` | — |
| 1 — overlay restyle, countdown removed | `ee4322d` | `_gate-overlay.mjs` PASS |
| 2 — stingers (5 in / 4 out) + join picker | `37f3b40` | `_gate-overlay.mjs stingers` PASS (all 9) |
| 3 — co-streamer pin | `4808bf9` | `_gate-pin.mjs` PASS (charges freeze/resume proven on a live seat) |
| 4 — light mode + sweep | (this commit) | `_gate-theme.mjs` PASS (both themes × landing/dashboard/join) |

## What light mode actually needed
The landing hero + join page are **dark-locked by design** (scoped `.dark`
wrappers) and were fine. The real defect was the header wordmark: hardcoded
near-white text stroke → illegible on the light header. Now theme-aware via
`--wordmark-stroke` (globals.css both theme blocks + wordmark.tsx).

## Sweep results
Console/network sweep over `/`, `/dashboard`, `/join`, `/overlay`,
`/index.html`: **zero JS errors/exceptions**; only defect was a `/favicon.ico`
404 on every page load — fixed with a redirect to `/icon.svg` in server.js.

## Needs a human / bigger than tonight
1. **Passkeys are dead on localhost** — when the Railway domain was added to
   the Circle client key, `localhost` was dropped. Re-add BOTH
   `localhost` and `megachat-production.up.railway.app` in Circle Console →
   Modular Wallets client key. (This is why `_gate-pin.mjs` builds its seat
   through the Gateway/MetaMask shim instead of a passkey.)
2. **`default` room password drifted** — it no longer matches
   `ROOM_DEFAULT_PASSWORD` in .env (changed via dashboard at some point).
   Gates create their own rooms; humans should use the dashboard password.
3. **Overlay renders max 3 tiles** (`MAX_SEATS` in overlay.html) but a pinned
   co-host no longer counts toward the server's seat cap — 3 payers + 1
   pinned = 4 live seats, overlay silently skips the 4th. Decide: raise the
   overlay cap to 4 when a pinned seat exists, or keep 3 and accept it.
4. **Legacy `/index.html` page** has no stinger picker (auto-default only)
   and keeps the old overlay-era styling. Fine as a fallback; retire or port
   when convenient.
5. **`_gate-ui-part-a.mjs` is stale** (pre-unification markup expectations +
   2.5s boot wait vs slower Next dev startup). Modernize or delete.
6. **Stinger fly-in on OBS reconnect**: `initial_state` seats replay their
   entrance stinger when the overlay reloads mid-stream. Harmless but a
   `skipAnimation` flag on initial_state would be cleaner.

## Re-run everything
```
node _gate-overlay.mjs stingers   # parts 1+2
node _gate-pin.mjs                # part 3 (funds a viewer from the seller)
node _gate-theme.mjs              # part 4
node _gate-phase2.mjs             # legacy contract
node _verify-join.mjs full        # full join flows (needs Circle localhost fix for C/D)
```
