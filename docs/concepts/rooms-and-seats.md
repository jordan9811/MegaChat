# Rooms and seats

**A room** is a streamer's configured space: a name, a set of prices, a seat count, an overlay layout, and the switches that decide what viewers may do there. **A seat** is one viewer's place on camera inside a room, alive for as long as they stay and are charged for.

## The room record

A room is one JSON record in `data/rooms.json`, created by `createRoom()` in `rooms-store.js` with an 8-character id, a name, `active: true`, an optional password hash, and a `config` object seeded from environment defaults (`getEnvDefaults()`, `rooms-store.js`). Every read goes through `resolveRoomConfig()` (`rooms-store.js`), which normalises the stored config against those defaults so an older record renders exactly as it did before a field existed.

The fields that shape what a viewer sees, all from `resolveRoomConfig()`:

| Field | Meaning | Default |
|---|---|---|
| `active` | Whether the room accepts joins. A paused room still serves direct links but refuses new seats. | `true` |
| `unlisted` | Hidden from the browse board; still works by link. | `false` |
| `maxSeats` | Paid seats on camera at once. Clamped to 1–3. | `3` |
| `passkeyTickSeconds`, `passkeyTickPrice` | The metering unit for a live seat. | 1 s, `0.001` |
| `maxSession` | The most one seat can spend before it ends. | `2` |
| `letters` | The MegaChat settings — see [MegaChats](megachats.md). | enabled |
| `joinStream` | The live-seat settings, with their own admission and gates. | enabled |
| `layout` | Where tiles sit on the canvas — see [The overlay](the-overlay.md). | top-right, 320×180 |
| `transport` | `livekit` when the server has LiveKit credentials, else `vdo`. | `resolveTransport()` |
| `twitchChannel`, `twitchAuto` | The broadcast the room follows — see [Follow my stream](../features/follow-my-stream.md). | adopted from the linked account |
| `handle` | The permanent `/<handle>` link — see [Identity and handles](identity-and-handles.md). | none |

The cap of three paid seats is enforced twice: at creation (`createRoom`, `Math.min(3, …)`) and on every read (`resolveRoomConfig`, the same clamp). A whitelisted guest can sit *above* that cap, up to a hard ceiling of ten tiles — the derivation is in `server.js` above `MAX_EFFECTIVE_SEATS` and on the [Guest whitelist](../features/guest-whitelist.md) page.

## Who controls a room

Two credentials, deliberately different in scope (`auth.js`, the comment above `canManageRoom`):

- **The owner** — the signed-in account that created the room. Ownership is stamped on the record as `ownerKey` (`provider:platformId`, `roomOwnerKey()` in `auth.js`) and checked against the sealed identity cookie, never against anything the client asserts.
- **The room password** — optional, hashed with scrypt (`room-auth.js`), shared with moderators to run *one* room. A room created without a password is owner-only (`createRoomWithPassword`, `rooms-store.js`).

## A seat's life

A seat exists in one in-memory map, `activeSeats` in `server.js`. It is created by a join route, becomes **live** when the viewer's camera is actually publishing (`activateSeatLive`, `server.js`), is charged every tick while live, and is torn down by `removeParticipant()` (`server.js`) whether the viewer left, was kicked, ran out of balance, or vanished.

The reasons a seat ends are the reasons the code passes to `removeParticipant`: `left`, `out_of_funds`, `payment_stalled`, and the dashboard's kick. When a seat ends the overlay is told (`seat_removed`), the media server drops the participant (`livekit.kickParticipant`), and whatever was not spent is dealt with by `refundSeat()` — what that means depends on how the seat was paid for, which is the subject of [Money and metering](money-and-metering.md).

Seats do not survive a server restart: the map is memory, not disk (`server.js`, `activeSeats`). A room does — it is on disk.

## What this does NOT do

- A room does not record who sat in it. The seat map is transient; the only durable trace of a broadcast is the airing record ([Airings and evidence](airings-and-evidence.md)), which stores usernames of guests as labels, not viewer identities.
- A room's `maxSeats` is not a promise of three *simultaneous* streams of income; it is a cap on tiles.
- `followersOnly` and `subsOnly` on a room's gates are stored but not enforced — `checkFeatureGates()` in `server.js` enforces `minWatchSeconds` only, and says so in its comment.
