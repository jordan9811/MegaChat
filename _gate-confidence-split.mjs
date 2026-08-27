/**
 * GATE — confidence is READ QUALITY; presence is a second, separate number.
 *
 * WHY THIS GATE EXISTS AT ALL. Kick's fourth real broadcast (2026-08-26) aired
 * five clips, every badge decoded at 28px, all five clips verified — and the
 * streamer was paid NOTHING. avgConfidence read 0.596 against a 0.6 bar.
 *
 * The mean spanned every sample, found or not, and bounty-ocr.js returns two
 * incommensurable quantities under the one name `confidence`: a glyph-match
 * margin on a read, and 0.2 x a JUNK ring decode on a miss. So the mean was
 * identically
 *
 *     mean  =  q*d + m*(1-d)
 *
 * with q read quality, d detection rate, m the meaningless miss score. Measured
 * on run #4's own capture files and reproduced exactly:
 *
 *     13 samples, 8 reads, 5 misses
 *     q = 0.8430   m = 0.2000   d = 0.6154
 *     q*d + m*(1-d) = 0.5957  ->  reported 0.596
 *
 * 84% read quality was multiplied by 62% presence behind our backs, and the
 * product was compared against a threshold calibrated purely as a LEGIBILITY
 * number. Every fixture in the repo is all-found or all-miss, so no fixture's
 * mean ever carried a detection rate — which is precisely why nothing caught
 * it. THE ONE THING THIS GATE MUST DO IS RUN REAL MISSES THROUGH THE MEAN.
 *
 * The split is not a loosening, and the assertions below are written to prove
 * that rather than assume it. Dropping misses from the mean WITHOUT gating
 * presence separately would hand a cheater a free pass: flash the badge for
 * one sampled frame per clip, miss every other, and score q = 0.9. So
 * detectionRate is gated in the verifier's ladder AND again in escrow, and
 * both doors are tested here.
 *
 * A note on what is NOT punished. Frames sampled at an instant when no code
 * was valid never reach the mean — the verifier drops them before OCR — so
 * correct silence cannot count against anyone. Every sample in detectionRate's
 * denominator was taken inside a clip window while one of that clip's codes
 * was valid, which is what makes a miss there real evidence.
 *
 * Zero network, zero spend.
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'mc-confsplit-'));
process.env.BOUNTY_CLAIM = '1';
// 40 across 4 clips = 10 samples per clip. With the default 10 there are
// only 2 per clip, and a flash-once cheat would measure d = 0.5 -- the same
// number as the honest half-detection case, which would make section C
// prove nothing. The cheat has to be separable from the honest case.
process.env.BOUNTY_SAMPLE_SIZE = '40';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const near = (a, b, eps = 0.002) => Math.abs(Number(a) - Number(b)) <= eps;

const store = await import('./bounty-store.js');
const { verifyAirSession, FrameSource, CodeChecker } = await import('./bounty-verifier.js');
const escrow = await import('./bounty-escrow.js');
const { bountyConfig } = await import('./bounty-claim.config.js');

// ── a session whose codes are always valid at the sampled instants ─────────
// Four clips, each with codes covering its whole window, so EVERY sample is a
// fair test: any miss below is a genuine absence, never a timing artifact.
const HANDLE = 'SplitStreamer';
store.reserveHandle({ platform: 'twitch', handle: HANDLE, ttlMs: 864e5 });
const key = store.handleKey('twitch', HANDLE);
const claim = store.createClaim({ handleKey: key, claimant: 'cs', platform: 'twitch', handle: HANDLE });
const sess = store.createAirSession({ claimId: claim.id, roomId: 'csroom', platform: 'twitch' });

const T0 = Date.now() - 900_000;
const CLIPS = ['C1', 'C2', 'C3', 'C4'];
CLIPS.forEach((clipId, i) => {
  const startedAt = T0 + i * 60_000;
  store.pushPlaybackWindow(sess.id, {
    clipId, playbackId: `${clipId}#n`, startedAt, endsAt: startedAt + 20_000,
    durationS: 20, belowSamplingFloor: false,
    // Overlapping codes across the whole window: no dead instants.
    codes: [0, 4000, 8000, 12000, 16000].map((d, j) => ({
      code: `${clipId}-${j}`, clipId, playbackId: `${clipId}#n`,
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
 * Reads the badge on the first `hitsPerClip` samples of each clip and misses
 * the rest — a controllable detection rate with a FIXED, high read quality, so
 * the two quantities can be told apart by construction.
 */
