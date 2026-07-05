# NIGHT_CHECKLIST — multi-fix pass 2026-07-05

Six groups, each gated + committed separately off baseline `35402fc`.
Production `npm run build` passes; full-site sweep (7 pages) = zero console
errors, zero dead links, zero stale copy.

| Group | Commit | Gate |
|-------|--------|------|
| 1 — landing cleanup: LEVEL UP deleted, nav bottom-right (Dashboard / How it works / Roadmap / FAQ / Contact via `CONTACT_URL`), tagline promoted, hero copy trimmed | `49a0318` | rendered-HTML greps + zero console errors |
| 2 — /how-it-works (+FAQ merged as `#faq`) and /roadmap from ROADMAP.md | `4fa7234` | 200s + section greps + accordion click |
| 3 — light mode reaches the whole landing page (var-driven .bg-noir/.bg-grid; join stays dark-locked by design) | `08328c1` | `_gate-theme.mjs` PASS + new pages shot both themes |
| 4 — graffiti tagline (Kaushan Script) centered under wordmark, GRAB hitbox realigned to the button art + hover tilt / click rattle, ticket badge | `957aa7e` | click-center-of-pill navigates `#browse`; screenshots `join-fix-evidence/g4-*` |
| 5 — wallet line no longer wraps (middle-truncated addr), stinger selects readable + mock camera-square preview playing the real overlay animations | `78b90ec` | contrast/height measurements + animation playback assertions; `join-fix-evidence/g5-*` |
| 6 — WS reconnect grace (30s, `SEAT_RECONNECT_GRACE_MS`), client auto-reconnect + re-register, pagehide leave beacon, dashboard Signal column (good/unstable), overlay `buffer=300&retrytimeout=2000` | `d4e9e0d` | `_gate-stability.mjs` PASS on a real Gateway-paid seat |

## Needs a human (this pass)
1. **Set `CONTACT_URL` on Railway** — the footer Contact link falls back to a
   placeholder (`https://x.com/megachat`). Set the real X/Twitter URL in
   Railway → Variables (also appended to local `.env`); no code edit needed.
2. **Arc USDC deposit quirk (gate harness knowledge)** — the Arc ERC-20 USDC
   mirrors the native balance; Gateway deposits of ~90% of a wallet's balance
   revert with "transfer amount exceeds balance". Keep gate deposits well
   under half the funded amount (`_gate-stability.mjs` comments).
3. **Turbopack dev cache can go stale on OneDrive** — if new Tailwind classes
   silently don't apply in dev, delete `web/.next` and restart. Prod builds
   unaffected.

---

# NIGHT_CHECKLIST — night pass 2026-07-04

> **Deploy status: ALL LIVE on `megachat-production.up.railway.app`** — every
> commit below was pushed to GitHub `v0-ui-migration` and verified on the live
> URL (Railway auto-builds `npm run build` + `--prod`). Earlier in the night the
> feature commits sat unpushed, which is why the deployed site looked unchanged;
> that's fixed — nothing is stranded local now.

## AAA polish pass (after the 4 feature parts)
| Polish | Commit | Live-verified |
|--------|--------|---------------|
| Global feel — motion keyframes, neon scrollbar, selection, reduced-motion | `052b83e` | ✅ |
| Hero — staggered reveals, metallic animated wordmark, IPO stat strip | `052b83e` | ✅ |
| Browse — killed localhost dev-ism, skeleton loaders, live pulse stat | `052b83e` | ✅ |
| Header — neon hairline + glowing CTA | `052b83e` | ✅ |
| Social share cards (OG + Twitter) + branded 404 | `02351f3` | ✅ |
| Join + dashboard entrance motion (consistency) | `6805db6` | ✅ |

Every polish push passed a real `npm run build` (Railway parity), both themes,
and a zero-console-error sweep. Screenshots: `join-fix-evidence/polish-*.png`.

---

All four feature parts landed, gated, and committed separately. `.env` untouched.

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
