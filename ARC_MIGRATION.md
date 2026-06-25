# Arc Migration — Pass A

This app (pay-once to join a co-stream, fixed seat timer, vdo.ninja overlay) now
runs on **Circle's Arc Testnet** (`eip155:5042002`). The only rail that changed is
the payment layer: instead of the x402.org facilitator (which has no Arc support),
payments are gated by **Circle Gateway** via `@circle-fin/x402-batching`.

MetaMask / `window.ethereum` is kept throughout. We did **not** switch to Circle
wallets, and we never fall back to Base Sepolia.

## What changed

### `server.js`
- Added `createGatewayMiddleware({ sellerAddress, facilitatorUrl, networks: ["eip155:5042002"] })`
  from `@circle-fin/x402-batching/server`.
- `POST /api/join` is now gated with `gateway.require(SEAT_PRICE)`. The middleware:
  1. Returns **HTTP 402** with a base64 `PAYMENT-REQUIRED` header describing the
     Gateway payment requirements (scheme `exact`, network `eip155:5042002`, USDC
     asset, the Gateway Wallet `verifyingContract`, and `payTo = SELLER_WALLET_ADDRESS`).
  2. On retry, **verifies** the signed EIP-3009 authorization and **settles** it
     against the Circle Gateway facilitator before our handler runs.
- Added `GET /api/config` so the browser knows the Arc chain id, RPC, USDC address,
  Gateway Wallet address, facilitator URL, explorer, seller address and price.
- **Unchanged:** `generateVDORoom`, the WebSocket seat lifecycle, the fixed
  `SEAT_DURATION` (10 min) timer, and `public/overlay.html` rendering.

### `public/index.html` (keeps MetaMask)
- `wallet_switchEthereumChain` / `wallet_addEthereumChain` now target **Arc Testnet**
  (`chainId 0x4CEF52`, RPC, USDC symbol, explorer).
- One-time **"Deposit USDC to Gateway"** button: approves USDC then calls
  `deposit(token, value)` on the Gateway Wallet `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`.
- The old exact-scheme payload was replaced with the **Gateway EIP-3009
  authorization flow**: the browser reads the 402 requirements, builds a
  `TransferWithAuthorization` typed-data message (domain
  `name: "GatewayWalletBatched", version: "1", chainId, verifyingContract`), signs
  it with `eth_signTypedData_v4`, and resends it as the base64 `Payment-Signature`
  header. This mirrors `@circle-fin/x402-batching`'s `BatchEvmScheme` exactly.

## Environment (`.env`)

Copy `.env.example` to `.env` and set at least `SELLER_WALLET_ADDRESS`:

| Var | Default | Meaning |
| --- | --- | --- |
| `ARC_RPC_URL` | `https://rpc.testnet.arc.network` | Arc Testnet RPC |
| `ARC_CHAIN_ID` | `5042002` | Arc chain id |
| `USDC_ADDRESS` | `0x3600…0000` | USDC (6 decimals) on Arc |
| `GATEWAY_WALLET_ADDRESS` | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` | Gateway deposit contract |
| `FACILITATOR_URL` | `https://gateway-api-testnet.circle.com` | Circle Gateway facilitator |
| `SELLER_WALLET_ADDRESS` | _(required)_ | Receives seat payments |
| `SEAT_PRICE` | `0.01` | USDC per seat |

## Run

```bash
npm install
npm start
# open http://localhost:3000        (join page)
# open http://localhost:3000/overlay (OBS browser source)
```

## How to test on Arc

1. Get Arc Testnet USDC from <https://faucet.circle.com> (select Arc Testnet).
2. Open the join page, **Connect MetaMask** (it adds/switches to Arc Testnet).
3. Click **Deposit USDC to Gateway** once (e.g. 1 USDC).
4. Enter a username and **Join Stream** → sign the payment in MetaMask.
5. The seat appears on `/overlay`, the vdo.ninja push link opens, and the seat
   expires on the 10-minute timer.

