/**
 * OCR CODE CHECKER — the real implementation of the verifier's CodeChecker
 * contract: `found`, `confidence`, and measured `pixelHeight`. The pixelHeight
 * half is not optional; verifier-side size measurement is the real anti-shrink
 * enforcement, and an implementation returning only found/confidence is
 * incomplete by the redesign's contract note.
 *
 * DETERMINISTIC BY DESIGN — no vision API, no spend, runs in CI forever.
 * The badge renders the code as 5x7 dot-matrix glyphs inside a solid white
 * registration ring (public/code-matrix.js — the same table read here, so
 * writer and reader cannot drift). Reading it back is therefore template
 * decoding against a known font, not general OCR:
 *
 *   1. LOCATE: scan the grayscale frame for the ring — a solid bright
 *      rectangle outline with a dark interior band. Done at every plausible
 *      scale by geometry, not ML: for each candidate bright run that could be
 *      a top border, verify bottom border + side columns + interior.
 *   2. SAMPLE: the ring fixes the dot pitch (ring is BORDER=2 dots thick,
 *      total height 13 dots), so every glyph cell center is known. Average a
 *      small window per cell, threshold against the local ring/field levels.
 *   3. DECODE: per character, hamming-match the 35 sampled dots against every
 *      glyph in the font. Confidence = margin between best and second-best
 *      match, scaled by cell contrast. pixelHeight = 7 * measured pitch.
 *
 * Frames arrive as raw grayscale (`{gray, width, height}`) — FrameSources
 * decode media to gray via ffmpeg, which the corpus pipeline requires anyway.
 */
import { createRequire } from 'module';
import { spawnSync } from 'child_process';

const require = createRequire(import.meta.url);
const { FONT, GLYPH_W, GLYPH_H, BORDER, GAP, matrixSize } = require('./public/code-matrix.cjs');

const CHARS = Object.keys(FONT);

/** Decode any image file to raw grayscale via ffmpeg (deterministic, local). */
export function fileToGray(file) {
  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file,
  ], { encoding: 'utf8' });
  if (probe.status !== 0) throw new Error(`ffprobe failed for ${file}`);
  const [width, height] = probe.stdout.trim().split(',').map(Number);
  const out = spawnSync('ffmpeg', [
    '-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
  ], { maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) throw new Error(`ffmpeg gray decode failed for ${file}`);
  return { gray: out.stdout, width, height };
}

/**
 * Summed-area table, built once per frame, cached on the frame object. Turns
 * every rect mean into four lookups — the locator samples millions of rects
 * per frame and was minutes-per-frame without this.
 */
function sat(f) {
  if (f.__sat) return f.__sat;
  const { width: w, height: h, gray } = f;
  const t = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    const src = y * w, dst = (y + 1) * (w + 1) + 1, prev = y * (w + 1) + 1;
    for (let x = 0; x < w; x++) {
      row += gray[src + x];
      t[dst + x] = t[prev + x] + row;
    }
  }
  f.__sat = t;
  return t;
}

/** Mean over a clamped rect — O(1) via the summed-area table. */
function mean(f, x0, y0, w, h) {
  const t = sat(f);
  const W = f.width + 1;
  const xa = Math.max(0, Math.round(x0)), ya = Math.max(0, Math.round(y0));
  const xb = Math.min(f.width, Math.round(x0 + w)), yb = Math.min(f.height, Math.round(y0 + h));
  const n = (xb - xa) * (yb - ya);
  if (n <= 0) return 0;
  return (t[yb * W + xb] - t[ya * W + xb] - t[yb * W + xa] + t[ya * W + xa]) / n;
}

/**
 * Find the registration ring for a code of `nChars` characters.
 *
 * Geometry does the work: total matrix is W=matrixSize.w x H=13 dots, so for
 * a hypothesised pitch p the ring is a (W*p x H*p) rectangle whose 2-dot
 * border is bright and whose 1-dot inner margin is dark. We scan candidate
 * top-left corners on a coarse grid at each pitch, score border-vs-margin
 * contrast, then refine the best hit on a fine grid. Returns null when no
 * candidate clears the contrast floor — "no badge in frame".
 */
