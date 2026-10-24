# Architecture

One process, one port, JSON on a volume. Everything below is read from `server.js` and the modules it imports.

## The layers

```
                     ┌──────────────────────────────────────────────┐
  OBS browser source │ public/overlay.html   (static, served by Express)
  viewer / streamer  │ web/  (Next.js 16, React 19 — pages, join UI, dashboard)
                     ├──────────────────────────────────────────────┤
                     │ server.js — Express + one WebSocket server    │
                     │   routes: /api/config /api/join/* /api/seats  │
                     │           /api/rooms/* /api/livekit/* /auth/* │
                     │   attached: rewards (on the WebSocket), auth, │
                     │     letters, bounty, dashboard, whitelist,    │
                     │     overlay visibility, campaigns             │
                     │   loops: tickAllMeters (1 s), followTick (60 s)│
                     ├──────────────────────────────────────────────┤
                     │ stores  rooms · accounts · airings · guest-    │
                     │         whitelist · bounty (+ ledger, evidence)│
                     │         · campaigns · money ledgers            │
                     │         — JSON / JSONL under DATA_DIR          │
                     └──────────────────────────────────────────────┘
        ↕ LiveKit (media)      ↕ Tempo RPC (payments)      ↕ Twitch / Kick / YouTube / pump.fun / X APIs
```

The same picture as a diagram GitBook renders (Mermaid; text-sourced so it diffs):

```mermaid
flowchart LR
  subgraph browser["Browser / OBS"]
    OV[public/overlay.html<br/>OBS browser source]
    JP[web/ join page]
    DB[web/ dashboard + account]
  end
  subgraph proc["One Node process — server.js"]
    EX[Express routes<br/>/api/config /api/join/* /api/seats<br/>/api/rooms/* /api/livekit/* /auth/*]
    WS[WebSocket on /<br/>seat + MegaChat events]
    NX[Next.js fall-through<br/>pages + assets]
    LOOPS[tickAllMeters 1 s<br/>followTick 60 s]
    MODS[bounty · dashboard · whitelist<br/>letters · rewards · auth<br/>visibility · campaigns]
  end
  subgraph stores["DATA_DIR (Railway volume)"]
    RJ[(rooms.json)]
    IJ[(accounts.json)]
    AJ[(airings.json)]
    GJ[(guest-whitelist.json)]
    BJ[(bounty.json)]
    LEDGER[(bounty-ledger.jsonl<br/>append-only)]
    EVID[(bounty-evidence.jsonl<br/>append-only)]
    CAP[(bounty-captures/ · room-posters/ · airing-posters/)]
  end
  LK((LiveKit SFU))
  CHAIN((Tempo RPC))
  PLAT((Twitch · Kick · YouTube<br/>Rumble · X · pump.fun))

  OV <--> WS
  OV <--> LK
  JP --> EX
  JP <--> LK
  DB --> EX
  EX --> MODS
  EX --> NX
  LOOPS --> CHAIN
  MODS --> RJ & IJ & AJ & GJ & BJ & LEDGER & EVID & CAP
  LOOPS --> PLAT
  MODS --> PLAT
  LK -- signed webhooks --> EX
```

**Express owns the process.** `server.js` builds the app, creates the HTTP server and a `noServer` WebSocket server that takes messages of at most 64 KB (`server.js`, `createServer(app)`, `new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })`), attaches the feature modules in a fixed order — rewards (on the WebSocket server, not a route), auth, letters, then bounty, dashboard, whitelist, overlay visibility and campaigns (`attachRewards`, `attachAuth`, `attachLetters`, `attachBountyRoutes`, `attachDashboardRoutes`, `attachWhitelistRoutes`, `attachVisibilityRoutes`, `attachCampaignRoutes`) — and finally mounts Next as the fall-through handler for anything no Express route claimed (`app.use((req, res) => nextHandle(req, res))`).

**Next is a guest in the process.** `createNextApp({ dev: nextDev, dir: NEXT_DIR })` runs in dev mode unless `--prod` or `NODE_ENV=production`; in prod it serves `web/.next` as built. The Next dev server lazily attaches its own `upgrade` listener and destroys sockets it does not recognise, which would kill every app WebSocket — so `server.js` traps upgrade listeners added after its own and hands them `/_next/*` traffic only (`server.js`, "CAUTION: Next dev lazily attaches its OWN 'upgrade' listener"). Anything else upgrading on `/` is the app WebSocket.

