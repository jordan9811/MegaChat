# Platform feasibility — X and pump.fun

Investigated 2026-08-24, **pump.fun re-investigated 2026-08-25 and the verdict
reversed**. Neither is built. X should still not be. pump.fun should be, and
the first pass said otherwise because it read documentation instead of opening
the page — see the note at the end of that section.

Read the pump.fun section as superseding anything earlier in this file that
disagrees with it.

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

## pump.fun — I was wrong. It serves plain, pullable HLS.

**Superseding the assessment above it**, which said "undocumented, LiveKit
WebRTC, stop." That was reasoned from documentation and a community spec. This
is reasoned from **opening eight live streams and recording every request the
player made** — `_probe-pumpfun.mjs`, run 2026-08-25.

The earlier conclusion was not merely incomplete, it pointed the wrong way. It
took "livestreams initialise a LiveKit room" — which is true — and inferred
that playback is therefore WebRTC-only, which is false. Both things are there,
and **the one that matters to us is the one nobody had looked for.**

### What a pump.fun livestream actually serves

```
https://clips.pump.fun/<mint>/<streamid>_<date>/master_playlist_<date>.m3u8
```

A standard HLS master playlist with three renditions:

| rendition | resolution | fps | bandwidth |
|---|---|---|---|
| 0 | **1920×1080** | 60 | 6.0 Mbps |
| 1 | 1280×720 | 30 | 3.0 Mbps |
| 2 | 640×360 | 20 | 0.8 Mbps |

Media playlists carry **2-second MPEG-TS segments** (`video/MP2T`, sync byte
0x47 confirmed, ~800 kB each at 1080p60) and — notably — an
**`EXT-X-PROGRAM-DATE-TIME` on every single segment**.

**Our server can pull it.** Fetched from Node, outside any browser, with no
cookies, no token, no referer and no login: **HTTP 200**, both the manifest and
the segments. That is the entire requirement.

**It follows the live edge.** Sampled 14 seconds apart, the playlist gained 7
segments — exactly 14 seconds of media, in real time.

**8 of 8 live streams served it**, sampled across the currently-live listing.

### The two things that are genuinely different from Twitch and Kick

**1. The playlist is APPEND-ONLY, and gets long.** `EXT-X-MEDIA-SEQUENCE`
stays pinned at 0, there is no `EXT-X-ENDLIST`, and the list simply grows: a
stream 100 minutes in listed **3,063 segments in a 320 kB playlist**. Twitch
and Kick slide, and list about six.

That mattered immediately. A rolling capture that walks the playlist from the
top would have tried to download **~2.4 GB of back catalogue** before reaching
the live edge. `bounty-capture.js` now enters at the tail on any playlist
shape (`liveEdgeSlice`), which is where a *live* capture always should have
started — the old behaviour was only ever safe by accident, because the two
platforms we had both happened to slide.

The 320 kB manifest is still re-fetched every poll (2s default), which is
~160 kB/s per air session on manifests alone. Not a blocker; worth sizing for
before enabling pump.fun, and an argument for a slower poll there.

**2. `EXT-X-PROGRAM-DATE-TIME` makes calibration mostly unnecessary.** The
hardest part of Twitch verification was that a VOD's media timeline sits an
unknown ~15-17s behind our wall clock, which is why
`bounty-timeline-calibration.js` exists at all. pump.fun stamps wall-clock
UTC on every segment. A verifier could read the offset instead of measuring it.

### LiveKit: yes, and the token is client-side — but it is now beside the point

One of the eight probed sessions loaded no HLS at all and instead opened
`wss://pump-prod-<id>.livekit.cloud/rtc?access_token=<413-char JWT>`. So the
answer to "are the room URL and token discoverable client-side" is **yes** —
an anonymous headless browser with no account obtained both.

