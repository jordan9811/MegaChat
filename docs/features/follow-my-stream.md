# Follow my stream

**Status: `SHIPPED`** — landed in `974cb4d` (2026-09-14); the three-witness close rules, the manual-start hold and the owner's name rule landed 2026-11-07 after a production night where the loop fought the owner (below). Gated by `_gate-follow-stream.mjs` (46 assertions against a fake Twitch and a keyed overlay socket on local ports; 15 of them fail against the code before the 2026-11-07 change, which is how the gate shows it discriminates).

## What it does

When *Follow my stream* is on and the room names a Twitch channel, the room's state follows that broadcast: it opens and joins the board when the channel goes live, leaves the board the moment the channel goes dark, and pauses once the stream has ended. The toggle had promised this since it shipped and done nothing until `974cb4d` (`server.js`, the comment above `followTick`: "what the 'Follow my stream status' toggle has promised since it shipped and never did").

The manage page is part of it. A room opened by hand before the stream starts stays open while its manage page is open, and the manage page counts down when an ended stream is about to pause the room.

## Why it changed (2026-11-07)

The production log of 2026-11-07 showed the owner press Start four times in five minutes before going live, and the loop pause the room within a minute each time: the channel had been "dark" since the server booted four hours earlier, so the five-minute window was long spent. While live, the loop also replaced the name the owner had typed with the stream title every minute. And when the stream ended, the board dropped the room within a minute but the room kept saying "Live · taking joins" for five more.

## How it works

One loop, `followTick()` in `server.js`, every 60 s (`FOLLOW_POLL_MS`):

1. Collect every room with `twitchAuto !== false` and a `twitchChannel` (`followsBroadcast`).
2. Ask Twitch Helix which of those logins are live, in **one batched call** of up to 100 logins (`getStreamsByLogins`, `twitch-api.js`). The cost of the question does not grow with the number of rooms.
3. A channel seen live opens the room, and opens or resumes an airing record ([Airings and evidence](../concepts/airings-and-evidence.md)).
4. **Discovery** hides the room from the board on the first dark reading (`hiddenByBroadcast`, checked in `/api/rooms/public`), unless the owner is holding it open (below).
5. **Closing** is `closePlan`'s call (`server.js`), read after every poll and every `MANAGER_TICK_MS` (10 s) by `applyClosePlans`.

### Three witnesses

`closePlan` reads three things that each say whether somebody is behind the room (`server.js`, the block above `managerPresence`):

- **Twitch**, through the poll above.
- **The keyed OBS overlay**, the socket that presents the room's overlay key (`hasAuthedOverlay`).
- **The manage page.** It beats every 20 s while open and says goodbye on `pagehide` (`postManagerPresence`, `web/lib/api.ts`; the presence effect in `web/components/room-provider.tsx`), and its 5-second refresh also counts as word from the owner (`managerContactAt`, `server.js`).

| Situation | What happens |
|---|---|
| Opened by hand (Start, or a new room) before the stream is up | Stays open, and on the board, while its manage page is open (`ownerHolds`). Closes once the page has said goodbye and the reload grace (`MANAGER_LEAVE_GRACE_MS`, 45 s) is up, or has gone quiet for `MANAGER_BEAT_STALE_MS` (150 s). Going live later reopens it. |
| The stream ends, the owner is online, the overlay is gone | Pauses at once: the stream ended and OBS closed. |
| The stream ends, the owner is online, the overlay still connected | Pauses after `FOLLOW_OFF_OWNER_MS` (90 s). The manage page shows "Stream ended · pausing in m:ss". |
| The stream ends and the manage page closes | Pauses after the reload grace. |
| The stream ends and nothing is heard from the owner | Waits `FOLLOW_OFF_CONFIRM_MS` (5 min): that is what a dropped connection looks like, and a conversation in flight should survive it. |
| A room that follows no stream | Pauses when its manage page has closed (or gone quiet) and no keyed overlay is connected. |

