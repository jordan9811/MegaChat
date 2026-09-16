/**
 * GATE — MISSES ARE AUTHORITATIVE. A code we never saw is NOT_SHOWN, and no
 * confidence number gets to argue with it.
 *
 * WHY THIS GATE EXISTS. The verdict ladder in bounty-verifier.js asked its
 * questions in the wrong order. It established that SOMETHING verified, then
 * immediately consulted avgConfidence — and avgConfidence is averaged over
 * `counted` samples only, i.e. exclusively over frames where the code WAS
 * present. A playback that never appeared contributes nothing to that mean, so
 * a session that missed an entire required playback could still report 0.95
 * read quality off the playbacks that did air, sail past both thresholds, and
 * land on PARTIAL.
 *
 * PARTIAL is payable partial credit. It says "some of what we asked for
 * aired". It does not say "a code we required was never on screen", which is
 * the actual finding, and is the one the requirement demands be stated:
 *
 *   "Misses are authoritative: if a required per-playback code was never
 *    observed in the capture, the verdict is MISSED / NOT_SHOWN regardless
 *    of confidence."
 *
 * THE ORDER IS WHAT THIS GATE PROTECTS, not merely the existence of the
 * branch. Section C below is the whole point: it drives a session where the
 * confidence branch would have fired first and proves the presence verdict
 * still wins. A future refactor that keeps NOT_SHOWN but slides it below
 * either threshold check re-opens the bug with the branch still sitting there
 * looking correct, and only an ordering assertion catches that.
 *
 * Section B is the counterweight. A fix of this shape can always be faked by
 * refusing everything, so the honest broadcast — every playback observed, high
 * read quality — must still PASS, and section D keeps the two more specific
 * zero-verification diagnoses (FAIL, FAIL_TOO_SMALL) reachable above it.
 *
 * Zero network, zero spend, no server.
 */
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'mc-notshown-'));
process.env.BOUNTY_CLAIM = '1';
// 40 across 4 playbacks = 10 samples each. Density matters here: the miss has
// to be a sustained absence across every sample of a window, not one unlucky
// frame, or the fixture would be arguing about sampling luck instead of about
// the ladder.
process.env.BOUNTY_SAMPLE_SIZE = '40';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};

const store = await import('./bounty-store.js');
const { verifyAirSession, FrameSource, CodeChecker } = await import('./bounty-verifier.js');
const { bountyConfig } = await import('./bounty-claim.config.js');

/**
 * The ladder AS IT WAS, replayed from the verifier's own returned numbers.
 *
 * A gate that only asserts the new verdict cannot tell a genuine fix from a
 * fixture that would have passed anyway. This function is what makes the
 * discrimination explicit: section A asserts the same session that now reads
 * NOT_SHOWN would have read PARTIAL under the old order, so the gate provably
 * fails against the pre-fix verifier.
 */
const oldLadder = (v) => {
  if (v.checks.length === 0) return 'NO_FRAMES';
  if (v.verifiedClips === 0 && v.checks.some((c) => c.found && !c.legible)) return 'FAIL_TOO_SMALL';
  if (v.verifiedClips === 0) return 'FAIL';
  if (v.confidence < bountyConfig.minConfidence) return 'AMBIGUOUS';
  if (v.detectionRate < bountyConfig.minDetectionRate) return 'AMBIGUOUS';
  if (v.hitRate >= 0.999) return 'PASS';
  return 'PARTIAL';
};

// ── a session whose codes are valid at every sampled instant ──────────────
// Four playbacks, each carrying overlapping codes across its whole window, so
// there are no dead instants. Every miss below is therefore a genuine absence
// of the badge and never a timing artifact — which is what lets the gate say
// anything at all about presence.
const HANDLE = 'MissStreamer';
store.reserveHandle({ platform: 'twitch', handle: HANDLE, ttlMs: 864e5 });
const key = store.handleKey('twitch', HANDLE);
const claim = store.createClaim({ handleKey: key, claimant: 'ns', platform: 'twitch', handle: HANDLE });
const sess = store.createAirSession({ claimId: claim.id, roomId: 'nsroom', platform: 'twitch' });

