# 2026-09-11 → 09-14 — The preview, the booth camera, follow my stream, airings

Sources: commits `807b6e4`, `7ee7426`, `de5b89b`, `974cb4d`, `618e2ad` on `origin/v0-ui-migration`; `server.js` (the follow loop, `twitchLiveCached`), `twitch-api.js`, `airings-store.js`, `web/components/host-cam-card.tsx`; gates `_gate-follow-stream.mjs`, `_gate-cohost-booth.mjs`. No `DECISIONS.md` or `OPEN-ISSUES.md` section covers this period; the commit messages and the module headers are the record.

## What shipped

- **Measure the Twitch frame instead of trusting it** (`807b6e4`): Twitch serves a grey placeholder at HTTP 200 for a dark channel, so an `<img>` cannot tell. The server now probes the 640×360 thumbnail (the 440×248 one served the placeholder without redirecting) and reports `twitchLive`; the manage page shows the preview everyone else sees only on that.
- **A dark channel reported itself live, and refunds emptied the bounty board** (`7ee7426`): two real bugs — the placeholder probe above, and `withBountyExamples` hiding every example pool once any pool had been refunded (0/8 → 8/8 on live data).
- **The booth keeps hunting for the camera, and says so** (`de5b89b`): when the host's camera is held by another app, the seat used to go out silently mic-only. Now it retries every 6 s and shows a `role="alert"` banner — "Your camera isn't working — guests can hear you but cannot see you." The gate's camera stub was also made honest: it used to be unable to fail a camera at all.
- **The room follows the broadcast** (`974cb4d`): `followTick()` every 60 s, one batched Helix call for all following rooms, two speeds (hide from discovery on the first dark reading; pause after five minutes; resume on live), null answer touches nothing, `FOLLOW_STREAM=0` kill switch. Observed working in production when a followed room auto-paused — which also proved the Twitch credentials are in Railway.
- **Airings** (`618e2ad`): one record per broadcast, opened and closed by the follow loop, with `moments` for MegaChat plays and seat joins at absolute time plus offset; `attachRecording()` written and tested, without a caller until Pass B.

## What it found

- The "Follow my stream status" toggle had promised a behaviour since it shipped and done nothing: `twitchAuto` was stored, read by the UI to adopt the channel name, and read by nothing else (`server.js`, the comment above `followTick`).
- The same booth report had been filed once before (`d2595d9`, 2026-07-22) and the gate stub could not exercise it.
- A per-room thumbnail probe would not scale as a liveness signal; Helix batching keeps the follow question at one request per minute regardless of room count.

## Judgment calls

- **Discovery and pausing at different speeds**, because they carry different costs when wrong: hiding is free to undo; pausing someone's room on a blip is not.
- **Null means "we could not ask"** and must never be read as "everyone is offline" (`twitch-api.js`, `getLiveByLogins`; `server.js`, the comment above `followTick`).
- The booth should stay on air and retry rather than refuse — "off is more flexible", the owner's call, with the alert so nobody is unknowingly voice-only.
- Airings never fetch; resolving a replay or capturing video belong to other layers (`airings-store.js`, "WHAT THIS DELIBERATELY DOES NOT DO").

## Verification result

`_gate-follow-stream.mjs` 18/0 against a fake Twitch on a local port including blip resume; `_gate-cohost-booth.mjs` with the stub that honours constraints; the auto-pause observed in production.
