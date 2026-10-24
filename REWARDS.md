# Pass C — Watch-to-earn

Viewers **earn a room's reward for time spent connected with the tab visible**,
and earned credit can pay for a seat in that room. Because earning is measured
purely by the **WebSocket session + Page Visibility API** (not by the video
itself), it works no matter where the stream actually plays — Twitch, Kick,
Zora, or the local overlay.

A room's reward is **one** of three things, never two (`rewards.js`, header):

- **cash** — USDC from the reward pool, recorded as an intent at the settlement
  door (`settlement.js`, signer `rewardPool`) and paid to the **signed-in
  account's payout wallet**, never to a wallet the page names. Only in an
  **owned** room whose creator's account id is on `REWARDS_CASH_ALLOWLIST`
  (`*` = every owned room; unset or empty = cash off), never in a
  password-only room, and only while the door holds a pool signer.
- **credit** — seat credit in that room (`rewards.payout: 'credit'`, and every
  custom-token reward). Also signed-in, also keyed to the payout wallet.
- **points** — the room's own currency. No sign-in; the page's wallet.

Watching never needs a sign-in; earning cash or credit does.

The server half is one module, **`rewards.js`**; the client half is
`initRewardsClient` in **`web/lib/join-page.ts`**. The old standalone client,
`public/rewards.js`, was deleted on 2026-10-24: no page loaded it. The only hook
into the app is one guarded `attachRewards(wss, …)` call in `server.js`, which
parses each WebSocket message once and hands rewards its copy; a rewards failure
never stops a seat message.

## The loop

1. A viewer opens a room whose rewards are on. The join page opens its rewards
   socket only then; a room that pays nothing for watching gets no socket.
2. On every open the page sends `rewards_register` with the room id (and a
   wallet, used only for points and watch time), and reports tab visibility via
   the Page Visibility API. The server reads who is signed in from the sealed
   cookie at the socket's upgrade, so the page reopens the socket after a
   sign-in.
3. Server-side `rewards.js` decides what this socket may earn (`policyFor`), or
   says why not in `rewards_config.reason`. The page turns `sign_in_required`
   and `payout_wallet_required` into "Sign in to earn" and "Add a payout wallet
   on your account to earn"; other reasons stay silent.
4. Every `earnInterval` seconds of visible time it issues `earnAmount`, up to
   `earnCap` **lifetime in that room**, counted per payout wallet and per
   account (the larger counts) and persisted in `data/rewards-ledger.jsonl`, so
   a new socket, a re-register or a restart does not reset it. One earning
   socket per account (points: per wallet) per room; a newer register
   supersedes the older.
5. Cash: an `EARN` row, then one door intent, paid from the reward pool on the
   next settlement flush. Credit and points: added to the viewer's earned
   balance in that room (`reward-credits.js`, in memory).
6. The viewer can spend credit on a seat in that room (`/api/join/passkey` with
   `useRewardCredit`). Seat credit needs the signed-in account whose payout
   wallet earned it (`creditRefusal`, `server.js`); points stay anonymous.

```
Visible watch time ──► rewards.js (bounds, lifetime cap)
                          ├──► cash:   door intent ──► account's payout wallet
                          └──► credit / points: earned balance ──► a seat in this room
```

## Configuration (`.env`)

The interval, amount and cap are per room, set on the create/manage page (the
room config's `rewards`). The server bounds them for cash and credit, clamping at
earn time whatever the room stored; points are exempt.

| Var | Default | Meaning |
| --- | --- | --- |
| `REWARDS_CASH_ALLOWLIST` | _(unset: cash off)_ | Comma-separated creator account ids whose owned rooms may pay cash; `*` = every owned room |
| `REWARDS_MIN_INTERVAL_S` | `60` | Shortest earn interval, in seconds |
| `REWARDS_MAX_EARN` | `0.01` | Most one earn may issue, in the reward's own units |
| `REWARDS_MAX_CAP` | `0.1` | Most one payout wallet or account may earn in a room, lifetime |
| `REWARD_POOL_WALLET_ADDRESS` | _(display)_ | The reward pool wallet address |
| `REWARD_POOL_PRIVATE_KEY` | _(required for cash)_ | The pool's signer at the settlement door |

Saving a switched-on cash or credit reward outside these bounds answers 400
`rewards_out_of_bounds`, naming the limit (`dashboard-routes.js`).

If `REWARD_POOL_PRIVATE_KEY` is **not** set, cash is **off** (`no_pool_signer`):
no intent is recorded that nothing can pay. Credit and points still work. The
door also refuses a pool key that resolves to the platform wallet or another
signer, and logs it by name.

## How to refill the pool

The reward pool pays cash as plain USDC transfers on Tempo mainnet, and each
transfer's fee is paid in that same USDC (`settlement.js`, `feeToken`), so the
pool needs USDC for both:

1. Do not top it up until `REWARDS_CASH_ALLOWLIST` names creators; until then
   cash is off and nothing draws on it (`docs/internal/launch-readiness.md`).
2. Send USDC to your `REWARD_POOL_WALLET_ADDRESS`, sized to
   `REWARDS_MAX_CAP` times the viewers you expect to reach it.
3. No restart is needed: the door pays recorded intents on its next flush.
   Watch the logs for `[settlement] flush: sent …`.

## Verification performed

- Server boots with `[rewards] per-room rewards attached — cash …`, which says
  whether cash is on and, if not, why (no pool signer, or the allowlist unset).
- `_gate-rewards-auth.mjs` (13/0 on 2026-10-24), on the real server with every
  real key blanked and a read-only chain stand-in, so nothing can be sent: cash
  pays only in an allowlisted owned room, never a password room; an anonymous
  socket earns nothing and writes no intent; every intent pays the account's
  payout wallet whatever wallet the socket names; re-registers, extra sockets and
  a restart all stay within the cap; the server's bounds apply whatever the room
  stored; a cash reward is never also seat credit.
- `_gate-rewards-part-b.mjs`: optional per-room rewards do not break pay-to-join.
- Not proven with money: the signed-ahead transfer a cash reward goes out as has
  run only against stand-ins (`OPEN-ISSUES.md`, U7).
