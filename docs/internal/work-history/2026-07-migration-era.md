# 2026-07-05 → 07-23 — Migration era

Sources: git log of `origin/v0-ui-migration` (2026-07-07 → 07-23), the root `*_TEST.md` / `*_CHECKLIST.md` records (`MIGRATION_TEMPO.md`, `TEMPO_NOTES.md`, `PHASE2_TEST.md`, `MORNING_TEST.md`, `MEGA_CHECKLIST.md`, `PASS_CHECKLIST.md`, `PASS_NOTES.md`, `UX_AUDIT.md`, `UX_REPORT.md`, `LIVEKIT_NOTES.md`), `DESIGN.md`. This period predates `DECISIONS.md` and `OPEN-ISSUES.md`; the record is thinner and this page says so.

## What shipped

- **The meter rebuilt on MPP session channels on Tempo** — `17a5f09` "meter rebuilt on MPP sessions (TIP-1034 channels) — GATE 9/9 on mainnet" (2026-07-07); parity sweep and per-room payout wallets `189d6eb` "GATE 25/25 on mainnet". The Gateway prepaid join was retired then (`server.js`, `/api/join` → 501).
- **Passkey / embedded-wallet fixes**: "embedded wallets are signers, not RPCs — Privy sessions now work" (`0c394c1`); small wallets no longer auto-kicked (`28e0cbb`).
- **MEGA pass, phases 1–6** (2026-07-10): embedded target stream + watch-to-earn surface, true-live return feed, letter mode on mainnet dust (`856c47d` "GATE 18/0"), persistent handles + `/r/<handle>` + the always-on demo room, OAuth identity (Twitch + X) via a local mock IdP, the latency explainer.
- **LiveKit transport, phases 1–3** (2026-07-11) against a real local SFU; promoted to default transport 2026-07-15 (`e0e5968`, "vdo becomes the backup").
- **Feature + polish pass** (2026-07-15): per-feature pricing and reputation gates, AI moderation (mock API), stinger SFX, Simple/Advanced mode, the how-it-works scoreboard, roadmap timeline; naming settled — recorded clips are MegaChats, the live path is Join Stream (`a901fe3`).
- **Handles without `/r/`** and claiming your own name (`c27e7db`), one front door through Privy ("the second sign-in is deleted", `3a8d55e`), identity read over REST because the SDK dropped Twitch (`6c13380`).
- **Rooms owned by identity**, no password for your own, orphans pruned on deploy, FREE toggle (`f36e490`, `9e13309`, `ef504f4`), fee reserve from measured reality (`08e5117`, "GATE 18/0 real-money").
- **UX audit and repair** (2026-07-18/19): four P0s, five P1s found by a full walk (`ef0158a`); join/leave single-state button, zero payment surfaces in free rooms, one sign-in button; the polish gate 35/0 (`d5d2703`).
- **Three UI passes** (2026-07-21/22): layout surgery, component discipline, noise pass; the dashboard "opens itself" (`de1b6fc`); the booth camera picker self-updates (`dce8522`); the three real-test media failures fixed — lag, mic-only booth, silent guests (`d2595d9`).

## What it found

- The wallet provider was remounting the entire app (`44a5590`).
- `PRIVY_APP_SECRET` invalid in production, made loud rather than silent (`9c4f7a6`).
- A join-client corruption from a P0 patch left the build red for one commit (`13215cf`).
- The "empty price is free" ambiguity — resolved as invalid, not free (`d16fc27`).

## Judgment calls

- Two chains in one tree: `data/rooms.json` is shared with the Arc branches, so Arc-era token addresses are remapped at read time and never rewritten on disk (`rooms-store.js`, `LEGACY_ARC_TOKENS`). This is why `ARC_*` names survive in `.env.example`.
- LiveKit became the default only once real-SFU gates covered reconnect grace, quality and simulcast (`b391491`).

## Verification result

Per-commit gates named in the commit messages (`GATE n/0` throughout). No consolidated suite existed; `OPEN-ISSUES.md` T2 (2026-08-26) records that it still does not.
