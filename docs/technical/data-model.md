# Data model

Every store, what it holds, how it is written, and — at the end — the list of what the system deliberately does not keep. Paths are relative to `DATA_DIR` (`process.env.DATA_DIR`, else `./data`), which is the Railway volume in production (`json-store.js`, `dataDir`; `rooms-store.js`, `dataDirInfo`).

## Rewritten documents (current state)

One JSON file each, loaded into a module cache, rewritten whole on mutation. Safe to rewrite because they are current state, not history (`bounty-store.js`, "The records below are current state, rewritten as a document").

Every store in this table is written through `json-store.js`. Each rewrite is atomic: a temp file in the same directory, fsync, then rename, so a crash leaves the old document or the new one, never half of either (`json-store.js`, `writeJsonAtomic`). The document stores — rooms, accounts, campaigns, the guest whitelist, airings, the bounty board and the X tokens (`x-token-store.js`, since 2026-10-24) — never treat a file that exists but cannot be read (empty, unparsable, the wrong shape) as empty: the store serves an empty view, refuses every write (`store_refused`), leaves the file exactly as it was for a person, and stays that way until the file is repaired and the process restarts (`json-store.js`, `createJsonStore`). Most changes write through. The bursty ones — airing moments and recordings, bounty code rotations and violations — coalesce into one write within a second, and a SIGTERM writes whatever is held before the process exits (`saveSoon`, `flushPendingWrites`; `server.js`). The two LiveKit files instead copy an unreadable file aside and start fresh, because both are rebuilt from live events (`livekit-webhooks.js`, `livekit-activity.js`); an unreadable boot marker reads as no earlier boots. A refused `x-tokens.json` lists no token holders, and a disconnect that cannot drop its row names the account in the log for whoever repairs the file (`x-token-store.js`, `dropXToken`).

| File | Module | Holds | Keyed by |
|---|---|---|---|
| `rooms.json` | `rooms-store.js` | room records: id, name, `active`, `passwordHash` (scrypt), `ownerKey`, `handle`, `config` (prices, seats, `letters`, `joinStream`, `rewards`, `layout`, `poster` (bounty capture only; the board reads `airing-posters/`), `twitchChannel`, `transport`, …) | room id; handle → id |
| `accounts.json` | `accounts.js` | one record per person: canonical and reserved handles, links (provider, platform id, username, attributes), the names Privy reported (`platformLogins`), payout wallet, room defaults. `identity-store.js` is a view over it; the pre-account `identities.json` is read only by `_migrate-accounts.mjs` | account id; handle → id; `provider:platformId` → id |
| `x-tokens.json` | `x-token-store.js` | X OAuth user tokens, AES-256-GCM-encrypted, plus the X user id in the clear; read only for campaign `connection_status` checks | account id |
| `campaigns.json`, `reference-sets.json`, `campaign-claims.json` | `campaign-store.js` | targeted reward campaigns, their frozen reference sets (ids and handles), and claims | ids; slug → id |
| `guest-whitelist.json` | `guest-whitelist.js` | per-streamer guest lists: handle, `identityKey`, `enabled`, join counts | owner key |
| `airings.json` | `airings-store.js` | per room, the last 20 airings with `moments[]` (`seat`, `seat_leave`, `megachat`, `restart` — written at boot into open airings), `vodUrl`, `captureRef` | room id → airing id |
| `bounty.json` | `bounty-store.js` | reserved handles, contributions, pledges, claims, air sessions, verifications, reviews, strikes | ids |
| `livekit-webhook-state.json` | `livekit-webhooks.js` | replay-rejection window for signed LiveKit events | event id |
| `livekit-sessions.json` | `livekit-activity.js` | connect/disconnect ledger for lazy connect (append-style records, rewritten file) | — |
| `boot-marker.json` | `rooms-store.js` (`recordBoot`, called once at boot by `server.js`) | the last 20 boots: proof the volume persisted across a deploy, read by `/api/health` | — |

## Append-only files (history)

