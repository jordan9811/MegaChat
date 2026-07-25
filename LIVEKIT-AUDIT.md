# LIVEKIT CONNECTION LEAK — AUDIT

Date: 2026-07-25. Branch: `fix/livekit-lazy-connect`. Status: **leak identified, code-confirmed.**

## Verdict

**The OBS overlay page (`public/overlay.html`) is the leak.** It opens a LiveKit
subscriber connection the instant the browser source loads and **never closes it** —
there is no `disconnect()`, no `beforeunload`, no `pagehide`, and no visibility
teardown anywhere in the file. An OBS browser source that sits open is a connected,
billed participant for as long as OBS is running.

A second, compounding mechanism (below) explains the 26-participant count on a single
session and makes the burn **worse than linear**.

Hypotheses 2 and 3 from the brief are **ruled out** by the code: the booth is already
lazy, and no browse/preview/landing surface instantiates a `Room`.

## Offending identity

`viewer:<8 random base36 chars>` — minted at [server.js:1080](server.js:1080) for
`role: 'subscriber'`, which is what the overlay requests at
[public/overlay.html:520-524](public/overlay.html:520). In session `RM_5SBzgdcHoxXh`,
the participant sitting near 1,800 minutes will carry a `viewer:` prefix. It is the
only identity class in the codebase that can survive multiple hours — `seat:` dies
with the paid seat, `host:` dies on the booth's grace timer.

Room `mc-513c020a` = MegaChat room `513c020a` (`lkRoomName = mc-${roomId}`,
[livekit.js:26](livekit.js:26)). Hex id ⇒ a dashboard-created room, i.e. a real test
room, not the code-seeded `default`/`demo`. Jul 22 9:33 PM → Jul 24 3:38 AM is OBS
left running across two nights.

## Mechanism 1 — connect on mount, never disconnect

[public/overlay.html:551](public/overlay.html:551) calls `initLivekitOverlay()`
unconditionally at script top level. That function fetches a subscriber token and calls
`lkOverlayRoom.connect(...)` at [line 546](public/overlay.html:546).

Teardown search over the entire file — `disconnect`, `beforeunload`, `pagehide`,
`unload` — returns **zero matches**. The connection's only exit is process death
(OBS closing or the page being replaced).

Cost: 1,440 min/day = **43,200 min/month per streamer**, 8.6× the entire 5,000-minute
free tier, accrued whether or not a single guest ever pays.

## Mechanism 2 — reload churn mints a NEW identity each time (the multiplier)

[public/overlay.html:886-888](public/overlay.html:886):

```js
ws.onclose = () => { setTimeout(() => location.reload(), 3000); }
```

Every app-WebSocket blip reloads the overlay, which runs `initLivekitOverlay()` again
and connects **under a fresh random identity** (`viewer:` + `Math.random()`).

Because the identity is random rather than stable, LiveKit cannot dedupe. A stable
identity would evict the previous participant on rejoin (identity collision kicks the
old session immediately); a random one leaves the stale participant connected until
LiveKit's own reaper takes it. Reload churn therefore **stacks overlapping billed
participants** in the same room.

This is the direct explanation for **26 participants inside one 30-hour session** when
real usage was ~2 people. It also fits the fleet of 46–53s single-participant sessions:
short-lived overlay connections in otherwise-empty rooms, cycling.

Stable identity is a cheap, independent fix and lands regardless of lazy connect.

## Per-path audit

| # | Path | File / line | Connect trigger | Disconnect trigger | Can outlive purpose? |
|---|------|-------------|-----------------|--------------------|----------------------|
| 1 | **OBS overlay** | [overlay.html:551](public/overlay.html:551) → [:546](public/overlay.html:546) | **Page load, unconditional** | **NONE** | **YES — the leak** |
| 2 | Booth (host cam) | [host-cam-card.tsx:99-110](web/components/host-cam-card.tsx:99) | `armed && liveCount > 0` (guest on camera) | Unmount [:83](web/components/host-cam-card.tsx:83), disarm-mid-connect [:113](web/components/host-cam-card.tsx:113), falling-edge grace timer | No — already lazy |
| 3 | Guest publisher | [join-page.ts:1535-1544](web/lib/join-page.ts:1535) | `startLivekitCameraStage(data)` — requires a granted `data.seatId` (paid) | [:1599](web/lib/join-page.ts:1599) | No — gated on a paid seat |
| 4 | Guest's host-feed | [join-page.ts:1451](web/lib/join-page.ts:1451) | Reuses `lkRoom` (`if (!lkRoom) return`) | Shares #3 | No — no second connection |
| 5 | Browse / landing / deck | — | **No `Room` instantiated anywhere** | n/a | No |

Repo-wide, only **four** `Room` objects can exist (`new LK.Room` / `new lk.Room`):
overlay ×1, booth ×1, guest ×1, and none on any public surface.

## Brief's checklist, answered

1. **Overlay connects on mount and stays for as long as OBS is open** — ✅ **CONFIRMED**, the leak.
2. **Booth/room page connecting on mount** — ❌ ruled out. Booth connects on seat-occupied and already runs a grace timer. It is the correct model to copy.
3. **Browse/preview/landing instantiating a Room** — ❌ ruled out, zero instantiations.
4. **Reconnect loops** — ⚠️ **partially confirmed, and worse than a loop**: the overlay full-page-reloads every WS drop and reconnects under a *new random identity*, stacking billed participants (Mechanism 2).
5. **Missing teardown** — ✅ **CONFIRMED for the overlay only** (no disconnect/beforeunload/pagehide). Booth and guest both tear down correctly.
6. **Long/default `empty_timeout` / `departure_timeout`** — ⚠️ true but **not a cost factor**: rooms are auto-created implicitly on first join, no explicit timeouts are set ([livekit.js](livekit.js) mints tokens only, never calls `createRoom`). Billing is per *participant*-minute; an empty room bills nothing. Worth setting for hygiene, not for savings.

## Burn accounting

Roughly, against the 5,000-minute tier:

- 30h session, overlay alone: **~1,805 min**
- 343-min session + 31-min session: **~374 min**
- Overlap from reload churn across 26 participants: the balance, several thousand
  participant-minutes on top of the room-session wall time

Actual human camera time was under an hour. **Essentially 100% of the burn is
overlay idle time**, not usage.

## Consequences for the fix

- Lazy connect on the overlay is the whole ballgame — it is the only path that leaks.
- Ship **stable overlay identity** (`overlay:<roomId>`) alongside it: it fixes the
  stacking multiplier on its own and makes reconnects idempotent.
- The booth needs no rearchitecture; its arm→occupied→grace pattern is what the
  overlay should adopt.
- Add teardown on `pagehide`/`beforeunload` regardless of flag state — a connection
  that outlives its page is never correct.
