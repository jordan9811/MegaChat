# LAZY CONNECT — handoff

Branch: `fix/livekit-lazy-connect`, branched off **`v0-ui-migration`** (NOT off
the browse deck — this ships independently of that decision). 5 commits, HEAD
builds, gate 20/0.

Findings live in [LIVEKIT-AUDIT.md](LIVEKIT-AUDIT.md). This file is what changed
and how to run/revert it.

## One-line revert
Set `LAZY_CONNECT=0` in the environment. The overlay goes back to connecting on
mount and staying up — today's exact behavior, gate-verified (test G).

The **teardown on pagehide/beforeunload ships unconditionally**, outside the
flag. A LiveKit connection outliving its page is never correct in either mode,
and that missing line is the whole bug.

## What changed

| File | Role |
|---|---|
| `livekit-lazy.config.js` | Every knob in one place. Flag default is **ON**. |
| `livekit-activity.js` | Per-room idle/waking/live/grace machine + session ledger. |
| `server.js` | Wired to the real seat lifecycle; prewarm/beat/health/sessions endpoints; `role:'overlay'` stable-identity token. |
| `public/overlay.html` | Connects only on signal; stable identity; unconditional teardown; retry+heartbeat+poll fallback; reveal gating; status pin. |
| `web/lib/join-page.ts` | Prewarms on join click; warns if the streamer's overlay is closed. |
| `web/components/overlay-health-card.tsx` | Dashboard health card. |
| `rooms-store.js` | Per-room `lazyConnectScope`. |

## How it behaves now
1. **Idle** — overlay holds NO LiveKit connection. Costs nothing.
2. **Join click** (`/api/livekit/prewarm`) — server flips the room to wake and
   pushes `lk_activity` over the existing app WS. Overlay mints a **fresh**
   token and connects. This happens at the earliest credible intent, so the
   handshake completes inside the payment flow, which is much slower.
3. **Seat granted** — already connected; no-op.
4. **Last seat leaves** — grace timer (default 60s). Any new intent cancels it,
   so back-to-back joiners never cause a flap.
5. **Grace expires** — disconnect. Minutes stop.

### Transitions (the part that would look broken if done wrong)
- A seat reveals on the **later** of: track subscribed, stinger past its reveal
  frame. The seat frame is always rendered; only the video texture waits.
- Entry reveal is **not animated** — the stinger is the single transition owner
  on that path. A fade there would stack two transitions and stutter.
- If the stinger finishes first, the tile **holds** with a faint branded breath.
- Reconnect / track restart / camera toggle **never replay the stinger** — they
  get a 200ms crossfade instead.

## Config (`livekit-lazy.config.js`, all env-overridable)
| Knob | Env | Default |
|---|---|---|
| Master flag | `LAZY_CONNECT` | on (`0` disables) |
| Grace window | `LAZY_GRACE_MS` | 60000 |
| Prewarm trigger | `LAZY_PREWARM_TRIGGER` | `join-click` (descriptive only — see call site below) |
| Prewarm TTL | `LAZY_PREWARM_TTL_MS` | 300000 |
| Heartbeat | `LAZY_HEARTBEAT_MS` | 15000 |
| Heartbeat staleness | `LAZY_HEARTBEAT_STALE_MS` | 45000 |
| Long-session warning | `LAZY_LONG_SESSION_MS` | 3600000 |
| Empty/departure timeout | `LAZY_EMPTY_TIMEOUT_S` / `LAZY_DEPARTURE_TIMEOUT_S` | 60 / 20 |
| Signal poll fallback | `LAZY_SIGNAL_POLL_MS` | 4000 |
| Default scope | `LAZY_DEFAULT_SCOPE` | `seat` |

Per room: `lazyConnectScope: 'seat' | 'broadcast'` (see the knob section below).

## Observability — how the next leak gets caught on day one
- `GET /api/livekit/sessions` → currently-open sessions (room, identity, kind,
  minutes, `long` flag), minutes today, minutes this month.
- Any session past `LAZY_LONG_SESSION_MS` logs a loud `[lk-session] ⚠` warning,
  both on close and on a 60s sweep while still open.
- Dashboard card shows overlay state per room.
- Ledger persists to `DATA_DIR/livekit-sessions.json` (gitignored; ephemeral on
  Railway without a volume — fine, it is diagnostics).

## Reliability — the failure mode this introduces
Always-connected could never fail to show a guest; it just billed forever. Lazy
connect can fail as: signal dies → guest pays → nobody appears → refund on a
live broadcast. Mitigations shipped:
- Heartbeat response carries the desired state, so it doubles as the polling
  fallback — a dead WS cannot strand the overlay disconnected.
- Connect retries with capped backoff, only while something still wants it.
- Dashboard card: "Overlay not open" / "not responding" (with seconds since
  last beat) / "On air" / "Ready — sleeping".
- Guest is **warned before paying** if the streamer's overlay is closed. Warn,
  not block — a false negative would kill a legitimate join.

## The broadcast-scope knob (deliberately not the default)
`lazyConnectScope: 'broadcast'` keeps the overlay connected for a whole
broadcast instead of per-seat. Honest math: ~6× better than the old always-on
bug, but a 4h/day streamer still burns **~7,200 min/month**, which does not fit
the free tier. It exists for a streamer who wants zero pop-in risk and will pay
for it. Seat scope stays default.

## Is the free tier enough now?
**Yes, with room to spare — the burn profile is now driven by usage, not uptime.**

