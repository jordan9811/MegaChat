/**
 * MC CODE MATRIX — the ONE font table shared by the badge (writer) and the
 * OCR checker (reader).
 *
 * The watermark code is rendered as chunky 5x7 dot-matrix glyphs inside a
 * solid white registration ring. That is "designing the code for its reader":
 * dot blocks survive H.264 mangling that smears font antialiasing, the ring
 * lets the reader FIND the badge at any stream scale without knowing the
 * scene layout, and one shared table means writer and reader cannot drift.
 *
 * Geometry (in DOT units):
 *   ring border: 2 dots solid white, all four sides
 *   gap:         1 dot black between ring and glyphs
 *   glyphs:      5x7 dots per char, 1-dot gap between chars
 *   total h:     2+1+7+1+2 = 13 dots
 *   total w:     2+1 + n*5 + (n-1)*1 + 1+2 dots
 *
 * Alphabet matches bounty-watermark.js's ALPHABET plus '-'. Rows are 5-bit
 * masks, bit 4 = leftmost dot.
 *
 * Dual-environment on purpose: classic <script> in the overlay page sets
 * window.MCCodeMatrix; Node requires it via createRequire. Do not convert to
 * ESM — the overlay is a plain HTML page.
 */
(function () {
  const FONT = {
    '3': [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
    '4': [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
    '6': [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
    '7': [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
    '9': [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
    A: [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
    C: [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E],
    D: [0x1E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1E],
    E: [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F],
    F: [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
    G: [0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F],
    H: [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
    J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C],
    K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
    M: [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11],
    N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
    P: [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
    Q: [0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D],
    R: [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
    T: [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
    U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
    V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04],
    W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1B, 0x11],
    X: [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],
    Y: [0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04],
    '-': [0x00, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00],
  };

  const GLYPH_W = 5;
  const GLYPH_H = 7;
  const BORDER = 2; // registration ring thickness, dots
  const GAP = 1;    // ring→glyphs and glyph→glyph, dots

  function matrixSize(nChars) {
    return {
      w: BORDER + GAP + nChars * GLYPH_W + (nChars - 1) * GAP + GAP + BORDER,
      h: BORDER + GAP + GLYPH_H + GAP + BORDER,
    };
  }

  /**
   * Paint the code onto a canvas 2d context, dot grid at `dot` px per dot.
   * Black field, white ring, white glyph dots — nothing anti-aliased.
   */
  function drawMatrix(ctx, code, dot) {
    const chars = String(code).toUpperCase().split('');
    const { w, h } = matrixSize(chars.length);
    ctx.canvas.width = w * dot;
    ctx.canvas.height = h * dot;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w * dot, h * dot);
    ctx.fillStyle = '#ffffff';
    // registration ring
    ctx.fillRect(0, 0, w * dot, BORDER * dot);
    ctx.fillRect(0, (h - BORDER) * dot, w * dot, BORDER * dot);
    ctx.fillRect(0, 0, BORDER * dot, h * dot);
    ctx.fillRect((w - BORDER) * dot, 0, BORDER * dot, h * dot);
    // glyphs
    chars.forEach((ch, i) => {
      const rows = FONT[ch] || FONT['-'];
      const x0 = BORDER + GAP + i * (GLYPH_W + GAP);
      const y0 = BORDER + GAP;
      for (let r = 0; r < GLYPH_H; r++) {
        for (let c = 0; c < GLYPH_W; c++) {
          if ((rows[r] >> (GLYPH_W - 1 - c)) & 1) {
            ctx.fillRect((x0 + c) * dot, (y0 + r) * dot, dot, dot);
          }
        }
      }
    });
    return { w: w * dot, h: h * dot };
  }

  const api = { FONT, GLYPH_W, GLYPH_H, BORDER, GAP, matrixSize, drawMatrix };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.MCCodeMatrix = api;
})();