**That does not make it a route to take.** Joining someone's LiveKit room with
a token minted for a page view means participating in their session under
credentials issued for something else, against an undocumented endpoint, with
no agreement covering it. The HLS pull is a public GET of a public stream and
needs none of that argument. **Recorded as an observation, explicitly not a
plan.** The delivery path appears to vary per session; when HLS is absent the
correct behaviour is to say so, not to fall back to the room.

### Headless screenshot: works, and is ~100× the cost of not doing it

Asked and answered even though the HLS finding makes it moot here, because it
is the fallback for any future platform that really is WebRTC-only:

- **It renders.** Headless Chrome plays the stream at **1920×1080**,
  `readyState=4`, unpaused, via MSE (`blob:` src).
- **No DRM.** Zero `requestMediaKeySystemAccess` calls across every run.
- **No canvas fingerprinting.** Zero `toDataURL` reads.
- A clickwrap dialog is present. **Playback works with it untouched** — the
  probe accepts nothing, and did not need to.
- **Cost: 0.96 CPU-seconds per second of playback** (measured across the whole
  Chrome process tree, not the driver). That is **one concurrent verification
  per core, before frame extraction and OCR**, plus ~3s of CPU just to load the
  page. Pulling HLS costs a fetch and a byte-concat.

Cloudflare bot management is in front of the site (`cdn-cgi/challenge-platform`
fired on every load). It did not challenge a plain headless visit, but it is
there, and it is a standing reason to prefer the media-only path that never
touches the HTML.

### Verdict

**Un-park it.** pump.fun is technically the *easiest* platform we have looked
at after Twitch: it serves a higher-quality ladder than Kick, from a plain
public URL, with a wall-clock stamp Twitch does not give us.

What is still missing is not technical:

- **Live status.** `frontend-api-v3.pump.fun/coins/currently-live` answers it
  and the site's own frontend uses it, but it is **reverse-engineered, not
  documented**, and can change without notice. Same caveat as before — it just
  applies to a much smaller part of the problem now.
- **Identity.** MegaChat pays the *verified owner* of a handle. pump.fun
  streams are keyed to a coin mint, not to an account we can OAuth against.
  **This, not video, is the real blocker**, and no amount of HLS fixes it.
- **Permission.** Everything above is a public GET, but there is still no
  sanctioned agreement, and the discovery endpoint is undocumented.

Reproduce any of this in one command:

```
node _probe-pumpfun.mjs --sweep --sweep-n 8
```

## Where this leaves platform coverage

| | live status | pullable stream | verifiable today |
|---|---|---|---|
| **Twitch** | Helix, proven on a real broadcast | VOD + live HLS + self-capture | **yes, proven** |
| **Kick** | api.kick.com, proven in production | live HLS + self-capture (no VOD exists) | **shipped, unproven** — needs one real broadcast |
| **X** | Spaces only | none sanctioned | no |
| **pump.fun** | undocumented API (works, unsanctioned) | **yes — public HLS, 1080p60, PROGRAM-DATE-TIME** | **video: yes. Blocked on IDENTITY, not on capture** |

Self-capture (T1) removed the VOD dependency, which is what makes Kick viable
at all and would make any *future* platform viable the moment it offers a
readable live stream. It cannot conjure one where the platform offers none —
which is precisely why **X** stays parked.

**pump.fun is no longer in that category.** It offers a readable live stream,
and the assessment that said otherwise was inference from documentation rather
than observation of the wire. The lesson generalises past this one platform:
for the "is there a pullable stream" question, **open the page and record the
requests before writing the verdict** — it takes twenty seconds and it is the
difference between "parked indefinitely" and "the easiest platform we have."

Sources: [X API pricing 2026](https://postproxy.dev/blog/x-api-pricing-2026/) ·
[X API changelog](https://docs.x.com/changelog) ·
[X API overview](https://docs.x.com/x-api/overview) ·
[pumpfun-apis spec](https://github.com/BankkRoll/pumpfun-apis) ·
[pump.fun create-livestream](https://www.mintlify.com/BankkRoll/pumpfun-apis/api-reference/livestreams/create)
