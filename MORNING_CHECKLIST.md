# Morning checklist — streamer-dashboard branch

Branch: **`streamer-dashboard`** (off `modular-wallets`)

## Phase status

| Phase | Gate | Commit | Live verification |
|-------|------|--------|-------------------|
| **1 — Streamer dashboard** | `npm run gate:dashboard` ✓ | `phase 1: streamer dashboard` | [DASHBOARD_TEST.md](DASHBOARD_TEST.md) |
| **2 — Pluggable token** | `npm run gate:tokens` ✓ | `phase 2: pluggable payment token` | [TOKENS_TEST.md](TOKENS_TEST.md) |
| **3 — Payout/reward token** | Not started | — | Stretch; rewards still use global `.env` |

## Before you test

```bash
npm run build:passkey
npm start
```

Set in `.env`: `STREAMER_DASHBOARD_KEY`, `CIRCLE_CLIENT_KEY`, `SELLER_WALLET_ADDRESS`, `SELLER_PRIVATE_KEY`.

## Tomorrow — verify in order

### 1. Dashboard (Phase 1)

- [ ] http://localhost:3000/dashboard — unlock with dashboard key
- [ ] Create room → save tick prices → copy JOIN + OVERLAY URLs
- [ ] OBS browser source with overlay URL (`?room=…`)
- [ ] Passkey join on JOIN URL — one approve, meter ticks, tile on overlay
- [ ] MetaMask join on same room — Gateway flow unchanged
- [ ] Stop room → join rejected; kick removes seat

### 2. Custom token (Phase 2)

- [ ] Dashboard → set passkey payment token (or leave USDC default)
- [ ] Join page shows correct **symbol** in meter
- [ ] Passkey approve/pull uses chosen token on Arcscan
- [ ] MetaMask still shows USDC / Gateway only

### 3. Regression (must not break)

- [ ] http://localhost:3000/ without `?room=` uses **default** room
- [ ] Overlay animations, leave/refund, vdo.ninja camera flow
- [ ] No console TDZ errors on load

### 4. Phase 2 passkey join fix (prior)

- [ ] After approve, **no** 402 / `transfer_not_found` on join
- [ ] Server logs `[join:passkey] verified allowance …`

## Automated gates (run anytime)

```bash
npm run gate:dashboard
npm run gate:tokens
npm run gate:phase2
```

## Phase 3 (not landed)

Watch-to-earn reward token / points from dashboard — still global `EARN_*` in `.env`. Next step: extend `rewards.js` + dashboard fields per room without touching join/meter paths.
