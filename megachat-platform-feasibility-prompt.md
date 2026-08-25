# MEGACHAT: PLATFORM FEASIBILITY — X, YOUTUBE, RUMBLE

/goal

Investigation only. Do not build, do not stub, do not branch anything into the product. Produce one document that says, per platform, exactly what is possible and what it would cost us. Twitch is proven and Kick is built, so this is about what comes next.

Work on a scratch branch, commit only documentation. Nothing in this run touches shipped code.

## The three questions, per platform

Verification needs exactly three things. Answer each separately, because a platform can fail one and still be viable.

1. **Ownership** — can we prove the person claiming a handle actually controls that channel?
2. **Live status** — can we know when they are broadcasting?
3. **Frames** — can we get pixels off their public broadcast during a clip playback?

For each: what is the sanctioned path, what does it cost, what are the rate limits, and what is the ToS position. If the sanctioned path does not exist, say so plainly rather than describing an unsanctioned one as though it were supported.

## Check this first, it may delete a whole workstream

We use Privy for auth, and Privy supports social logins. **Does our Privy configuration already return the user's X handle and their Google/YouTube identity?** Grep the auth code and check what the provider actually hands back: a usable platform handle, or an opaque ID or email.

If Privy returns real handles, ownership is already solved for X and YouTube and large parts of the analysis below are moot. Report this before anything else.

## Per platform

**YouTube** — never assessed, and likely the easiest target after Twitch. Expect a public Data API covering live status and concurrent viewers on a free quota, auto-archived VODs giving both a live and a retry path, and strong yt-dlp support. Confirm rather than assume, and report the actual quota numbers, since quota is the usual thing that bites.

**Rumble** — completely unknown. Is there any public or partner API? Is live status discoverable? Are broadcasts pullable as public HLS? If there is no API at all, say so, and assess the fallback stack below instead.

**X** — the previous run concluded there is no sanctioned pullable stream at any tier and that live status exists only for Spaces. Sanity-check that conclusion, then assess the fallback stack, because "unsanctioned" is not the same as "impossible" and the difference matters for a decision.

## The fallback stack, assess for any platform lacking a sanctioned path

These work without platform cooperation, because the watermark is the trust anchor and all we need is a frame.

- **Posted-code ownership.** Streamer posts a one-time string from their account; we read it back through a public unauthenticated endpoint (oEmbed or equivalent). Does such an endpoint exist per platform?
- **Declared live status.** Streamer says they are live and pastes their broadcast URL rather than us polling. Their claim is not trusted; the watermark still proves it. What does this cost us in reliability?
- **Headless browser capture.** Playwright opens the public broadcast page and screenshots during playback windows. Assess feasibility, resource cost per concurrent session, and ToS exposure per platform.
- **Fan-submitted frames.** The fan who pledged is already watching. They submit a screenshot. Unforgeable, because they cannot produce a code that was never issued. Assess as a backstop rather than a primary.

## Deliverable

Update `docs/platform-feasibility.md` with a table: platform by the three questions, each cell marked sanctioned, fallback-only, or unavailable, with the method named.

Then a short section per platform covering what integration would actually take in effort terms, what would break it, and a recommendation: build next, build later, or park.

Finish with a ranked order of which platform to add after Kick, and say why. Include the honest case against your own top pick.

## Rules

- Investigate only. No code, no branches into the product, no stubs.
- Where you are uncertain, say uncertain. A confident wrong answer here costs a whole build run.
- Distinguish what you verified from documentation versus what you inferred.
- If a platform's situation has changed recently and you cannot confirm current state, say that rather than reporting stale information as fact.
