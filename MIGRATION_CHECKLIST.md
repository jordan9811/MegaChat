# v0 UI Migration Checklist

Branch: `v0-ui-migration` · Commits: baseline → phase 1 → phase 2 → phase 3

## Architecture

- **`web/`** — the v0 Next.js 16 app (extracted from `mega-chat-dashboard-ui.zip`),
  now the streamer-facing UI. Run with `npm run dev` inside `web/`.
- **`server.js`** — the existing Express + WebSocket backend, **unchanged** (zero
  edits to any backend file). It keeps serving the viewer join page (`/?room=…`),
  the OBS overlay (`/overlay?room=…`), and all `/api/*` routes on port 3000.
- Next.js proxies `/api/*` → `BACKEND_URL` (default `http://localhost:3000`) via
  rewrites; the dashboard's WebSocket connects directly to the backend origin
  (`NEXT_PUBLIC_BACKEND_URL`, default `http://localhost:3000`).
- Decision: Express runs **alongside** Next.js (not ported to Next API routes) —
  the per-second meter interval, in-memory `activeSeats`, and WS seat lifecycle
  need one long-lived process, and porting would have meant rewriting protected
  payment logic.

## Wired (verified against the live backend)

- ✅ **Create room** from the v0 settings card → `POST /api/dashboard/create`
  (room password required, hashed with scrypt server-side).
- ✅ **Manage existing** tab → `POST /api/dashboard/unlock`; wrong password
  rejected (401); session drops back to the entry state on auth failure.
- ✅ **Config autosave** while managing (debounced 900 ms, `X-Room-Password`
  header) — verified a price change persisted to `data/rooms.json`.
- ✅ **Accepting-joins toggle** → `/start` / `/stop`; a paused room really
  rejects joins (`room_stopped`).
- ✅ **Result panel** shows the real `joinUrl` / `overlayUrl` returned by the
  backend, with copy buttons.
- ✅ **On-camera table** — real seats via WebSocket `subscribe_room`:
  `seat_added`/`seat_removed` trigger an authenticated refresh, `meter_update`
  patches spent/remaining per second in place; 5 s poll fallback also surfaces
  pending (paid, camera-not-live) seats. Kick button → `/kick/:seatId`,
  confirmed delivered to the viewer as `seat_removed: kicked`.
- ✅ **Rewards card** → real per-room rewards config (interval is **seconds**,
  USDC / ERC-20 / points, optional token address). End-to-end test: a simulated
  viewer earned USDC credits over the watch-to-earn WebSocket, joined a seat
  with earned balance (no wallet), went camera-live, was metered 1 USDC/s on
  the dashboard, and was kicked from the UI.
- ✅ **Join gates** for rooms created in the new UI: passkey path returns real
  session terms (with the prices set in the UI); MetaMask/Gateway path returns
  the x402 `402` challenge.
- ✅ **Viewer join page + OBS overlay** — untouched Express pages, still serve
  (passkey bundle 200). The links generated in the new UI point at them.

## Stubbed / intentionally not ported

- The v0 header links (**Dashboard / Pricing / Docs** in the hero footer strip)
  and the hero **“GRAB 10 SEC”** button are design copy — not wired to anything.
- The old dashboard's "Join gating" (min watch time, subscribers-only…) was
  already a stub and was not carried over.
- Twitch/Kick integrations pill (old UI stub) not carried over.
- The legacy `public/dashboard.html` still exists and works at
  `http://localhost:3000/dashboard`; retire it whenever you're confident in the
  new UI.

## Verify live (needs a real wallet / HTTPS — can't be tested headlessly)

1. **Passkey gasless join end-to-end**: WebAuthn prompt, approve userOp, seat
   assigned, per-second `transferFrom` pulls. Note the join page warns passkeys
   only work at `http://localhost:3000` (or HTTPS) — that page still runs on the
   Express origin, so this is unchanged.
2. **MetaMask/Gateway prepaid join**: EIP-712 signing, facilitator
   verify/settle, refund of unused balance on leave.
3. **OBS overlay in OBS itself** (~340×620 px browser source) with a live seat.
4. **Rewards pool payouts on-chain** (`REWARD_POOL_PRIVATE_KEY` set — otherwise
   credits accrue locally, which is what the E2E test exercised).

## Known pre-existing issue (NOT introduced by this migration — left unfixed per guardrails)

- **Points rewards seats die on their first meter tick**: points credits are
  stored at 0 decimals, but the seat's tick price (`passkeyTickPriceAtomic`) is
  computed with the payment token's 6 decimals in `roomAtomics()` (server.js),
  so `remainingAtomic (e.g. 20) < tickPrice (1_000_000)` → instant
  `out_of_funds`. USDC-type reward credits are unaffected (decimals match).
  Reproduced with the legacy backend logic untouched.

## Housekeeping

- Test room `ef1ff57f` ("migration-test", password `test1234`) was created in
  `data/rooms.json` during verification — delete the entry if you care.
- `.env` remains gitignored; no secrets were touched or logged. The Next app
  needs no secrets (it only proxies).
- Dev servers: `.claude/launch.json` defines `v0-frontend` (web/, auto-port)
  and `express-backend` (port 3000).
