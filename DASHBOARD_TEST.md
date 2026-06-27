# Phase 1 — Streamer Dashboard

Branch: **`streamer-dashboard`**

Per-room join economics live in **`data/rooms.json`** (gitignored). Secrets stay in `.env`.

## Automated gate

```bash
npm run gate:dashboard
```

Also run `npm run gate:phase2` to confirm passkey meter math still passes.

---

## Manual test — http://localhost:3000

### Prerequisites

1. `.env` with `STREAMER_DASHBOARD_KEY=changeme` (or your key), Circle keys, seller wallet.
2. `npm start`

### Dashboard

1. Open **http://localhost:3000/dashboard**
2. Enter dashboard key → Unlock
3. **Create room** (e.g. "Saturday Stream") — note the 8-char room id
4. Set passkey tick **0.001 USDC / 1s**, session cap **2**, max seats **3**
5. **Save config** → **Start room**
6. **Copy JOIN URL** and **Copy OVERLAY URL**

### OBS

1. OBS → Add → **Browser Source**
2. Paste **OVERLAY URL** (includes `?room=YOUR_ID`)
3. Size ~340×620, transparent background

### Passkey join (viewer)

1. Open **JOIN URL** in browser (`http://localhost:3000/?room=YOUR_ID`)
2. Console clean on load
3. Sign in with Passkey → fund if needed → **JOIN STREAM**
4. One approve prompt → seat assigned → camera live → meter ticks
5. Tile appears on overlay for **this room only**

### MetaMask join (regression)

1. Open same JOIN URL with `?room=YOUR_ID`
2. Connect MetaMask → Gateway deposit if needed → JOIN
3. EIP-712 sign once → prepaid meter ticks

### Stop / kick

1. Dashboard → **Stop room** → new joins rejected on join page
2. **Kick** removes a seat from live view

### Backward compat

- **http://localhost:3000/** (no `?room=`) uses **`default`** room from dashboard/env defaults.

---

## What remains live-only

- WebAuthn approve userOp on Arc
- On-chain passkey `transferFrom` ticks (needs `SELLER_PRIVATE_KEY`)
- Full OBS + camera end-to-end
