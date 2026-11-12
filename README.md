# Holler

**Get on the stream, not just in the chat.** Holler lets viewers put themselves on a streamer's live broadcast: a recorded clip that plays on stream, or a live camera seat billed by the second. Fans can also pool money to bring a streamer on, and streamers can pay viewers to show up.

Live at **[hollertv.com](https://hollertv.com)** · pre-launch

## What it does

| | |
|---|---|
| **Holler** | Record a short clip. It clears the room's moderation, then plays on the stream. |
| **Call in** | Take a live seat: your camera appears in a tile on the broadcast, metered per second at the streamer's rate. Leave, and the tile goes. |
| **Pledge** | Back a streamer who isn't on Holler yet. The pool pays out when they go live and verify the channel on air. |
| **Campaigns** | A streamer funds a budget and pays viewers per Holler or call-in that airs. Whatever isn't paid out is refunded. |

The streamer adds one browser source to OBS. Viewers need nothing but a link.

## How it's built

- **One Node process.** An Express server (`server.js`) owns the API, WebSockets and the OBS overlay, and mounts the Next.js app in `web/` as its fallthrough handler.
- **Live video** runs on LiveKit. The overlay connects lazily, so an idle stream doesn't hold a room open.
- **Sign-in** is Privy.
- **Money** is USDC on the Tempo chain via viem. Live seats are metered per second (`meter-mpp.js`, with a seat escrow contract in `contracts/MegaChatEscrow.sol`). Every server-side transfer goes through one of two doors: `settlement.js` (platform wallet) or `escrow-chain.js` (escrow contract).
- **Bounty verification** doesn't trust the streamer's word. The overlay renders a rotating code per air session, and a verifier reads it back out of the public broadcast's frames before anything is paid (`bounty-verifier.js`, `bounty-claim.config.js`).
- **Frontend:** Next.js 16, React 19, Tailwind 4.

## Repository map

| Path | What's there |
|---|---|
| `server.js` | The server: rooms, seats, overlay, and the mount for the web app |
| `web/` | The Next.js app: landing page, rooms, dashboard, bounties, campaigns |
| `bounty-*.js` | Bounty program: ledger, escrow state machine, claim verification, settlement |
| `campaign-*.js` | Reward campaigns: eligibility rules, funding, payouts, refunds |
| `livekit*.js` | Live video: tokens, webhooks, lazy connect, circuit breaker |
| `settlement.js`, `escrow-chain.js`, `meter-mpp.js` | The money paths |
| `contracts/` | The seat escrow contract and its deployment record |
| `public/` | The OBS overlay and other static pages |
| `_gate-*.mjs` | End-to-end gates (see below) |
| `docs/` | The handbook: concepts, features, verification, technical reference |

## Testing

There are 100+ end-to-end **gates** (`_gate-*.mjs`). Each one boots the real server, authenticates with real minted credentials (no test-only bypass in the auth path), and drives it with Puppeteer or direct API calls. The money gate (`_gate-money.mjs`) has to stay green for any change that touches a payment path. Shared harness: `_gate-helpers.mjs`.

```bash
node _gate-demo-credit.mjs   # run one gate
npm run docs:verify          # every claim in docs/ still points at real code
```

## Running it locally

Requires Node 22.

```bash
npm install                  # also installs web/
cp .env.example .env         # fill in the keys you need; see the comments in the file
npm run dev                  # http://localhost:3000
```

For a production build: `npm run build && npm start`.

## Notes

- The product was called MegaChat until the October 2026 rebrand, so some code, routes and data keys still use that name.
- `v0-ui-migration` is the shipping branch: Railway deploys it on every push.
- Design decisions and their reasoning are in [`DECISIONS.md`](DECISIONS.md); known gaps are in [`OPEN-ISSUES.md`](OPEN-ISSUES.md).
