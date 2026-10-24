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
| Persistence | `DATA_DIR`, `KEEP_ORPHAN_ROOMS`, `MIGRATE_AT_BOOT` | `./data`; rooms with neither an owner nor a password pruned on boot; data migrations reported at every boot, applied only when named here (`accounts`, `whitelist-identity`) |
| Chain / payments | `TEMPO_RPC_URL`, `TEMPO_CHAIN_ID`, `TEMPO_USDC_ADDRESS`, `TEMPO_EXPLORER_URL`, `SELLER_WALLET_ADDRESS`, `SELLER_PRIVATE_KEY`, `MPP_SECRET_KEY`, `MPP_FEE_HEADROOM`, `MPP_STALE_MS` | MPP meter unavailable (`/api/join/mpp` → 503) |
| Money doors | `PLATFORM_SETTLEMENT_KEY`, `REWARD_POOL_PRIVATE_KEY`, `ESCROW_OPERATOR_KEY`, `ESCROW_ATTEST_KEY`, `ESCROW_CONTRACT_ADDRESS`, `SEAT_ESCROW_*`, `CAMPAIGN_FUNDING`, `CAMPAIGN_SPENDER_KEY` | outbound intents recorded and left PENDING; cash rewards off; campaign funding off; escrow off, so paid seats pay viewer → streamer directly; an empty `ESCROW_CONTRACT_ADDRESS` means the recorded deployment (`contracts/deployments.json`), so both escrow keys alone turn escrow on, and a preflight still checks the contract before a seat uses it (`server.js`, the `createEscrowChain` call; `escrow-chain.js`) |
| Room defaults | `TICK_SECONDS`, `TICK_PRICE`, `PASSKEY_TICK_SECONDS`, `PASSKEY_TICK_PRICE`, `MAX_SESSION`, `MAX_SEATS`, `MEGACHAT_MAX_SEATS`, `ROOM_DEFAULT_PASSWORD`, `DEMO_ROOM_PASSWORD` | `getEnvDefaults()` values; without `ROOM_DEFAULT_PASSWORD` the default room has no password and nobody can manage it from the dashboard (`migrateLegacyRoomPasswords`, `rooms-store.js`) |
| Identity | `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `AUTH_SECRET`, `TWITCH_CLIENT_ID/SECRET`, `X_CLIENT_ID/SECRET`, `KICK_CLIENT_ID/SECRET`, `YOUTUBE_API_KEY` | sign-in surfaces disabled / 503 |
| Media | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_SEAT_GRACE_S`, `LAZY_CONNECT`, `LAZY_*`, `LK_BREAKER`, `LK_*_BUDGET_MIN`, `OPS_ALERT_WEBHOOK` | vdo.ninja transport; breaker/alerts no-op |
| Features | `BOUNTY_CLAIM`, `BOUNTY_*` (thresholds), `BOUNTY_IDENTITY_STUB`, `OBS_ONECLICK`, `FOLLOW_STREAM`, `FOLLOW_POLL_MS`, `FOLLOW_OFF_CONFIRM_MS`, `SITE_ADMIN_TWITCH` (whose Twitch login may first claim `/dev`; default the owner's channel), `BOARD_BIG_VIEWERS` and `AIRED_CLIPS` (fallbacks for two `/dev` settings), `GUEST_WHITELIST_MAX`, `MODERATION_API_KEY`, `MODERATION_API_BASE`, `EARN_*` (room reward defaults), `REWARDS_CASH_ALLOWLIST`, `REWARDS_MIN_INTERVAL_S`, `REWARDS_MAX_EARN`, `REWARDS_MAX_CAP`, `X_BEARER_TOKEN`, `X_TOKEN_KEY` | bounty off; bounty claims use the real identity check (only `BOUNTY_IDENTITY_STUB=1`, for test environments, turns on the auto-approving stub — `bounty-routes.js`); one-click hidden; follow loop on; moderation unconfigured; cash watch-to-earn off (`rewards.js`); no campaign profile refresh or X-built reference sets; X tokens sealed under `AUTH_SECRET`, and with neither set none are stored (`x-token-store.js`) |
| Docs | `NEXT_PUBLIC_DOCS_URL` | no docs links render anywhere |
| Legacy (other branches) | `ARC_*`, `USDC_ADDRESS`, `GATEWAY_WALLET_ADDRESS`, `FACILITATOR_URL`, `CIRCLE_*` | ignored on this branch (`rooms-store.js`) |

`AUTH_SECRET` is the absence with the widest reach, and not a 503. It (else `MPP_SECRET_KEY`) seals sign-in cookies and derives each room's overlay key; with neither set in production (`--prod`, or Railway's own variables), sessions are sealed with a secret made fresh at every boot — everyone is signed out by each restart — and no overlay key exists, so no overlay counts as a room's real one (unlike the cookie secret, a key made fresh at every boot would silently break every saved OBS URL on each deploy). Outside production the public dev constant is used (`runtime-env.js`, `sessionSecret`, `isProduction`; `overlay-key.js`). A session lasts 30 days from sign-in, enforced server-side, and its cookie is `Secure` in production (`auth.js`, `readIdentityFromRequest`).