const T0 = Date.now() - 900_000;
const CLIPS = ['M1', 'M2', 'M3', 'M4'];
CLIPS.forEach((clipId, i) => {
  const startedAt = T0 + i * 60_000;
  store.pushPlaybackWindow(sess.id, {
    clipId, playbackId: `${clipId}#p`, startedAt, endsAt: startedAt + 20_000,
    durationS: 20, belowSamplingFloor: false,
    codes: [0, 4000, 8000, 12000, 16000].map((d, j) => ({
      code: `${clipId}-${j}`, clipId, playbackId: `${clipId}#p`,
      issuedAt: startedAt + d, expiresAt: startedAt + d + 5_000,
    })),
  });
});

class Frames extends FrameSource {
  async getFrames(_p, _h, timestamps) {
    return timestamps.map((t) => {
      const ts = typeof t === 'object' ? t.ts : t;
      return { ref: `f:${ts}`, ts, live: false, clipId: t.clipId, playbackId: t.playbackId };
    });
  }
}

/**
 * The badge is on screen for the listed clips and off screen for every other
 * one — a per-clip decision, not a per-sample counter, so a playback in
 * `hidden` misses on ALL of its samples. That is the precise shape the
 * requirement is about: not a low hit rate, but a required code never observed
 * anywhere in the capture.
 *
 * Reads are scored at a deliberately COMFORTABLE confidence. The fix must hold
 * because the code was absent, not because the reads were also shaky; a
 * fixture where quality happened to be marginal would let the confidence
 * branch produce the same verdict for the wrong reason and prove nothing about
 * the ordering.
 */
class ShownChecker extends CodeChecker {
  constructor(shown, readConf = 0.95) { super(); this.shown = new Set(shown); this.readConf = readConf; }
  async findCode(frame, expected) {
    if (this.shown.has(frame.clipId)) {
      return { found: true, confidence: this.readConf, pixelHeight: 28, text: expected[0] };
    }
    // A MISS, scored the way bounty-ocr.js scores one on real captures: 0.2 x
    // its opinion of a junk ring, measured at the locator's noise floor.
    return { found: false, confidence: 0.2, pixelHeight: 4.1, text: '-------' };
  }
}

const run = (checker) => verifyAirSession(sess.id, { frameSource: new Frames(), codeChecker: checker });

// ── A. THE MISS. Three playbacks aired, one was never on screen. ──────────
const miss = await run(new ShownChecker(['M1', 'M2', 'M3']));
const unshown = miss.clipVerdicts.filter((c) => c.hits === 0);

ok('A. the fixture really does contain a playback whose code was never observed',
  unshown.length === 1 && unshown[0].clipId === 'M4' && unshown[0].samples > 0,
  `${unshown.length} unshown; samples in it=${unshown[0]?.samples}`);
ok('A. ...while read quality over what WAS read is comfortably above the bar',
  miss.confidence >= bountyConfig.minConfidence + 0.2,
  `conf=${miss.confidence} vs floor ${bountyConfig.minConfidence}`);
ok('A. ...and detection rate clears its floor too, so neither threshold is doing the work',
  miss.detectionRate >= bountyConfig.minDetectionRate + 0.1,
  `detectionRate=${miss.detectionRate} vs floor ${bountyConfig.minDetectionRate}`);
ok('A. THE VERDICT: a code never observed is NOT_SHOWN, regardless of confidence',
  miss.result === 'NOT_SHOWN', `result=${miss.result}`);
ok('A. ...and the OLD ladder, replayed from these same numbers, said PARTIAL',
  oldLadder(miss) === 'PARTIAL',
  `old=${oldLadder(miss)} — payable partial credit for a code that was never there`);
ok('A. ...the verified playbacks are still counted honestly, not zeroed out',
  miss.verifiedClips === 3 && miss.clipVerdicts.length === 4,
  `verifiedClips=${miss.verifiedClips} of ${miss.clipVerdicts.length}`);

