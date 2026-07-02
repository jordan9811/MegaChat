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
