# MEGACHAT: SELF-CAPTURE HARDENING + OBS SCENE VERIFICATION + PUMP.FUN CAPTURE

/goal

Make self-capture trustworthy enough to be the primary verification method on platforms without external capture, and add an OBS-sourced signal that independently confirms the overlay was visible on the broadcast. Also settle the pump.fun capture question.

Branch `feat/capture-hardening` off trunk. Commit per unit, HEAD always builds.

**Standing constraints:** no settlement, Gate H zero transfer calls, `BOUNTY_CLAIM` off, real pages not mirrors, gates exercise HTTP routes, zero external spend inside gates.

---

## T1: OBS scene-item visibility check

The obs-websocket connection is already built. Use it to query whether the overlay source is in the active scene and not hidden, during air sessions.

- Poll `GetSceneItemEnabled` and `GetSceneItemTransform` (for bounds, position, visibility) at each clip playback. Record the result as evidence alongside the self-capture and watermark.
- If the source is not in the active scene, or is hidden, or has zero-area bounds, record that as `OVERLAY_NOT_VISIBLE` and route the session to review.
- This is an evidence signal, not a hard gate. A streamer using manual paste has no obs-websocket connection and must not be penalized for that. The check runs when the connection exists and is absent when it doesn't.
- Verification tiers: obs-websocket connected and scene-item visible = highest confidence (auto-verify eligible). Self-capture only = standard. Neither = review.
- Gate it with the mock obs-websocket server: source visible passes, source hidden flags, no connection degrades gracefully.

## T2: Harden self-capture against the obvious cheat

Self-capture proves the overlay rendered the code. It does NOT prove the overlay was visible on the broadcast. A streamer could have the source loaded but not in their active scene.

Beyond the scene-item check (which only works with obs-websocket), add:

- **Canvas-size verification.** The overlay knows its own render dimensions via `window.innerWidth/Height`. If the browser source is sized to something absurd (1x1, or vastly different from common canvas sizes), record it. This catches a source that exists but was shrunk to invisible.
- **Visibility state.** `document.visibilityState` and the `visibilitychange` event. A browser source not in the active scene may report as hidden in some OBS versions. Record it as evidence, don't gate on it, since behavior varies.
- Record both alongside self-capture frames so they're available for review without re-checking.

## T3: pump.fun capture — settle it

The inference is that pump.fun delivers via WebRTC with no public HLS, based on their use of LiveKit Ingress. This is circumstantial. Three things to check, in order:

**a. Does pump.fun serve HLS?** Write a small script that opens a pump.fun livestream page in Playwright, waits for the player to load, and captures all network requests. Filter for `.m3u8`, `.ts`, or any HLS-signature traffic. If found, external capture works the same as Twitch and the whole problem is solved. If not, confirm it's WebRTC (look for LiveKit signaling or WHEP traffic).

Run this against a real live pump.fun page. If no streams are live, say so and ship the script as a one-command check for when one is.

**b. If WebRTC only: can we subscribe as a LiveKit viewer?** pump.fun streams run on LiveKit. Investigate whether the page's LiveKit room URL and token are discoverable from the client-side JavaScript (they'd have to be, since the viewer's browser connects). If so, we could theoretically connect our own LiveKit client as a subscriber and pull video frames directly from the WebRTC track. Assess feasibility and ToS risk. Do not build, just report what you find.

**c. Headless browser screenshot as the fallback.** If neither HLS nor LiveKit subscription works, the remaining external option is Playwright screenshotting the page. Assess: does the pump.fun player render in headless Chrome? What resolution? Is there DRM or canvas fingerprinting that would block screenshots? How much CPU per concurrent verification?

Report findings per option with a recommendation.

## T4: Verification confidence tiers

Formalize what's been implicit. Every verified playback should carry a confidence tier based on what evidence exists:

- **Tier 1 (highest):** external capture confirmed the code on the public broadcast. No further questions.
- **Tier 2:** obs-websocket confirmed the source was visible in the active scene, plus self-capture confirmed the code. Strong.
- **Tier 3:** self-capture confirmed the code, no obs-websocket, no external. Sufficient with stream-context rules, but weaker.
- **Tier 4:** self-capture only, with one or more warning signals (canvas size anomaly, visibility hidden, etc.). Routes to review.

The tier determines the verification path: Tier 1 and 2 auto-verify, Tier 3 auto-verifies with stream-context passing, Tier 4 routes to review. Configure the boundaries.

This is not payout scaling. Every tier that passes pays the same amount. It only determines whether a human needs to look.

---

/loop

Iterate T1, T2, T4 until gates pass. T3 exits after findings are reported, since it depends on a live pump.fun stream being available. Do not loop on external dependencies.

---

## Hand back

- OBS scene-item check working against the mock, with the three states (visible, hidden, no connection) all producing the correct evidence and tier.
- What pump.fun actually serves (HLS, WebRTC, or both), with evidence.
- Whether the LiveKit room details are discoverable from the client.
- Whether headless screenshot works on pump.fun and at what cost.
- The confidence tier table as shipped.
- Gate SHAs, updated `OPEN-ISSUES.md`, brief per convention.
