# Phase 2 — Passkey per-second stream meter

Branch: **`modular-wallets`**

## Approach used: **B** (approve + server `transferFrom` ticks)

| Option | Status | Why |
|--------|--------|-----|
| **A — Session key module** | Not used | Circle Modular Wallets SDK/docs list ERC-6900 session keys as coming soon; no installable session-key module on Arc Testnet in `@circle-fin/modular-wallets-core`. |
| **B — Streamed pulls** | **Implemented** | Viewer signs **once** (gasless userOp `approve(seller, sessionCap)`). Server pulls `PASSKEY_TICK_PRICE` every `PASSKEY_TICK_SECONDS` via `transferFrom(viewer, seller, tick)` using `SELLER_PRIVATE_KEY`. No per-tick passkey prompts after join. |
| **C — Prepaid block fallback** | Not needed | Approach B constructs and passes automated gate; MetaMask/Gateway path unchanged (still prepaid block meter). |

Defaults (override in `.env`):

- `PASSKEY_TICK_SECONDS=1` — true per-second meter
- `PASSKEY_TICK_PRICE=0.001` — USDC per tick (6 decimals)
- `MAX_SESSION=2` — approval cap / tracked session balance

MetaMask path still uses `TICK_SECONDS=10`, `TICK_PRICE=0.1` (unchanged).

---

## Automated gate (headless)

```bash
npm run build:passkey
node _gate-phase2.mjs
```

Checks: stream meter math (dry-run to zero), server boot, `GET /` 200, `/api/config` passkey tick fields, bundle serves `authorizeSessionGasless`.

---

## Manual live test — http://localhost:3000

**Prerequisites**

1. `.env` with `CIRCLE_CLIENT_KEY`, `CIRCLE_CLIENT_URL`, `SELLER_WALLET_ADDRESS`, **`SELLER_PRIVATE_KEY`** (required for on-chain `transferFrom` pulls).
2. Circle Console passkey domain = **`localhost`**.
3. Fund passkey smart account via [faucet.circle.com](https://faucet.circle.com) (Arc Testnet) — at least `MAX_SESSION` USDC.

**Steps**

1. `npm run build:passkey && npm start`
2. Open **http://localhost:3000** (not 127.0.0.1 — passkey domain).
3. DevTools → Console: should be clean on load (no module/TDZ errors).
4. Enter username → **Sign in with Passkey** → complete Face ID / platform auth.
5. Confirm header shows passkey pricing (`0.001 USDC/s` by default).
6. **JOIN STREAM** → **one** passkey prompt for USDC **approve** (not transfer). Note approval tx link.
7. Allow camera → go live automatically (or GO LIVE fallback).
8. **UI meter:** `Remaining` ticks down every `PASSKEY_TICK_SECONDS`; `≈ time left` counts down.
9. **Arcscan:** open [testnet.arcscan.app](https://testnet.arcscan.app) → smart account address → watch **Transfer** txs from viewer → seller every second (server `[meter:passkey]` logs in terminal).
10. **Silent pulls:** no additional passkey/WebAuthn prompts after step 6.
11. **Auto-kick:** let balance drain (or set `MAX_SESSION=0.01` for faster test) → seat removed, `out_of_funds` message, overlay tile gone.
12. **Leave:** click Leave Stream → meter stops; unspent USDC stays in smart account (no refund tx).

**Regression (Phase 1 + MetaMask)**

- MetaMask JOIN still works (Gateway EIP-712, prepaid block meter).
- Overlay tiles, `generateVDORoom`, seat/WS lifecycle unchanged.

---

## What remains untested until you run the manual steps

- Live WebAuthn approve userOp on Arc
- Real on-chain `transferFrom` every tick (needs `SELLER_PRIVATE_KEY` + allowance)
- End-to-end auto-kick at zero on testnet

Automated gate only proves construction + dry-run math.