class RateChecker extends CodeChecker {
  constructor(hitsPerClip, readConf = 0.9) {
    super(); this.hitsPerClip = hitsPerClip; this.readConf = readConf; this.seen = new Map();
  }
  async findCode(frame, expected) {
    const n = (this.seen.get(frame.clipId) || 0) + 1;
    this.seen.set(frame.clipId, n);
    if (n <= this.hitsPerClip) {
      return { found: true, confidence: this.readConf, pixelHeight: 28, text: expected[0] };
    }
    // A MISS, SCORED THE WAY THE REAL DECODER SCORES ONE: 0.2 x its opinion of
    // a junk ring, reported at the locator's sub-pixel noise floor. Both
    // numbers are what real Kick captures produced.
    return { found: false, confidence: 0.2, pixelHeight: 4.1, text: '-------' };
  }
}

const run = (checker) => verifyAirSession(sess.id, { frameSource: new Frames(), codeChecker: checker });

// ── A. the mean no longer multiplies the two quantities together ──────────
const rAll = await run(new RateChecker(99, 0.9));
ok('A. all-found: confidence is the read quality, unchanged by the split',
  near(rAll.confidence, 0.9) && near(rAll.detectionRate, 1),
  `conf=${rAll.confidence} detectionRate=${rAll.detectionRate}`);

const rHalf = await run(new RateChecker(1, 0.9));
const d = rHalf.detectionRate;
const oldMean = 0.9 * d + 0.2 * (1 - d);
ok('A. with real misses, confidence reports READ QUALITY (0.9), not the product',
  near(rHalf.confidence, 0.9),
  `conf=${rHalf.confidence}, the old diluted mean would have been ${oldMean.toFixed(3)}`);
ok('A. ...and the presence evidence is not discarded, it is reported separately',
  d > 0 && d < 1 && near(d, rHalf.clipVerdicts.reduce((a, c) => a + c.hits, 0)
    / rHalf.clipVerdicts.reduce((a, c) => a + c.samples, 0)),
  `detectionRate=${d}`);
ok('A. ...and the two are genuinely different numbers here',
  !near(rHalf.confidence, d),
  `q=${rHalf.confidence} vs d=${d}`);
ok('A. THE REGRESSION THAT COST RUN #4: q*d + m*(1-d) is what we no longer report',
  !near(rHalf.confidence, oldMean, 0.01),
  `would have been ${oldMean.toFixed(3)} vs a ${bountyConfig.minConfidence} bar`);

// ── B. a junk 4.1px miss must not be quoted back at the streamer ──────────
// medianPixelHeight and the quality floor decide whether we tell someone their
// stream was too small. A miss reports the pixel height of whatever junk
// hypothesis scored best — on real captures, 4.1px of background.
ok('B. medianPixelHeight is measured only where a badge was actually read',
  rHalf.clipVerdicts.every((c) => c.medianPixelHeight === 28),
  JSON.stringify(rHalf.clipVerdicts.map((c) => c.medianPixelHeight)));
ok('B. ...so a clip full of 4.1px misses is not accused of a tiny badge',
  rHalf.clipVerdicts.every((c) => c.belowQualityFloor === false)
  && rHalf.belowQualityFloorClips === 0);
ok('B. ...and smallestBadgePx reports a real measurement, never the noise floor',
  (rHalf.attempt?.smallestBadgePx ?? 28) === 28,
  `smallestBadgePx=${rHalf.attempt?.smallestBadgePx}`);

// ── C. THE CHEATER. High read quality, almost no presence. ────────────────
// One legible frame per clip out of every sample: exactly the profile the
// split would have rewarded if presence were not gated on its own.
const cheat = await run(new RateChecker(1, 0.95));
ok('C. a flash-once-per-clip cheat still scores high READ quality',
  near(cheat.confidence, 0.95), `conf=${cheat.confidence}`);