| File | Module | Semantics |
|---|---|---|
| `bounty-ledger.jsonl` | `bounty-ledger.js` via `bounty-store.js` | every money movement as intent: a consecutive sequence and a SHA-256 checksum on every row (unkeyed, and no previous-row hash: it catches damage, not forgery); `appendLedger` is the only writer; balances are folded from it, never stored (`bounty-store.js`, "APPEND-ONLY by contract"). A torn final line is truncated and logged. A gap or a bad checksum inside the file LATCHES the ledger: every read and append throws the same `LedgerCorrupt` until a person repairs it, the process keeps running, and `/api/health` lists every ledger's state (`bounty-ledger.js`, `ledgerHealth`). This build reads checksum v1 and v2 rows and still writes v1. |
| `bounty-evidence.jsonl` | `bounty-evidence.js` | every verification-relevant event (`EVIDENCE_TYPES`): session opened, playback started/ended, code issued, viewer sample, capture frozen, OBS scene sample, overlay env, violation, verification. Same format and latch; a release refuses unless it validates (`release()`, `bounty-escrow.js`). |
| `bounty-clips/` index | `bounty-clips.js` | clip index with seq + checksum; media content-addressed by SHA-256; a purge appends a record rather than erasing (`bounty-clips.js`, "a stored clip is treated as evidence, not cache"). |
| `settlement.jsonl`, `seat-ledger.jsonl`, `escrow-chain.jsonl` | `settlement.js`, `seat-escrow.js`, `escrow-chain.js` | the app's own money: every outbound intent and its SENT / DONE / FAILED rows, seat accruals, sweeps and refunds, escrow deposits, attestations and finalizes. Same primitive. If any of the three latches, both money doors stop sending; intents still record (`corruptMoneyLedger`, `bounty-ledger.js`). |
| `rewards-ledger.jsonl` | `rewards.js` | every cash or credit watch-to-earn row (room, account, payee, amount), so the lifetime cap per room survives a restart |
| `overlay-visibility.jsonl` | `overlay-visibility.js` | what the streamer's OBS said about the overlay, transitions only; indexed in memory on first use. A damaged one reads as "cannot tell", and the server-driven meters charge nobody in that room until it is repaired (`visibilityVerdict`; `shouldCharge`, `seat-escrow.js`) |
| `campaign-ledger.jsonl` | `campaign-store.js` | one row per campaign state change that involves an amount; the settlement door's own ledger says what actually moved |

## Binary artefacts

| Directory | Module | Lifetime |
|---|---|---|
| `bounty-captures/*.ts` | `bounty-capture.js` | one MPEG-TS window per clip playback, named `<airSessionId>__<playbackId>.ts`; swept at `captureRetentionMs` (14 d) on the pledge sweeper, and purged when an expired handle's pool is refunded (`refundExpired`, `bounty-escrow.js`) |
| `bounty-clips/` media | `bounty-clips.js` | fan-recorded clips for the bounty program. Purged when their contribution is refunded (a reservation that expired after `reservationTtlMs`, 90 d, or a policy rejection); a released clip is never purged today (`OPEN-ISSUES.md`, R9). Private until its streamer approves it or it airs: only its pledger, its streamer and the operator can list or play it (`isPublicClip`, `bounty-clips.js`; `bounty-routes.js`) |
| `room-posters/<roomId>.jpg` | `room-poster.js` | one 640-px poster per room from a bounty capture; nothing sweeps it |
| `airing-posters/<airingId>.jpg` + `.json` | `airing-posters.js` | the picture a finished broadcast shows, and what it is (`source`, `at`); removed with its airing or its room |
| `aired-clips/<letterId>.clip` + `.json` | `aired-clips.js` | a MegaChat that completed on a recorded broadcast, kept for that broadcast's replay: the days its fan was told, capped by the owner's setting (`site-settings.js`; 30 by default), 100 MB per room, 400 MB in all; deleted on refund, by the room's owner, or with its broadcast |
| `site-settings.json` | `site-settings.js` | the owner's live settings from `/dev` (big-stream viewers, replay days, quiet broadcasts), the last 50 changes (who, when, from, to), and `adminAccountIds` — the account pinned as the owner |
| `airing-posters/candidates/<airingId>/<t>.jpg` | `airing-posters.js` | Twitch live previews kept while a broadcast is up (owned rooms only, 3,000 at most across all); cleared an hour after the end |

## Memory only (lost on restart)

| State | Module | Why memory |
|---|---|---|
| `activeSeats` | `server.js` | a seat is a live connection; a restart ends it |
| MegaChat clips awaiting or after playback | `letters.js` | one-shot by design; dropped ~60 s after playback (a copy of one that completed on a recorded broadcast goes to `aired-clips/` for its replay — see the files table) |
| earned reward credits per room and wallet | `reward-credits.js` | `new Map()`; isolated from pay-to-join. The points cap per room and wallet is memory too (`rewards.js`, `pointsEarned`); the cash and credit cap is on disk (`rewards-ledger.jsonl`) |
| take ids for a Holler and a bounty pledge (`attemptId`) | `letters.js`, `bounty-routes.js` | a retry of the same take within ten minutes is answered from the first one instead of paying again; a restart inside that window can let one repeat through |
| capture rolling buffers | `bounty-capture.js` | ~28 MB per open air session; only frozen windows reach disk |
| Twitch liveness cache | `server.js`, `twitchLiveCache` | a TTL cache over a public probe |
| follow-loop state (`live`, `offSince`) | `server.js`, `followState` | nothing is hidden on a guess after a restart |
| settlement intents | `bounty-settlement.js`, `StubSettlement.intents` | the stub's record of what *would* be paid |