export function locateRing(f, nChars, { minPitch = 1, maxPitch = 10 } = {}) {
  const dims = matrixSize(nChars);
  // One best CANDIDATE PER PITCH, each refined before the global compare.
  //
  // The single-global-max version had a quantization trap that cost an hour:
  // the coarse grid steps by ~pitch, so the true ring can be sampled ±2px off
  // its edge, collapsing its score below flat background junk (a gray matte
  // scores ~150 as a "ring" at small pitches). The junk then wins the coarse
  // pass and refinement anchors on it, never revisiting the real hit. Keeping
  // per-pitch candidates and refining EACH makes the off-grid true ring snap
  // to its 255 before it ever has to compete.
  const candidates = [];
  for (let pitch = minPitch; pitch <= maxPitch; pitch += 0.5) {
    const W = dims.w * pitch, H = dims.h * pitch;
    if (W > f.width || H > f.height) break;
    const step = Math.max(2, Math.floor(pitch));
    let bestAtPitch = null;
    for (let y = 0; y + H <= f.height; y += step) {
      for (let x = 0; x + W <= f.width; x += step) {
        const score = ringScore(f, x, y, pitch, dims);
        if (score > (bestAtPitch?.score ?? 0)) bestAtPitch = { x, y, pitch, score, step };
      }
    }
    if (bestAtPitch && bestAtPitch.score > 40) candidates.push(bestAtPitch);
  }
  if (!candidates.length) return null;

  let best = null;
  for (const cand of candidates) {
    let ref = cand;
    const r = Math.max(3, cand.step);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        for (const dp of [-0.25, 0, 0.25]) {
          const s = ringScore(f, cand.x + dx, cand.y + dy, cand.pitch + dp, dims);
          if (s > ref.score) ref = { x: cand.x + dx, y: cand.y + dy, pitch: cand.pitch + dp, score: s };
        }
      }
    }
    if (!best || ref.score > best.score) best = ref;
  }
  return best && best.score >= 60 ? best : null;
}

function ringScore(f, x, y, pitch, dims) {
  const W = dims.w * pitch, H = dims.h * pitch;
  const b = BORDER * pitch;
  // Border brightness: sample the four border bands.
  const top = mean(f, x, y, W, b);
  const bot = mean(f, x, y + H - b, W, b);
  const left = mean(f, x, y + b, b, H - 2 * b);
  const right = mean(f, x + W - b, y + b, b, H - 2 * b);
  const border = (top + bot + left + right) / 4;
  // Inner margin darkness: the 1-dot gap ring just inside the border.
  const g = GAP * pitch;
  const innerTop = mean(f, x + b, y + b, W - 2 * b, g);
  const innerBot = mean(f, x + b, y + H - b - g, W - 2 * b, g);
  const inner = (innerTop + innerBot) / 2;
  return border - inner; // bright ring on dark margin
}

/**
 * Decode the code inside a located ring. Returns per-char results plus an
 * aggregate confidence (worst char wins — one unreadable character is an
 * unreadable code).
 */
export function decodeAt(f, ring, nChars) {
  const { pitch, x, y } = ring;
  const white = mean(f, x, y, matrixSize(nChars).w * pitch, BORDER * pitch); // ring level
  const black = ringScoreInner(f, ring, nChars); // field level
  const span = Math.max(20, white - black);

  const cells = (ch) => FONT[ch];
  let text = '';
  let worst = 1;
  for (let i = 0; i < nChars; i++) {
    const x0 = x + (BORDER + GAP + i * (GLYPH_W + GAP)) * pitch;
    const y0 = y + (BORDER + GAP) * pitch;
    // Sample all 35 cells → normalized [0,1] against ring/field levels.
    const sampled = [];
    for (let r = 0; r < GLYPH_H; r++) {
      for (let c = 0; c < GLYPH_W; c++) {
        const v = mean(f,
          x0 + c * pitch + pitch * 0.25, y0 + r * pitch + pitch * 0.25,
          pitch * 0.5, pitch * 0.5);
        sampled.push(Math.min(1, Math.max(0, (v - black) / span)));
      }
    }
    // Match against every glyph: score = mean agreement.
    let best = { ch: '?', score: -1 }, second = -1;
    for (const ch of CHARS) {
      const rows = cells(ch);
      let agree = 0;
      for (let r = 0; r < GLYPH_H; r++) {
        for (let c = 0; c < GLYPH_W; c++) {
          const bit = (rows[r] >> (GLYPH_W - 1 - c)) & 1;
          const v = sampled[r * GLYPH_W + c];
          agree += bit ? v : (1 - v);
        }
      }
      const score = agree / (GLYPH_W * GLYPH_H);
      if (score > best.score) { second = best.score; best = { ch, score }; }
      else if (score > second) second = score;
    }
    // Confidence per char: how decisively the best beats the runner-up AND
    // how clean the cells were. Both in [0,1].
    const margin = Math.max(0, best.score - second) * 4; // margins are small; scale
    const clean = Math.max(0, (best.score - 0.5) * 2);
    const conf = Math.min(1, Math.min(margin + 0.5, clean + margin));
    worst = Math.min(worst, conf);
    text += best.ch;
  }
  return { text, confidence: +worst.toFixed(3), pixelHeight: +(GLYPH_H * pitch).toFixed(1) };
}

