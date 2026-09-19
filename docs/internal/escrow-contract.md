# The seat escrow contract

`contracts/MegaChatEscrow.sol` holds one viewer's session cap for one session and releases it on a timer. It exists so the platform never holds the float: the tokens sit in the contract, the streamer is fixed at deposit, and the only thing the server can do to the money is report hidden time — which can only move money toward the viewer. This page says what the contract enforces, what it does not, and what a viewer still trusts the platform for. It does not claim trustlessness, because the design does not have it.

**Status, 2026-09-19.** Deployed to Tempo mainnet and wired to live seats (Session 2). A paid seat's cap is deposited into the contract at join, metered off-chain exactly as before, attested once at seat end, and finalized by the server's sweeper after the deadline. Proven end to end with mainnet dust — the escrow path and the direct fallback both — by `_gate-escrow-seat.mjs`, 29 assertions, 0 failures, balances to the atomic unit. The adversarial suite on Moderato is unchanged at 60/0 (`_gate-escrow-contract.mjs`). `PLATFORM_SETTLEMENT_KEY` is present but empty on production; E38's door keeps its role for everything that is not a paid seat.

## Where it is

| | |
|---|---|
| Source | `contracts/MegaChatEscrow.sol` (Solidity ^0.8.30) |
| Artifact | `contracts/build/MegaChatEscrow.json` — solc 0.8.37, evm `osaka`, optimizer 200 runs. Committed so any address can be checked against the bytecode that produced it: `node contracts/escrow-build.mjs --check` |
| Deploy | `scripts/deploy-escrow.mjs`; every deployment is appended to `contracts/deployments.json` with the source and bytecode hashes |
| Moderato (chain 42431) | `0xedd9ec3906c1865908af64e9434dd1cdf07e225b`, block 35865884. A rehearsal only: every role is an ephemeral key discarded at exit, so anyone can read it and finalize on it, and nobody can administer it (`contracts/deployments.json`) |
| Tempo mainnet (chain 4217) | `0x432bb6c62503711ad4e70a91247a110e61779213`, deployed 2026-09-19 from the seller wallet (tx `0xda7eb6d7…`, 10.06M gas), token USDC.e. Operator `0x96271dF58d86418aA77A7f7517d75708b5B639BB` (`ESCROW_OPERATOR_KEY`), attester `0x19711b9CC0869273aBcF1f8bc8dF39654036937A` (`ESCROW_ATTEST_KEY`), owner and fee recipient the seller wallet. Bytecode verified against the artifact (`contracts/deployments.json`). The server resolves it from that file; `ESCROW_CONTRACT_ADDRESS` overrides |
| Seat gate | `_gate-escrow-seat.mjs` — **spends mainnet dust** (about 0.02 USDC.e a run from the test viewer wallet, plus role gas); run under `railway run` so the two escrow keys are present |
| Gate | `_gate-escrow-contract.mjs` — Moderato only, faucet-funded throwaway keys, spends nothing real, reads no key from `.env` |

## What it enforces

Every rule below is asserted by the gate against the deployed contract, by the contract's own custom error where it refuses (`_gate-escrow-contract.mjs`, sections 1–8).

| Call | Who may call | What it does | Which way money can move |
|---|---|---|---|
| `deposit(id, viewer, streamer, amount, releaseAt, feeBps, rate, sessionId)` | the **operator** only | pulls the viewer's approved cap into the contract; fixes streamer, per-second rate, deadline and fee for good | viewer → contract |
| `attest(id, consumedSeconds, hiddenSeconds)` | the **attester** only — a separate key, `ESCROW_ATTEST_KEY` | the one server signal. Paid seconds = consumed − hidden, clamped to the cap. A later attestation that would raise the streamer's share **reverts** | only toward the viewer |
| `finalize(id)` | **anyone**, once the deadline has passed | pays the streamer what was not attested away, less the declared fee; returns the rest to the viewer. Server silence pays the streamer; nothing is ever stranded | contract → streamer, viewer, fee recipient |
| `streamerRefund(id, amount)` | the **streamer** only, any time before finalize | returns any amount up to what remains to the viewer, no conditions | contract → viewer |
| `flag(id, signatures[])` | **anyone** may relay | each EIP-712 `Flag(sessionId)` signature is recovered through the TIP-1020 verifier precompile; a signer with no deposit in the session, a duplicate, or a forged signature is rejected with no weight. Enough distinct depositors **by count and by value** extend every deadline in the session **once** | none — a flag never moves money |
| `setEscalation(minFlaggers, thresholdBps, extensionSeconds)` | the **owner** only | tunes the three escalation parameters within hard bounds, without a redeploy | none |

