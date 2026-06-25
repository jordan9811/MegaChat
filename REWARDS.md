# Pass C — Watch-to-earn

Viewers **earn testnet USDC for time spent connected and focused** on this site,
and can spend those earnings to join via the Pass B meter. Because earning is
measured purely by the **WebSocket session + Page Visibility API** (not by the
video itself), it works no matter where the stream actually plays — Twitch, Kick,
Zora, or the local overlay.

All of this lives in one module, **`rewards.js`** (server) plus
**`public/rewards.js`** (client), so it cannot break Pass A or Pass B. The only
hook into the app is a single guarded `attachRewards(wss, …)` call in `server.js`.

## The loop

1. A viewer opens the site and connects MetaMask.
2. `public/rewards.js` opens its own WebSocket, registers the wallet, and reports
   tab focus via the Page Visibility API.
3. Server-side `rewards.js` accrues **focused** session time. Every
   `EARN_INTERVAL` seconds (default 60) of focused time it credits `EARN_AMOUNT`
   USDC (default 0.1) to that wallet, **capped at `EARN_CAP`** (default 5) per
   wallet per session.
4. The credit is a real `GatewayClient.depositFor(EARN_AMOUNT, viewerWallet)` from
   the **pre-funded reward pool wallet** — it deposits USDC into Gateway *on behalf
   of the viewer*, so the balance is owned by (and spendable by) the viewer.
5. The viewer's "earned this session" total updates live next to the spend meter.
6. The viewer can now **join** (Pass A/B), signing a Gateway authorization that
   spends the earned balance; the Pass B meter draws it down per tick.

```
Focused watch time ──► reward pool depositFor() ──► viewer Gateway balance
                                                          │
                                                          ▼
                                            Pass B prepaid session + meter
```

## Configuration (`.env`)

| Var | Default | Meaning |
| --- | --- | --- |
| `EARN_INTERVAL` | `60` | Seconds of focused time per credit |
| `EARN_AMOUNT` | `0.1` | USDC credited each interval |
| `EARN_CAP` | `5` | Max USDC earned per wallet per session |
| `REWARD_POOL_WALLET_ADDRESS` | _(display)_ | The reward pool wallet address |
| `REWARD_POOL_PRIVATE_KEY` | _(required for payouts)_ | Pool wallet key used to sign `depositFor` |

If `REWARD_POOL_PRIVATE_KEY` is **not** set (or invalid), rewards run in
**dry-run** mode: the loop still runs and the UI ticks up ("earned this session
(sim)") so you can see the mechanism, but no on-chain deposit happens. Set the key
to enable real payouts.

## How to refill the pool

The reward pool must hold USDC (and Arc uses USDC for gas) so it can
`depositFor` viewers:

1. Go to <https://faucet.circle.com> and select **Arc Testnet**.
2. Send testnet USDC to your `REWARD_POOL_WALLET_ADDRESS`.
3. (Optional) Pre-deposit some USDC into the pool's own Gateway balance if you
   extend the module to pay from Gateway; the default `depositFor` path pulls
   USDC straight from the pool wallet, so a plain faucet top-up is enough.
4. Restart the server (or it picks up new balance automatically on the next
   credit). Watch the logs for `[rewards] credited … (tx …)`.

## Verification performed

- Server boots with `[rewards] watch-to-earn active …` and the rest of the app
  unaffected.
- A registered wallet with a visible tab receives a `rewards_earned` credit after
  `EARN_INTERVAL` of focused time; the UI shows "earned this session" rising and
  it stops at `EARN_CAP`.
- In dry-run the loop is demonstrable without funds; with
  `REWARD_POOL_PRIVATE_KEY` set and the pool funded from the faucet, the credit is
  a real `depositFor` into the viewer's Gateway balance, immediately spendable by
  the Pass B join/meter.
