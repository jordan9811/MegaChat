# MIGRATION_TEMPO — MegaChat on Tempo mainnet (tempo-mainnet branch)

Full rebuild from Circle Arc Testnet to **Tempo mainnet (eip155:4217)**, done
2026-07-07. The Arc version is untouched on its own branches (fallback).
Verified facts + addresses: [TEMPO_NOTES.md](TEMPO_NOTES.md). Every phase was
gated against the running app — Phases 2 and 3 with **real mainnet money** at
dust prices.

## Gates

| Phase | Gate script | Result |
|---|---|---|
| 1 — chain + wallets | `_gate-tempo-phase1.mjs` | 17 pass / 0 fail / 1 warn |
| 2 — MPP session meter | `_gate-tempo-phase2.mjs` | 9 pass / 0 fail (live mainnet session) |
| 3 — parity sweep | `_gate-tempo-phase3.mjs` | 25 pass / 0 fail (live full flow) |

Run them against a booted server: `node server.js` then `node _gate-tempo-phaseN.mjs`.

## LIVE (verified on mainnet)

- **Chain layer** — env-driven `TEMPO_*` config (4217, rpc.tempo.xyz, USDC.e
  `0x20c0…b950`); on-chain TIP-20 balance reads for every wallet mode; legacy
  rooms with persisted Arc token addresses remap to USDC.e at read time
  (rooms.json is branch-shared and never rewritten).
- **The meter — MPP sessions (TIP-1034 payment channels), the whole point:**
  - Join grants a seat with NO upfront transfer or approve.
  - First paid tick opens an escrow channel (one on-chain deposit tx by the
    viewer, ~0.7–1.3 s); the session cap is `min(balance − fee headroom, room cap)`.
  - Every subsequent per-second tick is a **signed off-chain voucher** —
    observed 7–159 ms, zero gas, `meter_update` broadcast each tick.
  - Leave (or kick → the client reacts) **cooperatively closes the channel:
    unspent deposit auto-refunds from escrow**. Measured: viewer lost
    $0.011 of a $0.10 cap after streaming $0.005 (rest = open/close fees).
  - Kick/vanish: the server **settles with the newest voucher** (claims the
    streamed amount); it can do so because channels are opened with the
    platform account as TIP-1034 **operator**.
  - Batched server settlement schedule: ≥ $0.25 or 5 min, whichever first.
- **Payout wallet per room** — dashboard field; channel `recipient` = payout
  address, so settlements pay the streamer DIRECTLY on-chain (verified:
  +$0.005 to a payout wallet distinct from the platform seller wallet).
- **Feature parity**: per-room password auth (create/unlock/401s), dashboard
  APIs, overlay page + `seat_added`/`seat_removed` broadcasts, stinger picks
  travel with the seat, **pin = free co-host** (paid ticks acknowledged
  without charge while pinned; billing resumes on unpin), browse directory
  with live counts, kick.
- **Rewards** — points/local-credit mode fully working (dry-run). Real USDC
  payouts now use a plain TIP-20 transfer from the pool wallet (Tempo),
  replacing Circle Gateway `depositFor`; **not yet exercised with a funded
  pool on mainnet**.
- **MetaMask secondary path** — chain add/switch to 4217; joins fall back to
  the proven approve+transferFrom allowance meter (per-voucher signing would
  pop a MetaMask window every second, so sessions are embedded-wallet-only).

## NEEDS ONE CREDENTIAL (blocked on user, not on code)

- **Privy login UI** — everything is wired (`TempoWalletProvider`,
  `window.MegaWallet` bridge, silent signing, viem `tempo` chain), but
  `NEXT_PUBLIC_PRIVY_APP_ID` is empty. Create an app at dashboard.privy.io
  (enable email + passkey + socials, embedded wallets on Tempo), put the app
  id in `.env`, restart, and the Sign up / Sign in buttons go live. Until
  then the join page runs in MetaMask-only degraded mode with a clear
  message. The MPP meter itself is proven independently of Privy (the gate
  drives it with a raw key through the same session-manager code path).

