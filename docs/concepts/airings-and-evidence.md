# Airings and evidence

What the system remembers about a broadcast after it ends. There are **two records of the same broadcast**, kept by different subsystems for different reasons, and nothing joins them (`docs/pass-b-handoff.md`, "the seam between the two systems"). Knowing which is which explains most of what the recent-rooms board can and cannot show.

## Airings — keyed to rooms

An **airing** is one record per broadcast a room went through, with the *moments* inside it worth showing someone: the second a MegaChat played, the second a guest took a seat, and — as of `e0fda49` — the second a guest left (`airings-store.js`, header; `addMoment` calls in `server.js`). Moments store an absolute time plus the offset from the airing's start, so a replay attached later is still seekable without rewriting anything (`airings-store.js`, "WHAT A MOMENT IS FOR").

Airings are opened and closed by the follow-my-stream loop when the owner's broadcast is seen to start and stop (`followTick`, `server.js`; `openAiring`/`closeAiring`). A room whose owner never streams to a followed channel never gets one. The store keeps the last 20 per room and at most 200 moments per airing (`KEEP_PER_ROOM`, `MAX_MOMENTS`, `airings-store.js`), and it never fetches anything — resolving a replay or capturing video belong to other layers ("It never fetches").

## Evidence — keyed to bounty air sessions

An **air session** is a bounty-program object: the span during which a claimant's overlay is issuing verification codes (`bounty-store.js`, `createAirSession`). Everything a payout is computed from is written to an **append-only evidence chain** — codes issued, playbacks started and ended, viewer-count samples, capture freezes, OBS scene samples, overlay environment reports (`bounty-evidence.js`, `EVIDENCE_TYPES`). A release refuses to run unless that chain validates and the session's cached windows match it (`release()`, `bounty-escrow.js`, "EVIDENCE GATE").

Alongside the chain, **self-capture** holds a rolling window of the public stream while an air session is open and freezes the part covering each clip when it ends, into `data/bounty-captures/` as MPEG-TS (`bounty-capture.js`, header). Those files exist to settle a payout or a dispute, so they are purged with their pledge and swept at 14 days regardless (`captureRetentionMs`, `bounty-claim.config.js`; `purgeCaptures`, `purgeExpiredCaptures`, `bounty-capture.js`).

## The seam

A room with both has two records of one broadcast: an airing keyed to the room, and evidence plus captures keyed to the air session. `attachRecording()` on an airing is the only bridge, and today it is called once — at air-session close, to note that a poster frame was extracted from the capture (`bounty-routes.js`, the air-session `end` handler; `docs/pass-b-handoff.md`, "attachRecording() has its caller"). Nothing resolves a platform VOD onto an airing; `vodUrl` is null on every airing written so far (`docs/pass-b-handoff.md`, "Explicitly not built").

## What is kept, in one table

| Record | Where | Keyed to | Lifetime | Written by |
|---|---|---|---|---|
| Airing + moments | `data/airings.json` | room | last 20 per room | follow loop, seat lifecycle, MegaChat playback |
| Poster frame | `data/room-posters/<roomId>.jpg` | room | not swept | air-session close (`room-poster.js`) |
| Evidence chain | `data/bounty-evidence.jsonl` | air session | append-only | every verification-relevant event |
| Capture windows | `data/bounty-captures/*.ts` | air session | 14 days, or the pledge's life | clip end + freeze delay |
| Escrow ledger | `data/bounty-ledger.jsonl` | pool | append-only | every money movement (intent) |

## What this does NOT do

- It does not record broadcasts. A capture is a verification artefact of the minutes a claimant is claiming for, and it runs only while an air session is open, enforced in code rather than promised in copy (`bounty-capture.js`, "CAPTURE RUNS ONLY WHILE AN AIR SESSION IS OPEN").
- It does not store viewer identities on an airing. Moment labels are the usernames guests chose, or null (`addMoment` calls in `server.js`).
- It does not rewrite history. A closed airing is history; the evidence and ledger files append (`airings-store.js`, "history that rewrites itself is not evidence"; `bounty-ledger.js`).
