# MegaChats — record and send

**Status: `SHIPPED`** — proven through the real UI in a free room by `_gate-free-megachat.mjs` ("free-room MegaChat send, end to end through the REAL UI") and on mainnet dust by `_gate-phase3-letters.mjs`. The moderation path was gated against a mock moderation API (`_gate-p2-moderation.mjs`); producer mode — hold, air, expire, and survive a restart — by `_gate-megachat-producer.mjs`, which spends nothing.

<!-- snippet:pre-launch -->
{% hint style="warning" %}
**Pre-launch.** MegaChat is deployed but in stealth with no users. This money path has been verified against fixtures, local infrastructure and rehearsal broadcasts run by the project's own operator — not production traffic. No real money has moved through it on anyone's behalf. See `docs/internal/launch-readiness.md`.
{% endhint %}
<!-- /snippet -->

## What it does

A viewer records a clip from their camera on the join page, sees the clip total before sending, pays it, and the clip plays once in a tile on the stream when there is room for it. The concept page — [MegaChats](../concepts/megachats.md) — explains lengths, price derivation and the one-shot storage; this page is about the surfaces.

## How it works

- **Recording** happens in the browser; the join page enforces the room's `minSeconds`/`maxSeconds` from `/api/config.letters` (`server.js`, the `letters` block of `/api/config`).
- **Paying** is `POST /api/letter/submit` at the room's flat letter price, then the upload within 90 s (`letters.js`, header). A clip that misses the upload window is refunded (`letters.js`, "reject (or upload expiry) refunds the payer").
- **Moderation**, when the room asks for it, holds the clip in a queue the streamer sees on the dashboard (`web/lib/api.ts`, `listLetters`, `forcePlayLetter`, `approveLetter`, `rejectLetter`; `dashboard-routes.js`). AI screening runs before that when a key is configured (`moderation.js`).
- **Producer mode** (`moderation: 'approve'`) splits that queue into two piles on the dashboard card: *Waiting for review*, and *Ready to air* — approved clips the scheduler deliberately will not touch. A mod presses **Air it** on the one the show wants, which is the same route as *Play now* (`POST /api/dashboard/rooms/:roomId/letters/:id/play`, which accepts both `queued` and `ready`). In `auto` rooms nothing changes: approving queues the clip and the scheduler airs it.
- **Nothing is held indefinitely.** A clip waiting on a person is refunded after `LETTER_HOLD_TTL_MS` (default 6 h) — `review_expired` if nobody reviewed it, `never_aired` if it was approved and never aired (`letters.js`). The dashboard row counts down to that moment.
- **Clips and the queue survive a restart.** Media is written under `DATA_DIR/letters/media/` and its metadata to `letters/meta.json`; `letter-store.js` restores both at boot, and the boot log says how many came back. A clip interrupted mid-playback comes back held rather than replayed, and a row whose media is missing is refunded instead of resurrected (`letters.js`, `restoreFromDisk`).
- **Playback** is scheduled by the server when a tile is free and broadcast to the overlay as `letter_play` (`letters.js`). The dashboard's queue card shows overlay status so a streamer can see whether a MegaChat is about to play into an overlay that is not connected (`176e3a8`, "never play a MegaChat into the void").
- **Airings** get a `megachat` moment when one plays, so the recent-rooms card knows the second worth opening at ([Airings and evidence](../concepts/airings-and-evidence.md)).

## How to use it

- **Viewer:** on the room page choose *Send a MegaChat*, record, review, pay, send. In a free room there is no payment step (`web/lib/join-page.ts`, `isFreeRoom`).
- **Streamer:** MegaChats are on by default (`resolveLetters`, `enabled: l.enabled !== false`). Set a flat price or leave it derived; choose `approve` if you want to see clips before they play; set AI strictness. All on the create/manage room page.
- **Mod, in producer mode:** watch what is in *Waiting for review* and approve or reject it. Approving parks the clip in *Ready to air* — nothing reaches the stream yet. When the show wants one, press **Air it**. Each row shows how long before the payer is refunded automatically.

## Limits, as configured

| Limit | Value | Source |
|---|---|---|
| Clip length | 3–30 s (default max 10 s) | `resolveLetters`, `rooms-store.js` |
| Upload size | 25 MB per clip, 120 MB across all rooms | `LETTER_MAX_BYTES`, `GLOBAL_MAX_BYTES`, `letters.js` |
| Queue | 10 per room | `QUEUE_MAX_PER_ROOM`, `letters.js` |
| Upload deadline after paying | 90 s | `UPLOAD_GRACE_MS`, `letters.js` |
| Media kept after playback | ~60 s | `MEDIA_TTL_MS`, `letters.js` |
| Held waiting on a mod, then refunded | 6 h | `LETTER_HOLD_TTL_MS`, `letters.js` |

## What this does NOT do

- **It does not keep your clip** after it plays, except in the bounty program (`letters.js`; `bounty-clips.js`).
- **It does not moderate without a key.** With no `MODERATION_API_KEY`, AI screening reports unconfigured and only the streamer's approve setting applies (`moderation.js`).
- **It does not promise when a clip plays.** A full room queues it; the scheduler plays it when a tile frees (`letters.js`). In producer mode it makes no promise at all: a `ready` clip plays when a mod airs it, or never, in which case the payer is refunded.
- **It does not let a held clip leak onto the stream.** `ready` is skipped by the scheduler on purpose; `_gate-megachat-producer.mjs` proves the discrimination by running the same clip through an `auto` room, which airs it unaided, and an `approve` room, which does not.
- **It does not refund on rejection unless the room says so** — `autoRefundOnReject` is on by default but is a room setting (`resolveLetters`, `rooms-store.js`).
