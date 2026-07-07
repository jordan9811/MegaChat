# TEMPO_NOTES — verified facts for the tempo-mainnet migration

All values below were pulled from live docs/packages on **2026-07-07** (research pass, no
guessed constants). Sources: docs.tempo.xyz (redirects to tempo.xyz/developers/docs),
mpp.dev, docs.privy.io, npm registry, and installed package type definitions.

## Chain

| | Mainnet | Testnet (Moderato) |
|---|---|---|
| Chain ID | **4217** | 42431 |
| RPC (HTTP) | https://rpc.tempo.xyz | https://rpc.moderato.tempo.xyz |
| RPC (WS) | wss://rpc.tempo.xyz | wss://rpc.moderato.tempo.xyz |
| Explorer | https://explore.tempo.xyz | https://explore.testnet.tempo.xyz |

- **No native gas token.** Fees are paid in USD-denominated stablecoins (Fee AMM +
  TIP-20 fee token). `nativeCurrency` in viem's chain def is `USD` with **6 decimals**.
- viem ≥ 2.54 ships first-class support: `import { tempo } from 'viem/chains'`
  (chain 4217, includes Tempo `chainConfig` formatters/serializers) and a full
  `viem/tempo` module (Tempo tx envelope / fee-token support). Repo must bump viem
  (was ^2.53.1; 2.54.6 verified to include both).
- Fee sponsorship is native (fee-payer envelopes, dual signature domains — NOT
  ERC-4337). Public testnet sponsor relay: `https://sponsor.moderato.tempo.xyz`.
  No public mainnet sponsor — mainnet fees are simply paid in the sender's
  stablecoin, or the app runs its own fee-payer relay. Since our viewers already
  hold USDC, self-paid sub-cent fees satisfy "no gas token" UX on mainnet.

## Stablecoins (TIP-20; ERC-20-compatible, all 6 decimals)

| Token | Mainnet address |
|---|---|
| **USDC.e** (Bridged USDC, Stargate) | `0x20c000000000000000000000b9537d11c60e8b50` |
| pathUSD (docs' default example currency) | `0x20c0000000000000000000000000000000000000` |
| USDT0 | `0x20c00000000000000000000014f22ca97301eb73` |

Full registry: `https://tokenlist.tempo.xyz/list/4217`. TIP-20 = ERC-20 interface plus
memos/roles — `balanceOf`, `approve`, `transferFrom`, EIP-2612-style flows all work.
Our meter currency: **USDC.e** (test wallets are funded with it), env-driven.

## MPP — Machine Payments Protocol (the sessions primitive)

- Protocol docs: https://mpp.dev (Tempo method: https://mpp.dev/payment-methods/tempo,
  sessions: https://mpp.dev/intents/session). Spec: https://paymentauth.org.
- **TypeScript SDK: `mppx` — v0.8.6 on npm, updated 2026-07-07 (same day as this note;
  very actively maintained).** Python `pympp`, Rust `mpp-rs` also exist.
- Sessions are **TIP-1034 payment channels via a precompile**:
  `0x4d50500000000000000000000000000000000000` (same address mainnet + Moderato).
- Lifecycle: client deposits into escrow channel (1 on-chain tx, `channelId`), then
  signs **cumulative off-chain vouchers** ("I've consumed up to X total") — zero gas,
  microsecond verification, each voucher replaces the last. Close = 1 on-chain tx
  settling the final voucher; **unused deposit auto-refunds to the client**. Server
  can only claim what the client signed; client can't exceed the locked deposit.
- Confirmed from installed 0.8.6 type definitions:
  - Client: `tempo.session.manager({ account/client, maxDeposit, decimals=6, escrow?, channelStore? })`
    → `.fetch()` (HTTP 402 loop), `.sse()`, **`.ws()` (in-band voucher frames over
    WebSocket)**, `.topUp()`, `.close()` → `SessionReceipt { channelId, spent, txHash… }`.
  - Server (`mppx/server` → `tempo.session({...})` + `Mppx.create`): validates and
    records cumulative vouchers per request; `settlementSchedule { amount, intervalMs,
    units }` for periodic batch settlement; `settle`/`settleBatch` exports;
    `Ws.serve()` bridges a WebSocket to the payment flow (synthetic POST with
    Authorization header per voucher frame); `Store.memory()` or pluggable store.
  - Express middleware exists: `mppx/express`.
  - `feePayer` (boolean or viem `Account`) supported on session requests; client
    `getResolver` supports `feePayerUrl` (wraps transport `withFeePayer`).
  - mppx accepts standard **viem `Account` or a viem `Client`** — a Privy embedded
    wallet works via `createWalletClient({ chain: tempo, transport: custom(provider) })`.
- Server-side session verify example (from mpp.dev, verbatim shape):
  `tempo.session({ account, chainId: 4217, currency: <TIP-20 addr>, store, settlementSchedule })`,
  route: `mppx.session({ amount, unitType })(request)` → 402 challenge or
  `result.withReceipt(response)`.

## Privy

- `@privy-io/react-auth` **v3.34.0** (npm, checked today). Privy supports wallets on
  Tempo explicitly (listed among supported EVM chains) and publishes an MPP recipe:
  https://docs.privy.io/recipes/agent-integrations/mpp (server-side:
  `@privy-io/node` ≥ 0.20 + `createViemAccount(privy, { walletId, address })` →
  plug into `Mppx.create({ methods: [tempo.charge({ account })] })`).
- React setup: `PrivyProvider` with `supportedChains: [tempo]` (viem chain import),
  `defaultChain: tempo`; embedded wallet created on login (email/social/passkey);
  browser signer via `useWallets()` → `wallet.getEthereumProvider()` → viem
  `createWalletClient({ account, chain: tempo, transport: custom(provider) })`.
- Embedded wallets sign without confirmation modals when
  `embeddedWallets.showWalletUIs: false` — required for silent per-second vouchers.
- Privy also offers dashboard-level native gas sponsorship (chain-agnostic); on Tempo
  it's optional because fees come out of the user's stablecoin anyway.

## Decisions locked for this migration

1. **Meter = MPP session over `mppx`** (primary): viewer's embedded wallet opens a
   TIP-1034 channel with `maxDeposit = session cap`; server verifies cumulative
   vouchers per second; leave/kick → cooperative close → unspent auto-refunds
   **from the escrow contract itself** (no more seller-key refund transfers).
   Fallback (only if the SDK breaks in practice): approve + transferFrom port,
   documented in MPP_BLOCKERS.md per the build prompt.
2. **Wallets = Privy** (`@privy-io/react-auth`), email/social/passkey; MetaMask stays
   as the secondary injected-provider path (chain switch to 4217).
3. **Currency = USDC.e** env-driven (`TEMPO_USDC_ADDRESS`), 6 decimals.
4. All `TEMPO_*` env vars are NEW; every `ARC_*` / Circle var stays untouched.
5. Dust pricing for mainnet testing: tick `$0.001/s`, session cap `$0.05` default.
6. Seller-wallet on-chain writes (rewards payouts, fallback pulls) use plain EIP-1559
   txs — Tempo accepts them and takes fees in the fee token; **the Arc 1-gwei
   priority-fee floor hack is Arc-specific and must NOT be ported.** Verify fee
   behavior on-chain during Phase 1 gate.