Old model (per streamer): OBS open 24/7 → 1,440 min/day → **~43,200 min/month**,
8.6× the 5,000-minute tier, with zero guests. Plus reload churn stacking extra
participants on top.

New model: minutes accrue only while a seat is being bought or held, and the
overlay is one participant alongside the guest. Roughly:

- overlay ≈ guest camera time + ~1 min grace per session
- a 5-minute guest session ≈ 5 (guest) + 6 (overlay) ≈ **11 participant-minutes**
- 5,000 min/month ÷ ~11 ≈ **~450 five-minute paid sessions per month**

For your current testing — a handful of sessions per day — that is comfortably
inside the tier. Realistically the limit now binds on **real paid usage**, which
is the correct thing to pay for: at that point the seats are generating revenue
and Ship ($50/mo) is a cost-of-goods line, not a leak.

Caveat worth knowing: an abandoned join (sheet opened, tab closed without
leaving) holds the connection until the 5-minute prewarm TTL. Twenty of those
is ~100 min. Tighten `LAZY_PREWARM_TTL_MS` if that ever shows up in the ledger.

**The exhausted 5,000 minutes do NOT come back** — the fix stops future burn,
it cannot refund the past. Testing stays blocked until the tier resets (or you
take Ship). Nothing in this branch changes that.

## Verification
`node _gate-lazy-connect.mjs` — needs `tools/livekit-server.exe --dev` running.
**20/0.** Proves: zero minutes accrue while idle (measured as a delta against
the real ledger, isolated DATA_DIR), prewarm connects before any seat exists
under the stable identity, grace holds then releases, signal-drop recovery,
page-close closes the record, both reveal orderings, no stinger replay, no flap,
and `LAZY_CONNECT=0` restoring old behavior.

`node _gate-cohost-booth.mjs` re-run: 17/0, no regression.

## Outstanding — pinned for recirculation when LiveKit testing resumes

Not solved yet, deliberately. Recorded here so they surface again instead of
getting lost between now and the tier reset.

**1. Abandoned prewarms cost more than the happy-path math assumed — this
   changes the capacity number materially.**
   The 450-sessions/month estimate above assumes every prewarm converts to a
   guest. It won't — this is wallet-based onboarding on testnet, and 50–80%
   drop-off between "clicked Join" and "actually paid" is plausible. The real
   problem: **an abandoned prewarm today rides the full `prewarmTtlMs` (5 min)**,
   not the 60s post-session grace, because nothing calls `/prewarm/cancel`
   unless `leaveStream()` runs — and a guest who bails mid-wallet-flow never
   reaches that code path. Recomputing successful-session capacity (not raw
   attempts, since that's the number that matters) across abandonment rates,
   at the current 5-min abandon cost vs. a proposed dedicated ~90s abandon
   timeout (separate from the 60s post-session grace):

   | Abandonment | Sessions/mo — current (5 min abandon cost) | Sessions/mo — with a 90s abandon cap |
   |---|---|---|
   | 0% | 455 | 455 |
   | 50% | 313 | 400 |
   | 80% | 161 | 294 |

   At realistic testnet drop-off, a short abandon-specific timeout roughly
   **doubles** real testing throughput inside the free tier. Not implemented —
   would need a client-side "give up" signal (visibility change / timeout on
   the join page itself) plus a shorter server-side TTL, tuned separately from
   `graceMs` since the two protect against different things (thrash between
   real guests vs. burn from people who were never going to pay).

**2. The derived session ledger is not authoritative — it self-reports.**
   Every number in `/api/livekit/sessions` comes from the overlay telling the
   server what it's doing (`beat(lkState)`). That is the same trust problem as
   client-reported bounty verification: correct today by construction, but
   nothing catches a client that silently stops reporting while still
   connected, or a bug that reports 'live' without actually holding a
   connection. **Reclassifying from "still stubbed" to next-up**: LiveKit
   webhooks (`participant_joined` / `participant_left`) would make the ledger
   authoritative instead of derived, closing exactly the gap this whole
   feature exists to prevent. Needs LiveKit Cloud project webhook config: does
   not work against the local dev SFU this gate uses, so it needs to be
   proven against Cloud once testing resumes.

**3. Ship $50/mo decision needs the actual reset date, which isn't visible
   from here.** The logic holds either way: paying to resume *before* this
   fix would have been re-funding the same leak; paying *after* is buying
   back testing time against a burn profile that's now bounded by real usage.
   Check the LiveKit Cloud dashboard for the reset date before deciding.

## Still stubbed / not done
- LiveKit **webhooks** (`participant_joined/left`) would make the ledger
  authoritative rather than derived from overlay-reported state. Not wired —
  it needs LiveKit Cloud project config and would not work against the local
  dev SFU used by the gate. Current ledger is accurate for the overlay (the
  thing that leaked); guest/booth sessions are not separately recorded.
- The broadcast-scope knob is readable per room but has **no settings-UI row**;
  set it via the room config API. Flagged rather than half-built.
- `empty_timeout` / `departure_timeout` are configured but never applied —
  rooms are auto-created implicitly by LiveKit on first join. Hygiene only, and
  per the audit **not** a cost lever (empty rooms bill nothing).

## Note on branches
`fix/livekit-lazy-connect-stacked-on-deck` is the original line where these
commits sat on top of `feat/browse-deck`. It is kept only as a safety copy —
**use `fix/livekit-lazy-connect`**, which is the same five commits replayed on
`v0-ui-migration` so the cost fix can ship without deciding on the browse deck.
Delete the stacked branch once you are happy.
