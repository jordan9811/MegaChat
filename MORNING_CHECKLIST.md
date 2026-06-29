# Morning checklist — streamer-dashboard branch

Branch: **`streamer-dashboard`**

## Part status (this pass)

| Part | Gate | Commit | Live doc |
|------|------|--------|----------|
| **Baseline** | — | `baseline: before part A/B UX and rewards pass` | — |
| **Part A — UX overhaul** | `npm run gate:ui-a` ✓ | `part A: app-wide UX overhaul` | [UI_TEST.md](UI_TEST.md) |
| **Part B — Optional rewards** | `npm run gate:rewards-b` ✓ | `part B: optional rewards primitive (first pass)` | [REWARDS_TEST.md](REWARDS_TEST.md) |
| **Auth — Per-room passwords** | `npm run gate:auth` ✓ | `auth: per-room passwords + entry flow` | [AUTH_TEST.md](AUTH_TEST.md) |

## Earlier phases (still must pass)

| Phase | Gate | Doc |
|-------|------|-----|
| Dashboard + rooms | `npm run gate:dashboard` | [DASHBOARD_TEST.md](DASHBOARD_TEST.md) |
| Pluggable token | `npm run gate:tokens` | [TOKENS_TEST.md](TOKENS_TEST.md) |
| Passkey join fix | `npm run gate:phase2` | [PHASE2_TEST.md](PHASE2_TEST.md) |

## Before you test live

```bash
npm run build:passkey
npm start
```

`.env`: `ROOM_DEFAULT_PASSWORD` (legacy rooms), `CIRCLE_CLIENT_KEY`, `SELLER_WALLET_ADDRESS`, `SELLER_PRIVATE_KEY`.  
Optional: `REWARD_POOL_PRIVATE_KEY` for on-chain USDC reward payout (otherwise local/dry-run credits).

## Verify in order

### 1. Product spine — pay to join

- [ ] `/dashboard` — create room; config **above** Create; URLs only in result panel
- [ ] JOIN link `/?room=…` — passkey: one approve, per-second meter, overlay tile
- [ ] Same room — MetaMask Gateway join unchanged
- [ ] Stop room → join rejected; kick works

### 2. Part A UX

- [ ] Token dropdown defaults USDC; custom address only when chosen
- [ ] Plain-language labels; Advanced expander for dual pricing
- [ ] Join + overlay pages use mint/teal theme; **overlay.html not restyled**

### 3. Part B rewards (optional)

- [ ] Dashboard **Rewards (optional)** — enable, save, persists
- [ ] Join page shows **earned toward join** when enabled
- [ ] Focused watch → balance accrues; spend toward join (free/cheaper)
- [ ] Room with rewards **off** — identical to pre-rewards join

### 4. Regression

- [ ] `/` without `?room=` → default room
- [ ] No console TDZ / null errors on `/`, `/dashboard`, `/overlay`
- [ ] vdo.ninja camera, leave, animations, room-scoped WS

## Automated gates

```bash
npm run gate:ui-a
npm run gate:rewards-b
npm run gate:auth
npm run gate:dashboard
npm run gate:tokens
npm run gate:phase2
```
