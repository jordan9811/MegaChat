# LIVEKIT_NOTES — livekit-transport branch (2026-07-11)

Flag-gated parallel camera transport. **vdo.ninja is untouched and remains
the default for every room** — LiveKit activates per room via the dashboard
transport dropdown, and only when the env credentials exist. Payment, meter,
auth, and rewards logic were not touched (the meter is transport-agnostic;
the only contact point is that livekit seats get a configurable stale
grace).

## Your setup steps (to turn it on for real)

1. **LiveKit Cloud account** — [cloud.livekit.io](https://cloud.livekit.io),
   create a project (free tier is plenty to start).
2. From the project settings copy three values into `.env` (and Railway →
   Variables when you deploy this branch):
   - `LIVEKIT_URL` — the project's `wss://….livekit.cloud` URL
   - `LIVEKIT_API_KEY`
   - `LIVEKIT_API_SECRET`
   - optional: `LIVEKIT_SEAT_GRACE_S` (seat survival window on a network
     blip; default 15, actual threshold is max(this+5s, 20s))
3. Restart. The dashboard's Advanced → Camera transport dropdown lights up;
   pick LiveKit on a room (existing rooms stay on vdo untouched).
4. Streamer flow on a LiveKit room: dashboard grows a **Host camera** card —
   "Go on air" publishes your cam straight from the dashboard (this replaces
   the vdo Host-cam link for those rooms). **OBS instructions are identical
   regardless of transport**: the browser source is still
   `/overlay?room=<id>` (or `/<handle>/overlay`) — the overlay speaks
   whichever transport the room uses under the hood.

Local testing without Cloud: `tools/livekit-server.exe --dev` (gitignored;
official v1.13.3 binary) runs a full local SFU at `ws://localhost:7880`
with `devkey`/`secret` — exactly what all three gates use.

## Verified by automated gates (real local SFU + real mainnet meter dust)

- **Phase 1 (16/0)**: env-gating honest (flag false / token 503 / disabled
  dropdown); publisher tokens require a meter-granted seat (403 otherwise);
  subscriber tokens are subscribe-only JWTs scoped to `mc-<room>`; joiner
  publishes through the same UI states with vdo iframes dormant; overlay
  renders LiveKit `<video>` tracks inside the SAME tile/stinger machinery
  with real frames; meter ticks flow during the session; kick removes the
  participant AT THE SFU; vdo control room untouched.
- **Phase 2 (11/0)**: host token password-gated; "Go on air" from the real
  dashboard UI publishes (SFU-listed); a live joiner receives host frames
  sub-second over its existing connection; delayed Twitch embed REMOVED
  during the slot and restored after; letters play unchanged on livekit
  rooms; vdo return feed untouched.
- **Phase 3 (11/0)**: ~8s network kill → seat survives, joiner UI shows
  "⏸ paused / Reconnecting…" with the quality dot red, dashboard flips
  unstable, spent FROZEN (no vouchers = no dead-air charges) → auto
  reconnect → control WS re-registers → meter resumes. Simulcast verified
  (2 layers on the published track). Sub-~8s blips are invisible even to
  the SDK and cost nothing — by design.

## Needs live testing (not automatable here)

- Real cameras/mics on real networks (gates use synthetic canvas cams).
- LiveKit **Cloud** (gates ran the local dev SFU; Cloud adds TURN, regional
  routing — the client code is identical, but verify one end-to-end session
  after setting the env vars).
- OBS capturing a LiveKit-room overlay (the page renders identically, but
  eyeball a session: tiles, stingers, audio levels).
- Simulcast quality degradation under genuine bandwidth pressure.

## Transport status, one line each

- **vdo.ninja**: production, default, battle-tested on live streams — zero
  changes on this branch.
- **LiveKit**: feature-complete parallel implementation (publish, overlay,
  return feed, letters, reconnect grace, quality signals, simulcast,
  server-side kick), fully gated against a real local SFU — awaiting Cloud
  creds + one live human session to graduate.

## Implementation map

- `livekit.js` — token minting + room admin (server), null when unconfigured
- `POST /api/livekit/token` — publisher (seat-gated) / subscriber / host
  (password-gated); `POST /api/seat/quality` — client quality reports
- `web/lib/join-page.ts` — `startLivekitCameraStage`, host-feed subscription,
  tick-skip while reconnecting, quality dot
- `public/overlay.html` — transport-aware tile content (buffers seats until
  transport known), `/vendor/livekit-client.umd.js` (no CDN)
- `web/components/host-cam-card.tsx` — dashboard Go on air
- Seat grace: `tickAllMeters` in `server.js`; dashboard quality blend in
  `dashboard-routes.js`
- Gates: `_gate-lk-phase1/2/3.mjs` (need `tools/livekit-server.exe --dev`
  running)
