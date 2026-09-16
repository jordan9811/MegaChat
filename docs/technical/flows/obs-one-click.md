# Flow: OBS one-click, and how it is verified

The path behind *Add to OBS*. It runs in the **streamer's browser** against the **streamer's own OBS** over obs-websocket v5; the server is not in the loop until the on-air scene check posts its samples. Requires `OBS_ONECLICK=1` to be shown at all (`server.js`, `/api/config.obsOneClick`).

| # | Step | Where | What can stop it |
|---|---|---|---|
| 1 | Streamer enables OBS's WebSocket server (Tools → WebSocket Server Settings), copies the password. Port 4455. | `docs/obs-oneclick-checklist.md`, rows 1–2 | — |
| 2 | *Connect OBS* on the manage or claim page: the browser opens `ws://127.0.0.1:4455`, completes the v5 hello/identify handshake with the password. The local-network permission prompt is named before it appears. | `web/lib/obs-client.mjs`; `187c9e5` | wrong password → "OBS rejected the password" (row 3); OBS down → "Could not reach OBS…" with the Tools path and the manual URL beside it (row 14) |
| 3 | *Test connection* reports OBS version and canvas size. | `web/lib/obs-client.mjs`, `GetVersion`/`GetVideoSettings` | — |
| 4 | *Add to OBS*: find an input named `MegaChat Overlay` in the current programme scene or create it; **find-or-update, never duplicate** — re-clicking is the repair path. | `web/lib/obs-oneclick.mjs`, `OVERLAY_INPUT_NAME` | — |
| 5 | Write every setting that decides whether the badge survives: `width`/`height` = canvas base size, position 0,0, scale 1, `boundsType: OBS_BOUNDS_NONE`, `shutdown: false`, `restart_when_active: false`, `reroute_audio: true`, monitor-and-output. Each has a stated reason in the settings table in the module header. | `web/lib/obs-oneclick.mjs` | — |
| 6 | **Verify against OBS's own declared defaults**, not assumed key names, and re-verify at runtime against the OBS actually running (`verifyOverlayInObs`). Green *Verified ready* lists the named checks. | `web/lib/obs-oneclick.mjs`; `ae59e2e` "verification that cannot lie" | a check fails → named in the UI |
| 7 | The overlay appears full-canvas at 0,0 with its own mixer channel; the streamer hears the join sound in monitoring; switching scenes does not reload the page. | `docs/obs-oneclick-checklist.md`, rows 6–11 | — |
| 8 | During a bounty air session, the page polls OBS for the overlay's scene-item state every `obsScenePollMs` and posts each sample to the server. `NO_CONNECTION` on the manual path is a normal outcome. The path is `GetVideoSettings` → `GetCurrentProgramScene` → `GetSceneItemId` → `GetSceneItemEnabled` → `GetSceneItemTransform`; it does **not** call `GetSceneItemList`, which this row claimed until Pass C checked it. The separate room-level check in [Overlay visibility](../../features/overlay-visibility.md) does call it, to see what it did not expect. | `web/lib/obs-scene-check.mjs`, `checkOverlayVisible`; `POST /api/bounty/air-session/:id/obs-scene`; `recordObsSceneSample`, `bounty-evidence.js` | — |
| 9 | At verification, a self-capture read corroborated by an "on screen" sample is tier 2; a disagreement is tier 4 and a person looks. The sample can raise confidence and can never be the only thing holding a verification up. | `bounty-confidence.js` | — |

## What is proven, and how

- **Protocol conformance** against a mock that speaks the real v5 protocol, including the error shapes: `_gate-obs-protocol.mjs`, `_gate-mock-obs.mjs`.
- **The UI end to end** on the real claim page in a real browser: `_gate-obs-ui.mjs`.
- **Real OBS, once, by hand:** the fourteen-row checklist with `_verify-obs-oneclick.mjs` walking each row as an assertion (`docs/obs-oneclick-checklist.md`).
- **Is it actually on screen right now?** `_smoke-obs-overlay.mjs` asks a running OBS and exits 0/1/2 for found / could not look / not there.

## What is not proven

The obs-websocket path has not been exercised against a real OBS **during a real broadcast** with verification reading the result — recorded open in `OPEN-ISSUES.md` ("The obs-websocket path is still untested against real OBS"). The smoke test exists to close it.

## Two unverified OBS risks, flagged in code

Setting-key names and loopback transport were flagged as unverified before the defaults check was written (`b33ac91`); the defaults check (`ae59e2e`) closes the first. Loopback — whether every OBS build accepts a browser-originated local WebSocket the same way — is confirmed on the owner's machine only (`docs/obs-oneclick-checklist.md`, "What CI cannot prove is real OBS itself").
