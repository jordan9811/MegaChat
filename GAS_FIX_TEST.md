# GAS_FIX_TEST — Arc 1 gwei gas floor across ALL user-op / tx paths

**Bug:** passkey join rejected with
`precheck failed: maxPriorityFeePerGas is 818578550 but must be at least 1000000000`.
Arc's bundler enforces a 1 gwei priority-fee floor, but nothing in the codebase set gas
params — every path relied on raw network estimation, which can return ~0.82 gwei.

**Invariant now enforced everywhere:** `maxPriorityFeePerGas >= 1_000_000_000` (1 gwei) and
`maxFeePerGas >= maxPriorityFeePerGas + base-fee headroom`, on every transaction or user
operation this app constructs for Arc.

## Every call site found (whole-repo sweep, including web/)

Sweep method: grep for `maxPriorityFeePerGas`, `maxFeePerGas`, `sendUserOperation`,
`writeContract`, `sendTransaction`, `estimateFeesPerGas`, `gasPrice` across all tracked
files (bundle excluded, then regenerated from fixed source).

### Fixed — sites that construct/submit Arc transactions or userOps

| # | File:line | Path | Fix |
|---|-----------|------|-----|
| 1 | `src/passkey-wallet.mjs:28-67` | client fee helper `arcFeesWithFloor()` | Prefers Circle's own bundler oracle (`circle_getUserOperationGasPrice`, medium tier), falls back to `estimateFeesPerGas`, **always clamps to the 1 gwei floor** |
| 2 | `src/passkey-wallet.mjs:141` | `createBundlerClient` → `userOperation.estimateFeesPerGas` hook | Fee source for **every** userOp prepared through the bundler client — no future call can silently fall back to the raw estimate |
| 3 | `src/passkey-wallet.mjs:226-233` | **approve userOp** in `authorizeSessionGasless()` (the failing join op; `payJoinGasless` aliases it) | Explicit `maxFeePerGas`/`maxPriorityFeePerGas` passed to `sendUserOperation` — belt-and-suspenders with the hook |
| 4 | `public/passkey-wallet.bundle.js` | browser bundle | Rebuilt via `npm run build:passkey`; both frontends (`web/lib/join-page.ts` and legacy `public/index.html`) load **this same bundle**, and Express serves it `no-store`, so no stale copy survives |
| 5 | `token-utils.js:18-41` | shared server floor: `MIN_PRIORITY_FEE_WEI`, `clampFeesToArcFloor()`, `estimateArcFeesWithFloor()` | Single implementation used by all server-side writes |
| 6 | `server.js:160-164, 235` | **refund transfer** (`refundSeat` → `writeContract transfer`) | Spreads `...(await arcFeesWithFloor())` (cached 30 s) |
| 7 | `server.js:800` | **per-tick `transferFrom`** (`tickPasskeyStreamSeat` → `writeContract`) — the seller pull that meters passkey streams every second | Spreads `...(await arcFeesWithFloor())` |

### Exempt — reviewed and intentionally NOT given explicit gas params

| File:line | What | Why exempt |
|-----------|------|------------|
| `web/lib/join-page.ts:409,420` | MetaMask `eth_sendTransaction` (Gateway approve + deposit) | Gas is estimated and signed inside MetaMask's own UI (user-adjustable); not a modular-wallet userOp and not part of the failing passkey path |
| `public/index.html:511,522` | Same MetaMask flow, legacy page | Same as above |
| `rewards.js:28-32` (`GatewayClient.depositFor`) | Watch-to-earn pool payout | Circle x402 SDK manages gas internally; `depositFor` exposes **no gas override options** (checked `dist/client/index.d.ts:660`); on failure rewards fall back to local credits (`rewards.js:132-144`) |
| `server.js` `BatchFacilitatorClient` verify/settle | Gateway nanopayment settlement | Executed by Circle's facilitator service on their infrastructure — gas is theirs |
| `passkey-meter.js` | stream meter helpers | Pure local accounting, sends nothing on-chain |

