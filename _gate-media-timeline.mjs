/**
 * GATE — the media timeline is not our clock.
 *
 * Everything here was found by the FIRST REAL BROADCAST (2026-07-29, VOD
 * 2832201336) and none of it was reachable by any fixture-driven gate, because
 * fixtures never exercise the handle argument or the seek arithmetic.
 *
 *  1. HANDLE RESOLUTION. Air sessions carry a claimId, not a handle. The
 *     verifier read `session.handle`, which was undefined for every session
 *     ever created, so the real frame sources built "https://www.twitch.tv/"
 *     and yt-dlp rejected it. Live grabs AND VOD discovery were dead on
 *     arrival for everyone — and on the VOD path it surfaced as a 500 rather
 *     than a graceful SOURCE_UNAVAILABLE.
 *
 *  2. TIMELINE SKEW. Public media runs behind our wall clock: ~15-17s measured
 *     on the VOD, 12-25s on live HLS. Codes rotate every 4s, so the sampled
 *     frame showed a badge from ~4 rotations earlier — legible at 28px, and
 *     the wrong code every time. Verification read PASS only after the seek was
 *     shifted and the accepted-code window widened.
 *
 *  3. THE SAFETY PROPERTY THAT MUST SURVIVE BOTH. Widening the window may
 *     never let one clip's code satisfy a different clip. Codes are bound to a
 *     playback instance by nonce and the window is built from THAT clip's code
 *     list, so this holds by construction — and is asserted here, because it is
 *     the property the payout rests on.
 *
 * Zero network, zero spend: a recording frame source stands in for the platform
 * so the arithmetic is checked without touching Twitch.
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'mc-timeline-'));
process.env.BOUNTY_CLAIM = '1';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};

const store = await import('./bounty-store.js');
const { verifyAirSession, FrameSource, CodeChecker } = await import('./bounty-verifier.js');
const { bountyConfig } = await import('./bounty-claim.config.js');

// ── a session with a real handle behind a claim, and two clips ─────────────
const reserved = store.reserveHandle({ platform: 'twitch', handle: 'TimelineStreamer', ttlMs: 864e5 });
const key = store.handleKey('twitch', 'TimelineStreamer');
const claim = store.createClaim({ handleKey: key, claimant: 'tl', platform: 'twitch', handle: 'TimelineStreamer' });
const sess = store.createAirSession({ claimId: claim.id, roomId: 'tlroom', platform: 'twitch' });
const T0 = Date.now() - 600_000;
const mkWin = (clipId, startedAt, codes) => store.pushPlaybackWindow(sess.id, {
  clipId, playbackId: `${clipId}#n`, startedAt, endsAt: startedAt + 10_000,
  durationS: 10, belowSamplingFloor: false,
  codes: codes.map(([code, issuedAt]) => ({ code, clipId, playbackId: `${clipId}#n`, issuedAt, expiresAt: issuedAt + 5_000 })),
});
// Clip A's badge is on screen at T0..T0+10s; clip B's 60s later.
mkWin('CLIP_A', T0, [['AA-1111', T0 + 1000], ['AA-2222', T0 + 5000]]);
mkWin('CLIP_B', T0 + 60_000, [['BB-3333', T0 + 61_000], ['BB-5555', T0 + 65_000]]);

/** Records what it was asked for; returns whatever code the harness plants. */
class Recorder extends FrameSource {
  constructor(live) { super(); this.live = live; this.handles = []; this.asked = []; }
  async getFrames(platform, handle, timestamps) {
    this.handles.push(handle);
    return timestamps.map((t) => {
      const ts = typeof t === 'object' ? t.ts : t;
      this.asked.push(ts);
      return { ref: `rec:${ts}`, ts, live: this.live, clipId: t.clipId, playbackId: t.playbackId };
    });
  }
}
/** Answers with the code that was on screen SKEW ms before the asked-for ts. */
class SkewedChecker extends CodeChecker {
  constructor(skewMs, plant) { super(); this.skewMs = skewMs; this.plant = plant; this.offered = []; }
  async findCode(frame, expected) {
    this.offered.push([...expected]);
    const onScreen = this.plant(frame.ts - this.skewMs);
    return expected.includes(onScreen)
      ? { found: true, confidence: 0.9, pixelHeight: 28, text: onScreen }
      : { found: false, confidence: 0.2, pixelHeight: 28, text: '-------' };
  }
}
// What the badge really showed at a given wall-clock moment.
const plant = (wall) => {
  const all = (store.getAirSession(sess.id).playbackWindows || []).flatMap((w) => w.codes);
  const hit = all.find((c) => c.issuedAt <= wall && c.expiresAt > wall);
  return hit ? hit.code : null;
};

// ── 1. the handle actually reaches the frame source ───────────────────────
const rec = new Recorder(false);
await verifyAirSession(sess.id, { frameSource: rec, codeChecker: new SkewedChecker(0, plant) });
ok('the verifier resolves the handle from the claim, not session.handle',
  rec.handles.every((h) => String(h).toLowerCase() === 'timelinestreamer'),
  JSON.stringify([...new Set(rec.handles)]));
ok('...so the platform URL is never built with an empty handle',
  rec.handles.every((h) => h && h.length > 0));

