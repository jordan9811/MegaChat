# Phase 1 Morning Test — Passkey Modular Wallets

**Prerequisites**
- Passkey bundle built: `npm run build:passkey` (re-run after editing `src/passkey-wallet.mjs`)
- Server running: `npm start` on branch `modular-wallets`
- Open **`http://localhost:3000`** only (passkey domain in Circle Console is `localhost` — Cloudflare tunnel will **not** work for passkeys)
- `.env` has `CIRCLE_CLIENT_KEY` and `CIRCLE_CLIENT_URL` from Circle Console
- MetaMask still works as the alternate path (optional second browser/profile)

---

## Step 0 — Clean load (no wallet)

1. Open `http://localhost:3000` in a fresh private window (no MetaMask connect).
2. Open DevTools → Console.

**Expected console**
- `Connected` (WebSocket)
- `[passkey]` lines only **after** you click passkey — not on load
- **No** `Cannot access … before initialization` errors
- **No** uncaught `TypeError` / `ReferenceError`

**Expected UI**
- Both buttons visible: **Connect MetaMask** and **Sign in with Passkey (Face ID)**
- JOIN disabled until a wallet path is connected

---

## Step 1 — Passkey register / login

1. Enter username (e.g. `alice`).
2. Click **Sign in with Passkey (Face ID)**.
3. Complete Windows Hello / Face ID / Touch ID when prompted.

**Expected console**
```
[passkey] modular clients ready (Arc path: arcTestnet)
[passkey] registering new passkey for alice   ← first time
   OR
[passkey] logging in with stored credential… ← return visit
[passkey] smart account: 0x…
```

**Expected UI**
- Green success toast: passkey smart account ready
- Smart account address shown under wallet info
- Faucet note with link to https://faucet.circle.com (Arc Testnet)
- **Remaining** meter updates (likely `0 USDC` before funding)
- Deposit-to-Gateway button **hidden** (passkey path)

---

## Step 2 — Fund smart account

1. Copy the smart account address from the UI.
2. Go to https://faucet.circle.com → select **Arc Testnet** → request testnet USDC to that address.
3. Wait ~30–60s, refresh page or reconnect passkey.

**Expected**
- **Remaining** shows funded balance (up to session cap from `MAX_SESSION` in `.env`)
- Console: balance refresh with no errors

---

## Step 3 — JOIN gaslessly

1. Click **JOIN STREAM**.
2. Approve passkey prompt for the gasless user operation.

**Expected console**
```
[passkey] sending gasless join payment … USDC → 0x… (seller)
[passkey] join payment confirmed: 0x…
```

**Expected UI**
- Inline camera stage appears (same as MetaMask path)
- Meter shows prepaid session balance

**Server console**
```
[seat] <id>: camera live — meter started (… USDC prepaid)
```
(after camera goes live)

---

## Step 4 — Camera + overlay + meter

1. Allow camera in the inline iframe.
2. Open overlay (`http://localhost:3000/overlay`) in OBS or a second tab.

**Expected**
- Tile appears on overlay after camera is live (not before)
- Meter counts down every `TICK_SECONDS` on index page
- Leave Stream or tab close refunds unused balance (if `SELLER_PRIVATE_KEY` set)

---

## Step 5 — MetaMask path regression (quick)

1. New private window with MetaMask on Arc Testnet.
2. Click **Connect MetaMask** (do **not** use passkey).
3. Deposit to Gateway + Join — should behave exactly as before Phase 1.

**Expected**
- MetaMask EIP-712 signature prompt on join (not passkey)
- No passkey console lines unless you click passkey button

---

## Arc transport path (verified in code)

Circle skill **Transport URL Path Segments** table:

| Chain | Testnet Path |
|-------|--------------|
| Arc   | `/arcTestnet` |

Code uses: `toModularTransport(\`${clientUrl}/arcTestnet\`, clientKey)` — **not** `polygonAmoy`.

---

## If something fails

| Symptom | Check |
|---------|--------|
| `SecurityError` on passkey | Must use `http://localhost:3000`, not tunnel IP |
| Passkey button disabled | `CIRCLE_CLIENT_KEY` + `CIRCLE_CLIENT_URL` in `.env`, restart server |
| `insufficient_balance` on join | Fund smart account via faucet (on-chain USDC, not Gateway) |
| `Modular payment verification failed` | Explorer: USDC transfer from smart account → seller for session amount |
| AA21 prefund error | Ensure `paymaster: true` on userOp (already set in `passkey-wallet.mjs`) |

---

## Automated gate (already run by agent)

```bash
npm run build:passkey
node _gate-phase1.mjs
```

Must pass before Phase 1 commit. Live passkey steps above are **human-only**.
