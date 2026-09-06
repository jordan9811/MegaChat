# MegaChats roadmap

Product spine: pay-to-join metered on-camera slots. Everything below extends that core without changing the default join flow until shipped.

## Join gating (anti-spam / abuse controls)

Optional pre-join requirements so streamers can throttle low-signal or abusive join attempts. Dashboard stubs are visible under **Advanced → Join gating**; no server enforcement yet.

| Control | Purpose |
|--------|---------|
| **Min watch time** | Require N seconds of focused watch before a viewer can request a camera slot. Reduces drive-by joins and bot spam. |
| **Subscribers only** | Restrict joins to platform subscribers (Twitch/Kick OAuth linkage required). |
| **Followers only** | Restrict joins to followers of the linked channel. |
| **Reputation score gate** | Minimum on-chain or app reputation score before join is allowed. Composable with other gates. |

Planned config shape (not implemented):

```js
joinGating: {
  minWatchSeconds: null,
  subscribersOnly: false,
  followersOnly: false,
  minReputation: null,
}
```

## Integrations

- **Twitch / Kick OAuth** — link channel for subscriber/follower gates and future discovery (`platformLink { provider, oauthId, linkedAt }` per room).
- **Real Twitch Drops OAuth** — credit viewers for external (Twitch/Kick) watch time toward join balance; viewer-side "link to earn drops from watching" stub lives on the join page.

## Rooms

- **Persistent room names** — human-readable, reserved room slugs that survive restarts and can be re-claimed by the owning wallet (today room IDs are random 8-char hex).

## Moderation

- **Sybil-resistant bans** — bans keyed on wallet + linked platform identity (Twitch/Kick OAuth), so a kicked viewer can't rejoin with a fresh burner wallet.

## Stingers (transitions)

- **Stinger transition catalogue + default** — a built-in set of join/leave stinger transitions for camera tiles, with a default that ships enabled.
- **Stinger marketplace** — creators publish/sell custom stingers; streamers equip them per room.

## Rewards (optional module)

Crypto-native “drops” to drive more paid joins. Already stubbed in dashboard; earn/spend logic is isolated from pay-to-join when disabled.

## Overlay placement (pinned 2026-09-06, not built)

Goal: **fewer clicks for manual OBS setup**, and let the overlay live somewhere
other than the top-right. The one-click path already sizes the source itself, so
this is aimed at everyone who adds the browser source by hand — plus anyone
whose facecam occupies the corner we currently assume.

### Why the default size already almost works
The overlay paints far less than the source it sits in:

| Element | Size |
|---|---|
| One tile | 320 × 180 (`TILE_W`/`TILE_H`, overlay.html) |
| Three stacked | 320 × 564 (`+ GAP` 12) |
| Bounty barcode chip | ~30px tall, **fixed px** — no viewport units |

Everything else is transparent, so on a 1920×1080 source under a tenth is ever
painted. Three tiles fit inside OBS's default **800 × 600** browser source, which
is why the old manual instructions said 340 × 620. Nothing has to shrink — the
default just has to be *supported*.

The barcode is a fixed pixel size, so a smaller source does **not** shrink it,
as long as the source is placed 1:1 and not scaled down inside the scene. (An
earlier note in this repo claimed otherwise; it was wrong.)

### What actually blocks it: placement, not size
`#stage` is pinned `top: 20px; right: 20px` and `#bounty-badge` is pinned
`left: 16px; bottom: 16px` — **diagonally opposite corners on purpose**, so the
barcode is never drawn over live video. Shrink the source and the two collapse
together, and the barcode stops being a corner watermark of the broadcast.

### Shape of the fix
Config-driven, read from the `/api/config?room=` call the overlay **already
makes at boot** (overlay.html ~line 670, where `stingerSounds` is read). No URL
params, no re-adding the browser source.

- `overlayCorner: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'`
  — sets the `#stage` anchor. Fill direction falls out of it: top corners stack
  down, bottom corners stack up.
- The barcode takes the **diagonally opposite** corner automatically, which
  preserves the never-over-video invariant by construction.
- Later, fine-tuning in the app: tile size, gap, max visible tiles, with a live
  preview.

Positioning is hardcoded in exactly four places, all in `public/overlay.html`:
the `#stage` rule (~line 33), the three `box.style.top = i * (TILE_H + GAP)`
assignments, and the `stage.style.height` line in `relayout()`.

### Guardrails
- **Clamp or warn** when `maxSeats × (TILE_H + GAP)` exceeds the source height —
  at 800 × 600 that is three tiles, so a future seat-count rise overflows silently.
- Keep the barcode **1:1**: the verifier measures its rendered height in the
  captured broadcast frame against `minCodePixelHeight` (12px). Moving its corner
  does not change its height; scaling the source in the scene does.

**Retest cost: minor.** A normal room has no barcode at all, so the capture and
verification stack is untouched there. For a bounty room the only new failure
mode is a corner collision between tiles and barcode, which the
diagonally-opposite rule prevents.
