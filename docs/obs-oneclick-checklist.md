# OBS one-click — the owner's five-minute real-OBS checklist

Everything below is proven against a conformance mock in CI
(`_gate-obs-protocol.mjs`, `_gate-obs-ui.mjs`). What CI cannot prove is real
OBS itself: its actual CEF build, its actual mixer, your actual machine. That
is this checklist. Run `node _verify-obs-oneclick.mjs` and it walks you through
each step as an assertion with an expected result — a failure names itself.

**Setup (once):** OBS 28+ installed. Start the app with `OBS_ONECLICK=1` and
`BOUNTY_CLAIM=1` (locally: set both in `.env`, `node server.js --prod`).

| # | Do | Expect |
|---|----|--------|
| 1 | OBS → Tools → WebSocket Server Settings → Enable WebSocket server → Show Connect Info → copy password | A password exists; port shows 4455 |
| 2 | Open a streamer claim page (any seeded handle), claim it, reach setup | "Connect OBS" section renders with these exact instructions |
| 3 | Paste a WRONG password → Test connection | "OBS rejected the password" — not a generic error, not a hang |
| 4 | Paste the real password → Test connection | "Connected — OBS <version>, canvas <your canvas>" |
| 5 | Click **Add to OBS** | Green **Verified ready** with named checks, all listed |
| 6 | Look at OBS | A source "MegaChat Overlay" in the current scene, full canvas, position 0,0 |
| 7 | Right-click the source → Transform | Position 0,0, scale 100% (Edit Transform shows no bounds) |
| 8 | OBS mixer | "MegaChat Overlay" appears as its OWN channel with a meter |
| 9 | Have a guest join (or replay a MegaChat) | You HEAR the join/stinger sound in your monitoring device, and the mixer meter moves |
| 10 | Switch scenes away and back | The overlay page did NOT reload (no reconnect flash; source persists) |
| 11 | In MegaChat, untick "hear overlay sounds in your headphones" | Mixer keeps the audio in the stream; your monitoring goes silent |
| 12 | Shrink the source by hand, then click **Add to OBS** again | The source snaps back to full canvas — the repair path works |
| 13 | Start OBS Virtual Camera; in the booth's camera picker choose "OBS Virtual Camera" | The picker shows it, the note about no-audio + mirror caution renders, feed is 1080p |
| 14 | Stop OBS entirely → Test connection | "Could not reach OBS…" with the Tools → WebSocket path — and the manual URL + dimensions are right there |

If any row fails, the row number + what you saw is the whole bug report.