A press of Start holds the room only until the manage page speaks: a hold that outlived a goodbye kept a closed page's room open for the whole stale window (`ownerHolds`, `server.js`; `_gate-follow-stream.mjs` H4).

**Only a room whose manage page has been seen this boot is closed on the page's word.** The test room and the demo room are never closed on this signal (`closePlan` skips `DEFAULT_ROOM_ID` and `isDemo`), and a room nobody manages is left as it was (`_gate-follow-stream.mjs` L5, L6).

**A null answer touches nothing.** If Helix is unconfigured, errors or times out, `getStreamsByLogins` returns `null` and the loop leaves every room as it is: "pausing somebody's room because Twitch timed out would be the worst failure this loop could have" (`server.js`). `closePlan` judges a following room only on a fresh Twitch answer (`freshFollow`). Nothing is hidden on a guess before the first successful reading or after a restart (`hiddenByBroadcast`). A room whose own write fails is logged and skipped; the rooms after it still poll (`followTick`, `applyClosePlans`, `server.js`).

### The room name

While the channel is live, a room nobody named takes the stream's title, so the board and the Twitch directory say the same thing. A name the owner typed is theirs: the title no longer replaces it (`nameSource` on the room record, `rooms-store.js`; the rename rule in `followTick`, `server.js`).

- A name typed at creation, or edited later, marks the room `nameSource: 'owner'`. A save that repeats the name the room already has does not (the dashboard `PUT` in `dashboard-routes.js`), and the manage page sends the name only when the field was edited, so an autosave carrying a stale name cannot claim it (`nameEditedRef`, `web/components/room-provider.tsx`).
- Only then, the manage page shows the Twitch title in small text under the name field, with **Use this name**. That takes the title now and follows it from then on (`useTwitchTitle` in the dashboard `PUT`). Nothing shows when the name follows the stream.
- Older rooms, with no `nameSource`, follow the title until the owner types a name.

The comparison is by character, through the store's own 64-character cut, so an emoji at the cut is not read as a change every minute (`clampRoomName`, `rooms-store.js`).

### Turning it off

`FOLLOW_STREAM=0` disables the loop entirely. `MANAGER_CLOSE=0` turns off the manage-page witness and every rule that reads it: the loop then behaves as it did before 2026-11-07, pausing a following room only after `FOLLOW_OFF_CONFIRM_MS` of dark (`closePlan`, `noteManualStart`, `server.js`).

## How to use it

On the create/manage page, connect your Twitch account (the channel name is adopted automatically: `twitchAuto` is on by default, `resolveRoomConfig`, `rooms-store.js`) or type a channel, and leave *Open and close with my Twitch stream* on. Open the room before you go live if you like; it stays open while the page is open. Go live on Twitch; within a minute the room is listed with your live preview. Stop streaming; the card disappears within a minute, and the room pauses within a minute or two.

## What this does NOT do

- **It does not follow Kick, YouTube, Rumble, X or pump.fun.** The loop asks Twitch Helix only (`followTick` → `getStreamsByLogins`, `twitch-api.js`). Those platforms are verified for bounties ([Platform support](platform-support.md)) but do not drive room state. A room on those platforms is closed only by the manage-page rule for rooms that follow no stream.
- **It does not confirm that the streamer is showing the overlay.** The overlay socket being connected is one witness; whether the overlay is on screen is a separate question the OBS scene check asks ([OBS setup](obs-setup.md)).
- **It does not end a seat.** Pausing a room refuses new joins; a guest already seated is untouched (`updateRoom` on `active`, not `removeParticipant`).
- **It does not close a room because a browser tab elsewhere on the site closed.** Only the room's own manage page counts.
- **It does not run without Twitch credentials.** With `TWITCH_CLIENT_ID`/`SECRET` absent the Helix call returns null and the loop is a no-op (`twitch-api.js`); the manage-page rule for rooms that follow no stream still runs.