ok('C. ...but its detection rate collapses, far under the floor',
  cheat.detectionRate < bountyConfig.minDetectionRate,
  `d=${cheat.detectionRate} vs floor ${bountyConfig.minDetectionRate}`);
ok('C. ...so the verdict is AMBIGUOUS, not PASS — the split is not a loosening',
  cheat.result === 'AMBIGUOUS', `result=${cheat.result}`);

// ── D. escrow holds the same second door ──────────────────────────────────
// Validate the evidence chain, exactly as attachBountyRoutes does at boot.
// Without it every release fail-closes with `evidence_unverified` — correct
// production behaviour (never pay against unvouched proof), but an in-process
// harness has to opt in the same way a booting server does.
store.verifyEvidenceIntegrity();

const relArgs = {
  handleKey: key, claimId: claim.id, airSessionId: null,
  verifiedClips: 4, verifiedClipSeconds: 80, actor: 'gate',
};
escrow.contribute({ platform: 'twitch', handle: HANDLE, contributor: 'gate', amount: 100 });

const blocked = escrow.release({
  ...relArgs, confidence: 0.95, detectionRate: 0.08, idempotencyKey: 'cs-cheat',
});
ok('D. escrow refuses a high-quality / low-presence release, and names why',
  blocked.released === 0 && blocked.skipped === 'low_detection_rate',
  `skipped=${blocked.skipped}`);

const paid = escrow.release({
  ...relArgs, confidence: 0.843, detectionRate: 0.6154, idempotencyKey: 'cs-honest',
});
ok('D. THE RUN #4 NUMBERS: an honest broadcast now actually pays',
  paid.released > 0 && !paid.skipped,
  `released=${paid.released} skipped=${paid.skipped ?? 'none'}`);

const legacy = escrow.release({
  ...relArgs, confidence: 0.9, idempotencyKey: 'cs-legacy',
});
ok('D. a caller with no detection rate is unchanged (null is not zero)',
  legacy.released > 0 && !legacy.skipped,
  `released=${legacy.released} skipped=${legacy.skipped ?? 'none'}`);

const lowQ = escrow.release({
  ...relArgs, confidence: 0.3, detectionRate: 0.99, idempotencyKey: 'cs-lowq',
});
ok('D. ...and the legibility door still shuts independently of presence',
  lowQ.released === 0 && lowQ.skipped === 'low_confidence',
  `skipped=${lowQ.skipped}`);

// ── E. the floor sits between the two numbers that set it ────────────────
ok('E. the detection floor is above the broken-timeline fixture (0.50)',
  bountyConfig.minDetectionRate > 0.5, `floor=${bountyConfig.minDetectionRate}`);
ok('E. ...and below what a broadcast proven honest measured (0.6154)',
  bountyConfig.minDetectionRate < 0.6154, `floor=${bountyConfig.minDetectionRate}`);

