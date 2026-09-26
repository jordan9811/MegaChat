# Running it

Setup, environment, ports, modes, and the operational hazards that have actually bitten. Variable **names** only appear here; values do not.

## Setup

```bash
npm install          # root; postinstall also installs web/ (package.json, "postinstall")
npm run build        # builds web/.next — required before --prod and before any browser gate
npm run dev          # node server.js — Next in dev mode, one process on :3000
npm start            # node server.js --prod — serves web/.next as built
```

Node 24 is what the tree is developed and gated on (`node --version` at the time of this pass: v24.12.0). Next 16.2.6, React 19 (`web/package.json`). `ffmpeg` on `PATH` is needed for capture, posters and verification (`room-poster.js`, `frame-sources.js`); an HLS extractor (`yt-dlp`) for platform VOD reads (`frame-sources.js`, "THE EXTRACTOR IS A SEAM").

## One process, one port

`PORT` (default 3000) serves the API, the WebSocket, the overlay and every Next page (`server.js`, `const PORT`). `BASE_URL` defaults to `http://localhost:<PORT>` and is what share links are built from. There is no separate frontend server; `NEXT_PUBLIC_BACKEND_URL` exists only for an unusual split (`web/lib/backend.ts`).

**Modes.** `--prod` (or `NODE_ENV=production`) serves the built `.next`; anything else runs Next in dev mode with HMR (`server.js`, `nextDev`). Development on OneDrive has a known stale-CSS trap: when new classes silently fail to apply, delete `web/.next` and restart.

## Environment

The names the tree reads, grouped by what they switch. Absent credentials degrade to "not configured" — nothing is faked (`auth.js`, `livekit.js`, `privy-identity.js`, `moderation.js`, all say so in their headers).

| Group | Names | Behaviour when absent |
|---|---|---|
| Persistence | `DATA_DIR`, `KEEP_ORPHAN_ROOMS` | `./data`; orphans pruned on boot |
| Chain / payments | `TEMPO_RPC_URL`, `TEMPO_CHAIN_ID`, `TEMPO_USDC_ADDRESS`, `TEMPO_EXPLORER_URL`, `SELLER_WALLET_ADDRESS`, `SELLER_PRIVATE_KEY`, `MPP_SECRET_KEY`, `MPP_FEE_HEADROOM`, `MPP_STALE_MS` | MPP meter unavailable (`/api/join/mpp` → 503) |
| Room defaults | `TICK_SECONDS`, `TICK_PRICE`, `PASSKEY_TICK_SECONDS`, `PASSKEY_TICK_PRICE`, `MAX_SESSION`, `MAX_SEATS`, `MEGACHAT_MAX_SEATS`, `ROOM_DEFAULT_PASSWORD`, `DEMO_ROOM_PASSWORD` | `getEnvDefaults()` values |
| Identity | `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `AUTH_SECRET`, `TWITCH_CLIENT_ID/SECRET`, `X_CLIENT_ID/SECRET`, `KICK_CLIENT_ID/SECRET`, `YOUTUBE_API_KEY` | sign-in surfaces disabled / 503 |
| Media | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_SEAT_GRACE_S`, `LAZY_CONNECT`, `LAZY_*`, `LK_BREAKER`, `LK_*_BUDGET_MIN`, `OPS_ALERT_WEBHOOK` | vdo.ninja transport; breaker/alerts no-op |
| Features | `BOUNTY_CLAIM`, `BOUNTY_*` (thresholds), `OBS_ONECLICK`, `FOLLOW_STREAM`, `FOLLOW_POLL_MS`, `FOLLOW_OFF_CONFIRM_MS`, `SITE_ADMIN_TWITCH` (whose Twitch login may first claim `/dev`; default the owner's channel), `BOARD_BIG_VIEWERS` and `AIRED_CLIPS` (fallbacks for two `/dev` settings), `GUEST_WHITELIST_MAX`, `MODERATION_API_KEY`, `MODERATION_API_BASE`, `EARN_*`, `REWARD_POOL_*` | bounty off; one-click hidden; follow loop on; moderation unconfigured |
| Docs | `NEXT_PUBLIC_DOCS_URL` | no docs links render anywhere |
| Legacy (other branches) | `ARC_*`, `USDC_ADDRESS`, `GATEWAY_WALLET_ADDRESS`, `FACILITATOR_URL`, `CIRCLE_*` | ignored on this branch (`rooms-store.js`) |

`.env.example` documents 52 of these with comments; the root modules read about 190 in total (`grep -oh "process.env.[A-Z_0-9]*" *.js`). The full list is in `REPORT-DOCS.md` §1b.

**Never strip keys from `.env`.** It holds the only copy of live secrets; treat it as append-only and confirm a change from the boot log (`AGENTS.md`).

## Deploying

Railway auto-deploys from `v0-ui-migration`. A commit is not live until the deployed URL serves it; confirm by polling for a marker that only the new build carries (`AGENTS.md`, "Commit ≠ ship"; the deploy poll in `REPORT-DOCS.md`). `/api/health` reports the persistence status of the volume and echoes `GATE_NONCE` when set (`server.js`, `/api/health`; `_gate-helpers.mjs`).

## Operational hazards

- **OneDrive file locks.** The working tree lives under OneDrive on the owner's machine. Git operations that delete files under `.git/worktrees/` fail with `Permission denied` when OneDrive holds the file; two stale worktree entries (`create-room-ui`, `mc-guest-whitelist`) print that error on every commit. Report it, do not force it (`OPEN-ISSUES.md`, 2026-09-15; `megachat-pass-a-prompt.md`, "If a git operation fails on a locked file, stop and report").
- **A stale server on the port.** See [Testing methodology](testing-methodology.md); use `startGateServer` from `_gate-helpers.mjs` rather than a bare spawn.
- **A stale build.** `--prod` serves whatever `web/.next` is on disk. Rebuild before judging anything in a browser; `_gate-bounty-claim` refuses otherwise (section G0).
- **LiveKit minutes.** The overlay's lazy connect and the burn breaker exist because an always-connected overlay drained the quota once; `LAZY_CONNECT=0` restores that behaviour and should not be set in production without a reason (`livekit-lazy.config.js`).
- **The local `v0-ui-migration` ref goes stale.** Worktrees push with `git push origin <branch>:v0-ui-migration`; read prod state from `origin/v0-ui-migration`, not the local branch.

## Ports used by gates

Gates pick private ports (3222, 3250–3253, 3288, 3301, …) and refuse to start on one already in use (`_gate-helpers.mjs`, `portInUse`). A local LiveKit SFU and mock OBS (`_gate-mock-obs.mjs`, port 4455-compatible) are started by the gates that need them.
