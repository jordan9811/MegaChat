# Follow my stream

**Status: `SHIPPED`** — landed in `974cb4d` (2026-09-14) and observed working in production when a followed room auto-paused after its channel went dark. Gated by `_gate-follow-stream.mjs` (18 assertions against a fake Twitch on a local port, including the blip-resume case).

## What it does

When *Follow my stream* is on and the room names a Twitch channel, the room's state follows that broadcast: it leaves the browse board the moment the channel goes dark, pauses if the dark holds for five minutes, and comes back when the channel is live again. The toggle had promised this since it shipped and done nothing until `974cb4d` (`server.js`, the comment above `followTick`: "what the 'Follow my stream status' toggle has promised since it shipped and never did").

## How it works

One loop, `followTick()` in `server.js`, every 60 s (`FOLLOW_POLL_MS`):

1. Collect every room with `twitchAuto !== false` and a `twitchChannel` (`followsBroadcast`).
2. Ask Twitch Helix which of those logins are live, in **one batched call** of up to 100 logins (`getLiveByLogins`, `twitch-api.js`). The cost of the question does not grow with the number of rooms.
3. For each room, two answers at two speeds, because they carry different costs when wrong (`server.js`, "TWO QUESTIONS, ANSWERED AT TWO DIFFERENT SPEEDS"):
   - **Discovery** hides the room from the board immediately on the first dark reading (`hiddenByBroadcast`, checked in `/api/rooms/public`). Nobody should be able to pay into a room with no picture and nobody behind it.
   - **Pausing** waits `FOLLOW_OFF_CONFIRM_MS` (5 min). A ninety-second drop is a blip; the room stays live so a conversation in flight survives, and direct links keep working. Only a broadcast dark for the whole window pauses the room (`updateRoom(r.id, { active: false })`).
4. A channel seen live again resumes the room, and opens or resumes an airing record ([Airings and evidence](../concepts/airings-and-evidence.md)).

**A null answer touches nothing.** If Helix is unconfigured, errors or times out, `getLiveByLogins` returns `null` and the loop leaves every room as it is — "pausing somebody's room because Twitch timed out would be the worst failure this loop could have" (`server.js`). Nothing is hidden on a guess before the first successful reading or after a restart (`hiddenByBroadcast`, "Only a room we have OBSERVED go offline is hidden").

`FOLLOW_STREAM=0` disables the loop entirely.

## How to use it

On the create/manage page, connect your Twitch account (the channel name is adopted automatically — `twitchAuto` is on by default, `resolveRoomConfig`, `rooms-store.js`) or type a channel, and leave *Follow my stream* on. Go live on Twitch; within a minute the room is listed with your live preview. Stop streaming; the card disappears within a minute and the room pauses after five.

## What this does NOT do

- **It does not follow Kick, YouTube, Rumble, X or pump.fun.** The loop asks Twitch Helix only (`followTick` → `getLiveByLogins`, `twitch-api.js`). Those platforms are verified for bounties ([Platform support](platform-support.md)) but do not drive room state.
- **It does not confirm that the streamer is showing the overlay.** Liveness is the channel being live, nothing more. Whether the overlay is on screen is a separate question the OBS scene check asks ([OBS setup](obs-setup.md)).
- **It does not end a seat.** Pausing a room refuses new joins; a guest already seated is untouched (`updateRoom` on `active`, not `removeParticipant`).
- **It does not run without Twitch credentials.** With `TWITCH_CLIENT_ID`/`SECRET` absent the Helix call returns null and the loop is a no-op (`twitch-api.js`).
