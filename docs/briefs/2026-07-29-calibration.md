# 2026-07-29 (later) — per-VOD timeline calibration

## The headline

**The seek constant is gone. Each broadcast's timeline is now measured from its
own content, and the real VOD proves it.**

Against the real broadcast's archive (VOD `2832201336`), starting from a
deliberately **wrong 0ms prior**, calibration recovered **13.2s** and still
verified **4 of 4** playbacks. The value that previously had to be hard-coded is
now derived. That removes the last asterisk on the first real broadcast's PASS.

## How the skew is measured

Seeking with a hypothesised skew `s` toward wall-clock `ts` lands on content at
`ts + s − Δ` for the unknown true skew Δ. Decode that frame, see which code is
*actually* on screen, and that code only ever existed during its own validity
window — so

```
Δ = ts + s − midpoint(code_on_screen)
```

Probes are spread across the session's playback windows, each hypothesis tried
on a ladder, and the offset recovered from the content. No constant required.

**Resolution is quantized by code validity, and that is stated rather than
rounded away.** One point can only place Δ within ±`codeValidityMs/2` (±2.5s as
shipped), because every instant inside a code's window looks identical.

## Constant or drifting?

**Treated as constant per VOD, and the reason is the evidence.** The two
hand measurements from the real broadcast were −16.7s and −15.0s: a 1.7s
difference that sits *inside* one point's uncertainty. The data therefore cannot
distinguish a constant offset from a slow drift, and fitting a slope to two
quantized points would be precisely the one-code-corpus mistake wearing a new
hat. So: constant, several points, median, and the spread reported and
threshold-checked so a genuinely non-linear timeline surfaces as a finding
instead of being averaged into a confident-looking number.

If a longer broadcast ever shows an *ordered progression* across probes rather
than scatter, that is drift and the model needs revisiting. The spread check
would flag it as DISAGREEMENT first, which is the safe direction to fail.

## Accuracy across the spread — never a single figure

| injected | measured | error | points | verified |
|---|---|---|---|---|
| 4s | 4.4s | **+0.4s** | 6 | 6/6 |
| 16s | 16.0s | **0.0s** | 6 | 6/6 |
| 24s | 24.1s | **+0.1s** | 5 | 6/6 |
| **real VOD** (0ms prior) | **13.2s** | cluster spread 1.5s | 4 (1 outlier) | 4/4 |

