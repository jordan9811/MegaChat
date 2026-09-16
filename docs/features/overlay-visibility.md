# Overlay visibility

**Status: `SHIPPED`** — Pass C Part 2, gated by `_gate-overlay-visibility.mjs` (32 assertions: the state machine against the shared obs-websocket mock in six scene states, the occlusion and scale arithmetic, the store's transition contract, authorization and the server-side floor over real HTTP). **Unproven:** the direction real OBS orders `sceneItemIndex` — see *What this does NOT do*.

## What it does

While a room is live, the streamer's browser asks their own OBS whether the overlay is actually on screen, and the dashboard says so within one poll if it is not. It catches the ordinary way a broadcast goes wrong: a scene switched and forgotten, a source unticked, an item dragged off canvas, a full-screen "BRB" card dropped on top, or the overlay scaled down until the verification badge can no longer be read.

{% hint style="info" %}
**Accident detection, not anti-cheat.** It runs in the streamer's browser against the streamer's own OBS, so anyone determined can post whatever they like. Broadcast capture remains the payout authority and nothing here gates a payout on its own (`_gate-overlay-visibility.mjs`, section E asserts no transfer-shaped call and no import from the escrow or meter layer). Its value is against accident, which is by far the most common failure — and it turns "no badge found" from a mystery into a diagnosis.
{% endhint %}

## The signals

Four, recorded as **transitions** rather than per poll (`overlay-visibility.js`, `recordSignal`):

| Signal | Meaning |
|---|---|
| `overlay_visible` | on screen, full size, nothing over it |
| `overlay_hidden` | not reaching the broadcast, with a reason: `scene`, `disabled`, `offcanvas`, `covered` |
| `overlay_scaled_below_floor` | on screen, but the badge renders under the verifier's pixel floor |
| `obs_disconnected` | we could not look — blameless, and it *closes* a dark window rather than opening one |

`overlay_scaled_below_floor` is deliberately separate from `overlay_hidden` because it means something different: the overlay *is* on screen, the streamer has done nothing wrong, and a clip that plays now may still not be provable (`web/lib/obs-visibility.mjs`, header).

## How it works

1. The managing page polls every 5 s while the room is live and an obs-websocket password is stored (`web/components/obs/use-overlay-visibility.ts`, `VISIBILITY_POLL_MS`). The interval is the worst-case blindness the dashboard can have, and each tick opens and closes one loopback connection — the same cadence the air-session watch has used since it shipped.
2. Each poll reads the program scene, the overlay's item, its enabled state and transform, and the full scene item list (`web/lib/obs-visibility.mjs`, `checkOverlayVisibility`).
3. **Occlusion**: items above the overlay in z-order with a box over it. Coverage must exceed 60% (`COVER_FRACTION`) before it counts, so a chat box in a corner is not a bury.
4. **Scale**: the effective rendered scale, taken from the rendered height over the source height rather than the reported `scaleY`, because a bounds mode leaves `scaleY` describing something else (`effectiveScale`).
5. The browser posts the measurement to `POST /api/rooms/:roomId/overlay-visibility`, authorized as the room's owner or with the room password (`visibility-routes.js`).
6. **The server decides the floor.** The client posts what it measured; the route derives whether the badge falls under `minCodePixelHeight` (`bounty-claim.config.js`) — that number is what a payout turns on, and the client is deliberately never told it. A client claiming "visible" at quarter scale still gets the floor applied (gate D4, D5).
7. Transitions append to `data/overlay-visibility.jsonl` with the ledger's sequence and checksum chain, and `hiddenWindows()` exposes each dark span with a start and an end.

## Every bias runs away from accusing anyone

- Our own rect keeps `effectiveRect`'s deliberate over-estimate (`web/lib/obs-scene-check.mjs`), because a false "not visible" accuses an honest streamer.
- An **occluder's** rect is under-estimated (`occluderRect`) — the opposite bias, on purpose, because over-estimating an occluder over-reports coverage.
- If z-order cannot be established the answer is `unknown`, never `covered`.
- `obs_disconnected` is not written to the room's chain on a loop; it is shown locally so the streamer knows the check is blind (`web/components/obs/use-overlay-visibility.ts`).

## How to use it

Connect OBS once through *Add to OBS* ([OBS setup](obs-setup.md)); the password is stored in your browser and is not posted anywhere (`web/components/obs/obs-oneclick.tsx`, `LS_PASSWORD`). Keep the manage page open while you stream. If the overlay goes dark the card tells you which of the four causes it is, in your terms rather than OBS's.

## What this does NOT do

- **It does not prove anything.** Client-reported, from the streamer's own machine. `bounty-confidence.js` already fixes what a corroborating signal is worth: it can raise a tier, it is never the only thing holding a verification up, and tiers 2 and 3 pay identically.
- **It does not gate a payout.** Part 2 produces signals; consuming them is Pass C Part 3, which has not run.
- **It does not catch a semi-transparent or chroma-keyed layer over the overlay.** Bounding boxes are all OBS reports; a 10%-opacity full-screen source reads as a full cover, and a transparent PNG reads the same as an opaque one. Deliberately out of scope.
- **It does not work for manual-paste streamers**, who have no obs-websocket. They emit nothing, and that silence is not held against them (`web/components/obs/use-overlay-visibility.ts`: the watch does not run without a stored password). This must not become a soft requirement to connect obs-websocket in order to be paid.
- **It has not been run against a real OBS.** Which direction real obs-websocket orders `sceneItemIndex` is not established anywhere in this repo — the shared mock returns the array position and the gate asserts the logic against that stated convention (`HIGHER_INDEX_IS_ON_TOP`). If real OBS is the other way round, the consequence is a **missed** detection rather than a false accusation, and no payout difference either way (`web/lib/obs-visibility.mjs`, header). One real OBS session settles it, and that is the same session the internal outstanding list tracks as B1.
