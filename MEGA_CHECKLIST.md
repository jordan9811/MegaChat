# MEGA_CHECKLIST — MEGA pass 2026-07-08

Baseline `ae390fc` → six phases, each gated and committed separately.
Production build + 7-page sweep clean (zero first-party console/network
errors, zero dead links). Payment/meter/passkey core untouched except the
explicit Phase-3 extension (one-voucher letter payments over the same rails).

| Phase | Status | Commit | Gate |
|---|---|---|---|
| 1 — Twitch embed + watch-to-earn surface | **landed** | `9567716` | 12/0 |
| 2 — true-live return feed (host cam) | **landed** | `5382621` | 8/0 + 1 human-verify |
| 3 — letter mode | **landed** | `856c47d` | 18/0 (real mainnet dust) |
| 4 — /r/&lt;handle&gt; + demo room | **landed** | `4f7c803` | 17/0 |
| 5 — OAuth identity (Twitch + X) | **landed** (env-gated) | `632ae10` | 13/0 via mock IdP |
| 6 — latency explainers | **landed** | `50e5f49` | 7/0 |

No phase hit the 3-fail rule; no FAILED_*.md; no resets.

## Needs live human verification

1. **Phase 2 — host feed media flow.** Automated browsers can't complete
   vdo.ninja's publish handshake on this machine (your real camera is in
   use; synthetic cams never finish signaling — 3 harness variants tried).
   All wiring is gate-proven. Verify in 30s: open the dashboard's **Host
   cam** link while streaming, go live from a phone, confirm you see/hear
   yourself sub-second and the Twitch embed silences during the slot.
2. **Phase 3 — a letter end-to-end from the real join page** (record →
   pay via Privy → watch it pop on the overlay). The pipeline is gate-proven
   with raw-key payments + real webm; the Privy-signer path is gate-proven
   separately (`_gate-mpp-clientpath.mjs`) — this checks the two together.
3. **Phase 5 — real OAuth round-trips.** The full flow is gate-proven
   against a mock IdP through the real handlers. To light the buttons up:
   create a Twitch app (redirect: `https://<domain>/auth/twitch/callback`)
   and an X app with OAuth2 + PKCE (redirect: `https://<domain>/auth/x/callback`),
   then set the env vars below. Without them the buttons honestly say
   "not configured".
4. **Demo room on prod:** first boot seeds it and LOGS a random dashboard
   password — set `DEMO_ROOM_PASSWORD` on Railway BEFORE the deploy if you
   want a known one, else fish it from the deploy logs.

## Env vars to add on Railway (all optional, feature-gating)

- `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` — enables "Continue with Twitch"
- `X_CLIENT_ID` / `X_CLIENT_SECRET` — enables "Continue with X"
- `AUTH_SECRET` — pins identity-cookie signing (defaults to `MPP_SECRET_KEY`)
- `DEMO_ROOM_PASSWORD` — pins the demo room's dashboard password

## Known limits / deliberate choices

- Host stream id is deterministic (`mc-host-<roomId>`): someone who knows
  the scheme could squat the publish slot before the host connects
  (vdo.ninja rejects the second publisher). Same trust model as seat ids;
  roadmap: secret suffix.
- Letter reject/expiry refunds come from the **platform** wallet even for
  rooms with their own payout wallet (settlement already went to the
  streamer). Dust-level exposure; revisit if letter prices grow.
- Letters live in memory only (by design): a server restart drops queued
  letters (paid ones would need manual refunds — queue is capped at 10/room,
  25MB/letter, 120MB global, so exposure is minutes-not-hours).
- OAuth is identity ONLY — no platform watch-verification, no native drops
  (both on the roadmap page already).
- Identity handles vs room handles live in two registries with cross-checks
  at the claim APIs; a simultaneous-claim race is theoretically possible and
  harmless (first write wins at the store level).
- `data/identities.json` is gitignored and branch-shared like rooms.json.
