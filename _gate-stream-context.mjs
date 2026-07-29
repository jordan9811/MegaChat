/**
 * GATE — stream-context enforcement.
 *
 * The requirement: the streamer genuinely went live and played the clips as
 * part of a real broadcast, rather than going live at 4am, dumping everything
 * to nobody, and ending the stream.
 *
 * A GATE, NOT A DIAL. Payout is unweighted and unchanged; context only decides
 * whether a HUMAN looks. Cases:
 *   A. warmup — inside the first 10 min does not count; after does
 *   B. tail — stream ending too soon after the last counted playback → review
 *   C. config — both durations take effect when changed
 *   D. routing — failures reach a reviewer with the SPECIFIC condition named,
 *      never auto-denial
 *   E. the deliberate absences — no viewer threshold, no spacing rule
 */
import { readFileSync } from 'fs';
import { evaluateStreamContext, describeContext, CONTEXT_FAILURES } from './bounty-stream-context.js';
import { bountyConfig } from './bounty-claim.config.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};

const MIN = 60_000;
const start = Date.parse('2026-07-28T04:00:00Z'); // the 4am farm, by name
const pb = (id, minsIn) => ({ clipId: `C${id}`, playbackId: `P${id}`, startedAt: start + minsIn * MIN });

// ── A. warmup ─────────────────────────────────────────────────────────────
const a = evaluateStreamContext({
  broadcastStartedAt: start,
  broadcastEndedAt: start + 60 * MIN,
  playbacks: [pb(1, 2), pb(2, 9), pb(3, 11), pb(4, 30)],
});
ok('A. playbacks inside the first 10 minutes do NOT count',
  a.rejected.length === 2 && a.rejected.every((r) => r.failure === CONTEXT_FAILURES.INSIDE_WARMUP),
  `${a.rejected.length} rejected`);
ok('A. playbacks after the warmup DO count', a.counted.length === 2,
  a.counted.map((c) => c.clipId).join(','));
ok('A. the rejection says how far into the broadcast it was',
  /\d+s into the broadcast/.test(a.rejected[0].detail || ''), a.rejected[0].detail);
ok('A. a warmup rejection needs a human, it is not an auto-denial', a.needsReview === true);

// The pure farm: everything dumped immediately.
const farm = evaluateStreamContext({
  broadcastStartedAt: start,
  broadcastEndedAt: start + 8 * MIN,
  playbacks: [pb(1, 1), pb(2, 2), pb(3, 3)],
});
ok('A. THE 4AM DUMP: every playback inside warmup, nothing counts',
  farm.counted.length === 0 && farm.rejected.length === 3);

// ── B. tail ───────────────────────────────────────────────────────────────
const b = evaluateStreamContext({
  broadcastStartedAt: start,
  broadcastEndedAt: start + 20 * MIN + 20_000, // 20s after the last playback
  playbacks: [pb(1, 15), pb(2, 20)],
});
ok('B. a stream ending too soon after the last playback is flagged',
  b.warnings.some((w) => w.failure === CONTEXT_FAILURES.STREAM_ENDED_TOO_SOON), b.warnings[0]?.detail);
ok('B. ...but the playbacks still COUNT — the streamer did play them',
  b.counted.length === 2);
ok('B. ...and it routes to review rather than silently uncounting', b.needsReview === true);

const bOk = evaluateStreamContext({
  broadcastStartedAt: start,
  broadcastEndedAt: start + 40 * MIN,
  playbacks: [pb(1, 15), pb(2, 20)],
});
ok('B. a stream that keeps going is clean', bOk.needsReview === false && bOk.counted.length === 2);

const stillLive = evaluateStreamContext({
  broadcastStartedAt: start, broadcastEndedAt: null,
  playbacks: [pb(1, 15)], now: start + 15 * MIN + 5_000,
});
ok('B. a STILL-LIVE stream is never penalised for a short tail',
  stillLive.needsReview === false && stillLive.counted.length === 1);

// ── C. config ─────────────────────────────────────────────────────────────
const c = evaluateStreamContext({
  broadcastStartedAt: start, broadcastEndedAt: start + 60 * MIN,
  playbacks: [pb(1, 3)], warmupMs: 2 * MIN,
});
ok('C. a shorter configured warmup lets an earlier playback count',
  c.counted.length === 1 && c.rejected.length === 0);
const c2 = evaluateStreamContext({
  broadcastStartedAt: start, broadcastEndedAt: start + 60 * MIN,
  playbacks: [pb(1, 20)], warmupMs: 30 * MIN,
});
ok('C. a longer configured warmup rejects a later one', c2.rejected.length === 1);
const c3 = evaluateStreamContext({
  broadcastStartedAt: start, broadcastEndedAt: start + 20 * MIN + 90_000,
  playbacks: [pb(1, 20)], tailMs: 5 * MIN,
});
ok('C. a longer configured tail flags a stream that was previously fine',
  c3.warnings.length === 1, c3.warnings[0]?.detail);
ok('C. defaults are 10 minutes and 1 minute',
  bountyConfig.streamWarmupMs === 10 * MIN && bountyConfig.streamTailMs === MIN,
  `${bountyConfig.streamWarmupMs}/${bountyConfig.streamTailMs}`);

// ── D. unknown broadcast start ────────────────────────────────────────────
const d = evaluateStreamContext({
  broadcastStartedAt: null, playbacks: [pb(1, 15)],
});
ok('D. an unknown broadcast start is REVIEW, not a silent pass or denial',
  d.needsReview === true && d.counted.length === 0
  && d.rejected[0].failure === CONTEXT_FAILURES.NO_BROADCAST_START);
ok('D. the reviewer summary names the specific condition',
  /warmup|no known broadcast start/i.test(describeContext(a))
  && /no known broadcast start/i.test(describeContext(d)),
  describeContext(d));
ok('D. a clean session summarises as OK', describeContext(bOk) === 'stream context OK');

// ── E. the deliberate absences ────────────────────────────────────────────
const src = readFileSync('bounty-stream-context.js', 'utf8');
const code = src.split('*/').slice(1).join('*/'); // strip the doc comment
ok('E. NO viewer-count threshold anywhere in the logic',
  !/viewerCount|viewer_count|viewers\s*[<>=]/.test(code));
ok('E. NO playback-spacing or minimum-gap rule',
  !/gap|spacing|sinceLast/i.test(code));
ok('E. payout is not scaled here at all (gate, not dial)',
  !/multiplier|weight|scale/i.test(code));

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
