# BROWSE DECK — decisions log

One line each: what / why / how to undo. Newest at the bottom.

- **Recon: no chat infra exists in the repo** — the WS protocol is seats/letters/overlay only (server.js), so lobbyChat defines its own seeded message model; flagged in HANDOFF as the model to match if real chat ever ships. Undo: n/a (fact).
- **Recon: no persistent clip/VOD storage** — MegaChat letters are in-memory and dropped ~60s after play (letters.js MEDIA_TTL_MS), so the featured carousel uses animated thumbnails and the claim drawer uses a clip placeholder. Undo: n/a (fact).
- **Mount flag = `BROWSE_DECK` env, deck ON by default on this branch** — `page.tsx` renders BrowseDeck unless `BROWSE_DECK=0`; classic BrowseDirectory is untouched and still mounts with the flag. Undo: set `BROWSE_DECK=0` or revert the one `<main>` line in web/app/page.tsx.
- **Classic grid reused wholesale, not just its card** — BrowseDirectory (header + search + grid + direct-id lookup) mounts as the belowFold grid module via a new optional `embedded` prop that only drops the duplicate `id="browse"` anchor; zero behavior change when the prop is absent. Undo: delete the prop + the roomGrid wrapper.
- **Seeds are typed JSON in `web/components/browse-deck/seeds/`** — one obvious folder per the spec; adapters in data.ts are the only readers. Undo: delete folder.
- **Fictional streamer names in all seeds** — real streamer names would fabricate an association; seeds use invented-but-plausible handles. Undo: edit seeds JSON.
- **Money figures are placeholders with explicit "testnet" framing** — bounty pool, bounty rows, and banner all carry testnet copy; no payment code touched. Undo: n/a (rule).
- **Demo surfaces carry a small "demo" tag** — featured entries and the seeded lobby chat are labeled demo (config-toggleable) so seeded activity is never mistaken for live traffic. Undo: flip `showDemoTag` in browse-deck.config.ts.
- **Platform set for campaign rows = twitch / youtube / x** — lucide has official-ish icons for these; Kick has none and its brand marks are off-limits per spec. Undo: edit seeds + PlatformIcon.
- **No new dependencies** — deck is built entirely on existing stack (Next, Tailwind tokens, lucide-react). Undo: n/a.
- **Campaign countdown targets 2026-08-15T00:00:00Z** — placeholder end date for the bounty campaign (absolute so it doesn't drift). Undo: edit `campaign.endsAt` in browse-deck.config.ts.
- **Carousel autoplays a simulated player, not video** — no VOD assets exist (see above), so entry switches show a short spinner then an animated branded thumb; a real `roomId` on a featured entry re-points its CTA at the live join page. Undo: n/a (documented gap).
- **Search survives inside the reused classic grid** — the classic's search box (with unlisted direct-id lookup) ships below the fold as-is; a deck-header search slot is logged as a known gap, not half-built. Undo: n/a.
- **lobbyChat is read-only with a disabled input** — wiring a real posting path would require new auth surface (off-limits); the input explains itself instead of pretending. Undo: n/a (documented gap).
- **Claim drawer is portaled to `<body>`** — the sticky rails + backdrop-blur panels create stacking/containing contexts that trapped the fixed overlay (chat panel painted OVER the drawer; caught on screenshot). Undo: n/a (bugfix).
- **Seeded featured CTAs land on /demo** — the code-seeded demo room is always alive, so "Drop in" is never a dead end; a config roomOverride beats it. Undo: edit featured seeds/config.
- **Deck landed as one build-verified commit, not per-module commits** — the registry imports every module, so intermediate per-module commits could not build; HEAD-always-builds won over commit granularity. Undo: n/a (process).
- **Slot-swap acceptance verified live, then reverted** — flipped leftRail→recommendedRooms and rightPanel→activityFeed with two one-line config edits against the running app (real rooms rendered in the alternate rail, ticker ran); screenshot in screens/deck-alternate-slots.png. Undo: n/a (test).
- **Gate `_gate-browse-deck.mjs` (19 asserts)** — deck-on render of every slot, BROWSE_DECK=0 exact classic restore, git-level hero freeze vs eae3f7d, no-15s copy rule over seeds, drawer portal + Esc. Shipped gates re-run with the deck mounted: _gate-polish 37/0, _gate-browse-thumb 7/0. Undo: n/a (evidence).
