# Data model

Every store, what it holds, how it is written, and — at the end — the list of what the system deliberately does not keep. Paths are relative to `DATA_DIR` (`process.env.DATA_DIR`, else `./data`), which is the Railway volume in production (`rooms-store.js`, `dataDirInfo`).

## Rewritten documents (current state)

One JSON file each, loaded into a module cache, rewritten whole on mutation. Safe to rewrite because they are current state, not history (`bounty-store.js`, "The mutable records below are still a rewritten document").

| File | Module | Holds | Keyed by |
|---|---|---|---|
| `rooms.json` | `rooms-store.js` | room records: id, name, `active`, `passwordHash` (scrypt), `ownerKey`, `handle`, `config` (prices, seats, `letters`, `joinStream`, `rewards`, `layout`, `poster`, `twitchChannel`, `transport`, …) | room id; handle → id |
| `identities.json` | `identity-store.js` | OAuth/Privy identities and the handles they reserved | `provider:platformId`; handle |
| `guest-whitelist.json` | `guest-whitelist.js` | per-streamer guest lists: handle, `identityKey`, `enabled`, join counts | owner key |
| `airings.json` | `airings-store.js` | per room, the last 20 airings with `moments[]` (`seat`, `seat_leave`, `megachat`), `vodUrl`, `captureRef` | room id → airing id |
| `bounty.json` | `bounty-store.js` | reserved handles, contributions, pledges, claims, air sessions, verifications, reviews, strikes | ids |
| `livekit-webhook-state.json` | `livekit-webhooks.js` | replay-rejection window for signed LiveKit events | event id |
| `livekit-sessions.json` | `livekit-activity.js` | connect/disconnect ledger for lazy connect (append-style records, rewritten file) | — |
| `boot-marker.json` | `server.js` | proof the volume persisted across a deploy, read by `/api/health` | — |

## Append-only files (history)

| File | Module | Semantics |
|---|---|---|
| `bounty-ledger.jsonl` | `bounty-ledger.js` via `bounty-store.js` | every money movement as intent: sequence + checksum chain; `appendLedger` is the only writer; balances are folded from it, never stored (`bounty-store.js`, "APPEND-ONLY by contract"). A torn final line recovers; a gap or interior corruption refuses to load (`LedgerCorrupt`). |
| `bounty-evidence.jsonl` | `bounty-evidence.js` | every verification-relevant event (`EVIDENCE_TYPES`): session opened, playback started/ended, code issued, viewer sample, capture frozen, OBS scene sample, overlay env, violation, verification. Same chain; a release refuses unless it validates (`release()`, `bounty-escrow.js`). |
| `bounty-clips/` index | `bounty-clips.js` | clip index with seq + checksum; media content-addressed by SHA-256; a purge appends a record rather than erasing (`bounty-clips.js`, "a stored clip is treated as evidence, not cache"). |

## Binary artefacts

| Directory | Module | Lifetime |
|---|---|---|
| `bounty-captures/*.ts` | `bounty-capture.js` | one MPEG-TS window per clip playback, named `<airSessionId>__<playbackId>.ts`; swept at `captureRetentionMs` (14 d) and purged with the pledge |
| `bounty-clips/` media | `bounty-clips.js` | fan-recorded clips for the bounty program, until claimed and played or the reservation expires (`reservationTtlMs`, 90 d) |
| `room-posters/<roomId>.jpg` | `room-poster.js` | one 640-px poster per room; nothing sweeps it |

## Memory only (lost on restart)

| State | Module | Why memory |
|---|---|---|
| `activeSeats` | `server.js` | a seat is a live connection; a restart ends it |
| MegaChat clips awaiting or after playback | `letters.js` | one-shot by design; dropped ~60 s after playback |
| earned reward credits per room and wallet | `reward-credits.js` | `new Map()`; isolated from pay-to-join |
| capture rolling buffers | `bounty-capture.js` | ~28 MB per open air session; only frozen windows reach disk |
| Twitch liveness cache | `server.js`, `twitchLiveCache` | a TTL cache over a public probe |
| follow-loop state (`live`, `offSince`) | `server.js`, `followState` | nothing is hidden on a guess after a restart |
| settlement intents | `bounty-settlement.js`, `StubSettlement.intents` | the stub's record of what *would* be paid |

## Deliberately absent

Things the system does not store, each with the reason the code gives:

- **Viewer identities on seats or airings.** A seat carries a username the viewer typed and, for paid seats, a wallet address; an airing's moments carry that username or null (`addParticipant`, `addMoment` calls in `server.js`). No account linkage is written for a viewer who sits.
- **Plaintext passwords.** Room passwords are scrypt hashes; nothing logs or stores the plain form (`room-auth.js`).
- **Platform OAuth tokens or scopes beyond identity.** The direct Twitch path requests no scopes and reads identity with an app token (`auth.js`, `scope: ''`); Privy holds the social session, not MegaChat (`privy-identity.js`).
- **A stored balance for anything bounty-related.** Pools are folded from the ledger on every read (`bounty-store.js`).
- **Viewer-count thresholds or history.** Viewer samples are evidence, never a payout input; no baseline is polled or kept (`bounty-stream-context.js`, "DELIBERATELY NOT HERE").
- **Recordings of broadcasts.** Capture runs only inside an air session and keeps only the windows around clip playbacks (`bounty-capture.js`).
- **A copy of a platform VOD.** Frames are extracted transiently by ffmpeg and discarded (`frame-sources.js`; `docs/pass-b-handoff.md`).
- **Self-reported LiveKit consumption as the cost record.** The authoritative session record comes from signed webhooks (`livekit-webhooks.js`).
- **A bounty settlement transaction.** The bounty program's settlement is still the stub (`bounty-settlement.js`; Gate H, legacy section). The app's own money — seat ticks, seat and MegaChat refunds, reward payouts, the MPP channel settle — does move, and only through `settlement.js`, which signs nothing that is not first a recorded intent in `data/settlement.jsonl` (`_gate-money.mjs`, Tier 1). No balance read from the chain is ever stored; every amount is folded from a ledger.
- **Owner notes or docs state.** Nothing in `docs/` is read by the app.

## Where the shape is defined

The client-side types are the readable contract and are embedded on [Interfaces](interfaces.md) straight from `web/lib/api.ts`. Server-side, the room shape is `resolveRoomConfig()` in `rooms-store.js`, the airing shape is `openAiring()` in `airings-store.js`, and the bounty records are the `EMPTY()` document in `bounty-store.js`.