function ringScoreInner(f, ring, nChars) {
  const { pitch, x, y } = ring;
  const b = BORDER * pitch, g = GAP * pitch;
  const W = matrixSize(nChars).w * pitch;
  return mean(f, x + b, y + b, W - 2 * b, g);
}

/**
 * The verifier-facing contract. Matches MockCodeChecker's shape exactly:
 * check(frame, expectedCode) → { found, confidence, pixelHeight }.
 */
export class OcrCodeChecker {
  constructor({ log = console } = {}) { this.log = log; }

  /** @param {{gray: Buffer, width: number, height: number}} frame */
  async check(frame, expectedCode) {
    const n = String(expectedCode).length;
    const ring = locateRing(frame, n);
    if (!ring) return { found: false, confidence: 0, pixelHeight: 0, text: null };
    // Non-integer pitches (720p ≈ 2.67 dots/px) drift the sample grid by a
    // fraction of a dot across 47 columns — enough to mirror a 9 into a 6.
    // Jitter the ring hypothesis and decode at each alignment.
    //
    // Selection is a MATCHED FILTER, which is the honest shape for
    // verification: we are not doing blind OCR, we are asking "is the code
    // the server issued present in this frame?". Among alignments, one that
    // reads the expected text wins (highest confidence among those);
    // otherwise the most confident read is reported for what it saw. Raw
    // max-confidence selection was actively harmful — a half-dot-shifted
    // grid reads border rows as clean '-' glyphs and outscores the true
    // alignment. False-positive safety is not argued, it is measured: the
    // corpus asserts ZERO absent-frame finds, because all 7 characters would
    // have to misread into exactly the expected string at once.
    const expected = String(expectedCode).toUpperCase();
    let dec = decodeAt(frame, ring, n);
    let matched = dec.text === expected ? dec : null;
    // ±2px and a finer pitch fan: the ring locator optimizes ring contrast,
    // whose peak can sit 2px from the decode optimum at fractional pitches —
    // measured, not guessed, on the 720p corpus where dx=+2 was the truth.
    for (const dp of [-0.16, -0.12, -0.08, -0.04, 0.04, 0.08, 0.12, 0.16]) {
      for (const dx of [-2, -1, 0, 1, 2]) {
        for (const dy of [-2, -1, 0, 1, 2]) {
          const d = decodeAt(frame, { ...ring, pitch: ring.pitch + dp, x: ring.x + dx, y: ring.y + dy }, n);
          if (d.text === expected && (!matched || d.confidence > matched.confidence)) matched = d;
          if (d.confidence > dec.confidence) dec = d;
        }
      }
    }
    if (matched) dec = matched;
    const found = dec.text === String(expectedCode).toUpperCase();
    return {
      found,
      // A confident read of the WRONG text is decisive evidence of absence,
      // not low confidence — report the decode confidence either way and let
      // the verifier's thresholds do their job.
      confidence: found ? dec.confidence : +(dec.confidence * 0.2).toFixed(3),
      pixelHeight: dec.pixelHeight,
      text: dec.text,
    };
  }
}

export default OcrCodeChecker;
