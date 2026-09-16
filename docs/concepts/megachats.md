# MegaChats

A **MegaChat** is a short clip a viewer records from their own camera and pays a flat price to have played on the stream once. The code calls them *letters*: the module is `letters.js`, the config block is `letters`, and the wire messages are `letter_play` / `letter_end`. Same thing.

## The mechanic

From the protocol comment at the top of `letters.js`:

1. The viewer pays — one flat charge at the room's letter price, on the same payment machinery a live seat uses (`POST /api/letter/submit`).
2. The viewer uploads the recording within a grace window (`PUT /api/letter/upload/:id`, ≤ 25 MB, 90 s after payment — `LETTER_MAX_BYTES`, `UPLOAD_GRACE_MS`).
3. When the room has a free tile, the scheduler broadcasts `letter_play`; the overlay draws the clip in a tile with the same entrance and exit treatment a live seat gets; `letter_end` follows and the media is dropped shortly after.

Clips are **one-shot by design**: they live in memory, never on disk, and the buffer is released about a minute after playback (`MEDIA_TTL_MS`, `letters.js`). The exception is the bounty program, which keeps fan clips durably because there the clip *is* the promise — see [Bounties](bounties.md) and `bounty-clips.js`.

## Length and price

Both come from `resolveLetters()` in `rooms-store.js`:

- **Length** is 3–30 seconds by default (`minSeconds` … `maxSeconds`, default max 10 s, hard cap 30 s). The floor is not an aesthetic choice: it is derived from the bounty verifier's sampling floor (`bountyConfig.minClipSeconds`), because a clip shorter than that cannot carry a verification code long enough to be read back off a re-encoded broadcast. The comment above `minSeconds` explains why the two numbers are one number.
- **Price** is either a flat figure the streamer set, or — when unset — the live per-second rate multiplied by the maximum clip length (`letterPriceFor()`, `rooms-store.js`).

## Moderation

Two independent controls, both on the room's `letters` config (`resolveLetters`, `rooms-store.js`):

- `moderation: 'approve'` — clips wait in a queue the streamer (or a moderator with the room password) approves or rejects from the dashboard. A rejection refunds the payer (`autoRefundOnReject`, default on).
- **AI moderation** — when the server has `MODERATION_API_KEY`, every clip is transcribed and scored before it plays (`moderation.js`). `aiStrictness` decides whether only high-confidence violations are flagged (`severe`, default) or anything the model marks (`borderline`). The pipeline fails *open* on error and never fakes a verdict when the key is absent (`moderation.js`, "Fail-open on any error or timeout, and a verdict is NEVER faked when the API key is absent").

## Stingers

The entrance and exit animation on the broadcast — the viewer picks it on the join page. Pure CSS, each ≤ 1.5 s (`public/overlay.html`, the `STINGERS` block); the sets the join page offers are `FLY_IN_OK` / `FLY_OUT_OK` in `letters.js`. Sounds are synthesised in the overlay and switched per room by `stingerSounds` (`rooms-store.js`).

## What this does NOT do

- It does not store your clip. Outside the bounty program, a MegaChat exists in server memory from upload to about a minute after it plays, then it is gone (`letters.js`, `MEDIA_TTL_MS`).
- It does not guarantee playback time. A clip plays when the scheduler finds a free tile; a busy room queues it (`QUEUE_MAX_PER_ROOM`, `letters.js`).
- It does not moderate without a key. With no `MODERATION_API_KEY` the AI step reports itself unconfigured and the streamer's own approve/reject setting is the only filter (`moderation.js`).