## STUBBED / NOTES

- `public/index.html` (legacy Express viewer page) is still the Arc build —
  the real join page is `/join` (Next). Treat the legacy page as dead code on
  this branch.
- Circle-era deps (`@circle-fin/*`, `@x402/*`, `x402`) are no longer imported
  by live code (the passkey bundle in `public/` still references them but is
  never loaded). Safe to prune from package.json in a cleanup pass.
- `Store.memory()` holds channel voucher state: a server restart mid-session
  loses the newest voucher server-side (client keeps its channel and simply
  re-probes; worst case the server settles less than was actually streamed —
  never more). A persistent store is the production follow-up.
- If a viewer vanishes without close (crash), the server settles its claim;
  the viewer's remainder stays in the channel until their next cooperative
  close or the channel's protocol-level expiry path. Funds are never
  claimable by the platform beyond signed vouchers.
- ~0.29 USDC.e of TEST viewer funds sit in 3 channels stranded by failed
  gate attempts (fee-sizing + payee-settle bugs found and fixed during
  gating): `0x8711…`, `0x0698…`, `0xadbc…` (+ the phase-3 attempt-1/2 rooms).
  Recoverable by the test viewer via channel close/expiry; dust, not urgent.
- +~1.49 USDC.e stranded 2026-07-08 while developing `_gate-mpp-clientpath`:
  a wallet-broadcast channel open landed on-chain but mppx never adopted the
  channel (its bookkeeping derives from the raw bytes), so ZERO vouchers were
  signed — the full deposit is reclaimable by the test viewer at channel
  expiry. This is the experiment that proved the wallet-send fallback is
  unsafe (now removed; incapable wallets fail clean instead).
- Production build (`npm run build`) not exercised — all gates ran the
  unified dev server. Run once before deploying to Railway.
- MetaMask `wallet_addEthereumChain` uses `decimals: 18` for the display
  currency (MetaMask hard-requires 18); Tempo has no native token at all, so
  the field is cosmetic.

## Mainnet lessons encoded in the code (so nobody re-learns them)

1. Tempo fees come out of the SAME stablecoin balance being deposited —
   always leave `MPP_FEE_HEADROOM` (default $0.10) when sizing a channel.
   $0.02 was NOT enough: padded wallet estimators (Privy embedded) quote
   ~$0.022 for a plain transfer, so any wallet with balance < cap + headroom
   had an unpayable channel open and got auto-kicked ~3s after going live
   (found live 2026-07-07; raw-key gates estimated lean and never hit it).
2. TIP-1034 settle must be sent by the channel **payee or operator** — with
   per-room payout wallets, open channels with the platform as `operator`.
3. `tempo.session.settle(...)` needs an explicit `feeToken` — the resolver
   otherwise prefers the chain default fee token (pathUSD) that the platform
   wallet doesn't hold.
4. `SessionReceipt.spent` is RAW atomic units; mppx clones the incoming
   Request, so correlate `onPaymentSuccess` receipts by URL, not by object.
5. The Arc 1-gwei priority-fee floor is Arc-specific — do NOT port it.
6. Wallet providers (Privy embedded) are SIGNERS, not RPCs. Route every read
   (`eth_call`, `eth_fillTransaction`, receipts) to the public Tempo RPC;
   only signing goes to the wallet. The fill's Tempo 0x76 envelope encodes
   empty fields as bare `"0x"` — embedded parsers do `BigInt("0x")` and die
   ("Cannot convert 0x to a BigInt"), so retry `eth_signTransaction` once
   with `"0x"→"0x0"` normalized. NEVER fall back to a wallet-side SEND for
   channel opens: mppx derives channel bookkeeping from the raw signed bytes,
   so a wallet-broadcast open strands the whole deposit (gate-proven). And
   plain eip1559 is impossible on Tempo — no native token to pay fees.
   Gate: `_gate-mpp-clientpath.mjs` (17/0 incl. fail-safe + refund checks).
