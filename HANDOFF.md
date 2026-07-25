# BROWSE DECK — overnight handoff

Branch: `feat/browse-deck`, branched off `v0-ui-migration` @ eae3f7d. NOT merged, NOT deployed
(Railway only deploys v0-ui-migration — pushing this branch ships nothing). Your call tomorrow.
DECISIONS.md is the one-line why-log for every call made overnight.

## One-line revert
Set `BROWSE_DECK=0` in the environment — the old browse section comes back exactly
(gate-verified). Or revert the single `<main>` line in `web/app/page.tsx`. Hero diff vs
branch base: **zero** (also gate-verified, git-level).

## Status: DONE — every planned module built, verified, committed
- [x] Deck shell with slots: promoBanner / leftRail / featured / rightPanel / belowFold[]
- [x] `browse-deck.config.ts` — the single file mapping modules → slots + all copy/toggles
- [x] Featured legacy-streamer carousel (viewer badge, mute, load spinner, floating info card,
      dots+arrows, 8s auto-advance paused on hover; 5 fictional demo entries, demo-tagged)
- [x] Campaign dashboard rail — $25,000 testnet pool placeholder, claimed count, live countdown,
      8 target rows with status chips; claim drawer (clip placeholder, stubbed Claim CTA → /dashboard)
- [x] Seeded lobby chat — colored names, badges, reply threads, pinned MegaBot, join events,
      scroll-aware autoscroll, read-only input that says so
- [x] Promo banner (creator-bounty tease, one CTA → #bounty-board)
- [x] Shipped grid reused wholesale below the fold (search + unlisted direct-id lookup intact)
- [x] Categories stub (labeled "coming soon", non-interactive)
- [x] Alternates BUILT + unmounted: activityFeed (event ticker), recommendedRooms (real data)
- [x] Responsive: 240/1fr/340 at desktop; tablet/mobile = featured full width, rail + chat as
      slide-over sheets behind toggle pills
- [x] Screenshots in /screens (desktop dark/light/full, tablet, mobile, drawer, both sheets,
      alternate-slots proof) — all captured against the prod build

## Verification (all green)
- `_gate-browse-deck.mjs` — **19/0**: every slot renders; BROWSE_DECK=0 restores classic exactly;
  hero freeze proven at git level; no "15s" claims from seeds; drawer portaled + Esc closes
- `_gate-polish.mjs` — **37/0** with the deck mounted (no landing regression)
- `_gate-browse-thumb.mjs` — **7/0** (classic grid works identically inside the deck)
- `npm run build` clean; slot-swap acceptance test run live and reverted

## Config lines you'll actually edit (web/components/browse-deck/browse-deck.config.ts)
- `slots.leftRail: 'campaignDashboard'` → `'recommendedRooms'` for the real-data rail (verified working)
- `slots.rightPanel: 'lobbyChat'` → `'activityFeed'` for the event ticker (verified working)
- `featured.roomOverrides: {}` → e.g. `{ slugmoney: 'demo' }` points that entry's CTA at a real room
- `campaign.endsAt: '2026-08-15T00:00:00Z'` — bounty countdown target
- `showDemoTag: true` → false hides the "demo" labels on seeded surfaces
- Seeds (names, chat lines, bounties, banner copy): `web/components/browse-deck/seeds/*.json`

## Known gaps (deliberate, logged in DECISIONS.md)
- Lobby chat is seeded + read-only — the repo has NO chat infra (WS = seats/letters only). If real
  chat ships, match `LobbyMessage` in `browse-deck/data.ts` and swap the adapter.
- Featured "player" is an animated thumb + simulated load — no VOD/clip assets exist anywhere
  (MegaChat letters are dropped from memory ~60s after play).
- Claim CTA is a stub → /dashboard; TODO(claim-flow) marked in `campaign-dashboard.tsx`.
- Deck-header search placement not built — the classic grid's search survives below the fold.
- Platform icons are neutral glyphs (Tv/Video/AtSign) — lucide v1 has no brand marks.

## Your outstanding items from earlier (unrelated to deck)
- Set `MODERATION_API_KEY` + `CONTACT_URL` in Railway env.
- LiveKit Cloud free-tier minutes exhausted (verified 429) — Ship $50/mo vs wait for reset vs self-host.
- Refresh the OBS browser-source cache once (overlay self-heals after that).