Most numeric variables are read through one helper (a few older reads, such as `FOLLOW_POLL_MS`, still use `Number(…) || default`): unset, empty or whitespace means the default; a value that is not a number means the default plus one `[env]` warning naming the variable; `0` stays 0; a variable read with a floor (the sweep and poll intervals) is raised to it (`env-num.js`, `envNum`).

`.env.example` documents about 60 of these with comments; the root modules read about 190 in total — the `process.env.X` reads plus the numeric ones that go through `envNum('X')`. The full list is in `REPORT-DOCS.md` §1b.

**Never strip keys from `.env`.** It holds the only copy of live secrets; treat it as append-only and confirm a change from the boot log (`AGENTS.md`).

## Deploying

Railway auto-deploys from `v0-ui-migration`. A commit is not live until the deployed URL serves it; confirm by polling for a marker that only the new build carries (`AGENTS.md`, "Commit ≠ ship"; the deploy poll in `REPORT-DOCS.md`). `/api/health` reports the persistence status of the volume — `persistence.thisBootAt` is when this process booted, so a value later than the push shows a reboot since, though not yet that the new build is the one serving — the state of every checksummed ledger (`ledgers`) and why money is halted (`moneyHalted`, null while it can move), and echoes `GATE_NONCE` when set (`server.js`, `/api/health`; `_gate-helpers.mjs`). The log names, once each, what the server found and would not touch: a store refusing writes (`json-store.js`), a `[migrate]` report, an `[env]` variable it could not use.

## Operational hazards

- **OneDrive file locks.** The working tree lives under OneDrive on the owner's machine. Git operations that delete files under `.git/worktrees/` fail with `Permission denied` when OneDrive holds the file; two stale worktree entries (`create-room-ui`, `mc-guest-whitelist`) print that error on every commit. Report it, do not force it (`OPEN-ISSUES.md`, 2026-09-15; `megachat-pass-a-prompt.md`, "If a git operation fails on a locked file, stop and report").
- **A stale server on the port.** See [Testing methodology](testing-methodology.md); use `startGateServer` from `_gate-helpers.mjs` rather than a bare spawn.
- **A stale build.** `--prod` serves whatever `web/.next` is on disk. Rebuild before judging anything in a browser; `_gate-bounty-claim` refuses otherwise (section G0).
- **LiveKit minutes.** The overlay's lazy connect and the burn breaker exist because an always-connected overlay drained the quota once; `LAZY_CONNECT=0` restores that behaviour and should not be set in production without a reason (`livekit-lazy.config.js`).
- **The local `v0-ui-migration` ref goes stale.** Worktrees push with `git push origin <branch>:v0-ui-migration`; read prod state from `origin/v0-ui-migration`, not the local branch.

## Ports used by gates

Gates pick private ports (3222, 3250–3253, 3288, 3301, …) and refuse to start on one already in use (`_gate-helpers.mjs`, `portInUse`). A local LiveKit SFU and mock OBS (`_gate-mock-obs.mjs`, port 4455-compatible) are started by the gates that need them.
