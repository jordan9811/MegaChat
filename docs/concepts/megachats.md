# MegaChats

A **MegaChat** is a short clip a viewer records from their own camera and pays a flat price to have played on the stream once. The code calls them *letters*: the module is `letters.js`, the config block is `letters`, and the wire messages are `letter_play` / `letter_end`. Same thing.

## The mechanic

From the protocol comment at the top of `letters.js`:

1. The viewer pays — one flat charge at the room's letter price, on the same payment machinery a live seat uses (`POST /api/letter/submit`).
2. The viewer uploads the recording within a grace window (`PUT /api/letter/upload/:id`, ≤ 25 MB, 90 s after payment — `LETTER_MAX_BYTES`, `UPLOAD_GRACE_MS`).
3. The clip reaches its resting state — straight into the play queue, or held for a person, depending on the room's moderation setting (below).
4. When the room has a free tile, the scheduler broadcasts `letter_play`; the overlay draws the clip in a tile with the same entrance and exit treatment a live seat gets; `letter_end` follows and the media is dropped shortly after.

Clips are **one-shot by design**: each plays once and its media is released about a minute after playback (`MEDIA_TTL_MS`, `letters.js`). They are not, however, ephemeral against a restart. A paid clip is written to `DATA_DIR/letters/media/<id>` with its row in `letters/meta.json`, and `letter-store.js` reads both back at boot (`createLetterStore`), because a deploy landing between "a fan paid" and "it played" used to destroy a paid clip with no record that it had existed. The exception that keeps clips *permanently* is still the bounty program, where the clip *is* the promise — see [Bounties](bounties.md) and `bounty-clips.js`.

## Length and price

Both come from `resolveLetters()` in `rooms-store.js`:

- **Length** is 3–30 seconds by default (`minSeconds` … `maxSeconds`, default max 10 s, hard cap 30 s). The floor is not an aesthetic choice: it is derived from the bounty verifier's sampling floor (`bountyConfig.minClipSeconds`), because a clip shorter than that cannot carry a verification code long enough to be read back off a re-encoded broadcast. The comment above `minSeconds` explains why the two numbers are one number.
- **Price** is either a flat figure the streamer set, or — when unset — the live per-second rate multiplied by the maximum clip length (`letterPriceFor()`, `rooms-store.js`).

## Moderation

Two independent controls, both on the room's `letters` config (`resolveLetters`, `rooms-store.js`):

- `moderation: 'auto'` (default) — no person is in the loop. A clip goes to the play queue on arrival and the scheduler airs it at the next free tile.
- `moderation: 'approve'` — **producer mode**. Clips wait in a queue the streamer (or a moderator with the room password) approves or rejects from the dashboard. Approving does **not** put a clip on screen: it moves to `ready`, which the scheduler never drains, and a mod airs it explicitly when the show wants it — the pattern a broadcast desk uses to read out posts between plays. A rejection refunds the payer (`autoRefundOnReject`, default on).

  Nothing may sit held forever, because the payer's money is held with it. Any clip waiting on a person — `pending_approval` or `ready` — is refunded automatically once `LETTER_HOLD_TTL_MS` elapses (default 6 h), with the reason recorded as `review_expired` or `never_aired` so the two cases stay distinguishable (`letters.js`).
- **AI moderation** — when the server has `MODERATION_API_KEY`, every clip is transcribed and scored before it plays (`moderation.js`). `aiStrictness` decides whether only high-confidence violations are flagged (`severe`, default) or anything the model marks (`borderline`). The pipeline fails *open* on error and never fakes a verdict when the key is absent (`moderation.js`, "Fail-open on any error or timeout, and a verdict is NEVER faked when the API key is absent").

## Stingers

The entrance and exit animation on the broadcast — the viewer picks it on the join page. Pure CSS, each ≤ 1.5 s (`public/overlay.html`, the `STINGERS` block); the sets the join page offers are `FLY_IN_OK` / `FLY_OUT_OK` in `letters.js`. Sounds are synthesised in the overlay and switched per room by `stingerSounds` (`rooms-store.js`).

## What this does NOT do

- It does not keep your clip beyond the broadcast's replay. Outside the bounty program the queued media lives from upload to about a minute after it plays, then it is deleted (`letters.js`, `MEDIA_TTL_MS`); it survives a server restart in the meantime, which is durability against a deploy, not storage. Since 2026-09-25 a clip that COMPLETED on a recorded broadcast of a room whose owner proved the channel is copied for that broadcast's replay, for up to 30 days, so the replay can still show it when the platform's recording is gone; a refund deletes the copy, and the room's owner can remove one (`aired-clips.js`; the send screen says so).
- It does not air a held clip by itself. In producer mode an approved clip sits in `ready` until a mod airs it; the scheduler will not pick it up (`letters.js`).
- It does not guarantee playback time. A clip plays when the scheduler finds a free tile; a busy room queues it (`QUEUE_MAX_PER_ROOM`, `letters.js`).
- It does not moderate without a key. With no `MODERATION_API_KEY` the AI step reports itself unconfigured and the streamer's own approve/reject setting is the only filter (`moderation.js`).
