# Identity and handles

**Identity** is who a person is to MegaChat. **A handle** is the name a room lives at (`megachat.fun/<handle>`), and separately the name a person reserved by signing in. They are related but not the same registry, and the difference matters for what can be trusted.

## One front door

Sign-in goes through Privy — Twitch, X, Google, email or a passkey — and the server turns a verified Privy session into a MegaChat identity (`privy-identity.js`, "ONE login for the whole app"). The identity key is the Privy DID, not the social account: one person is one handle no matter how many socials they link later, and linking a second social does not mint a second name (`privy-identity.js`, "IDENTITY KEY: the Privy DID, never the social account").

Two implementation facts the docs should not paper over:

- Linked accounts are read from Privy's REST API, not its SDK, because the SDK version in use silently drops Twitch and newer account types while parsing (`privy-identity.js`, "ACCOUNTS COME FROM THE RAW REST API, NOT THE SDK"). Verified empirically by the author of that comment; it is a workaround, not a preference.
- The older direct OAuth path (Twitch, X, Kick) still exists in `auth.js` and answers 503 when its credentials are absent. `auth.js` describes itself as "IDENTITY ONLY" — no watch-time verification, no platform drops.

Identities persist in `data/identities.json` (`identity-store.js`) on the same volume as rooms, because a store wiped on deploy was what made the claim screen reappear "every time" (`identity-store.js`, the comment above `DATA_DIR`).

## The owner key

Every room a signed-in person creates is stamped with `ownerKey = provider:platformId` (`roomOwnerKey()`, `auth.js`; `setRoomOwner()`, `rooms-store.js`). That key is what lets an owner manage a room without a password, lists "your rooms", and scopes the guest whitelist — which is per streamer, not per room, precisely because it is keyed on the owner (`guest-whitelist.js`, header). Ownership is checked against the sealed identity cookie the server issued; it is never accepted from the request body (`auth.js`, "never client-asserted").

## Handles: two registries

- **Identity reservation** — signing in reserves your platform username as a MegaChat handle; on collision you get an editable suggestion before claiming (`auth.js`, header; `suggestHandle`, `identity-store.js`).
- **Room handles** — a room *uses* a handle when its owner sets one (`setRoomHandle`, `rooms-store.js`). `/<handle>` then resolves to that room permanently; the old id links keep working (`resolveRoomConfig`, "Permanent identity").

The dashboard resolves the obvious conflict — "the handle I reserved by signing in is the one I want on my room" — by asking *whose* reservation it is, not merely whether one exists (`dashboard-routes.js`, the comment above the handle check).

## A handle is not an authorization token

This is recorded as an open issue and worth repeating here. The guest whitelist originally admitted anyone presenting a listed handle; a handle can be squatted or reassigned, so entries now pin the `identityKey` they were added for and refuse a match on handle alone when one is recorded (`isWhitelisted(ownerKey, handle, identityKey)`, `guest-whitelist.js`; `OPEN-ISSUES.md`, "A HANDLE IS NOT AN AUTHORIZATION TOKEN"). Entries written before that field existed need the migration `_migrate-whitelist-identity.mjs` run against production data — that is on the owner's list in [Outstanding](../internal/outstanding.md).

## What this does NOT do

- It does not verify follower or subscriber status on any platform. Those gates are stored config only (`checkFeatureGates`, `server.js`).
- It does not prove that the person signed in as a Twitch user is the streamer whose channel a room follows. `twitchChannel` on a room is a login the owner typed or adopted from their linked account (`resolveRoomConfig`, `twitchAuto`), not a verified ownership claim. The bounty program's claim flow does prove platform ownership, through Privy's linked account (`_gate-x-claims.mjs`, "X ownership through the Privy identity, PROVEN not assumed").
- It does not keep your platform tokens. The direct OAuth path uses an app token for identity reads and requests no scopes on Twitch (`auth.js`, `scope: ''`).
