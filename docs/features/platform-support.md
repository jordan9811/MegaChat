# Platform support

Which streaming platforms MegaChat can verify a bounty on, and what each one gives up. The single source for both the verifier's behaviour and the words a streamer is shown is `PLATFORM_PROFILES` in `bounty-claim.config.js`; the proofs are individual real broadcasts recorded in `OPEN-ISSUES.md`. Status is **per platform**.

What a platform has to provide, in order (`docs/platform-feasibility.md`): **live status** — is this channel broadcasting — and **a pullable live stream** we are allowed to read frames from. Since self-capture (`bounty-capture.js`) a platform no longer has to keep a replay; it still has to serve a stream.

| Platform | Status | Replay retry | Sampling | Proven on a real broadcast | Source |
|---|---|---|---|---|---|
| Twitch | `SHIPPED` | yes — Helix archive | 1× | Yes: both read paths, and they agree (`OPEN-ISSUES.md`, 2026-08-30 "BOTH READ PATHS PROVEN ON TWITCH AND PUMP.FUN"; the first real broadcast, `347ac4b`) | `PLATFORM_PROFILES.twitch` |
| Kick | `SHIPPED-PARTIAL` | no — live pass only | 2× | Yes, and self-capture measurably underperformed the Twitch archive path on the first run (`OPEN-ISSUES.md`, "KICK'S FIRST REAL BROADCAST"); the freeze window was re-derived in Pass A (`b3ccf8b`) and has not been re-measured on Kick since | `PLATFORM_PROFILES.kick` |
| YouTube | `SHIPPED` | yes — same watch URL is the replay | 1× | Yes, after two real bugs (`9f02254`, 2026-09-03; `OPEN-ISSUES.md`, "YOUTUBE SELF-CAPTURE PROVEN") | `PLATFORM_PROFILES.youtube` |
| pump.fun | `SHIPPED-PARTIAL` | yes while the stream stays up — retention after it ends is unproven | 1× | Yes, with three caveats (`OPEN-ISSUES.md`, "pump.fun PROVEN on a real broadcast (2026-08-29)"); the "hollow live" placeholder video is a known gap (T6) | `PLATFORM_PROFILES.pumpfun` |
| X | `SHIPPED-PARTIAL` | no — no pullable stream at all | 2× | Yes, self-capture only, 5/5 on a real broadcast (`2f6e5d4`, 2026-09-03). There is no fallback: if self-capture freezes nothing, nothing else can be tried | `PLATFORM_PROFILES.x` |
| Rumble | `SPECCED` | no | 2× | Ingest proven; the playback URL is the blocker (`OPEN-ISSUES.md`, "Rumble: ingest PROVEN, playback URL is the blocker"). A profile exists; no real verification has run | `PLATFORM_PROFILES.rumble` |

## What "replay retry" buys

Where a platform keeps a replay, a live check that misses a code costs nothing — the verifier re-checks the archive afterwards. Where it does not, the live pass is the only pass; the verifier samples twice as often to compensate and the streamer is told so before going live (`bounty-claim.config.js`, the comment above `PLATFORM_PROFILES`: "We compensate with double the sampling density; we do not pretend the difference away"). In both cases MegaChat's own capture of the public stream is the primary evidence, and an inconclusive check goes to a person, never to a denial (every `notice` string in `PLATFORM_PROFILES`).

## Where the sources disagree

- **X.** `docs/platform-feasibility.md` (2026-08-24) says "X — park it. Confirmed, not assumed." — about X's *API*: no live-status or stream access short of an enterprise agreement. Commit `2f6e5d4` (2026-09-03) proves X self-capture of the operator's own RTMPS push on a real broadcast. Both are true: X gives MegaChat no stream to read, so verification runs entirely on MegaChat's own recording of the broadcast plus the OBS scene check. That is exactly what `PLATFORM_PROFILES.x.notice` tells the streamer. The feasibility doc's verdict predates the proof and was not updated.
- **Kick and VODs.** The notice shown to Kick streamers says "Kick has no VOD we can read". `OPEN-ISSUES.md` (2026-08-29, "Terminology correction") records that Kick *does* keep VODs; what it lacks is a sanctioned VOD *discovery* API, which is the thing the verifier needs. The copy was not changed after the correction. Which wording is intended is an open status call (U2 on the internal *Needs a status call* page).
- **pump.fun.** The first feasibility pass parked it by reading documentation; the second opened the page and reversed the verdict (`docs/platform-feasibility.md`, header; `ea5b5f4`). The later section supersedes the earlier one, and the file says so.

## Identity on each platform

Claiming a bounty handle proves ownership of the platform account through the linked Privy account (`_gate-x-claims.mjs`); Twitch, X and Kick also have a direct OAuth path in `auth.js` that answers 503 without credentials. Kick's OAuth lives on two hosts and conflating them yields opaque 404s (`auth.js`, the `kick` provider comment). YouTube and Rumble are verification targets only — no identity path (`auth.js`, `PROVIDERS`).

## What this does NOT do

- **It does not follow room state on anything but Twitch** ([Follow my stream](follow-my-stream.md)).
- **It does not read a platform's private or subscriber-only replay.** A sub-only VOD is a typed unavailability, routed to review, never a failure against the streamer (`frame-sources.js`, `SOURCE_STATES.VOD_SUBSCRIBER_ONLY`).
- **It does not treat external capture as a dependable fallback.** Recorded as T8 in `OPEN-ISSUES.md`: the two "externals" (platform VOD, live HLS) are different things with different failure modes, and self-capture is the primary evidence on every platform.
- **It does not verify on Rumble today** — the profile is written; the playback URL is not resolvable (`OPEN-ISSUES.md`).
