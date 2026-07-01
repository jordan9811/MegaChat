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

## Rewards (optional module)

Crypto-native “drops” to drive more paid joins. Already stubbed in dashboard; earn/spend logic is isolated from pay-to-join when disabled.
