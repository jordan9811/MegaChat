# 2026-07-29 (night) — OBS one-click: Add to OBS, with sound

## The headline

**"Add to OBS" exists, is flag-gated (`OBS_ONECLICK`), and is proven end to end
in a real browser against a real-protocol mock** — real claim page, real React
state machine, the browser's own crypto.subtle doing the v5 auth handshake,
and a mock obs-websocket holding the resulting source. What only real OBS can
prove is packaged as the owner's five-minute checklist with an interactive
walker. The manual fallback (URL + exact canvas dimensions, copy buttons) is
always rendered, first-class.

## Warm-up: the two gates that crashed on a clean checkout

Both fixed and green. `_gate-overlay` simply never spawned a server — the page
that renders money-bearing badges had no working gate at all. `_gate-auth` had
**three stacked rots**: a blind 2.5s sleep against a ~10s boot; a `127.0.0.1`
base URL that the server 301-redirects to `localhost` (passkey domain-binding),
which converts every POSTed fetch into a GET — so its POSTs silently fell
through to Next's 404 page and the assertions blamed the product; and a
hardcoded Arc USDC address that triggered *live on-chain* `decimals()`
validation inside a gate, stale on Tempo anyway. Bonus: the harness's port
precheck caught a stale `node server.js` zombie holding :3005 on the very first
run — the exact failure the 4a audit built it for.

## Protocol gate (22/0), including the negative cases

The client is **one plain-JS file** used byte-identically by the Next UI and
the Node gates (`globalThis.WebSocket` + `crypto.subtle`, no dependency). The
mock implements the genuine v5 handshake with auth computed by an
**independent node:crypto implementation**, so every run cross-checks the two
hash paths byte-exactly (4 vectors incl. unicode and empty password).

Negative cases: wrong password → `AUTH_FAILED` (close 4009) with
re-copy-the-password copy; OBS absent → `NOT_REACHABLE`, no hang; name
collision in another scene → adopted via `CreateSceneItem`, never an error.
Plus: **the password never appears in any frame after the handshake**, and the
UI gate separately proves by request interception that it never travels to our
origin — localStorage only.

## What the button sets, exactly

| setting | value | why |
|---|---|---|
| width / height | canvas base size | badge renders 1:1; legibility floor un-screw-uppable |
| position | 0,0 | no cropping the badge corner |
| scale | 1,1 | any scale resizes the badge |
| boundsType | OBS_BOUNDS_NONE | bounds silently rescale too |
| shutdown | false | page persists across scene switches; never misses a lazy-connect wake |
| restart_when_active | false | same — never reload |
| reroute_audio | true | own mixer channel with a visible meter |
| monitor type | MONITOR_AND_OUTPUT (default, toggleable) | the streamer must hear the join sound to react; toggle exists because some monitoring setups echo |

Find-or-update, never error: a hand-shrunk existing source is **repaired** by
re-clicking (gated), and "Verified ready" is **read back from OBS** — settings,
transform, enablement, and the badge-clears-floor arithmetic as an explicit
check — not assumed from having just set it.

## The audio answer: who hears what, by default

| event | audience hears | streamer hears |
|---|---|---|
| guest joins | join stinger ✔ | ✔ (monitor-and-output) |
| stinger fires | ✔ | ✔ |
| bounty clip plays | clip audio in the mix ✔ | ✔ via monitoring (toggleable) |

Investigation first, as instructed: the overlay does **not** gate audio behind
a user gesture — sounds are synthesized WebAudio, each play best-effort
resumes the context. In OBS (autoplay permitted) it already worked; the real
gap was the first join sound losing its opening milliseconds to a
suspended→running resume race. Fixed by pre-warming the context at boot **only
when `window.obsstudio` is present**; a normal tab creates no context and gets
no rejected-resume console noise. Stinger machinery untouched and re-proven on
the real page against the real local SFU: `_gate-lazy-connect` 65/0 (includes
the black-tile repro driven through the page's own reveal gate),
`_gate-overlay` both modes, `_gate-cohost-booth` 17/0.

## The host self-tile finding

**The infinite-mirror hazard does not exist through the overlay, by
construction.** Overlay tiles are WS-seat-driven (`lkAttach` requires a tile
element only `seat_added` creates); the booth's host feed publishes tracks but
never holds a seat, so the overlay never renders the host's own feed. The one
real edge — the host buying a seat in their own room with the virtual cam — is
indistinguishable from a normal seat server-side, so it is a **warning at
picker time**, not an exclusion that would have to guess.

Also shipped for the booth: 1080p capture when the selected device is the OBS
Virtual Camera (LiveKit's 720p default would down-res the deliberately
full-canvas source; a live selection re-opens the track since
`switchActiveDevice` keeps old constraints), and the no-audio note at the
picker. Auto-upgrade of a mid-broadcast-started virtual cam already existed.

## Not provable without real OBS (→ the checklist)

`docs/obs-oneclick-checklist.md` + `node _verify-obs-oneclick.mjs` (uses the
shipped client against real OBS; automates rows 3-7 and 12, prompts y/n for
ears-and-eyes rows): mixer channel + meter, audible monitoring + the toggle
going silent, scene-switch persistence without reload, virtual-cam eyeball
check, and OBS's actual CEF autoplay behavior on this machine.

## Gates — full sweep on this branch

_gate-obs-protocol 22/0 · _gate-obs-ui 16/0 · _gate-bounty-claim 101/0 ·
_gate-bounty-program 40/0 · _gate-stream-context 23/0 · context-http 19/0 ·
quality-platform 22/0 · media-timeline 12/0 · run-b-pipeline 12/0 · run-b-ocr
6/0 · decoder-codes 4/0 · vod-calibration 15/0 · gate-harness 9/0 ·
min-duration 10/0 · bounty-oauth 17/0 · p2-moderation 10/0 ·
**lazy-connect 65/0 (real SFU)** · cohost-booth 17/0 (real SFU) · overlay both
modes · auth green. Gate H: zero transfer calls, settlement stub-only,
`BOUNTY_CLAIM` off by default, `OBS_ONECLICK` off by default.

## Spend

LiveKit Cloud: **0 minutes** (SFU suites run the local dev binary). External
API spend: **zero** — mock OBS on loopback, no platform calls anywhere new.
