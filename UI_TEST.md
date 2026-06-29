# Part A — App-wide UX overhaul

Branch: **`streamer-dashboard`**

## Product framing

One product: **pay to join the stream** (mega chats). Viewers pay per second to go on camera. Rewards (Part B) is an optional add-on — not a separate mode.

## Automated gate

```bash
npm run gate:ui-a
```

## Manual verification — http://localhost:3000

### Dashboard

1. Open `/dashboard` → create a room with password or manage with room ID + password
2. Confirm **no JOIN/OVERLAY URLs** until you click **Create room**
3. Token picker defaults **USDC**; **Custom token…** reveals address field only
4. USDC contract hidden behind **ⓘ view contract address** tooltip
5. Friendly labels: price per charge, how often charged, session cap, max on-camera
6. **Advanced** expander shows MetaMask vs passkey dual pricing
7. **Create room** → result panel with copy buttons + OBS hint
8. **Rewards (optional)** collapsed; Twitch/Kick stub disabled

### Join page

1. Open `/?room=YOUR_ID` — mint/teal theme, “Pay to go on camera”
2. Console clean on load
3. Passkey + MetaMask join still work

### Regression

- `/overlay?room=…` unchanged (transparent tiles)
- No `?room=` → `default` room still works

## Visual notes

- Near-neutral dark base `#0c0f12`, accent `#2dd4bf`
- Shared `public/app-theme.css` (dashboard + join only; overlay untouched)
