# OAuth + embed domain audit (Task 8)

**Date:** 2026-07-27
**Method:** proven by driving the real endpoints, not reasoned about. Every
claim below states what was actually observed and what could not be observed.

## The redirect URI the code sends — byte for byte

The code derives it from the request (`auth.js:133`), with `trust proxy` set so
Railway's TLS termination yields `https`. Captured LIVE from production by
hitting `https://megachat.fun/auth/twitch` and reading the 302:

```
https://megachat.fun/auth/twitch/callback
```

That exact string — scheme `https`, bare domain (no `www`), no trailing slash —
is what must be registered in the **Twitch developer console** for this app.
For X/Twitter (the other legacy provider), the same shape:

```
https://megachat.fun/auth/x/callback
```

Because the URI is request-derived, the CODE can never send a stale domain.
Only the console registration can be stale.

## What was proven, and how

1. **The app credentials are alive.** A client-credentials grant against
   `id.twitch.tv/oauth2/token` with the env's `TWITCH_CLIENT_ID/SECRET`
   returned HTTP 200 and an app token. The Helix API works with it (used to
   find a live channel, and now used in production for viewer sampling).
2. **Twitch does NOT validate the redirect URI before login.** This matters:
   my first probe reached Twitch's real login page and I nearly reported the
   registration as proven. A negative control — the same client_id with
   `redirect_uri=https://old-domain.example` — bounced to the identical login
   page. Twitch defers redirect validation until after authentication, so
   **"the login page rendered" proves nothing about registration.**
3. **Therefore: whether the console has `https://megachat.fun/auth/twitch/callback`
   registered is NOT provable from outside without logging in as the app
   owner.** The prompt's hypothesis (stale domain from before the move) is
   neither confirmed nor refuted. The 60-second owner test: while logged into
   Twitch, visit `https://megachat.fun/auth/twitch` — success lands back on
   megachat.fun; a stale registration shows Twitch's redirect-mismatch error
   after login.
4. **The embed cannot have a stale-domain failure.** `parent=` is derived from
   `location.hostname` (`web/lib/join-page.ts:1464`), and the player was probed
   directly: `player.twitch.tv/?channel=<live>&parent=megachat.fun` returns 200
   with `Content-Security-Policy: frame-ancestors https://megachat.fun` — Twitch
   echoes the parent into the CSP and the browser enforces it against the real
   embedding page. Negative control with a wrong parent produced
   `frame-ancestors https://old-domain.example`, confirming the mechanism. An
   iframe with the exact URL the code builds, injected on the real
   megachat.fun page against a live channel (55k viewers), loaded without a
   frame-ancestors violation.

## An architectural note the audit surfaced

Ordinary **Twitch login no longer touches our Twitch app at all** — Privy is
the front door, and Privy's own Twitch application handles that OAuth against
`auth.privy.io`. Our `TWITCH_CLIENT_ID` app matters for exactly two things
now: the legacy `/auth/twitch` flow (which the new claim verifier can use) and
server-side Helix reads (working, proven). So even a stale console
registration would NOT have broken sign-in — which is consistent with nothing
having visibly failed.

## Kick

No `KICK_CLIENT_ID`/`KICK_CLIENT_SECRET` in env. Nothing was guessed at. To
implement: register an app at Kick's developer portal, then OAuth 2.1 with
PKCE — **authorization on `id.kick.com`, API on `api.kick.com`; they are
different hosts and conflating them is the classic integration failure.** The
redirect to register will be `https://megachat.fun/auth/kick/callback` (the
code derives it, same as Twitch). Kick's channels endpoint returns live status
and viewer count in one call — wire it into the same `VIEWER_SAMPLE` evidence
path Twitch now uses.
