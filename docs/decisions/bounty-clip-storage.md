# Bounty clip storage

**Date:** 2026-07-27
**Status:** implemented (smallest correct version)
**Module:** `bounty-clips.js`

## The finding that forced this

The bounty mechanic had no content layer at all. Not "clips that don't
persist" — no clips.

Three separate confirmations:

1. **`letterRef` was write-only.** `BountyContribution.letterRef` is set by
   `addContribution` and read by nothing. Its only appearances outside its own
   write path are two test fixtures (`_gate-bounty-claim.mjs`, `_shot-bounty.mjs`).
   Nothing ever dereferenced it to an artifact.
2. **No ingestion existed.** `POST /api/bounty/contribute` accepted
   `{platform, handle, contributor, amount, letterRef}` — an amount and an
   opaque string. None of the 18 bounty routes touched media.
3. **Even in-room clips are ephemeral.** `letters.js` holds clips in an
   in-memory `Map`, drops the buffer 60s after playback (`MEDIA_TTL_MS`),
   deletes the record in `removeLetter()`, caps all rooms at 120MB combined,
   and imports `fs` nowhere. Nothing survives a restart.

And structurally: a MegaChat is recorded **into a room**. A streamer who is not
on the platform has no room, so there was not even a container for the
recording the product promises to keep for them.

Net: escrow, watermark, verifier and payout were all real and all accounting
for something that did not exist. A streamer completing the entire flow — claim
handle, install overlay, go live — would have had nothing to play.

## Options considered

| Option | Cost | Why not / why |
|---|---|---|
| **Local fs on the Railway volume** | ~2GB default headroom; capacity is the binding limit | **Chosen.** Smallest thing that is actually durable, needs no credentials that do not exist, reuses append-only primitives already proven here. |
| Object storage (R2 / S3) | Right answer at scale; effectively unlimited | Requires API credentials nobody can create unattended. Also premature: the interface below makes it a three-function swap later. |
| Keep clips in the room, extend TTL | No new storage | Does not work at all. An unclaimed streamer has no room, and memory does not survive restarts regardless of TTL. |
| Re-record at claim time | Zero storage | Breaks the product promise. The pitch is that fans record *now* for someone who is not here *yet*. |
| Store only metadata, ask fans to re-upload on claim | Cheap | Asks a fan to still be around 90 days later. Most will not be. |

## What was built

Append-only index (`index.jsonl`, seq + checksum chain, same primitives as the
escrow and evidence logs) plus content-addressed media files. Clip records are
treated as **evidence, not cache** — a fan's money and a fan's recording are the
same promise, so the question "a fan paid for this, where did it go?" must stay
answerable after the bytes are legitimately gone.

Design decisions worth stating:

- **Bytes are written before the index claims they exist.** The reverse order
  can assert a clip we do not have; this order can at worst orphan a file,
  which the sweeper cleans, and never overstates what we hold.
- **Every limit rejects rather than truncates.** The fan is charged either way,
  so a partial clip is strictly worse than a refused one.
- **A purge appends, never erases.** Media is deleted; the record survives with
  a reason.
- **Missing media is reported, never auto-purged.** Orphaned *files* are swept
  because nothing owns them. A record whose media has vanished is data loss, and
  someone has to know rather than have it tidied away.
- **Corrupt bytes are refused, not served.** A streamer playing a damaged clip
  would fail watermark verification and blame the wrong thing entirely.
- **Refund reclaims the recording.** Money and clip go back together, via
  `purgeForContribution` inside `escrow.refund()`. Cleanup failure never blocks
  a refund — the money is the part that matters.
- **The min-duration floor applies here too**, derived from the same
  `bountyConfig.minClipSeconds` as room recordings.

## Capacity, honestly

At the 25MB per-clip ceiling, the 2GB default is only ~80 clips. At realistic
5–8MB webm sizes it is several hundred. Per-handle cap (200) stops one popular
streamer consuming the volume.

That is fine for early onboarding and **not** fine at scale. `pctUsed` is on
`/api/bounty/admin/clip-storage`; it should be wired into the alarm push path
(T3) before this is ever switched on for real.

## Scaling path

Replace `writeMedia` / `readMedia` / `deleteMedia` with an object-store client.
That is the entire change: the index holds no bytes, only ids, sizes and
hashes. Keep the index on local disk — its durability guarantees are the point,
and an eventually-consistent index would undermine them.

## Still open

- **Nothing calls `storeClip` from the UI yet.** The routes exist and are
  gated; the contribute surface still has to be wired to actually record and
  upload. Filed rather than half-built, because the recording UI is a product
  surface and this run was not the place to invent one.
- **A contribution with no uploaded clip** is refundable via
  `CLIP_NEVER_UPLOADED`, but nothing sweeps for them automatically yet.
- Retention beyond the reservation TTL, and what happens to clips when a
  streamer claims but never goes live, are unresolved policy questions.
