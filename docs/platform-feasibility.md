# Platform feasibility — X and pump.fun

Investigated 2026-08-24. **Neither is built and neither should be, yet.** One
question each, answered, then stopped — per the brief.

What MegaChat actually needs from a platform, in order:

1. **Live status** — is this channel broadcasting, and since when? (stream-context)
2. **A pullable live stream** — an HLS/media URL we can read frames from. Since
   self-capture (T1) this no longer requires the platform to keep a VOD, but it
   absolutely still requires a stream we are allowed to pull.

A platform that gives (1) but not (2) cannot be verified at all. That is the
whole test below.

---

## X — park it. Confirmed, not assumed.

**Question: what do live-status and stream access cost and require at current
tiers, and is there any path short of an enterprise agreement?**

**Answer: no path short of Enterprise, and Enterprise still does not obviously
buy requirement (2).**

### Access and cost, as of 2026

- The **free tier is gone** for new developers.
- The legacy flat tiers — **Basic $200/mo** and **Pro $5,000/mo** — are
  **closed to new signups**; existing subscribers are being auto-migrated off
  them since June 2026.
- New developers get **pay-per-use**: ~$0.005 per post read, ~$0.015 per post
  created, **hard-capped at 2M reads/month** (≈ $10,000/mo at the cap).
- Past that cap you are forced into **Enterprise, ~$42,000/mo**.

### Live status: partially available

X added **Spaces lifecycle events** (`spaces.start`, `spaces.end`) to the X
Activity API in January 2026 — subscribe by user id, get told when a Space
starts or ends. That is a real answer to requirement (1), **for Spaces only**.
Spaces are audio rooms, not the general live-video broadcasts a streamer would
play MegaChats on.

### Pullable stream: no sanctioned route found

No documented X API endpoint exposes live video playback or an HLS manifest for
a broadcast. Spaces audio is delivered over HLS internally, but there is no
sanctioned API that hands you the manifest. The recurring developer-forum
question "how do I connect to live Spaces/video broadcasts from the API" has no
official answer.

`yt-dlp` can often pull X broadcasts, and that is exactly the sort of thing
this codebase's extractor seam would make easy — but it is **unsanctioned
scraping of a platform whose API terms are aggressively enforced and whose
pricing exists specifically to stop it**. Building the money path of a product
on that is not a technical risk, it is a business one.

### Verdict

**Parked, and the original instinct was right.** Requirement (1) exists only
for Spaces; requirement (2) has no sanctioned route at any price we could
plausibly pay. Revisit only if X ships a documented live-video read endpoint,
or if a partnership makes Enterprise a real option — at which point re-check
(2) *first*, because Enterprise pricing is about volume, not about capabilities
that do not exist.

---

## pump.fun — undocumented. Stop here.

**Question: is there a documented API surface exposing live status and a
pullable stream? If yes, what would integration take?**

**Answer: no documented surface. There is a large, actively-maintained
REVERSE-ENGINEERED one, which is a different thing and not one to build money
on.**

### What exists

- No official public API or developer documentation.
- A community spec (`BankkRoll/pumpfun-apis`) covers ~245 paths / ~283
  operations, described plainly as **reverse-engineered from live traffic**.
- Livestreams appear in it: `POST https://frontend-api-v3.pump.fun/livestreams/create-livestream`,
  authenticated with a **JWT bearer token** minted by their own frontend.
- The free, no-auth WebSocket feeds around pump.fun (`wss://pumpdev.io/ws` and
  similar) carry **on-chain events** — token creations, buys, sells, wallet
  activity. That is Solana data, not stream data. It answers nothing about
  whether a channel is broadcasting or how to read its frames.

### The one genuinely interesting detail

pump.fun livestreams **initialise a LiveKit room** — the same SFU MegaChat
already runs on. If access were ever sanctioned, the integration would be
unusually short: we already speak LiveKit, and a room token is the only thing
standing between us and both requirements at once.

That is a reason to keep an eye on it, **not** a reason to build. Without a
sanctioned way to obtain a token we would be minting credentials against an
undocumented endpoint, and an endpoint reverse-engineered from traffic changes
without notice, without a changelog, and without any obligation to us.

### Verdict

**Undocumented and unstable — stop, as instructed.** Re-examine if pump.fun
publishes an official API. The LiveKit detail means the work would be small
*if* that ever happens, so the correct posture is to wait rather than to
pre-build against a moving target.

---

## Where this leaves platform coverage

| | live status | pullable stream | verifiable today |
|---|---|---|---|
| **Twitch** | Helix, proven on a real broadcast | VOD + live HLS + self-capture | **yes, proven** |
| **Kick** | api.kick.com, proven in production | live HLS + self-capture (no VOD exists) | **shipped, unproven** — needs one real broadcast |
| **X** | Spaces only | none sanctioned | no |
| **pump.fun** | undocumented | undocumented | no |

Self-capture (T1) removed the VOD dependency, which is what makes Kick viable
at all and would make any *future* platform viable the moment it offers a
readable live stream. It cannot conjure one where the platform offers none —
which is precisely why X and pump.fun stay parked.

Sources: [X API pricing 2026](https://postproxy.dev/blog/x-api-pricing-2026/) ·
[X API changelog](https://docs.x.com/changelog) ·
[X API overview](https://docs.x.com/x-api/overview) ·
[pumpfun-apis spec](https://github.com/BankkRoll/pumpfun-apis) ·
[pump.fun create-livestream](https://www.mintlify.com/BankkRoll/pumpfun-apis/api-reference/livestreams/create)