// ── G. A TOO-SMALL BADGE MUST STILL REACH A HUMAN ────────────────────────
// The quality median filtered on `counted` for one revision, and `counted` is
// `found && legible` — so it excluded exactly the samples it exists to notice.
// A broadcast whose badge was located in every frame but sat below the floor
// left `reads` empty, medianPx 0, and belowQualityFloor FALSE (it requires
// medianPx > 0). Result: FAIL_TOO_SMALL, which names no review cause of its
// own, so the session paid zero with nobody looking — the project's worst
// failure mode, introduced while fixing a different instance of it.
{
  const smallChecker = new (class extends CodeChecker {
    async findCode(_f, expected) {
      // FOUND, and legibly located — just rendered too small to accept.
      return { found: true, confidence: 0.9, pixelHeight: 6, text: expected[0] };
    }
  })();
  const small = await run(smallChecker);
  ok('G. an all-too-small broadcast is FAIL_TOO_SMALL, not a bare FAIL',
    small.result === 'FAIL_TOO_SMALL', `result=${small.result}`);
  ok('G. ...and the quality median MEASURES the too-small reads (was 0)',
    small.clipVerdicts.every((c) => c.medianPixelHeight === 6),
    JSON.stringify(small.clipVerdicts.map((c) => c.medianPixelHeight)));
  ok('G. ...so belowQualityFloor fires, which is what carries it to a reviewer',
    small.belowQualityFloorClips === CLIPS.length,
    `${small.belowQualityFloorClips} of ${CLIPS.length} clip(s)`);
  ok('G. ...and the smallest badge is reported honestly, not as 0 or absent',
    small.attempt?.smallestBadgePx === 6, `smallestBadgePx=${small.attempt?.smallestBadgePx}`);
  // A miss must STILL be excluded — the 4.1px junk problem this replaced.
  const junk = await run(new (class extends CodeChecker {
    async findCode() { return { found: false, confidence: 0.2, pixelHeight: 4.1 }; }
  })());
  ok('G. ...while a MISS is still excluded from the quality median',
    junk.clipVerdicts.every((c) => c.medianPixelHeight === 0),
    JSON.stringify(junk.clipVerdicts.map((c) => c.medianPixelHeight)));
  ok('G. ...and a session with no reads at all is FAIL, never accused of a tiny badge',
    junk.result === 'FAIL' && junk.belowQualityFloorClips === 0,
    `result=${junk.result} belowFloor=${junk.belowQualityFloorClips}`);
}

// ── F. THE SAMPLE-INSTANT CLAMP, PROPERTY-TESTED ─────────────────────────
// sampleInstantsForWindow shifts each instant away from the window edge by the
// calibration residual. detectionRate's DENOMINATOR is checks.length, so if a
// shift could push an instant outside its code's validity the caller would
// drop that sample and the denominator would silently shrink — letting a gated
// measurement choose its own denominator, which is a fraud surface.
//
// This calls the SHIPPED function, not a copy. A gate that re-implements the
// logic it tests proves only that the author can write the same expression
// twice, and the first version of this test did exactly that.
//
// It found a real bug. When the residual is at least half the window, safeFrom
// runs past safeTo, the "safe" interval INVERTS, and every pull-toward-middle
// expression starts pulling toward an EDGE instead: 30,022 of 200,000
// generated cases moved the sample closer to the boundary than mid-code
// already was — the exact opposite of the change's purpose.
{
  const { sampleInstantsForWindow } = await import('./bounty-verifier.js');
  let seed = 20260827;                    // deterministic, so a failure repeats
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  // Positive = inside the window by that much; negative = outside by that much.
  // Written longhand: a min-of-two-differences version reported a point 1994ms
  // OUTSIDE the window as 50869ms deep inside it.
  const depth = (t, w) => {
    if (t < w.startedAt) return -(w.startedAt - t);
    if (t > w.endsAt) return -(t - w.endsAt);
    return Math.min(t - w.startedAt, w.endsAt - t);
  };
  const validSpans = (w) => w.codes
    .filter((c) => c.expiresAt > c.issuedAt)
    .map((c) => [c.issuedAt, Math.min(c.expiresAt, c.issuedAt + bountyConfig.codeValidityMs)]);

  let escaped = 0, worse = 0, countChanged = 0, instants = 0;
  for (let i = 0; i < 20_000; i += 1) {
    const startedAt = ri(1_600_000_000_000, 1_800_000_000_000);
    const durMs = ri(1_000, 120_000);
    const codes = [];
    for (let k = 0; k < ri(1, 6); k += 1) {
      const issuedAt = startedAt + ri(-10_000, durMs + 10_000);
      codes.push({ code: `C${k}`, issuedAt, expiresAt: issuedAt + ri(1, 20_000) });
    }
    const win = { startedAt, endsAt: startedAt + durMs, codes, clipId: 'C', playbackId: 'P' };
    const perClip = ri(1, 6);
    const guard = ri(0, 60_000);
    const shifted = sampleInstantsForWindow(win, perClip, guard);
    const baseline = sampleInstantsForWindow(win, perClip, 0);

    // The residual must never change HOW MANY samples a window yields.
    if (shifted.length !== baseline.length) countChanged += 1;

    const spans = validSpans(win);
    for (let j = 0; j < shifted.length; j += 1) {
      instants += 1;
      const t = shifted[j].ts;
      // Containment, rather than re-deriving which code index this pick came
      // from: if no valid code covers the instant, the caller drops it.
      if (!Number.isFinite(t) || !spans.some(([a, b]) => t >= a && t <= b)) escaped += 1;
      if (baseline[j] && depth(t, win) < depth(baseline[j].ts, win) - 1) worse += 1;
    }
  }
  ok('F. a shifted instant is ALWAYS covered by a valid code (denominator integrity)',
    escaped === 0, `${escaped} escapes across ${instants} instants`);
  ok('F. ...and the residual never changes how many samples a window yields',
    countChanged === 0, `${countChanged} windows changed count`);
  ok('F. ...and the shift never moves an instant CLOSER to the window edge',
    worse === 0, `${worse} moved the wrong way (30,022 before the inverted-interval fix)`);
}

