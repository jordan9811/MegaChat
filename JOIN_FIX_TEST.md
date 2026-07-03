# JOIN_FIX_TEST — Gateway deposit flow + passkey registration path

Both reported join-page flows were fixed and **exercised end-to-end in a real browser**
(system Chrome via puppeteer-core) against the live server, Arc Testnet, the Circle
Gateway facilitator, and the Circle passkey API. Driver: `_verify-join.mjs`
(`node _verify-join.mjs baseline|full`). Screenshots in `join-fix-evidence/`.

## What was actually broken (byte-for-byte comparison + live repro)

The ported logic in `web/lib/join-page.ts` is byte-identical to `public/index.html` —
the port didn't drop anything. Both pages shared the same defects:

1. **Deposit button permanently greyed** — `renderWallet()`'s connected-MetaMask branch
   `return`ed without ever setting `depositBtn.disabled = false`; the only line that
   touched it (`dep.disabled = !account`) sat in the *disconnected* branch, so the button
   disabled on page load and nothing ever re-enabled it. Introduced by commit `8e95156`
   ("Fix wallet init TDZ…" gating), inherited verbatim by the port.
   Live repro (baseline run): `connected: … depositBtn.disabled=true`.
2. **"Balance shows 0" / join "available 0"** — downstream of (1): users could never
   deposit, so their Gateway balance genuinely was 0. The balance *fetch/display path
   itself works*: baseline showed the funded seller wallet rendering `Remaining 10 USDC`
   right after connect, and the server `/api/balance` returned `available:"10",
   canJoin:true` for it.
3. **Passkey: no create path for new users** — one button ("Sign in with Passkey") ran an
   implicit stored-credential→login / else→register flow; a duplicate username forced a
   LOGIN fallback on a device with no passkey → the browser's "no passkeys" error.
4. **Passkey: no connected feedback** — `connectPasskeyWallet()`'s `finally` block reset
   the button label/disabled state *after* `renderWallet()` had set "Passkey connected",
   clobbering it — the button looked idle and clickable after a successful connect.

## Fixes (all mirrored into the legacy `public/index.html` for parity)

| File | Change |
|------|--------|
| `web/lib/join-page.ts` (`renderWallet`) | Connected-MetaMask branch now enables the deposit button; disconnected state gates it on wallet presence (`depositToGateway()` self-connects); 🟢 connected indicators with the address for both wallet modes; two-button passkey states |
| `web/lib/join-page.ts` (`connectPasskeyWallet(mode)`) | Explicit `register` / `login` / `auto` modes; `finally` restores idle labels **only when not connected** (fixes the clobber); mode-aware errors ("No passkey found on this device… use Create passkey", "username already has a passkey — use Sign in") |
| `web/components/join/join-client.tsx` | Two passkey buttons: `✨ Create passkey (new here?)` (`#passkeyCreateBtn`) and `🔐 Sign in with existing passkey` (`#passkeyBtn`) |
| `src/passkey-wallet.mjs` (+ rebuilt bundle) | New `registerPasskey(username)` (duplicate username → typed `USERNAME_TAKEN` error) and `loginPasskey(username?)` (discoverable login — no username needed); `connectPasskey` refactored on top as the legacy auto mode |
| `public/index.html` | Same markup + logic fixes as above (legacy page stays consistent) |
| `_gate-phase2.mjs` | Legacy-page content check now fetches `/index.html` (post-unification `/` is the Next app) — restores the gate's original intent |

## Verification — full transcript (2026-07-02, `node _verify-join.mjs full`)

A **fresh viewer wallet** is generated and funded from the seller each run (0.05 native
gas + 1.0 ERC-20 USDC) — a seller-as-viewer join is rejected as `self_transfer`, which is
also why the baseline join errored that way. MetaMask is simulated by an injected
EIP-1193 shim whose signing runs in node (key never enters page JS); passkeys use a CDP
WebAuthn virtual authenticator.

```
═══ [A] MetaMask / Gateway flow (full) ═══
  connected: walletInfo="🟢 Connected · Wallet: 0x62F5A661…" 
  connected: meterRemaining="0 USDC" depositBtn.disabled=false joinBtn.disabled=false
  ✅ wallet address shown after connect
  ✅ balance fetch rendered ("0 USDC")            ← fresh wallet: a real fetched zero
  ✅ deposit button ENABLED when connected        ← BUG 1 fix
  [shim] sent tx eth_sendTransaction → 0xeb97ecaa…   (approve)
  [shim] sent tx eth_sendTransaction → 0x31861dd5…   (Gateway deposit 0.2 USDC)
  ✅ deposit flow completed through page UI
  ✅ Gateway balance INCREASED after page-driven deposit   (0 → 0.2)
  ✅ page meter reflects Gateway deposit ("0.2 USDC")      ← "balance shows 0" fixed
  ✅ JOIN succeeded (payment settled, seat granted)        ← 402 → EIP-3009 sign → settle
  meter after join: remaining="0.2 USDC"; left the seat (refund path exercised)

═══ [B] Passkey flow, brand-new user (full) ═══
  passkey buttons: main="🔐 Sign in with existing passkey" createBtn=present
  ✅ explicit CREATE path offered to new users             ← BUG 2 fix
  [passkey] registering new passkey for verify-mr49k5ef
  [passkey] smart account: 0x078b2c6a8a2aaa8eca3f632d1472cb958b41586d
  ✅ smart account address shown ("🟢 Connected · Smart account: 0x078b2c6a…")
  ✅ clear connected indicator shown                       ← no-feedback bug fixed
  (reload — returning user)
  [passkey] logging in with existing passkey…
  [passkey] smart account: 0x078b2c6a8a2aaa8eca3f632d1472cb958b41586d
  ✅ returning user signed in with existing passkey        ← same address recovered

VERIFY FULL PASS
```

