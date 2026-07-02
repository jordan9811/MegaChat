# Join page + overlay design-system port — test record

Branch `v0-ui-migration`, commits: baseline → "port join page + overlay to
design system, add gating stubs". Date: 2026-07-02.

## What changed

- **New viewer join page**: `web/app/join` (`/join?room=<id>`), MegaChat design
  system (glitch background, chromatic heading, glass cards, neon accents,
  Space Grotesk/Inter). This is now the **primary** viewer page — the
  dashboard's Viewer copy-link points at it. The legacy Express page
  (`http://localhost:3000/?room=<id>`) remains untouched as a fallback.
- **Logic reuse**: `web/lib/join-page.ts` is the inline script from
  `public/index.html` + `public/rewards.js` ported **verbatim** — the only
  diffs are transport glue, listed at the top of the file: WS URL points at
  the backend origin, handlers bind via addEventListener instead of inline
  onclick, the passkey-bundle import gets a bundler-ignore comment, an
  initJoinPage/cleanup wrapper, and the fund-note copy no longer hardcodes
  localhost:3000. No payment / join / meter / passkey / MetaMask / WebSocket
  logic changed. Zero backend files changed (verified by git diff).
- **Passkey bundle**: `/passkey-wallet.bundle.js` proxied to the backend via a
  Next rewrite so the join page imports it same-origin.
- **OBS overlay**: left on the Express origin, byte-identical
  (`git diff baseline..HEAD -- public/overlay.html` is empty). Reason: OBS
  never sees the design system, the overlay needs its exact transparent
  rendering + WS origin, and moving it adds risk for zero visual benefit.
- **Dashboard additions**: Join-gating stubs (disabled, "Coming soon"
  tooltips) under Advanced — Minimum watch time, Reputation score gate,
  Subscribers only, Followers only, labeled as anti-spam/abuse controls.
  New Integrations card (streamer side): "Connect Twitch / Kick account —
  coming soon / credit viewers for external watch time". Join page (viewer
  side): "Link Twitch / Kick — link to earn drops from watching — coming
  soon". ROADMAP.md extended with Twitch-Drops OAuth, persistent room names,
  sybil-resistant bans, stinger catalogue + default, stinger marketplace.

## Verified (headless, against the live backend)

| Check | Result |
|---|---|
| `next build` + typecheck | ✅ clean, `/join` route emitted |
| `/join?room=<id>` loads real room config | ✅ price/label/title/caps from `/api/config` |
| Wallet detection states | ✅ "No MetaMask detected"; passkey button enabled (modularWallets configured) |
| Watch-to-earn client (ported rewards.js) | ✅ earned 60 USDC credits over backend WS; Earned row rendered |
| Real seat join (earned-balance path) | ✅ seat assigned, camera stage revealed |
| Camera lifecycle | ✅ GO LIVE fallback appeared at 5 s, `camera_ready` sent, status → "You're LIVE on stream" |
| **Real per-second meter in new UI** | ✅ Remaining 54→51, Spent 6→9, 0:54→0:51 over 3 s via WS `meter_update` |
| Leave button | ✅ teardown + "refunded" message + server seat count 0 |
| Passkey bundle via proxy | ✅ `window.PasskeyWallet` loaded with all real exports after clicking Passkey |
| Overlay | ✅ unchanged bytes, serves at `/overlay?room=<id>` with title "Stream Overlay" |
| Gating stubs | ✅ all four present + disabled with tooltips |
| Twitch/Kick stubs | ✅ dashboard card + join-page row |
| Dashboard Viewer link | ✅ now `<next-origin>/join?room=<id>`; OBS link still backend overlay |

## Verify live (needs a real device/wallet — not testable headlessly)

1. **Passkey end-to-end on the new page**: WebAuthn create/get prompt,
   `authorizeSessionGasless` userOp, seat confirm, silent per-second pulls.
   (Bundle load + `initModularClients` verified; the ceremony needs a real
   authenticator.)
2. **MetaMask end-to-end on the new page**: connect, Arc chain add/switch,
   Gateway deposit prompt flow, EIP-712 sign, settle, refund on leave.
3. **Camera publish with a real webcam** — auto-detect (`push-connection`)
   should fire without the GO LIVE fallback.
4. OBS overlay with a live seat from the new join page (same room id).

## Notes

- Test room `aa0d1de8` ("join-port-test", password `test1234`) was created in
  `data/rooms.json` during verification; the backend had been restarted and
  rooms.json reset, so the earlier `ef1ff57f` room no longer exists.
- The dev-only React console warning about the `next-themes` inline script
  tag predates this change (stock v0 template behavior).
