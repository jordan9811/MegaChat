# 2026-08-24 — platform parity and lockdown

## Headline

**Verification no longer depends on the platform keeping a VOD**, and **the
bounty routes are no longer open**. Those were the two things gating a public
flag-on. Kick is shipped but still unproven, X and pump.fun are parked with
reasons rather than assumptions.

---

## T0 — Housekeeping

Cleaned up what the previous session left behind: dev server on :56440 stopped;
the `OBS_ONECLICK=1` line I appended to local `.env` removed by exact prefix
match (43 keys before and after — every other line there is the only copy of a
live secret); `_dev-mock-obs.mjs` **kept and committed** rather than deleted,
because it is the way to click through the one-click UI with OBS closed, which
the headless gates deliberately do not provide.

Its header now carries the trap it set for me: it squats OBS's own port 4455,
and on Windows binds `127.0.0.1` while a running OBS holds `[::]`, so both bind
and the mock wins for `ws://127.0.0.1`. The symptom is your real OBS password
being rejected as wrong.

## T1 (P0) — Self-capture

**The Kick problem was never "find their VOD". It was "stop needing theirs."**

An air session now holds a rolling in-memory window of the live HLS and, when a
clip playback **ends**, freezes the part covering it. Freezing on *end* is what
makes the unknown 12-25s broadcast delay irrelevant — by then the segments
carrying the clip have arrived, so **the skew never has to be known in advance
to know what to keep**.

The frozen window is then just a seekable video with an unknown offset, which
is exactly what per-VOD calibration already solves. So `CaptureFrameSource`
needed no special verifier handling, and self-capture became primary on every
platform with the Twitch archive as fallback.

**Retention, precisely:** one window per clip playback — **~60s of media, ~22MB
at 720p, per clip** — not the broadcast. Kept **14 days**, purged with its
pledge, age-swept regardless. Capture starts on session open and stops on
close; freezing with no running capture returns null rather than inventing a
file. That boundary is code, not copy, and it is what makes this a verification
capture rather than a recording of someone's stream.

`_gate-self-capture.mjs` **17/0** against a stub live stream (sliding playlist,
advancing media sequence, segments appearing over time, real overlay badges),
with **the server** doing the capturing so the lifecycle, the freeze-on-end and
the verify source preference are all shipped paths. The decoder read **12 badge
frames** back out of a frozen capture.

**The gate caught a bug I had just written:** purging captures at the *start* of
`refundExpired` destroyed evidence for refunds that then failed (illegal
transition mid-verification). Purge now happens only after the refund succeeds,
and the gate asserts a refused refund leaves the capture intact.

## T4 (P0) — Route lockdown

Every bounty route was open — approve, reject, and all of `/admin/*` answered to
anyone who knew the path.

`bounty-auth.js` is one **table of 34 routes**, and registration goes through a
wrapper that looks each path up and **throws on an unknown one**. Authorization
is structural: a route cannot be added without deciding its tier, and the check
runs before the handler, so a handler that forgets is not the hole.

| tier | count | who |
|---|---|---|
| PUBLIC | 8 | anyone — the directory and its numbers |
| FAN | 2 | a signed-in contributor |
| STREAMER | 8 | the authenticated claimant of **that** handle |
| CAPABILITY | 5 | no session possible — the OBS overlay's UUID is the credential |
| ADMIN | 11 | `BOUNTY_ADMIN_KEY`; unset **refuses** rather than falling open |

STREAMER uses the same proof the claim requires, so a Kick session cannot act
on a Twitch handle of the same name.

**Found while gating:** resolving the subject before authenticating gave
anonymous callers a free existence oracle — 404 vs 401 told them whether any
claim, clip or air session existed. Authentication happens first now.

`_gate-bounty-auth.mjs` **19/0**: coverage diffed **both ways**, then every
protected route driven over HTTP anonymously, as the wrong streamer, and as a
same-username Kick session — all rejected — plus the positives.

**The honest cost:** 12 suites called these routes anonymously and all broke.
They now mint **real sealed identities** and authenticate exactly as a streamer
does. No test-only bypass in the auth path — that is the thing that turns out
to be reachable in production.

