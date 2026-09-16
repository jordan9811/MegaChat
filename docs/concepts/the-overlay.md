# The overlay

**The overlay** is one web page — `public/overlay.html` — that a streamer adds to OBS as a browser source. It is transparent except for what is live: seat tiles, playing MegaChats, and the bounty verification badge. Everything a viewer buys ends up drawn here, so the overlay is where MegaChat meets the broadcast.

## What it draws

- **Seat tiles**, one fixed-size tile per live participant, absolutely positioned on a column anchored to a corner of the canvas (`public/overlay.html`, the `#stage` block; positions come from `slotOffset()` and the room's `layout`).
- **MegaChat tiles**, the same tile treatment with a `<video>` playing the clip (`letters.js`, `letter_play`).
- **Stingers** — the CSS entrance/exit transitions, each ≤ 1.5 s, and their synthesised sounds (`public/overlay.html`, the `STINGERS` section; room toggle `stingerSounds`).
- **The pinned co-host badge** for a pinned seat (`public/overlay.html`, "Pinned co-host badge").
- **The verification badge** during a bounty air session: a rotating code drawn as 5×7 dot-matrix glyphs inside a white ring, rendered from `public/code-matrix.cjs`, the same table the reader uses (`docs/run-b-verification.md`, "The loop, end to end").

## Where tiles go: layout on the room record

Tile position, size, gap, stacking direction and margin are room config, not overlay constants: `resolveLayout()` in `rooms-store.js`, edited from the create-room page's layout editor (`web/components/create-room/layout-editor.tsx`). The defaults are the grid the overlay always had — top-right, 320×180, 12 px gap, stacking down — so an unedited room renders identically (`rooms-store.js`, "THE DEFAULTS ARE THE CURRENT HARDCODED GRID, to the pixel"). The record carries an integer `version`; the overlay applies a layout only when the version it holds is older (`applyLayout()` in `public/overlay.html`), so a mid-stream edit re-places tiles without reassigning seats.

The smallest tile the editor permits is 90 px high (`resolveLayout` clamps there). That floor comes from the verifier: the bounty badge has to stay legible in a captured frame, and `server.js` derives the ten-tile ceiling from it (the comment above `MAX_EFFECTIVE_SEATS`).

## How it connects, and why it mostly does not

The overlay talks to the server over a WebSocket for seat and MegaChat events, and to the media server (LiveKit) for video. **It holds a LiveKit connection only while a seat is being bought or held** — this is *lazy connect*, and it exists because an always-connected overlay once burned ~43,200 participant-minutes a month per streamer against a 5,000-minute tier, with zero guests (`livekit-lazy.config.js`, the header). The overlay connects on the first "Join" click (`prewarmTrigger`), stays up through a grace window after the last seat empties (`graceMs`, 60 s), and hangs up. `LAZY_CONNECT=0` restores the old behaviour exactly.

A separate breaker refuses *new* LiveKit connections when webhook-measured consumption crosses a budget, and never cuts an existing session mid-broadcast (`livekit-breaker.js`, "Blocking refuses NEW connections only").

## Adding it to OBS

Either paste the overlay URL into a browser source by hand, or use **Add to OBS**, which writes every browser-source setting that matters for the badge to stay legible — full canvas size, position 0,0, scale 1, no bounds, no reload on scene switch, own audio channel (`web/lib/obs-oneclick.mjs`, the settings table in the header). The [OBS setup](../features/obs-setup.md) page covers both paths and what each does not check.

## What this does NOT do

- It does not know whether it is on screen. A browser source can be loaded and still be in a scene OBS is not showing; the overlay itself cannot tell (`web/lib/obs-scene-check.mjs`, "was the overlay actually on screen?"). The scene check exists to ask OBS that question separately, and it is corroboration, not proof — see [Verification](../verification/README.md).
- It does not scale the badge to survive being shrunk. A source scaled down in the scene shrinks the badge below the reader's floor, and an honest streamer would go unpaid — which is the whole reason Add to OBS pins scale to 1 (`web/lib/obs-oneclick.mjs`).
- It does not record anything. Capture for verification reads the *public stream*, not the overlay page (`bounty-capture.js`, "resolves the channel page, not the overlay" in `bounty-confidence.js`).
