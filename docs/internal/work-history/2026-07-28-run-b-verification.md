# 2026-07-28 — Run B verification

Sources: `DECISIONS.md` ("2026-07-28 — Run B verification"), `OPEN-ISSUES.md` ("Run B — real verification"), `docs/run-b-verification.md`, `docs/briefs/2026-07-28.md`; commits `dfb7a38`, `d701f6d`, `02a38d8`, `d57e3bc`, `2a8602c`.

## What shipped

- **A machine-readable badge**: 5×7 dot-matrix glyphs inside a white registration ring, from one font table shared by writer and reader (`public/code-matrix.cjs`).
- **A deterministic decoder** (`bounty-ocr.js`): locate the ring geometrically at any scale, sample the dot grid, match glyphs, measure `pixelHeight`. Tesseract skipped entirely — zero dependencies, CI-forever, 100% at 720p and above on the corpus.
- **A synthetic corpus**: 84 frames, 7 conditions, script-generated, H.264-mangled; the detection table in `docs/run-b-verification.md`. 720p is the documented minimum; 480p lands at 12.3 px against a 12 px floor.
- **Real frame sources** (`frame-sources.js`): VOD-first via Helix archive discovery, an extractor seam (yt-dlp today), ffmpeg grab, typed unavailability so "we could not look" is `SOURCE_UNAVAILABLE` → review and never `FAIL`.
- **Kick identity and channel reads** (OAuth 2.1 PKCE, the two-host split pinned by a gate).
- **The full verification distance over HTTP** with the real decoder: `_gate-run-b-pipeline.mjs`.

## What it found

- **The "pre-existing trunk failure" of `_gate-p2-moderation.mjs` was a July-24 zombie server on :3222.** Every gate run's real server died on `EADDRINUSE` with `stdio: 'ignore'` eating the error, and the gate drove the stale process. 10/0 after. This became the spawn audit the next day and, eventually, `_gate-helpers.mjs` (`dfb7a38`; [Testing methodology](../../technical/testing-methodology.md)).

## Judgment calls

- Template decoding over general OCR, because the writer is ours.
- Matched-filter selection: verification asks "is the issued code present", so among jittered alignments the one reading the expected code wins; false-positive safety measured (0 of 12 absent frames), not argued.
- Kick live-first; the unofficial v2 API deliberately not built on.
- ±1.5 s timestamp tolerance derived from the shortest code window's midpoint margin (retired the next day by per-VOD calibration).

## Verification result

Corpus 100% at 1080p/720p; pipeline gate green over HTTP. The dress rehearsal against a real broadcast was the stated next step and the only untested stage.