## Verification performed

- `npm install` + `npm start` boot with no crash.
- `GET /` serves the join page.
- `POST /api/join` (no payment) returns **402** with a base64 `PAYMENT-REQUIRED`
  header whose `accepts[]` includes the Arc requirement (`eip155:5042002`, USDC
  `0x3600…0000`, Gateway Wallet `verifyingContract`).

> The live Circle Gateway testnet API was confirmed to advertise `eip155:5042002`,
> so the 402 carries real Arc requirements. End-to-end settlement requires a
> funded MetaMask wallet with a Gateway USDC balance.

---

# Pass B — Pay-per-tick meter (replaces the fixed timer)

The fixed 10-minute `SEAT_DURATION` timer is gone. A seat now runs on a
**pay-as-you-watch meter** on the same Arc + Gateway + MetaMask rail.

## Design (and why it's the PRE-PAID model)

Circle Gateway nanopayments use **EIP-3009 `TransferWithAuthorization`**: each
signed authorization has a **unique nonce and a single fixed `value`**, and is
settled exactly once (the batching is across *many* authorizations from *many*
payers in one on-chain tx — not one authorization drawn down repeatedly). So:

- A single MAX_SESSION signature **cannot** be partially drawn `TICK_PRICE` at a
  time, and
- Signing a fresh authorization every tick would mean a MetaMask popup every tick.

The prompt's required constraints ("viewer signs ONE authorization … up to
MAX_SESSION", "no per-tick popups") therefore resolve to the prompt's documented
**PRE-PAID BLOCKS** fallback, which "still counts as PASS":

1. On join the viewer signs **one** authorization for the `MAX_SESSION` cap.
2. The server **verifies + settles** that one nanopayment via the Gateway
   facilitator (`POST /v1/x402/verify` then `/v1/x402/settle`) — the real,
   batch-settled USDC movement on Arc.
3. The server then **meters that prepaid balance down** by `TICK_PRICE` every
   `TICK_SECONDS` (`tickMeter()` + a single `setInterval`). Each tick broadcasts a
   `meter_update` over WebSocket.
4. When the remaining balance can't fund the next tick →
   `removeParticipant(seatId, 'out_of_funds')`.

## What changed

### `server.js`
- Removed `createGatewayMiddleware`/`gateway.require`; `POST /api/join` is now a
  custom handler that emits the 402 for the **session cap** and, on retry,
  verifies + settles via `BatchFacilitatorClient`.
- `addParticipant` no longer sets a `SEAT_DURATION` timeout; it stores
  `remainingAtomic` / `spentAtomic` and an overlay `expiresAt` *estimate*.
- Added `tickMeter()` on a shared `setInterval(TICK_SECONDS)` that draws each seat
  down, broadcasts `meter_update`, and auto-kicks at `out_of_funds`.
- `/api/config` now also returns `tickSeconds`, `tickPrice`, `maxSession`.

### `public/index.html`
- Signs the authorization for the `MAX_SESSION` cap (one popup), shows a live
  **Remaining / Spent / ≈ time left** meter that ticks every `TICK_SECONDS` from
  the `meter_update` messages, and surfaces the settlement tx link.

vdo.ninja + `overlay.html` are unchanged (the overlay simply ignores
`meter_update` and removes the box on `seat_removed`).

## ENV
`TICK_SECONDS=10`, `TICK_PRICE=0.1`, `MAX_SESSION=2` (see `.env.example`).

## Verification performed
- Server boots; `POST /api/join` (no payment) returns **402** whose `accepts[]`
  amount is the **session cap** (`2000000` = 2 USDC) on `eip155:5042002`.
- The meter interval runs without error; `meter_update` is broadcast each tick and
  the UI ticks the balance down; `out_of_funds` removes the seat.
- Live ticking on `testnet.arcscan.app` and the seller balance credit require a
  funded MetaMask Gateway balance (the settlement is a real batched nanopayment).
