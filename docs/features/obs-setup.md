# OBS setup

**Status: `SHIPPED-PARTIAL`.** The manual browser-source path is shipped and is how every rehearsal ran. *Add to OBS* (one-click over obs-websocket) is shipped behind `OBS_ONECLICK=1`, proven against a conformance mock (`_gate-obs-protocol.mjs`, `_gate-obs-ui.mjs`) and by the owner's real-OBS checklist (`docs/obs-oneclick-checklist.md`). The on-air scene check is shipped and feeds verification. **Unproven:** the obs-websocket path against a real OBS *during a real broadcast* — recorded as open in `OPEN-ISSUES.md` ("The obs-websocket path is still untested against real OBS"); `_smoke-obs-overlay.mjs` exists to close it and has not been run against a live stream.

## What it does

Gets the overlay into OBS in a way that keeps the bounty badge legible to the verifier, and tells the streamer when it is not on screen.

## Two ways in

**Manual.** Copy the overlay URL from the manage page and add it as a browser source. The page tells you the size to use. This path has no connection to OBS and no scene check — which is a normal, blameless outcome for verification, not a penalty (`web/lib/obs-scene-check.mjs`, "`NO_CONNECTION` is a normal, blameless outcome").

**Add to OBS.** With `OBS_ONECLICK=1`, the manage page offers *Connect OBS* (obs-websocket v5, port 4455, the password from OBS's WebSocket Server Settings) and *Add to OBS*. The button is "a correctness feature wearing a convenience costume" (`web/lib/obs-oneclick.mjs`, header): it finds or creates a browser source named *MegaChat Overlay* and writes every setting that decides whether the badge survives — canvas-size width and height, position 0,0, scale 1, no bounds, no shutdown or reload on scene switch, its own audio channel, monitor-and-output so the streamer hears the join sound. It verifies the result against OBS's own declared defaults rather than assuming key names (`ae59e2e`, "verification that cannot lie"). Re-clicking is the repair path: a source someone shrank snaps back (`docs/obs-oneclick-checklist.md`, row 12).

## The on-air scene check

While a bounty air session is open, the streamer's browser asks their OBS whether the overlay's scene item is enabled and non-zero-size in the current programme scene, and posts the answer to the server (`web/lib/obs-scene-check.mjs`; `POST /api/bounty/air-session/:id/obs-scene`, `bounty-routes.js`). Its value is against *accident* — the source left in a scene you switched away from, the item unticked and forgotten — and it converts "we found no badge" into "your overlay was hidden from 20:14". It is client-reported, so it is corroboration and never a hard gate ([Verification](../verification/README.md)).

## How to use it

1. Manage page → right column → *OBS*. Choose manual (paste the URL, set the size shown) or Connect OBS then *Add to OBS*.
2. Look at OBS: a full-canvas *MegaChat Overlay* source at 0,0, and its own mixer channel.
3. For a bounty claim, the claim flow repeats the setup and shows a held badge so you can see it on your own preview (`2afe679`, "hold a badge on screen so OBS can be configured with feedback").
4. `node _smoke-obs-overlay.mjs` asks a running OBS whether the overlay is in the programme scene and visible; exit 0 = found, 1 = could not look, 2 = not there.

## What this does NOT do

- **It does not prove the overlay was on the broadcast.** A source can be enabled in a scene that is not on programme, or on programme while the stream encoder is down. The scene check reports what OBS says; the verifier reads the public stream to know what aired (`bounty-confidence.js`, "OBS SCENE CHECK — CLIENT-REPORTED").
- **It does not work over the internet.** obs-websocket is a local connection from the streamer's browser to their own OBS (`187c9e5`, "name the local-network permission prompt before it appears").
- **It has not been proven against a real OBS during a real broadcast** — the checklist and smoke test exist for that and the row is open (`OPEN-ISSUES.md`, `docs/obs-oneclick-checklist.md`).
- **It does not add the overlay to every scene.** One source in the current scene; switching to a scene without it hides the overlay, which is exactly what the scene check exists to notice.
