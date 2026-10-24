# Identity and handles

**Identity** is who a person is to MegaChat. **A handle** is the name a room lives at (`megachat.fun/<handle>`), and separately the name a person reserved by signing in. They are related but not the same registry, and the difference matters for what can be trusted.

## One front door

Sign-in goes through Privy — Twitch, X, Google, email or a passkey — and the server turns a verified Privy session into a MegaChat identity (`privy-identity.js`, "ONE login for the whole app"). A Privy sign-in is keyed by the Privy DID, not the social account: one person is one handle no matter how many socials they link later, and linking a second social does not mint a second name (`privy-identity.js`, "IDENTITY KEY: the Privy DID, never the social account").

Two implementation facts the docs should not paper over:

- Linked accounts are read from Privy's REST API, not its SDK, because the SDK version in use silently drops Twitch and newer account types while parsing (`privy-identity.js`, "ACCOUNTS COME FROM THE RAW REST API, NOT THE SDK"). Verified empirically by the author of that comment; it is a workaround, not a preference.
- The older direct OAuth path (Twitch, X, Kick) still exists in `auth.js` and answers 503 when its credentials are absent. `auth.js` describes itself as "IDENTITY ONLY" — no watch-time verification, no platform drops. It is also how a signed-in person connects another platform to their account; a login already linked to someone else is refused (`link_taken`), and so is a second login of a provider the account already holds (`provider_linked`): switching X accounts is disconnect, then connect (`accounts.js`, `attachLink`).

Every sign-in resolves to one **account** with its own id, persisted in `data/accounts.json` (`accounts.js`; `identity-store.js` is now a view over it) on the same volume as rooms, because a store wiped on deploy was what made the claim screen reappear "every time" (`rooms-store.js`, the comment above `storePath`).

The session is a sealed cookie holding `{accountId, iat}`: refused once it is 30 days old, enforced server-side, and `Secure` in production. The pre-account `{provider, platformId}` shape is refused outright (`auth.js`, `readIdentityFromRequest`). The seal key is `AUTH_SECRET` (else `MPP_SECRET_KEY`); a production box with neither seals with a secret made fresh at every boot, so sessions end at each restart rather than fall back to the public dev constant (`runtime-env.js`, `sessionSecret`).

## The owner key

Every room a signed-in person creates is stamped with `ownerKey` = their account id (`acct_…`; `roomOwnerKey()`, `auth.js`; `setRoomOwner()`, `rooms-store.js`). It was `provider:platformId` before the account layer, which would have split one person across their own logins. That key is what lets an owner manage a room without a password, lists "your rooms", and scopes the guest whitelist — which is per streamer, not per room, precisely because it is keyed on the owner (`guest-whitelist.js`, header). Ownership is checked against the sealed identity cookie the server issued; it is never accepted from the request body (`auth.js`, "never client-asserted").

## Handles: two registries

- **Identity reservation** — signing in reserves your platform username as a MegaChat handle; on collision you get an editable suggestion before claiming (`auth.js`, header; `suggestHandle`, `accounts.js`). The handle belongs to the account: claiming a new one leaves the old one reserved to you, never freed for a stranger, until you release it (`claimHandle`, `releaseHandle`, `accounts.js`).
- **Room handles** — a room *uses* a handle when its owner sets one (`setRoomHandle`, `rooms-store.js`). `/<handle>` then resolves to that room permanently; the old id links keep working (`resolveRoomConfig`, "Permanent identity").

The dashboard resolves the obvious conflict — "the handle I reserved by signing in is the one I want on my room" — by asking *whose* reservation it is, not merely whether one exists (`dashboard-routes.js`, the comment above the handle check).

## A handle is not an authorization token

This is recorded as an open issue and worth repeating here. The guest whitelist originally admitted anyone presenting a listed handle; a handle can be squatted or reassigned, so entries now pin the `identityKey` they were added for and refuse a match on handle alone when one is recorded (`isWhitelisted(ownerKey, handle, identityKey)`, `guest-whitelist.js`; `OPEN-ISSUES.md`, "A HANDLE IS NOT AN AUTHORIZATION TOKEN"). Entries written before that field existed need the migration `_migrate-whitelist-identity.mjs`. Run against production on 2026-09-16 it found nothing to migrate — no guest list had ever been written there. The server now runs it at every boot as a report and applies it only when `MIGRATE_AT_BOOT` names `whitelist-identity` (`server.js`, the boot migration block); whether to set that is on the owner's list in the internal *Outstanding* page.

## What this does NOT do

- It does not verify follower or subscriber status for a room. A room's follower and subscriber gates are stored config only (`checkFeatureGates`, `server.js`). (A targeted campaign does read an X account's own counts, as eligibility for that campaign's reward, not as a room gate — `campaign-eligibility.js`.)
- It does not prove that the person signed in as a Twitch user is the streamer whose channel a room follows. `twitchChannel` on a room is a login the owner typed or adopted from their linked account (`resolveRoomConfig`, `twitchAuto`), not a verified ownership claim. The bounty program's claim flow does prove platform ownership: the signed-in account must hold a login that platform itself proved — a real OAuth link's username, or the name Privy reports — matching the handle (`provenLoginsFor`, `accounts.js`; `loginProvingHandle`, `bounty-auth.js`). That check is the default; the auto-approving stub runs only under `BOUNTY_IDENTITY_STUB=1`, and YouTube, Rumble and pump.fun handles cannot be claimed until each has its own proof (`PlatformIdentityVerifier`, `bounty-routes.js`).
- It does not keep your platform tokens, except X's. The direct OAuth path uses an app token for identity reads and requests no scopes on Twitch (`auth.js`, `scope: ''`). The token from connecting X through that path is stored, encrypted, and used for one read: when you are on a campaign's frozen list, whether you follow someone applying to it (`connection_status`) — never to act on X (`x-token-store.js`).