Baseline run (pre-fix, same driver) had captured the defects live:
`depositBtn.disabled=true` after connect, join → `❌ self_transfer` (seller-as-viewer
artifact; a real empty wallet gets "available 0"), and the funded seller wallet correctly
rendering `Remaining 10 USDC` — proving the balance pipe was never the problem.

### Screenshots (`join-fix-evidence/`)

- `full-A2-connected.png` — 🟢 connected wallet, deposit button enabled
- `full-A3b-balance-reflected.png` — meter showing the finalized 0.2 USDC Gateway deposit
- `full-A4-joined.png` — seat granted, camera stage up, meter running
- `full-B2-created-connected.png` — new user created a passkey; connected state with address
- `full-B3-signin-returning.png` — returning user signed in with the existing passkey
- `baseline-A2-connected.png` — pre-fix: deposit button greyed after connect (the bug)

### Gates

- `node _gate-phase2.mjs` — **all green** (after pointing its legacy check at `/index.html`).
- `_gate-ui-part-a.mjs` — fails at boot (2.5 s wait vs slower unified Next dev startup) and
  expects pre-migration markup on `/`; it failed identically before this change —
  pre-existing staleness from the unification, out of scope here.

### Env

`.env` untouched this pass (no vars added, removed, or modified). Keys verified live at
boot: `[refund] seller refund wallet ready` + rewards attached non-dry-run.

---

# Join button state machine + passkey prominence (2026-07-02, follow-up)

The join flow was restructured around ONE morphing button — no separate Go Live button,
no scrolling between camera and controls:

```
🎬 Join Stream ──click──▶ 🔐 Connecting passkey… ──▶ ⏳ Authorize/Confirm…
      ▲                        (connected state: 🟢 + address)
      │                                   │ seat granted
      │                                   ▼
   leave / out_of_funds        ⏳ Waiting for camera…   (camera preview appears ABOVE)
      │                                   │ camera detected (or 5 s fallback)
      │                                   ▼
      └───────────── 🔴 You're LIVE ◀──click── 🎥 Go Live
```

- **Passkey primary**: Create/Sign-in buttons render larger and above the compact
  MetaMask + Deposit row (`web/components/join/join-client.tsx`). Clicking **Join Stream
  while disconnected runs passkey auth automatically** (register or sign-in), shows the
  🟢 connected state, then continues into the seat purchase — no separate connect step.
- **State machine** (`setJoinState` in `web/lib/join-page.ts`): every transition goes
  through one owner; `renderWallet`, error paths, `seat_removed`, and `leaveStream` can
  no longer leave the label stale. Repeat clicks in non-idle states are ignored.
- **Camera above the button**: the stage moved inside the card directly above `#joinBtn`
  (preview capped at 240 px). Camera detection (or the 5 s fallback) relabels the SAME
  button to **Go Live**; clicking it starts the meter. A stale error message is cleared
  when a new attempt starts.

## Verified end-to-end (`node _verify-join.mjs full` — VERIFY FULL PASS)

```
═══ [C] state machine — passkey-first click (unfunded) ═══
  ✅ join button starts enabled as "🎬 Join Stream" while DISCONNECTED (passkey-first)
  ✅ passkey buttons render ABOVE MetaMask (primary path)
  ✅ clicking Join ran passkey auth and shows connected state ("🟢 Connected · Smart account: 0xbfcc…")
  ✅ button returned to idle "Join Stream" after funds error
═══ [D] funded passkey ride ═══
  ✅ passkey JOIN succeeded (approve userOp accepted, seat granted)   ← real sponsored userOp
  ✅ camera stage appeared after seat granted
  ✅ camera preview renders ABOVE the join button
  button right after seat: "⏳ Waiting for camera…"
  ✅ SAME button relabeled to "Go Live" once camera stage was up
  ✅ camera box + button fit one viewport together (span 398px)
  ✅ GO LIVE click → LIVE state (camStatus="cam-status live")
  ✅ leave resets the button to idle "Join Stream"
```

Sections [A] (MetaMask deposit→join) and [B] (passkey create/sign-in) from the previous
fix still pass unchanged in the same run. New screenshots: `full-C1-connected-unfunded.png`,
`full-D1-go-live-ready.png`, `full-D2-live.png`, `full-D3-after-leave.png`.

The legacy `/index.html` page keeps its original flow (separate Go Live button) — the
state machine applies to the Next join page only.

## Re-verify after future changes

```
node _verify-join.mjs full     # needs Chrome; funds a fresh viewer + passkey account from the seller
node _gate-phase2.mjs
npm run build:passkey          # if src/passkey-wallet.mjs changed
```