// ── B. THE HONEST BROADCAST. The fix must not be "refuse everything". ─────
const clean = await run(new ShownChecker(CLIPS));
ok('B. every playback observed at high confidence still PASSes',
  clean.result === 'PASS', `result=${clean.result}`);
ok('B. ...with no playback left unobserved, and all four verified',
  clean.clipVerdicts.every((c) => c.hits > 0) && clean.verifiedClips === CLIPS.length,
  `verifiedClips=${clean.verifiedClips}, hits=${JSON.stringify(clean.clipVerdicts.map((c) => c.hits))}`);
ok('B. ...and the old ladder agreed here, so B is a genuine control',
  oldLadder(clean) === 'PASS', `old=${oldLadder(clean)}`);

// ── C. THE ORDER, WHICH IS THE ACTUAL FIX ────────────────────────────────
// Presence must be settled before quality is ever consulted. Same miss, but
// the reads are now scored BELOW minConfidence: under the old order the
// confidence branch fired first and returned AMBIGUOUS. If NOT_SHOWN is ever
// slid below either threshold check, this assertion is the one that notices —
// section A alone would still pass with the branch in the wrong place.
const lowQ = await run(new ShownChecker(['M1', 'M2', 'M3'], bountyConfig.minConfidence - 0.2));
ok('C. a miss beats a FAILING confidence too — presence is settled first',
  lowQ.result === 'NOT_SHOWN', `result=${lowQ.result}`);
ok('C. ...and that is a real reordering: the old ladder called this AMBIGUOUS',
  oldLadder(lowQ) === 'AMBIGUOUS',
  `old=${oldLadder(lowQ)}, conf=${lowQ.confidence} vs floor ${bountyConfig.minConfidence}`);
ok('C. ...so no confidence value, high or low, reaches past the presence check',
  miss.result === lowQ.result && miss.confidence !== lowQ.confidence,
  `${miss.confidence} and ${lowQ.confidence} both -> ${miss.result}`);

// ── D. THE SPECIFIC ZERO-VERIFICATION DIAGNOSES SURVIVE ──────────────────
// NOT_SHOWN sits BELOW FAIL and FAIL_TOO_SMALL on purpose. Those two name a
// cause ("the badge was there and too small to read" is a setup fix with a
// review cause attached in bounty-routes.js); collapsing them into a generic
// NOT_SHOWN would lose that and silently close the review path they open.
const nothing = await run(new ShownChecker([]));
ok('D. a broadcast where nothing at all was observed is still FAIL',
  nothing.result === 'FAIL', `result=${nothing.result}`);

const tooSmall = await run(new (class extends CodeChecker {
  async findCode(_f, expected) {
    // Located in every frame, just rendered under the pixel floor.
    return { found: true, confidence: 0.9, pixelHeight: 6, text: expected[0] };
  }
})());
ok('D. ...and an all-too-small broadcast is still FAIL_TOO_SMALL, not NOT_SHOWN',
  tooSmall.result === 'FAIL_TOO_SMALL', `result=${tooSmall.result}`);

// ── E. NOT_SHOWN IS A DOCUMENTED VALUE, NOT A SURPRISE ───────────────────
// A verdict string that appears only inside the ladder is an unknown value to
// every reader downstream. The module's own header enumerates what it can
// return; this keeps that list honest.
{
  const src = readFileSync(path.resolve('bounty-verifier.js'), 'utf8');
  const header = src.slice(0, src.indexOf('import fs from'));
  ok('E. the module header enumerates NOT_SHOWN alongside the other verdicts',
    header.includes('NOT_SHOWN'), 'not documented in the header block');
  ok('E. ...and the ladder is the only place the string is decided',
    (src.match(/'NOT_SHOWN'/g) || []).length === 1,
    `${(src.match(/'NOT_SHOWN'/g) || []).length} literal(s)`);
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
