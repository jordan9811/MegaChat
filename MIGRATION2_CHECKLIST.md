# Migration 2 — single app + public browse

Branch `streamer-dashboard`. Commits: `43cd1ab` baseline → `1f8927c` phase 1
(unified single app) → `8823c1b` phase 2 (public browse + search).
Date: 2026-07-02.

## Phase 1 — one app, one process, one port

**Chosen path: single combined server process.** `server.js` (Express) stays
the entrypoint and mounts the Next.js app in `web/` as its fallthrough request
handler (Next custom-server pattern). Why this direction instead of porting
Express into Next API routes: the meter interval, seat `Map`, WebSocket
server, and Gateway facilitator client are long-lived singletons; hosting them
in Next route handlers would have meant rewriting payment/meter/WS logic,
which was off-limits. This way every line of that logic is byte-identical.

**One command:**

| Command | What it does |
|---|---|
| `npm install` | installs root deps, then `web/` deps via postinstall (Windows-safe, no `&&`) |
| `npm run dev` | boots everything on **http://localhost:3000** (Next dev + HMR inside the Express process) |
| `npm run build` | production build of the Next frontend |
| `npm start` | same single process serving the built frontend (`--prod` flag, no env-var assumptions) |

**URL map (all on :3000):**

- `/` — public browse landing (Next)
- `/dashboard` — streamer dashboard (Next)
- `/join?room=<id>` — viewer join page (Next)
- `/overlay?room=<id>` — OBS overlay (Express, byte-identical)
- `/api/*`, WebSocket at root path — Express, unchanged
- `/?room=<id>` (old viewer links) — 302 → `/join?room=<id>`
- `/index.html?room=<id>`, `/dashboard.html` — legacy static pages, still served

**Transport glue that changed (no logic changes):**

- `WebSocketServer({ server })` → `noServer` + explicit upgrade routing:
  app sockets keep the root path exactly as before; `/_next/*` upgrades go to
  Next's HMR handler.
- Gotcha fixed along the way: Next dev **lazily attaches its own `upgrade`
  listener** to the shared HTTP server on the first proxied request and
  destroys sockets it doesn't recognize — that killed every app WebSocket
  (~4 ms after connect). `server.js` now traps upgrade listeners added after
  its own and routes them `/_next` traffic only.
- `next.config.mjs` rewrites removed (same origin now; the old `/api` rewrite
  would have looped back into the same server). `web/lib/backend.ts` resolves
  the backend origin to `window.location.origin`.
- Stale `pnpm.overrides` block removed from `web/package.json`.

**Phase 1 verified:** dashboard, join page, overlay all reachable on :3000
from one command; real per-second meter ticked; rewards earn → credit join →
leave refund → owner-disconnect cleanup; overlay tile rendered from a live
seat over the unified WS; `next build` passes.

## Phase 2 — public browse / directory

**Wired (all real):**

- `GET /api/rooms/public` — active rooms that haven't opted out, with
  `live` / `waiting` counts read from the existing in-memory seat map
  (waiting = paid seats whose camera isn't live yet). No duplicated state.
  Sorted hottest first: live count → waiting count → newest.
- Browse page at `/` — room cards (name, id, Live/Open badge, live/max
  seats, waiting count, drops badge, price per interval) linking to each
  room's join page; re-polls every 5 s.
- Search box — filters by room name or id as you type; an exact room id
  with no listed match (e.g. an unlisted room) resolves through
  `/api/config` and renders a "Direct match" card.
- **Unlisted toggle** — dashboard → Advanced → Visibility → "Unlisted (opt
  out of browse)". Real config field (`config.unlisted`), autosaved like
  every other field, default listed/public. Unlisted rooms disappear from
  browse + search listing but keep working by direct link.
- Streamer dashboard moved to `/dashboard`; header "Go live" and hero
  footer link point there. Hero's GRAB button scrolls to `#browse`.

**Phase 2 verified:** card flipped to "Live 1/3" and sorted first while a
real credit-metered seat was live; search by name ("auth") and id; unlisted
hid the room from `/api/rooms/public` while `/api/config` + join page stayed
reachable; direct-match card appeared for the unlisted id; toggle round-trip
through the real dashboard autosave; the test seat metered its full session
to `out_of_funds` and was auto-kicked (meter untouched by all of this).

## Stubbed / not implemented

- Join-gating fields (min watch time, reputation, subs/followers only) —
  still disabled dashboard stubs, no server enforcement.
- Twitch/Kick integration — stubs on dashboard + join page.
- "Waiting" counts only queued **paid** seats; page viewers who haven't paid
  aren't counted (no presence tracking was added).
- Browse cards don't live-update between 5 s polls (no WS push for the
  directory).

## Verify live (needs real devices/wallets)

1. Passkey + MetaMask joins end-to-end on `/join` (unchanged logic, but do a
   real-device pass on the unified origin).
2. OBS Browser Source pointed at `http://localhost:3000/overlay?room=<id>`.
3. `npm start` (production mode) smoke test after `npm run build`.
4. Room `aa0d1de8` ("join-port-test", password `test1234`) is test data in
   `data/rooms.json`, along with several older gate-test rooms — delete or
   ignore.
