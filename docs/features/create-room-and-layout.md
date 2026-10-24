# Create a room, set rates, arrange the overlay

**Status: `SHIPPED`** — the create/manage page shipped in the UI overhaul (`9e3c693`, `d3eb5ec`), the layout editor in Pass A (`94b0a23`), the live Twitch preview on the manage page in `807b6e4`. Gated by `_gate-overlay-room.mjs` (the overlay URL survives the next stream), `_gate-dashboard-phase1.mjs`, and the layout clamps in `_gate-overlay.mjs`.

## What it does

One page, `/dashboard` (rendered by `web/components/create-room/create-room.tsx`), creates a room and then manages it: name, prices, seat count, MegaChat settings, who gets in, the overlay layout, the OBS setup, and — while you are live — the same preview everyone else sees.

## How it works

- **Creating** posts to the dashboard API (`dashboard-routes.js`, `createRoomWithPassword`). A signed-in owner needs no password; a password, when set, is the key you hand a moderator (`rooms-store.js`, `createRoomWithPassword`). The room is stamped with your owner key so it appears under *Your rooms* and you can manage it without the password (`setRoomOwner`, `rooms-store.js`).
- **Rates** are the per-second price and the session cap ([Money and metering](../concepts/money-and-metering.md)). An empty price is invalid, not free (`d16fc27`, "empty price is INVALID, not free"); a free room is an explicit toggle (`ef504f4`, "FREE toggle — one flip, no wallet, no setup").
- **Seats** are 1–3 (`resolveRoomConfig`, `rooms-store.js`).
- **Features** are three switches: *Hollers*, *Call in* and *Rewards* (`lettersEnabled`, `joinStreamEnabled`, `rewardsEnabled` on the draft). A feature's tile wears its colour and tag only while it is on, and the previews carry the same tags the room's board card will (`web/components/create-room/create-room.tsx`, `Feature`, `featureList`).
- **Layout** — origin corner, stacking direction, margin, tile width and height, gap, and whether MegaChats clip to the tile — lives on the room record and is edited on a quarter-scale 1080p canvas with mock seats (`web/components/create-room/layout-editor.tsx`; `resolveLayout`, `rooms-store.js`). Clamps: tile width 160–1920, height 90–1080, gap 0–200. Each save bumps `version`, and a connected overlay re-places tiles without reassigning seats (`applyLayout`, `public/overlay.html`).
- **Handle** — claim `megachat.fun/<yourname>` once; old id links keep working (`setRoomHandle`, `rooms-store.js`; `dashboard-routes.js` handle check).
- **Saving** — the new password, the handle and the rest of the change are checked together and written once, so a refused layout or a taken handle leaves the room exactly as it was (`applyRoomUpdate`, `rooms-store.js`; `_gate-dashboard-update.mjs`). A cash or credit reward that is switched on and outside this server's bounds (`REWARDS_MIN_INTERVAL_S`, `REWARDS_MAX_EARN`, `REWARDS_MAX_CAP`) is refused with the limit it broke, 400 `rewards_out_of_bounds` (`dashboard-routes.js`, `rewardsOutOfBounds`).
- **Preview** — when the room follows a Twitch channel and that channel is live, the manage page shows the Twitch frame; liveness is measured by probing the 640×360 thumbnail rather than trusting the smaller one, which serves a placeholder without redirecting (`twitchLiveCached`, `server.js`; `807b6e4`).
- **End room** — a paused room stops accepting joins but keeps serving its links; *End room* is the explicit action (`2a0cd60`; `setRoomActive`, `endRoom` in `web/lib/api.ts`).

## How to use it

Landing → *Create a room* → `/dashboard`. Fill the name and price, save. Then, in the right column: add the overlay to OBS ([OBS setup](obs-setup.md)), and if you want it, turn on *Follow my stream* so the room pauses and resumes with your broadcast ([Follow my stream](follow-my-stream.md)). Come back to this page while live to see the preview and manage seats.

## The ten-tile ceiling

Three paid seats is the configured cap. Whitelisted guests can raise the *effective* cap above it, up to ten tiles — a number derived from the canvas and the verifier's badge floor, not chosen by taste (`server.js`, the comment above `MAX_EFFECTIVE_SEATS`: 1040 px of column at a 90 px minimum tile and 12 px gap is ten tiles, and at 90 px the bounty badge is ~14 px against a 12 px reading floor). `MEGACHAT_MAX_SEATS` overrides it for a bigger canvas.

## What this does NOT do

- **It does not delete a room in one click.** *End room* deletes it — every live seat is removed and refunded first, the record goes and the handle is freed — so the page arms, then confirms, before it calls `DELETE /api/dashboard/rooms/:roomId` (`dashboard-routes.js`; `web/components/create-room/create-room.tsx`, `endNow`). The default room cannot be ended (`deleteRoom`, `rooms-store.js`). Rooms nobody can manage — no owner and no password — are pruned on deploy unless `KEEP_ORPHAN_ROOMS` is set; a password-only room survives (`isOrphanRoom` / `pruneOrphanRooms`, `rooms-store.js`).
- **It does not migrate a layout.** The defaults equal the old hard-coded grid to the pixel, so there was nothing to migrate (`rooms-store.js`, "the migration is that there is no migration").
- **It does not let a moderator with the room password edit the guest list** — that list is per streamer and lives on the account page ([Guest whitelist](guest-whitelist.md)).
- **It does not let a layout bury the bounty badge.** The badge takes the corner diagonally opposite where the tile stack lands, and a layout whose tiles would still reach it at the ten-tile ceiling is refused at save time with the reason, rather than the badge being moved somewhere the streamer did not choose (`public/overlay.html`, `applyBadgeAnchor`; `rooms-store.js`, `layoutCollision`; `_gate-overlay-layout.mjs`). Fixed in Pass C (2026-09-16); L13 on the [limitations](../verification/limitations.md) page.