## Verification — live against the real Circle bundler (2026-07-02)

Runner: `node _gate-gas-floor.mjs` (kept in repo alongside the other `_gate-*.mjs` gates).
It stubs `window`/`location.hostname` and injects the page `Origin` so the domain-locked
Circle client key authenticates exactly like the real join page, then drives the **actual
`initModularClients()`/bundler client from `src/passkey-wallet.mjs`** with a throwaway
local-owner Circle smart account.

```
[1] clampFeesToArcFloor() on the original failing estimate
  ✅ clamped 0.818 gwei estimate: maxPriorityFeePerGas 1 gwei >= 1 gwei floor
  ✅ clamped 0.818 gwei estimate: maxFeePerGas 1.81857855 gwei >= priority (proportional)
  ✅ clamped null estimate (RPC down): maxPriorityFeePerGas 1 gwei >= 1 gwei floor
  ✅ clamped null estimate (RPC down): maxFeePerGas 3 gwei >= priority (proportional)
  ✅ estimates above the floor pass through untouched
[2] client arcFeesWithFloor() against live Circle transport
  ℹ️ raw network estimate: priority 1.5 gwei, max 25.5 gwei
  ✅ client helper (live): maxPriorityFeePerGas 4.15275 gwei >= 1 gwei floor
[3] prepareUserOperation via the same bundlerClient the browser uses
  ✅ prepared userOp: maxPriorityFeePerGas 4.15275 gwei >= 1 gwei floor
[4] eth_sendUserOperation precheck: old fee vs fixed fee
  ✅ old 0.818 gwei fee still rejected by the fee precheck (bug reproduced)
  ✅ floored userOp ACCEPTED by bundler (hash 0x7bac950dc8c91a19…) — gas precheck PASSED
[5] server estimateArcFeesWithFloor() against Arc RPC
  ✅ server helper (live): maxPriorityFeePerGas 1.5 gwei >= 1 gwei floor
GATE PASS — all gas paths at/above the 1 gwei floor
```

Key results:
- **[4] executes the passkey join's approve userOp shape end-to-end**: with the old
  818578550 fee the bundler still rejects on the exact original precheck; with the fixed
  fee path (hook, same as the browser) the bundler **accepted the userOp and returned a
  hash** — the gas precheck passes.
- **[3]** proves the fee hook fires inside the real prepare path, not just in isolation.
- The raw estimate happened to be 1.5 gwei during this run; the 0.818 gwei regression case
  is pinned by the unit assertions in **[1]**, so the gate stays meaningful in any fee
  weather.

## Env keys (BUG 2)

- `SELLER_PRIVATE_KEY` and `REWARD_POOL_PRIVATE_KEY` are present in `.env` with valid
  66-char `0x` values. Boot log confirms both are live:
  `[refund] seller refund wallet ready: 0xBda9…` and `[rewards] … attached` (not dry-run),
  so per-tick pulls and refunds execute for real.
- Restored the five documented keys that were missing from `.env` (values = code defaults,
  so behavior is unchanged): `CIRCLE_MODULAR_CHAIN_PATH`, `PASSKEY_TICK_SECONDS`,
  `PASSKEY_TICK_PRICE`, `PENDING_CAMERA_TIMEOUT_MS`, `ROOM_DEFAULT_PASSWORD`.
- `.env.example` now also documents optional `MAX_SEATS`; `.env` covers every key in
  `.env.example`.
- `.env` is gitignored (`.gitignore:2`) and untracked (`git ls-files .env` → empty).
- **Rule for future passes: never remove keys from `.env`.** Add, never strip; `.env` is
  the only copy of the secrets.

## To re-verify after any future change

```
npm run build:passkey        # if src/passkey-wallet.mjs changed
node _gate-gas-floor.mjs     # must print GATE PASS
```

Restart `node server.js` to activate the server-side fee changes (an already-running dev
server keeps the old in-memory code; the rebuilt bundle is picked up on next page load
either way because it is served no-store from disk).