## Deliberately absent

Things the system does not store, each with the reason the code gives:

- **Viewer identities on seats or airings.** A seat carries a username the viewer typed and, for paid seats, a wallet address; an airing's moments carry that username or null (`addParticipant`, `addMoment` calls in `server.js`). No account linkage is written on the seat or the airing. Two records do name an account beside a viewer's activity, both only for a viewer who signed in: a campaign Call in claim names the claimant's account and the seat it is bound to (`campaign-store.js`, `bySeat`), and a cash or credit watch-to-earn row names the earning account (`rewards.js`, `rewards-ledger.jsonl`).
- **Plaintext passwords.** Room passwords are scrypt hashes; nothing logs or stores the plain form (`room-auth.js`).
- **Platform OAuth tokens, except X's.** The direct Twitch path requests no scopes and reads identity with an app token (`auth.js`, `scope: ''`); Privy holds the social session, not MegaChat (`privy-identity.js`). A Twitch or Kick access token lives only for the length of the callback that fetches a link's attributes and is never written down (`auth.js`, the callback's `grabAttributes`). X's is the exception since 2026-10-23: connecting X through our own OAuth asks for `offline.access`, and the token is stored encrypted and used only to read `connection_status` for campaign checks, never to act on X (`x-token-store.js`; `auth.js`, the X provider's `scope`). Refreshing a link's attributes is still a re-authorisation, not a background job; the one other refresh is a campaign check re-reading an X profile with the app token when its last read is over a day old (`campaign-engine.js`, `check`; `accounts.js`).
- **Any social graph on an account.** A link stores follower and following COUNTS and nothing else: no follower lists, no following lists, no mutuals, no edges of any kind; the attribute shape has no room for a collection of people (`attestation/index.js`, `ATTRIBUTES`). Since 2026-10-23 a targeted campaign does page X lists, but only to freeze a creator's reference set (the ids and handles on it, `reference-sets.json`); a claimant's followers are counted and never stored (`attestation/x-api.js`, `pageUsers`; `docs/internal/campaigns.md`).
- **A verification step.** No attribute is ever collected by asking the person for one. Everything a link carries came back from the platform, inside the OAuth round trip they were already in or in a campaign check's app-token re-read, and a fetch that fails leaves `attributes: null` rather than prompting (`auth.js`, the callback's `grabAttributes`).
- **A stored balance for anything bounty-related.** Pools are folded from the ledger on every read (`bounty-store.js`).
- **Viewer-count thresholds or history.** Viewer samples are evidence, never a payout input; no baseline is polled or kept (`bounty-stream-context.js`, "DELIBERATELY NOT HERE").
- **Recordings of broadcasts.** Capture runs only inside an air session and keeps only the windows around clip playbacks (`bounty-capture.js`).
- **A copy of a platform VOD.** Frames are extracted transiently by ffmpeg and discarded (`frame-sources.js`; `docs/pass-b-handoff.md`).
- **Self-reported LiveKit consumption as the cost record.** The authoritative session record comes from signed webhooks (`livekit-webhooks.js`).
- **A bounty settlement transaction.** The bounty program's settlement is still the stub (`bounty-settlement.js`; Gate H, legacy section). The app's own money — seat ticks, seat and MegaChat refunds, reward and campaign payouts, the MPP channel settle, the seat escrow contract's deposits and finalizes — does move, and only through two doors: `settlement.js`, which signs nothing that is not first a recorded intent in `data/settlement.jsonl`, and `escrow-chain.js`, which records each escrow write as SENT in `data/escrow-chain.jsonl` before it leaves (`_gate-money.mjs`, Tier 1). No balance read from the chain is ever stored; every amount is folded from a ledger.
- **Owner notes or docs state.** Nothing in `docs/` is read by the app.

## Where the shape is defined

The client-side types are the readable contract and are embedded on [Interfaces](interfaces.md) straight from `web/lib/api.ts`. Server-side, the room shape is `resolveRoomConfig()` in `rooms-store.js`, the airing shape is `openAiring()` in `airings-store.js`, and the bounty records are the `EMPTY()` document in `bounty-store.js`.
