# Guest whitelist

**Status: `SHIPPED`** — built on `feat/guest-whitelist` (2026-09-05), hardened and merged in Pass A (`2443b22`, `c2c3807`). Gated by `_gate-guest-whitelist.mjs`, 63 assertions over real HTTP including the rejoin, the raised cap and the overlay rendering a guest past the paid cap. One item is on the owner: running the identity migration against production data (below).

## What it does

A streamer names MegaChat handles that may join their stream free, any time — regular co-hosts and recurring guests who come and go without paying per second or waiting for a paid seat (`guest-whitelist.js`, header). The list is **per streamer, not per room**: it applies to every room that account owns (`guest-whitelist.js`, "keyed by the owner key").

## How it works

- **The list** lives in `data/guest-whitelist.json`, keyed by the streamer's `ownerKey` (the account id, `acct_…`), with up to 20 entries by default (`whitelistMax`, `GUEST_WHITELIST_MAX`, capped at 200). Managed from the account page through `/api/whitelist/*` (`whitelist-routes.js`), which requires the streamer's own sealed identity cookie — there is deliberately no room-password path, because a moderator running one room should not edit a list that applies to all of them (`whitelist-routes.js`, header). The file is written atomically, and one that cannot be read refuses changes rather than reading as an empty list (`guest-whitelist.js`, header; `json-store.js`).
- **The short circuit** runs first in every join route, before the room's feature switches, before the reputation gates, and before any balance read or wallet call (`server.js`, "Guest whitelist: the free-join short circuit"; `tryWhitelistJoin` at the top of `/api/join/passkey` and `/api/join/mpp`). A matched guest gets a `whitelist_stream` seat that is never metered (`tickAllMeters`, `server.js`).
- **The cap is raised, not bypassed.** A guest sits above the configured `maxSeats`, and the number every surface reports is the cap *in force*: `effectiveMaxSeats(roomId, configured)` = configured + active whitelist guests, capped at ten (`server.js`). `initial_state`, `seat_added`, `/api/seats` and the browse card all read that one function, so a card never tells a viewer a full room has space (`/api/rooms/public`, `server.js`, "The cap in force, not the configured one"). Admission for *paying* viewers counts only paying seats (`payingSeatCount`).
- **Identity is pinned.** Each entry records the `identityKey` of the account it was added for, and `isWhitelisted(ownerKey, handle, identityKey)` refuses a handle-only match once a key is recorded — a handle can be squatted or reassigned; it is not an authorization token (`guest-whitelist.js`; `OPEN-ISSUES.md`, "A HANDLE IS NOT AN AUTHORIZATION TOKEN").
- **The toggle is strict.** `POST /api/whitelist/enabled` accepts only a boolean and returns 400 otherwise, so a malformed request cannot fail open (`whitelist-routes.js`).
- **The viewer is told.** `/api/config` reports `viewerRidesFree` from the same server-side check, so a whitelisted guest is never shown a wallet modal on the way to a free seat (`server.js`, `/api/config`).

## How to use it

Account page → *Guest list*. Add a handle; the person must have signed in to MegaChat at least once so the handle resolves to an identity. Toggle the list on. Guests open your room link as usual and are seated free; their tile appears even when your paid seats are full, up to the ten-tile ceiling.

## The migration on the owner's list

Entries written before `identityKey` existed carry none, and match on handle alone. `_migrate-whitelist-identity.mjs` pins the key by resolving each handle through the identity store; unresolvable entries are left and listed. The server runs it at every boot, after the accounts migration and before any store is read, in report mode: it writes only when `MIGRATE_AT_BOOT` names `whitelist-identity` (`server.js`; `migrateWhitelistIdentity`). It is idempotent, so leaving the variable set is harmless. Applying it to the production volume is the owner's action, recorded on the internal *Outstanding* page.

## What this does NOT do

- **It does not verify the guest's platform identity beyond MegaChat sign-in.** The pin is the MegaChat account id (`acct_…`) the guest's sign-in resolves to (`roomOwnerKey`, `auth.js`).
- **It does not exempt a guest from the room being paused** — a paused room refuses the guest too (`addParticipant`, `room_stopped`, `server.js`). The room's own feature switches are a different matter: the short circuit runs before them, so a listed guest is seated even with Join Stream off (`server.js`, "Runs FIRST in the join path — before the room's own feature switches"; the order of checks in `/api/join/passkey`).
- **It does not scale.** Twenty names by default, two hundred at most, on purpose: "the whitelist can't quietly become a way to run a free room at scale" (`whitelistMax`, `guest-whitelist.js`).
- **It does not give a guest the streamer's controls.** A guest is a seat; management still needs ownership or the room password (`auth.js`, `verifyRoomAccess`).
