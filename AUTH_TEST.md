# Auth test — per-room passwords

Automated gate: `npm run gate:auth`

## What changed

- Global `STREAMER_DASHBOARD_KEY` removed
- Each room has its own password (hashed in `data/rooms.json`)
- Dashboard entry: **Create a new room** or **Manage existing** (room ID + password)
- Viewer JOIN and OBS overlay URLs stay **public** (no password)

## Legacy rooms

Rooms created before this change (including `default`) get a hashed password from `ROOM_DEFAULT_PASSWORD` in `.env` on first server boot. Default in `.env.example` is `changeme` — change it before production, then set a new password per room in the dashboard.

## Manual checks

### Dashboard create

1. Open `/dashboard` → **Create a new room**
2. Fill config + room password (min 4 chars) → **Create room**
3. Note room ID in header badge; copy JOIN + overlay links
4. Open `data/rooms.json` — confirm `passwordHash` exists and **no plaintext password**

### Dashboard manage

1. **Switch room** → **Manage existing**
2. Enter room ID + **wrong** password → should fail
3. Enter **correct** password → unlock config, start/stop, live viewers

### Viewer (no auth)

1. Open JOIN URL — no password prompt
2. Passkey or MetaMask join still works
3. `/overlay?room=…` loads without password

### Kick

1. With a viewer in a seat, click **Kick** in Live on-camera viewers
2. Viewer should be removed (seat freed on overlay)

### Regression

- Meter, passkey approve, Gateway join unchanged
- No passwords in server logs

## Env

```env
ROOM_DEFAULT_PASSWORD=changeme   # legacy migration only
```

Remove `STREAMER_DASHBOARD_KEY` from your `.env` if present — it is no longer used.