**Pretty room links are registered last, on purpose.** `/:handle` and `/:handle/overlay` come after every real route so a handle can never shadow `/api/*` or `/auth/*`; reserved names are refused at claim time as a second net (`server.js`, "Registered HERE, dead last, on purpose"; `RESERVED_HANDLES`, `rooms-store.js`).

## The seams

| Seam | What crosses it | Where |
|---|---|---|
| Browser ↔ server | JSON over HTTP; seat and MegaChat events over one WebSocket on `/` | `server.js` routes; `wss` |
| Server ↔ media | LiveKit tokens minted per seat; participant kicks; webhooks in | `livekit.js`, `livekit-webhooks.js` |
| Server ↔ chain | every server-signed transfer, through two doors: `settlement.js` — a direct seat's per-tick `transferFrom` (viewer to streamer), seat sweeps and refunds, MegaChat refunds, reward and campaign payouts, the MPP channel settle — and `escrow-chain.js` for the seat escrow contract (deposit, attest, finalize). Each writes only against a row it recorded first, and both stop when a money ledger is damaged | `settlement.js` (`createSettlement`, `viemChainAdapter`), `escrow-chain.js` (`createEscrowChain`); their callers in `server.js`, `seat-escrow.js`, `letters.js`, `rewards.js`, `meter-mpp.js`, `campaign-engine.js` |
| Server ↔ platforms | Helix liveness (batched), thumbnails, VOD discovery, live HLS | `twitch-api.js`, `kick-api.js`, `youtube-api.js`, `rumble-api.js`, `pumpfun-api.js`, `frame-sources.js` |
| Bounty ↔ room | one call at air-session close attaches a poster reference to the airing, and saves the capture frame as its poster | `bounty-routes.js` → `attachRecording`, `saveAiringPoster` |
| Verification ↔ money | a verdict becomes a ledger row; a ledger row becomes a recorded intent | `bounty-verifier.js` → `release()` in `bounty-escrow.js` → `StubSettlement` |

## What runs where

- **Railway**, one service, auto-deploying from `v0-ui-migration`; `DATA_DIR` is the mounted volume (`AGENTS.md`, "Commit ≠ ship"; `rooms-store.js`, `dataDirInfo`). `/api/health` reports whether persistence is proven (an earlier boot's marker survived) and the state of every checksummed ledger the process opened (`server.js`, `/api/health`).
- **LiveKit Cloud** for media, flag-gated on `LIVEKIT_*`; absent, the vdo.ninja path is the transport (`livekit.js`).
- **Tempo mainnet** for payments (`server.js` boot banner, "UNIFIED APP (TEMPO MAINNET)").
- **The streamer's machine** runs OBS with the overlay as a browser source, and — for one-click setup and the on-air scene check — talks to its own OBS over obs-websocket from the streamer's browser (`web/lib/obs-oneclick.mjs`, `web/lib/obs-scene-check.mjs`).

## How data flows for one paid seat

Join page → `/api/config` (terms) → wallet `approve` → `POST /api/join/passkey` (whitelist short-circuit → room switches → gates → seat; the response carries the `seatToken`) → WebSocket `register_seat` with that token → GO LIVE: `camera_ready` with the token → `activateSeatLive` → `seat_added` to the overlay → LiveKit publish (the camera stays local until the server's answer) → `tickAllMeters` charges every tick → leave/kick/stall → `removeParticipant` → `seat_removed` + LiveKit kick + `refundSeat`. Each step is on the [paid seat join](flows/paid-seat-join.md) page with its source.

## Two loops

- `tickAllMeters()` every second: charges live seats by mode — the server-driven meters charge nothing in a room whose overlay is reported hidden, or whose visibility record cannot be read — and kicks stalled or exhausted ones (`server.js`, `setInterval(tickAllMeters, 1000)`; `shouldCharge`, `seat-escrow.js`).
- `followTick()` every 60 s: one batched Helix call for every following room; hides on the first dark reading, pauses after five minutes, resumes on live; null answer touches nothing (`server.js`, the comment above `followTick`).

## What is deliberately not here

- **No database server, no queue, no worker.** Stores are JSON documents rewritten atomically on mutation (`json-store.js`) plus append-only JSONL ledgers: the bounty ledger and evidence, and the money, rewards, visibility and campaign ledgers (`bounty-ledger.js`; the [data model](data-model.md) lists them).
- **No second service.** The overlay, the pages and the API share one origin; `NEXT_PUBLIC_BACKEND_URL` exists only for an unusual split (`web/lib/backend.ts`).
- **No self-reported cost accounting.** LiveKit consumption is read from signed webhooks, because self-reporting is what hid the last leak (`livekit-webhooks.js`, header; `livekit-breaker.js`).
