# Needs a status call

Everything the docs pass had to mark `UNCLEAR`: the sources disagree, or the repo does not say. Each is a decision only the owner can make. When one is decided, change the tag on the page named, and remove the row.

| # | Question | Where the sources disagree | Page that carries the tag |
|---|---|---|---|
| U1 | **Which payment mode is live for seats: MPP session channels on Tempo, the Circle passkey meter on Arc, or the Gateway prepaid block — and which are retained fallbacks?** | `server.js` `/api/config` reports `chainName: 'Tempo'` and serves `/api/join/mpp`, `/api/join/passkey` and `/api/join` (Gateway) side by side; `.env.example` carries both `TEMPO_*` and `ARC_*`/`CIRCLE_*` names; `web/app/layout.tsx` still lists "Arc network" in its keywords. Prod history (`17a5f09`, `189d6eb`, 2026-07-07) shows the MPP rebuild landed. Nothing in the tree says which join path the UI offers by default. | `concepts/money-and-metering.md`, `features/live-seats.md` |
| U2 | **Kick VOD wording.** Is "Kick has no VOD we can read" (what streamers are shown) the intended claim, or the corrected one? | `bounty-claim.config.js` `PLATFORM_PROFILES.kick.notice` says Kick has no VOD we can read. `OPEN-ISSUES.md` "Terminology correction: 'Kick has no VOD' is FALSE and was written twice" (2026-08-29) says Kick does have VODs; the accurate statement is that there is no sanctioned VOD *discovery* API. The copy was not changed after the correction. | `features/platform-support.md` |
