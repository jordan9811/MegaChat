# Pass B handoff — self-capture frames

Written at the end of Pass A. Everything below is read from the code as it
stands on `v0-ui-migration`, not from memory.

## Where the frames land

They are not frames. **`data/bounty-captures/` holds MPEG-TS segments**, not
stills — `bounty-capture.js:45` (`CAPTURE_DIR = path.join(DATA_DIR,
'bounty-captures')`). `DATA_DIR` is the Railway volume in production.

One file per **clip playback**, named by construction at
`bounty-capture.js:390`:

    <airSessionId>__<playbackId || clipId || 'window'>.ts

Each file is the rolling window frozen around one playback — currently 75s of
media (`captureWindowMs`), frozen 51s after the clip ends
(`captureFreezeDelayMs`). Both were re-derived in Pass A; the derivation is in
the comment above `captureFreezeDelayMs` and the short version is
`window >= L + D_max - D_min`.

Stills are produced on demand by **`frame-sources.js`**, which shells out to
`ffmpeg` with a pre-input seek (`frame-sources.js:141`) and writes a `.png` to
a work dir. They are not retained. `grabFrame` refuses to return a path ffmpeg
never wrote (`:155`) — ffmpeg can exit 0, print nothing, and produce no file
when the seek lands past the end of media, and treating that as success was a
real bug.

## Retention

**14 days**, `captureRetentionMs` (`bounty-claim.config.js:310`), overridable
with `BOUNTY_CAPTURE_RETENTION_MS`.

Two purge paths, and the distinction matters:

- `purgeCaptures(airSessionId)` — deletes one session's captures, called when
  its pledge is refunded or purged. Evidence outlives neither the payout nor
  the dispute it exists to settle.
- `purgeExpiredCaptures()` — sweeps anything older than the TTL by file mtime
  (`bounty-capture.js:597-605`), regardless of session state.

`claimTtlMs` is also 14 days, deliberately: a capture should not expire before
the claim it is evidence for.

## Looking up what a session holds

Two functions, and **the second is the one you want**:

    capturesFor(airSessionId)          // bare paths — enough to purge
    captureRecordsFor(airSessionId)    // paths WITH the playback each covers

Use `captureRecordsFor`. The comment above it (`bounty-capture.js:525`) records
why in the form of a real failure: one capture covers ONE playback's window, so
a verifier handed only the first file reads nothing about any other clip. A
multi-clip session could never calibrate its timeline — every probe after the
first seeked outside the only file it had — so self-capture returned
`SOURCE_UNAVAILABLE` on the path that is supposed to be primary.

`frozenAt` comes from the evidence chain, falling back to file mtime for
captures written before that record existed.

## Rooms that never had an air session

**Nothing in `bounty-captures/` — and that is not a gap in capture, it is the
boundary of the bounty program.** An air session is a bounty-program object; a
room whose owner never claimed a bounty handle never opens one, so nothing is
ever captured for it.

What such a room *does* have, as of Pass A, is an **airings record**:

    data/airings.json  —  airings-store.js

One record per broadcast, opened and closed off the follow-my-stream loop's
edges, carrying `moments` — the second a MegaChat played or a guest took a
seat, stored as absolute time with the offset derived. `attachRecording()`
exists and is tested but **has no caller yet**: nothing resolves a VOD or a
capture onto an airing, so `vodUrl` and `captureRef` are null on every record
written so far.

That is the seam between the two systems. Bounty captures are keyed to air
sessions; airings are keyed to rooms. A room with both has two records of the
same broadcast and nothing joins them.

## Pass B, Run 1 — SHIPPED

Posters exist now. `room-poster.js` extracts one JPEG per room at air-session
close and writes it to **`data/room-posters/`** — deliberately not
`bounty-captures/`, which is swept at 14 days and emptied per session on a
pledge refund. `_gate-room-poster.mjs` holds that: it ages a capture to 30 days,
runs `purgeExpiredCaptures`, and asserts the poster survives.

**The frame is the midpoint of the longest clip playback.** The brief preferred
peak seat count. When Run 1 shipped it was not derivable: `moments` recorded
joins and not leaves, so the running count was monotonic and "peak" degenerated
to "the last person who joined". `removeParticipant` in `server.js` now records
a `seat_leave` moment for every seat that went live, so peak IS derivable from
any airing written after that landed. The rule was not switched: nothing has
measured whether the two rules pick different seconds on a real capture, and
until they are shown to disagree the midpoint stands. Leaves are bookkeeping —
`/api/rooms/recent` filters them off the wire and `buildCard` does not count
them (`_gate-room-poster` D6), so the rail's "N moments" means what it did.

**`attachRecording()` has its caller.** Air-session close, after
`awaitPendingFreezes`: a freeze is scheduled ~51s after its clip ends, so at
clip end the media is still being written. Close is the first moment every
capture exists and the last before anything can be purged.

**Rooms with no capture get a card, not a fake frame.** Capture only runs during
a bounty air session, so a plain MegaChat or live-seat room has no picture and
never will. `buildCard` freezes a snapshot (title, up to four guest labels,
duration) onto the room record at close, and the rail draws it flat and
typographic with a `NO RECORDING` tag. `poster.kind` is the contract; the rail
never infers which to draw.

What the next pass inherits: `poster` is on the room record, the rail reads that
one field, and `vodUrl` is still null on every airing — nothing resolves a VOD.
The VOD path would only ever be a second source for a poster we can already get
from capture, which is why it stayed unbuilt.

## Explicitly not built

**No VOD resolution.** `attachRecording()` now has a caller for captures;
nothing resolves a platform VOD onto an airing, so `vodUrl` remains null.

**No thumbnails beyond the one poster per room.** Nothing generates, stores or serves a still as a persistent
artifact. `frame-sources.js` makes them transiently for the verifier and
discards them. If Pass B wants a thumbnail on a card, that is new work — and
the natural place to hang it is an airing's `moments[].offsetMs`, which is
already the "interesting second" of a broadcast and already computed.