// ── 2/3. RESIDUAL skew, after the seek correction ─────────────────────────
// frame-sources shifts the VOD seek by vodTimelineSkewMs, so a frame should
// land near the requested wall-clock instant. What the accepted-code window
// has to absorb is the RESIDUAL — the gap between the configured constant and
// whatever this particular broadcast's real skew turns out to be. That is the
// number a wrong constant turns into an unpaid streamer, so it is what gets
// tested here. (The seek arithmetic itself is proven by the real VOD: 4/4
// clips PASS on VOD 2832201336 — a fake source cannot exercise it.)
const residual = async (ms, live = false) => {
  const r = new Recorder(live);
  return verifyAirSession(sess.id, { frameSource: r, codeChecker: new SkewedChecker(ms, plant) });
};
const r0 = await residual(0);
ok('a CORRECTLY seeked frame verifies cleanly', r0.verifiedClips === 2 && r0.result === 'PASS',
  `${r0.verifiedClips}/2 clips, result=${r0.result}, conf=${r0.confidence}`);

// HOW FRAGILE THIS IS, measured rather than assumed. Sample instants sit only a
// few seconds after each clip's code coverage begins, so a modest residual
// pushes half the samples off the front of the clip: the clips still verify but
// the session degrades to AMBIGUOUS, which routes a streamer who did the work
// to human review. Accuracy of the seek is worth more than width of the filter.
//
// SAME ASSERTION, DIFFERENT MECHANISM SINCE THE detectionRate SPLIT. This used
// to be carried by confidence collapsing to 0.55, because the mean spanned
// found and not-found frames alike and so silently equalled read quality x
// detection rate. Read quality here is 0.9 -- the badges that WERE seeked to
// were decoded cleanly, and saying otherwise was always a slander on the
// encoder. What actually degrades is presence: 2 of 4 samples land off the
// front of the clip, so detectionRate is 0.50 against a 0.55 floor.
//
// That 0.05 is deliberately thin and is documented at minDetectionRate: this
// fixture (0.50, a knowingly broken timeline) and Kick run #4 (0.6154, a
// broadcast proven honest) are only 0.115 apart. If this assertion ever starts
// failing because the floor moved, do NOT lower the floor to suit it -- the
// property it protects is that a mis-seek must never silently auto-pay.
const r4 = await residual(4_000);
ok('a 4s residual still verifies but DEGRADES to review-worthy confidence',
  r4.verifiedClips === 2 && r4.result === 'AMBIGUOUS',
  `${r4.verifiedClips}/2 clips, result=${r4.result}, conf=${r4.confidence}`);

// THE HARD LIMIT, stated rather than papered over. Past a few seconds the
// sampled frame lands BEFORE the clip's badge was ever on screen, so no code
// belonging to it can be present and no acceptance window can fix it — the
// problem is the seek, not the filter. This is why vodTimelineSkewMs is
// load-bearing, why a wider tolerance is not a substitute for a correct one,
// and why per-VOD calibration is the right long-term answer. Clips may be as
// short as bountyConfig.minClipSeconds, which tightens this further.
const rBeyond = await residual(8_000);
ok('a residual past the code coverage of the clip cannot verify at all',
  rBeyond.verifiedClips === 0,
  `${rBeyond.verifiedClips} clips at 8s residual on 10s clips`);

const rLive = await residual(0, true);
ok('the live path verifies on its own (wider) allowance too',
  rLive.verifiedClips === 2, `${rLive.verifiedClips}/2 clips, result=${rLive.result}`);

// ── 4. the old behaviour is genuinely gone ────────────────────────────────
// A zero-tolerance window is what shipped before; prove it would have failed,
// so this gate fails loudly if the tolerance is ever set back to zero.
const strict = bountyConfig.mediaSkewToleranceMs;
ok('the shipped VOD tolerance is wide enough to cover the measured skew',
  strict >= 16_000, `mediaSkewToleranceMs=${strict}`);
ok('the shipped live allowance covers the measured live delay',
  bountyConfig.liveBroadcastDelayMs >= 25_000, `${bountyConfig.liveBroadcastDelayMs}`);
ok('the VOD seek is shifted by the measured skew',
  bountyConfig.vodTimelineSkewMs >= 10_000, `${bountyConfig.vodTimelineSkewMs}`);

// ── 5. THE SAFETY PROPERTY: no cross-clip credit ──────────────────────────
// Every code ever offered for a frame must belong to the clip being sampled.
const codesOf = (clipId) => (store.getAirSession(sess.id).playbackWindows || [])
  .find((w) => w.clipId === clipId).codes.map((c) => c.code);
const aCodes = codesOf('CLIP_A'), bCodes = codesOf('CLIP_B');
const leakChk = new SkewedChecker(15_000, plant);
await verifyAirSession(sess.id, { frameSource: new Recorder(false), codeChecker: leakChk });
const leaked = leakChk.offered.some((set) =>
  (set.some((c) => aCodes.includes(c)) && set.some((c) => bCodes.includes(c))));
ok('widening the window NEVER mixes two clips\' codes into one frame check', !leaked);

// A frame showing only CLIP_B's badge must not verify CLIP_A, however wide the
// window gets — this is the property the payout rests on.
const onlyB = new SkewedChecker(0, () => 'BB-3333');
const cross = await verifyAirSession(sess.id, { frameSource: new Recorder(false), codeChecker: onlyB });
ok('a frame carrying only ANOTHER clip\'s code cannot verify this clip',
  cross.verifiedClips <= 1, `${cross.verifiedClips} clip(s) verified from B-only frames`);
ok('...and the clip that did NOT air is not among the verified',
  !(cross.clipVerdicts || []).some((c) => c.clipId === 'CLIP_A' && c.verified),
  JSON.stringify((cross.clipVerdicts || []).map((c) => `${c.clipId}:${c.verified}`)));

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