// ── H. recordVerification ROUND-TRIPS detectionRate + timeline* ─────────
// This is the field-loss bug repeating: bounty-store.recordVerification's
// destructure is a FIXED WHITELIST, and a field absent from it fails by
// simply not appearing — no error, no warning, just a persisted record that
// cannot explain its own outcome.
//
// It happened TWICE. First silently, for months, on five timeline fields.
// Fixed once. Then a LATER commit whose message claimed to touch only
// OPEN-ISSUES.md deleted the fix again, unreviewed, and it stayed deleted
// until a fresh live Kick broadcast verified PASS at confidence 0.857 and
// then paid nothing — a calibration DISAGREEMENT had opened a review, and
// the persisted record carried none of the evidence that would explain why.
//
// This gate exists so the THIRD time is loud. It calls the shipped function
// directly — no HTTP, no server — so there is nowhere for a silent drop to
// hide.
{
  const store = await import('./bounty-store.js');
  const rec = store.recordVerification({
    airSessionId: 'gate-h-session', checker: 'GateH', evidenceRef: null,
    result: 'PASS', confidence: 0.857, verifiedMinutes: 2.5,
    verifiedClips: 5, verifiedClipSeconds: 150,
    detectionRate: 0.769,
    timelineSkewMs: 6569, timelineState: 'MEASURED', timelineSpreadMs: 2521,
    timelineResidualMs: 6521, timelineFellBack: false,
  });
  ok('H. detectionRate survives the round-trip',
    rec.detectionRate === 0.769, `got ${rec.detectionRate}`);
  ok('H. timelineState survives the round-trip',
    rec.timelineState === 'MEASURED', `got ${rec.timelineState}`);
  ok('H. timelineSkewMs, Spread, Residual, FellBack all survive',
    rec.timelineSkewMs === 6569 && rec.timelineSpreadMs === 2521
    && rec.timelineResidualMs === 6521 && rec.timelineFellBack === false,
    JSON.stringify({
      s: rec.timelineSkewMs, sp: rec.timelineSpreadMs,
      r: rec.timelineResidualMs, f: rec.timelineFellBack,
    }));
  // The failure mode is a field going missing from the OBJECT, which
  // `=== undefined` catches even when a lazier truthiness check would not
  // (false and 0 are legitimate values here, not absence).
  ok('H. none of the six fields is simply ABSENT from the record',
    ['detectionRate', 'timelineSkewMs', 'timelineState', 'timelineSpreadMs',
      'timelineResidualMs', 'timelineFellBack'].every((k) => rec[k] !== undefined
      && Object.prototype.hasOwnProperty.call(rec, k)),
    JSON.stringify(Object.keys(rec)));
  // And a caller that omits them entirely must not crash — they are
  // optional evidence, not a required contract (fixture-driven gates never
  // supply them).
  const bare = store.recordVerification({
    airSessionId: 'gate-h-bare', checker: 'GateH', evidenceRef: null,
    result: 'FAIL', confidence: 0, verifiedMinutes: 0,
  });
  ok('H. omitting the fields entirely does not throw, and they default to null',
    bare.detectionRate === null && bare.timelineState === null);
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
