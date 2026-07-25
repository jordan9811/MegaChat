# BROWSE DECK — overnight handoff

Branch: `feat/browse-deck` (never merged to `v0-ui-migration` — your call tomorrow).
Status: IN PROGRESS — this file is updated after every unit. See DECISIONS.md for the why-log.

## One-line revert
Set `BROWSE_DECK=0` in the environment (or revert the single `<main>` line in
`web/app/page.tsx`) — the old browse section comes back exactly as shipped.

## What's done
- [x] Recon (mount point, no chat infra, no clip storage, tokens)
- [x] Deck shell with slots: promoBanner / leftRail / featured / rightPanel / belowFold[]
- [x] `browse-deck.config.ts` — single file mapping modules → slots + all copy/toggles
- [x] Mount toggle in page.tsx (deck on by default on this branch)
- [x] Classic browse wrapped as the belowFold grid module (search included, real data)
- [x] Featured legacy-streamer carousel (viewer badge, mute, spinner, info card, dots+arrows, auto-advance pauses on hover)
- [x] Campaign dashboard (left rail) + claim drawer (portaled; Esc/backdrop close; stubbed Claim CTA)
- [x] Seeded lobby chat (right panel; colored names, badges, replies, pinned bot, join events, read-only input)
- [x] Promo banner
- [x] Responsive pass (featured full-width below lg; rail + chat as slide-over sheets behind toggle pills)
- [x] Alternates built + unmounted (activityFeed, recommendedRooms)
- [x] Categories stub
- [x] Screenshots in /screens (desktop dark/light, mobile, drawer, sheets — regenerated at wrap-up)

## Config lines you'll actually edit (web/components/browse-deck/browse-deck.config.ts)
- `slots.leftRail: 'campaignDashboard'` → swap to `'recommendedRooms'` for the alternate rail
- `slots.rightPanel: 'lobbyChat'` → swap to `'activityFeed'` for the event ticker
- `featured.entries[n].roomId: null` → set a real room id to point that carousel entry's CTA at a live room
- `campaign.endsAt` — bounty countdown target (ISO)
- `showDemoTag` — hide the "demo" labels on seeded surfaces

## Known gaps (deliberate, logged)
- Lobby chat is seeded + read-only — repo has no chat infra at all (WS = seats/letters only). If real chat ships, match the message model in `browse-deck/data.ts` (`LobbyMessage`).
- Featured "player" is an animated thumb + simulated load — no VOD/clip assets exist in the repo (letters are dropped from memory ~60s after play).
- Claim CTA in the drawer is a stub → routes to /dashboard; TODOs marked in `campaign-dashboard.tsx`.
- Deck-header search placement not built — the classic grid's search (with unlisted direct-id lookup) survives below the fold.

## Your outstanding items from earlier (unrelated to deck)
- Set `MODERATION_API_KEY` + `CONTACT_URL` in Railway env.
- LiveKit Cloud free-tier minutes are exhausted (verified 429) — Ship $50/mo vs wait for reset vs self-host.
- Refresh the OBS browser-source cache once (overlay self-heals after that).
