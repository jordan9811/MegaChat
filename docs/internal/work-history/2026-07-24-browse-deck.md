# 2026-07-24 — Browse deck

Sources: `DECISIONS.md` ("BROWSE DECK — decisions log"), `HANDOFF.md` ("BROWSE DECK — overnight handoff"), commits `73a7319`, `e4f1a4a`, merge `9b91d03` (2026-07-25).

## What shipped

A Kick-class browse section on the landing page behind `BROWSE_DECK` (on by default; `=0` restores the classic grid exactly): a shell with slots, a featured carousel, rails, a seeded lobby chat, a claim drawer. The classic `BrowseDirectory` was reused wholesale below the fold via an `embedded` prop rather than re-implemented. Gate `_gate-browse-deck.mjs`, 19 assertions, plus the shipped gates re-run with the deck mounted (`_gate-polish` 37/0, `_gate-browse-thumb` 7/0).

## What it found

- **No chat infrastructure exists in the repo** — the WebSocket protocol is seats, letters and overlay only; the lobby chat is seeded and read-only with a disabled input that says so (`DECISIONS.md`, "Recon: no chat infra").
- **No persistent clip or VOD storage** — MegaChats are dropped ~60 s after playback, so the carousel simulates a player with animated thumbnails and the drawer uses a placeholder. That gap later became the airings and posters work ([2026-09-11 → 14](2026-09-11-14-follow-and-airings.md), [Pass B](2026-09-15-16-pass-a-and-pass-b.md)).
- The claim drawer was painted *under* the chat panel — a stacking-context trap caught on a screenshot, fixed by portaling to `<body>`.

## Judgment calls

- Fictional streamer names in every seed, testnet framing on every money figure, a visible "demo" tag on seeded surfaces — so seeded activity is never mistaken for live traffic (`DECISIONS.md`, "Demo surfaces carry a small 'demo' tag").
- No new dependencies; platform icons limited to Twitch / YouTube / X because Kick's brand marks were off-limits.
- One build-verified commit rather than per-module commits — the registry imports every module, so intermediate commits could not build.

## Verification result

19/0 on the deck gate; slot-swap acceptance verified live against the running app and reverted. Merged to prod in `9b91d03`.