## T5 (P1) — Sign-in to pledge

`contributor` was whatever the client typed, and strikes attach to it, so
probing the classifier was free: get struck, pick a new name, start over. The
account behind the sealed session is the contributor now; the client's string
survives only as a display label.

**Fresh-account cost after this change: a fresh platform OAuth account.** That
is friction, not money — sign-up is free and instant. It raises probing from
*zero* to "make and verify another account each time" and makes repeat offences
attributable across sessions. It does **not** make abuse expensive. Keying
strikes to the payment instrument once settlement lands is the only thing that
would, and that is filed rather than pretended.

The program gate exposed the change working: its seven fixture "fans" were one
account, so strikes pooled and a first offence read as a repeat.

## T2 (P1) — Kick: shipped, **not run**

`_rehearsal-kick.mjs` mirrors the Twitch rehearsal, verifying off **self-capture**
rather than an archive — which is the whole reason T1 had to land first.

**It did not run: there is no Kick stream key in this environment.** Per the
brief, shipped and reported rather than looped on. To run it you need:

```
KICK_STREAM_KEY   Kick → Creator Dashboard → Stream Settings
KICK_RTMP_URL     same page — PER ACCOUNT, and the harness refuses to guess
KICK_CLIENT_ID / KICK_CLIENT_SECRET   (in Railway already, not in local .env)
```

then `node _rehearsal-kick.mjs --slug <your-slug>`.

Its preflight was itself wrong on first run — a `cmd /c if exist` probe claimed
Chrome was missing on a machine where every other suite drives it. A preflight
that lies about readiness is worse than none, so it uses `existsSync` now.

**Detection on Kick's real encoder vs the synthetic corpus: not measurable
without that broadcast.** Twitch's real encoder verified 4/4 at 720p against a
corpus that claims 100%; Kick is inferred to behave the same and that inference
is exactly what the rehearsal exists to test.

## T3 (P2) — X and pump.fun: investigated, not built

Full writeup in `docs/platform-feasibility.md`.

- **X — park it, confirmed.** Free tier gone; Basic ($200) and Pro ($5,000)
  closed to new signups; pay-per-use ~$0.005/read capped at 2M/month (≈$10k),
  above which **Enterprise ~$42,000/mo**. Live status exists **for Spaces only**
  (`spaces.start`/`spaces.end`, Jan 2026). **No sanctioned pullable stream at
  any tier.** yt-dlp can scrape it; building a money path on unsanctioned
  scraping of X is a business risk, not a technical one.
- **pump.fun — stop.** No official API. The comprehensive spec that exists is
  explicitly **reverse-engineered from live traffic**. One genuinely interesting
  detail: their livestreams **initialise a LiveKit room** — the same SFU we run
  — so integration would be short *if* access were ever sanctioned. That is a
  reason to watch, not to build against a moving target.

The precise reason both are parked: **self-capture removes the VOD requirement
but cannot conjure a stream where the platform offers none.**

---

## Gates

**Full suite green, 0 failures.** bounty-claim 101 · lazy-connect **65 (real
SFU)** · bounty-program 40 · obs-protocol 25 · stream-context 23 ·
quality-and-platform 22 · bounty-ui 20 · bounty-auth 19 · context-http 19 ·
bounty-e2e 19 · **self-capture 17** · cohost-booth 17 (real SFU) · oauth 17 ·
obs-ui 16 · vod-calibration 15 · media-timeline 12 · run-b-pipeline 12 ·
min-duration 10 · p2-moderation 10 · gate-harness 9 · run-b-ocr 6 ·
decoder-codes 4 · overlay (both modes) · auth.

**Gate H: zero transfer calls across 15 bounty modules, settlement stub-only.**
`BOUNTY_CLAIM` off by default.

## Spend

**LiveKit: 0 cloud minutes** — the two SFU suites run the local dev binary.
**External API spend: zero.** Stub HLS, stub Helix, mock obs-websocket, all on
localhost. No Kick broadcast happened, so no platform cost.