Defaults: 3 distinct eligible addresses holding at least 25% of the session's deposits extend release by 48 hours, once. The extension a session was granted is snapshotted at that moment; changing the parameter afterwards does not move it.

## The bounds, which are constants, not parameters

- **`MAX_HOLD` = 14 days.** A deposit's deadline can be at most this far out; the operator cannot lock funds indefinitely.
- **`MAX_EXTENSION` = 7 days,** applied at most once per session. The absolute worst case a viewer's funds can be held is 21 days.
- **`MAX_FEE_BPS` = 1,000 (10%).** The fee is declared at deposit, comes out of the streamer's share, and is 0 today.
- **No upgrade, pause, sweep, rescue or admin escape hatch.** The contract is immutable. Tokens sent to it outside `deposit()` are unrecoverable, on purpose: a rescue function that can move funds is custody by another name.
- **Only three destinations exist for money:** the escrow's streamer, its viewer, and the fee recipient fixed at deployment.

## What it does not enforce, and what a viewer still trusts the platform for

1. **The attestation itself.** No contract can see an OBS scene. The contract enforces the arithmetic of `hiddenSeconds`; whether hidden time is reported at all is the platform's honesty. If the platform says nothing, the streamer is paid in full. This is registered as L41 in the limitations register — and the visibility signals the attestation will consume (`overlay_hidden`, `overlay_scaled_below_floor`, `obs_disconnected`) are recorded in `launch-readiness.md` row 25a as mock-only, never run against a real OBS.
2. **The client code.** The viewer's wallet authorises the cap through the join page; they trust that page to ask for the right amount.
3. **The streamer named at deposit.** The operator supplies it. Per the decision already made, a room with no payout address is a hard refusal — the operator must never substitute a platform address.
4. **No viewer-side exit.** The viewer never calls the contract (Tempo's fee-token rules make that the right design), so they cannot withdraw early. Their protection is the bounded deadline, permissionless `finalize`, and the streamer's refund button.
5. **Flag relay.** The platform cannot forge a flag — signatures are verified on-chain — but it can decline to relay one. Publishing received flags off-chain makes suppression visible; that is Session 2's dashboard work.

## Where the built contract deviates from the prompt, and why

Each is recorded in `DECISIONS.md`.

- **`attest` takes `consumedSeconds` as well as `hiddenSeconds`.** The prompt's `attest(id, hiddenSeconds)` cannot express "unspent returns to the viewer": the deposit is the session cap, and only the server knows how many seconds were actually consumed. Both figures are viewer-ward only — the paid-seconds figure can never rise.
- **`deposit` takes `rate` and `sessionId`.** The refund is computed from a per-second rate, and escalation is per session, not per deposit.
- **Out-of-range attestations are clamped, not refused.** Consumed clamps to the cap, hidden clamps to consumed. A refusal would let a slightly-wrong figure block a refund the viewer is owed; a clamp cannot overpay the streamer.
- **`deposit` is operator-only, not permissionless.** A permissionless deposit would let anyone lock a viewer's approved allowance against a streamer of the attacker's choosing.
- **The TIP-1020 verifier, not raw `ecrecover`.** It recovers secp256k1, P256 and WebAuthn signers alike, so a viewer on a passkey wallet can flag, and future Tempo signature schemes verify without a redeploy.

## The small-room question

With the default of 3 distinct flaggers, a room with one or two paying viewers can never escalate, however broken the stream was. That is acceptable for launch, for two reasons: the streamer's refund button covers the honest case in any room size, and the escalation rule only ever *delays* a payout, so its absence in a small room costs the viewer a hold they would not have won anyway. If it needs closing, the smallest deterministic path is "when a session has fewer than `minFlaggers` depositors, require all of them" — a four-line change, since the contract already counts `depositors` per session. Recorded as O16; not built, because it changes a default the owner set.

## Why this cannot be fork-tested

TIP-20 tokens, the TIP-1034 channel escrow and the TIP-1020 verifier are node-level precompiles; each address carries a single byte of marker code on chain. An anvil fork of Tempo reproduces none of their logic, so the only rehearsal is the Moderato testnet, whose faucet (`tempo_fundAddress`) funds throwaway keys for free. Mainnet deployment is a separate, deliberate step.

## What it costs, measured

From the gate's run on Moderato (gas is the same on mainnet; the price is not). Tempo charges 250,000 gas for every new storage slot, which is where a first deposit's cost goes.

| Operation | Gas | Mainnet at 0.6 gwei | Moderato at ~12 gwei |
|---|---|---|---|
| deploy | 10,307,215 | ~$0.0062 | ~$0.12 |
| deposit (first in a session) | 1,831,906 | ~$0.0011 | ~$0.022 |
| attest | 282,884 | ~$0.00017 | ~$0.0034 |
| finalize | 332,357 | ~$0.0002 | ~$0.004 |
| streamerRefund | 308,189 | ~$0.00018 | ~$0.0037 |
| flag, one valid signature | 313,385 | ~$0.00019 | ~$0.0037 |
| **deposit + attest + finalize** | **2,447,147** | **~$0.0015** | ~$0.029 |

The scoping estimate was $0.0005–0.001 per lifecycle; the measured figure is a little above it because `attest` and `finalize` each cost ~300k rather than the ~35k an Ethereum-priced update would, which suggests Tempo prices some warm writes at the slot-creation rate too. It is still a rounding error against a seat that earns dollars.

## How live seats use it (Session 2)

`escrow-chain.js` is the app's side of the contract and, with `settlement.js`, one of the two files in which a transfer-shaped call may appear (Gate H Tier 1, `_gate-money.mjs`). Every write leaves it through one function with the fee token explicit.

**Three money modes**, decided when the viewer asks for terms and recorded on the seat and in the seat ledger's `SEAT_OPEN` row:

| Mode | Who the viewer approves | Where the money is | How it resolves |
|---|---|---|---|
| `escrow` | the contract | in the contract from join to finalize | one attestation at seat end, finalize after the deadline |
| `direct` | the seller key | with the streamer, tick by tick | nothing to resolve — no escrow, no mediation |
| `platform` | — | the door's ledger (points and earned credit only) | as E38 left it |

**The join.** Terms name the spender in `payTo`; the viewer's one `approve()` is unchanged (`web/lib/join-page.ts`). In escrow mode the server pulls the cap into the contract *before* confirming the seat (`server.js`, the passkey join route); a deposit the chain refuses or cannot reach frees the seat, answers `escrow_deposit_failed` with `retry: 'direct'`, and the client fetches terms again and re-authorizes the seller key. A room with no payout address is refused with `409 no_payout_address` in every mode.

**The deadline** is `joinedAt + cap × tick + SEAT_ESCROW_TAIL_MS + SEAT_ESCROW_REVIEW_MS` (`escrow-chain.js`, `releaseAtFor`), never past the contract's 14-day `MAX_HOLD`. The tail defaults to the seat ledger's own manual-paste tail (10 min); the review margin defaults to 24 h. In practice: the streamer is paid, at the latest, about a day and ten minutes after the seat's cap would have run out, and a human has that long to attest more hidden time. The deadline is fixed at deposit — the contract has no early release — so an honest stream waits it out; shortening `SEAT_ESCROW_REVIEW_MS` trades review time for faster payouts (L45).

**Metering is unchanged.** The seat ledger accrues per tick; `tickPasskeyStreamSeat` writes nothing to the chain for an escrow seat (`_gate-escrow-seat.mjs` step 5: 0 pulls).

**The attestation.** At seat end the ledger's figures go to `attest` once, from the attester key: consumed = the ticks accrued, hidden = the buried ticks the ledger charged to the streamer plus any clawback, both in *tick units* at the seat's tick price (`server.js`, `attestSeatFromLedger`). The detection-lag part of a bury is the platform's cost to carry, and the contract has no platform pocket, so that part alone stays a door intent from the platform wallet (`seat-escrow.js`, `refundBuried`). A clawback on an escrow seat becomes a further attestation, never a door refund.

**Finalize.** The server's sweeper (`SEAT_ESCROW_SWEEP_MS`, 30 s) reconciles sent transactions by receipt and finalizes every deposit whose deadline has passed. Finalize is permissionless on-chain; the sweeper only makes it prompt.

**The availability fallback.** Terms offer `direct` when: no contract address resolves for this chain; either key is unset; the preflight fails (no code at the address, or its `TOKEN`, `OPERATOR` or `ATTESTER` do not match ours); or a deposit was refused or unreachable in the last ten minutes. The rewritten path (`server.js`, the direct branch of `tickPasskeyStreamSeat`; `settlement.js`, `pull`) pulls each tick from the viewer to the **streamer's payout address**, records it at the door, and ends the seat rather than pay anyone else if that address is ever missing. Whether something aired is never a reason to fall back. Proven with dust: 7 pulls → the payout address, seller wallet unchanged (`_gate-escrow-seat.mjs` step 11).

**Where row 25a is load-bearing.** The obs-websocket visibility signals have never been produced by a real OBS (`launch-readiness.md` row 25a); the gate posts them itself. Everything below rests on them:

1. The *pause* on `overlay_hidden` is what keeps buried seconds off the streamer's bill at all — with no signal, a buried guest is charged in full and `hidden` is 0.
2. `hiddenSeconds` is derived from the ledger's `SEAT_REFUND_BURIED` rows, which exist only when `overlay_visible` follows a pause.
3. `obs_disconnected` is treated as blindness, not a bury (`overlay-visibility.js`): a real disconnect that *is* a bury attests nothing.
4. On the mainnet run the bury produced a pause, not a refund — `hidden` stayed 0 by design. The nonzero attestation path is proven on Moderato only (`_gate-escrow-contract.mjs`, 600 consumed / 120 hidden).

**The fee-token lesson (E49).** A fee token reaches the chain only inside a Tempo transaction, and only viem's own Tempo chain definitions carry that serializer. Through the hand-rolled chain object the server used, `feeToken` was silently dropped, writes went out as EIP-1559, and their fee was charged in pathUSD — which no wallet of ours holds (`insufficient funds … have 0`). That bit the escrow deposit first and then the door's own `transferFrom`, which means the door's transfers — pulls, platform payouts, reward payouts — could not have paid their fee on mainnet since E38 shipped them; no intent had ever flushed, so nothing noticed. Every server signer is now built on viem's Tempo chain and every transfer names its fee token (`server.js`, `tempoViemChain`; `settlement.js`; `escrow-chain.js`).

**Measured on mainnet, 2026-09-19** (`_gate-escrow-seat.mjs`): escrow deposit tx `0x7f6bc8de…`; 10 ticks consumed, 0 hidden; streamer +0.010 USDC.e, viewer refunded 0.040 of the 0.050 cap; the viewer's approve cost 0.000167 in fees; direct fallback 7 ticks = 0.007 USDC.e viewer → streamer; the whole run moved 0.017 USDC.e out of the test viewer wallet and nothing into the platform wallet.

**What Privy users get today.** The join page sends Privy wallets to `/api/join/mpp` when the server has the MPP meter — which production does — so the primary wallet layer pays into TIP-1034 channels whose payee E38 set to the platform wallet. Only the MetaMask / allowance path reaches the escrow. Routing Privy users to it is one client condition (E48); it was not this session's decision to make.
