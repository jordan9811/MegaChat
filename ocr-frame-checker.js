/**
 * ADAPTER: the deterministic matrix decoder (bounty-ocr.js) speaking the
 * verifier's CodeChecker dialect — findCode(frameRef, expectedCodes) over
 * frame REFS (local files produced by frame-sources.js).
 *
 * The verifier passes every code valid at the sampled instant (usually one,
 * occasionally two at a rotation boundary). Each is tried as a matched
 * filter; the best result wins. `found` requires an exact read of one
 * expected code AND the measured pixelHeight is always reported so the
 * verifier's legibility floor — the anti-shrink enforcement — has its number.
 */
import { CodeChecker } from './bounty-verifier.js';
import { OcrCodeChecker as MatrixDecoder, fileToGray } from './bounty-ocr.js';

export class OcrFrameChecker extends CodeChecker {
  constructor({ log = console } = {}) {
    super();
    this.log = log;
    this.decoder = new MatrixDecoder({ log });
  }

  async findCode(frame, expectedCodes) {
    const ref = typeof frame === 'object' ? frame.ref : frame;
    let gray;
    try {
      gray = fileToGray(ref);
    } catch (e) {
      // An unreadable frame FILE is a sampling failure, not evidence of
      // absence — report it as unfound with zero confidence and let the
      // hit-rate math treat it as a miss rather than crashing verification.
      this.log.warn(`[ocr] frame decode failed for ${ref}: ${e.message}`);
      return { found: false, confidence: 0, pixelHeight: 0, error: 'frame_unreadable' };
    }
    let best = { found: false, confidence: 0, pixelHeight: 0, text: null };
    for (const code of expectedCodes || []) {
      const r = await this.decoder.check(gray, code);
      if ((r.found && !best.found) || r.confidence > best.confidence) best = { ...r, code };
      if (best.found) break;
    }
    return best;
  }
}

export default OcrFrameChecker;