Worst stub error 0.4s, against a ±2.5s quantization floor. A session the fixed
16s constant would have missed entirely (4s — twelve seconds away, more than a
clip's whole code coverage) verifies cleanly once measured.

**What is NOT claimed:** offsets at/above ~30s are not asserted in the stub. Its
fixture chains six `overlay` filters over a long timeline and stops rendering
every badge past ~30s of pad — and the fixture self-check I wrote to catch that
was itself wrong (it reported 0/6 readable where calibration read 6/6), so I
deleted it rather than ship a check that lies. Inside the stub I could not
separate fixture from product there, and claiming those offsets would be claiming
a stub artifact as a product property. The real-VOD check is the arbiter for the
range that matters. Filed.

## The residual acceptance window, and why

It was a flat **20s** — wide enough to conceal the very error it existed to
absorb. It is now **derived per session**: one point's quantization
(`codeValidityMs/2`) + the observed spread of agreeing points + a small margin.
Observed at **±4.9s** in the stub and **±5.5s** on the real VOD. The old
"±1.5s tolerance" assumed an alignment that does not exist and is retired.

Narrower is not cosmetic: a wide window is extra chances to accept a code from
the wrong moment, so tightening it strengthens the evidence behind a payout.

## Failure handling

- **Cannot measure** → `SOURCE_UNAVAILABLE` / `TIMELINE_UNCALIBRATED`. Never a
  FAIL, because "we could not measure" must not cost a streamer money.
- **Points disagree** → its own review reason, with every measurement listed so
  a reviewer sees the split. Not forced into an average.
- **Fallback** → the old constant, logged loudly, so a systematic calibration
  failure is visible rather than absorbed into a plausible pass.
- Root cause is carried upward: a missing credential still reports
  `API_UNAVAILABLE` rather than being relabelled by the stage that noticed, and
  the extractor's stderr now travels in the detail.

## Three bugs found by the work itself

1. **A truncated search is not agreement.** When the probe budget ran out
   mid-way, the module reported a confident `MEASURED` built from whichever
   probes had agreed — hiding a real 12s inconsistency. Exhausted budget with
   unmeasured probes is now DISAGREEMENT.
2. **A ladder with gaps is a lookup, not a search.** Hand-written rungs had a 6s
   gap; a 30s offset fell into it and measured nothing while 4/16/24/40s — every
   one of them a rung — measured perfectly. That pattern is the tell. Rungs are
   now derived from the badge visibility window (0.7 × `codeValidityMs`).
3. **One junk probe must not condemn a VOD.** The real VOD's four points were
   13.2, 13.2, 14.7 and **23.1**. A plain max−min spread sent the whole thing to
   review on that one outlier — "one sample decides", one layer up from the
   corpus bug. The estimator now clusters around the median and calls
   disagreement only when the agreeing cluster is too small; outliers are counted
   and named.

## Also

The **rehearsal can finally demonstrate a clean context pass**. It played clips
immediately after going live, which the 10-minute warmup rule correctly rejected,
so every rehearsal ended in `INSIDE_WARMUP` rejections that looked like failure
and were the rule working. It now takes `--warmup-s` (default 60s), waits past
it, and prints the override loudly so a rehearsal pass can never be mistaken for
the production threshold. It also spawns through `_gate-helpers.mjs` instead of a
blind sleep — the harness that drives a real broadcast was the last place still
guessing whether its server had come up.

## Two dead ends, recorded so nobody re-runs them

- **Injecting the offset via `created_at` does not work.** It pushes playbacks
  outside their own VOD and breaks discovery instead of testing calibration; real
  archives put `created_at` *before* the playbacks. The offset has to be injected
  as leading content.
- **ffmpeg's pre-input `-ss` over HTTP is accurate.** I suspected it was a
  fast/approximate seek and that this explained the large-offset failures. I
  measured it against a range-serving stub: exact at 46s and 49s. **I nearly
  shipped that as a fix on reasoning alone** — the probe that "proved" it earlier
  had been testing against a server I had already deleted.

## Gates

| suite | result |
|---|---|
| `_gate-bounty-claim` | 101 / 0 |
| `_gate-bounty-program` | 40 / 0 |
| `_gate-stream-context` | 23 / 0 |
| `_gate-quality-and-platform` | 22 / 0 |
| `_gate-stream-context-http` | 19 / 0 |
| `_verify-bounty-oauth` | 17 / 0 |
| **`_gate-vod-calibration`** | **15 / 0** |
| `_gate-media-timeline` | 12 / 0 |
| `_gate-run-b-pipeline` | 12 / 0 |
| `_verify-min-duration` | 10 / 0 |
| `_gate-p2-moderation` | 10 / 0 |
| `_verify-gate-harness` | 9 / 0 |
| `_gate-run-b-ocr` | 6 / 0 |
| **`_verify-calibration-real-vod`** | **5 / 0** |
| `_gate-decoder-codes` | 4 / 0 |

**305 pass, 0 fail.** Gate H unchanged: zero transfer calls, settlement
stub-only, `BOUNTY_CLAIM` off by default.

## Spend

- **LiveKit: 0 minutes** of the 20 budgeted. Nothing here needed the SFU.
- **External API spend: zero.** The stub gate runs entirely on localhost (stub
  Helix, stub VOD with byte ranges). The real-VOD check makes a handful of Helix
  reads and pulls frames from one already-existing archive — no paid APIs, no new
  broadcast.

## What I would do next

1. **Rebuild the stub fixture by concatenating per-badge segments** instead of
   chaining overlays, so the gate can cover 30-45s too and stop depending on the
   real VOD for the wider range.
2. **A real Kick broadcast.** Kick has no VOD, so its live path is the only path
   and calibration cannot help there — the live delay (12-25s) is absorbed by the
   acceptance window alone, which has never faced a real Kick stream.
3. Close the admin routes before anything approaches mainnet.
