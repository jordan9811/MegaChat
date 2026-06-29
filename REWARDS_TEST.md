# Rewards test — Part B (optional per-room primitive)

Automated gate: `npm run gate:rewards-b`

## Prerequisites

```bash
npm run build:passkey
npm start
```

Optional for on-chain USDC pool payout: `REWARD_POOL_PRIVATE_KEY` in `.env`. Without it, credits accrue locally (dry-run) and still reduce join cost.

## Dashboard

1. Open `/dashboard`, unlock with `STREAMER_DASHBOARD_KEY`.
2. Select a room (or create one).
3. Expand **🎁 Rewards (optional)**.
4. Enable rewards; set interval (e.g. 60s), amount (e.g. `0.1`), cap (e.g. `5`).
5. Choose **USDC**, **Custom ERC-20**, or **Points**.
6. **Save changes** — refresh page; settings should persist.

## Viewer earn (join page)

1. Open `/?room=YOUR_ROOM_ID` with rewards enabled.
2. Connect passkey or MetaMask wallet (rewards WS registers wallet + room).
3. Keep tab **focused** — after each earn interval, **earned toward join** updates.
4. Switch tab away — earning pauses (Page Visibility API).
5. Console: `[rewards] room … credited …` (no secrets logged).

## Join with earned balance

### Points mode (easiest live test)

1. Dashboard: reward type **Points**, passkey tick price `1`, max session `20`, earn amount `5`, interval `30`.
2. Viewer: farm until balance ≥ tick price.
3. Join with passkey — should skip approve and show “Joining with earned balance”.
4. Meter ticks locally (no on-chain pull); overlay/seat flow unchanged.

### USDC credit mode

1. Reward type **USDC**, fund passkey wallet **below** tick price OR zero balance.
2. Farm until earned ≥ tick price.
3. Join without approve — session draws from earned balance.

## Regression (rewards off)

1. Room with rewards **disabled**: join page hides earned row.
2. Passkey join still uses approve + on-chain meter.
3. MetaMask Gateway join unchanged.
4. Overlay (`/overlay?room=…`) unchanged.

## Must not break

- Passkey per-second meter (on-chain when not using earned balance)
- MetaMask Gateway join
- Room-scoped URLs and overlay tiles
- Leave / refund behavior
