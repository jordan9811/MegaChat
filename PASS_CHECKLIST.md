# FEATURE + POLISH PASS — checklist (2026-07-15)

Every phase gated against a real prod build (`next build` + `node server.js --prod`)
with headless Chrome; real dust payments where money moves. Payment/meter/passkey
core logic untouched except where a phase explicitly extends it. No .env vars removed.

## What landed

### NAMING — recorded = "MegaChat" 📼, live = "Join Stream"
- Every user-facing surface swept: join page, dashboard, docs, overlay label,
  toasts, API error strings. Code/API identifiers (`letters`, `letter_*`) unchanged
  on purpose — wire compatibility.
- **Fallback:** n/a (copy only).

### P1 — per-feature pricing + gates (GATE 15/0)
- MegaChats and Join Stream are separately priceable/toggleable per room.
- Join Stream **inherits MegaChat gates by default** ("same as billing address"),
  with an override checkbox exposing its own gate fields.
- Min-watch-time gate is **enforced server-side** on both `/api/join/mpp` and
  `/api/join/passkey` (403 with watched/required seconds + a hint); watch-time
  ledger ticks 1s for visible, signed-in watchers. Followers/subs gates are
  stored + shown "(soon)" — enforcement arrives with Drops OAuth phase 2.
- **Fallback:** rooms with no new config fields behave exactly as before
  (additive fields; rooms.json is shared across branches).

### P2 — AI moderation for MegaChats (GATE on mock + real pipeline)
- Recorded clips only, never live seats. Frames (≤5, sampled during recording)
  + whisper transcript → moderation API; flagged clips land in the approve
  queue with a human-readable reason; strictness `severe`/`borderline` per room;
  auto-refund-on-reject default ON (off = keep the payment).
- Sender sees "reviewing…" then the verdict; verdicts in seconds, not minutes
  (15s fail-open timeouts per call).
- **Fallback:** no `MODERATION_API_KEY` → pipeline identical to before the
  feature existed. **No key, no fake verdicts.**

### P3 — stinger SFX (GATE 11/0)
- Every entrance/exit stinger has a WebAudio-synthesized sound timed to its
  animation beats (no audio assets to load). Per-room toggle, default on.
- OBS note in dashboard: control audio via the browser-source volume in OBS.
- **Fallback:** toggle off → overlay behaves exactly as before.

### P4 — Simple / Advanced mode (GATE 11/0)
- Global pill next to the theme toggle (landing + join headers), persists like
  the theme, applied pre-paint (`data-ui` on `<html>`, zero flash).
- **Simple:** amounts render as credits (1 credit = 1 second of Join Stream at
  the room's rate; streamer prices the credit in $ — USDC is 1:1), crypto lingo
  hidden, address behind an "account details" expander, "Add funds" instead of
  "Fund wallet", dashboard prices read "Price per credit ($)".
- **PRESENTATION ONLY** — nothing in the payment path reads the mode; same
  balances, same transactions.
- **Advanced:** the app exactly as today (gate-asserted).
- Docs adapt where lingo differs (stats strip, rails, step bodies).

### P5 — how-it-works darts scoreboard (GATE 13/0)
- VIEWERS column (magenta) left, STREAMERS (cyan) right, step numbers 01–06 on
  a dashed spine between them; mobile stacks number → viewer → streamer with
  side tags. Copy preserved; stale Arc/Gateway lines refreshed to Tempo.
- Bonus catch: header overflowed 375px after P4's pill — auth button now reads
  "Log in" below `sm`.

### P6 — roadmap timeline (GATE 16/0)
- Forward view (default): 8 items, strict priority order, horizon-colored —
  green near / amber mid / purple ambitious.
- "Our journey" back-arrow toggle: 9 milestones from the Feb 2026 MetaMask
  prototype (tweet-linked via `JOURNEY_TWEET_URL`) to OAuth + /r/ handles,
  ending at a Today marker.
- `/roadmap` is now request-time dynamic so both URLs below take effect on
  restart, no rebuild.

## Env vars for YOU to fill (locally AND on Railway)

| Var | What it does | Unset behavior |
|---|---|---|
| `MODERATION_API_KEY` | Turns on AI review of MegaChats (OpenAI key) | Moderation off — clips queue exactly as before, no fake verdicts |
| `MODERATION_API_BASE` | Optional: point at a compatible endpoint | Defaults to `https://api.openai.com` |
| `CONTACT_URL` | The Contact link in every nav/footer | Falls back to `https://x.com/megachat` |
| `JOURNEY_TWEET_URL` | "Watch the first demo →" link on the Feb 2026 roadmap milestone | Quiet "(tweet link coming soon)" placeholder |

All four are in `.env.example`. On Railway: add under Variables, then redeploy
(CONTACT_URL / JOURNEY_TWEET_URL only need a restart since /roadmap and / are
request-time dynamic).

## Verify on the live URL after deploy

1. **Naming:** join page says "Send a MegaChat 📼" and the live path reads
   "Join Stream" everywhere (dashboard, docs, overlay tile label).
2. **Simple mode:** flip the SIMPLE/ADV pill (landing header + join header) —
   join page shows "1 credit / per second on camera", wallet line hides the
   address behind "account details", price re-renders live when toggling.
   Flip back: USDC amounts identical to before.
3. **Gates:** set a min-watch gate on a room → fresh wallet gets the friendly
   403 hint on join; watch that long → join succeeds.
4. **Moderation (after adding the key):** send a MegaChat → sender sees
   "reviewing…", clean clip plays in seconds; a spicy test clip lands in the
   dashboard approve queue with a reason; reject refunds by default.
5. **SFX:** join with a stinger → sound fires with the animation in the OBS
   overlay; per-room toggle silences it.
6. **Scoreboard:** /how-it-works shows viewers-left / streamers-right with the
   numbered spine; stacks cleanly on a phone; light + dark both read well.
7. **Roadmap:** forward timeline is green→amber→purple top to bottom; the
   back-arrow reveals the journey; the Feb 2026 milestone links to your tweet
   once `JOURNEY_TWEET_URL` is set; Contact everywhere points at `CONTACT_URL`.
8. **Privy note:** localhost consoles show a Privy frame-ancestors warning —
   expected (domain allowlist); it does not occur on the Railway domain.

## Gate + sweep summary

| Phase | Result |
|---|---|
| P1 features/gates | 15 pass / 0 fail |
| P2 moderation | all scenarios (no-key / pass / flag / no-refund) green |
| P3 stinger SFX | 11 / 0 |
| P4 simple mode | 11 / 0 |
| P5 scoreboard | 13 / 0 |
| P6 roadmap | 16 / 0 |
| Final sweep | 6 pages × 2 modes, 84 internal links, 0 dead, 0 errors (Privy localhost notice aside) |
