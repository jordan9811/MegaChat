/**
 * VERIFY — calibration against the REAL VOD of the real broadcast.
 *
 * The stub gate exercises the arithmetic; this exercises the thing it is for.
 * VOD 2832201336 (jordandotfun, 2026-07-29) is the broadcast whose timeline was
 * measured BY HAND at 15.0s and 16.7s, and which needed a hard-coded 16s
 * constant to reach PASS. If calibration is real, it recovers that offset from
 * the content on its own and still verifies 4 of 4 playbacks.
 *
 * This is the arbiter the stub cannot be: real Twitch transcode, real HLS
 * segmentation, real keyframe placement, real badge pixels.
 *
 * Requires the rehearsal's data dir (REHEARSAL_DATA_DIR) and live Twitch
 * credentials. Skips loudly rather than passing when either is missing — a
 * check that quietly does nothing is worse than no check.
 */
import { existsSync, readFileSync } from 'fs';

process.loadEnvFile?.('.env');

const DATA = process.env.REHEARSAL_DATA_DIR
  || 'C:/Users/jorda/AppData/Local/Temp/mc-rehearsal-wg7OD9';
const PORT = 3340;

let pass = 0, fail = 0, skipped = false;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};

if (!existsSync(`${DATA}/bounty.json`)) {
  console.log(`SKIPPED: no rehearsal data at ${DATA}`);
  console.log('Set REHEARSAL_DATA_DIR to a dir from a real rehearsal run.');
  process.exit(0);
}
if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
  console.log('SKIPPED: Twitch credentials absent — this check reads a real VOD.');
  process.exit(0);
}

// The air session from the real broadcast.
const store = JSON.parse(readFileSync(`${DATA}/bounty.json`, 'utf8'));
const sess = Object.values(store.airSessions || {})
  .filter((s) => (s.playbackWindows || []).some((w) => (w.codes || []).length))
  .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
if (!sess) { console.log('SKIPPED: no air session with codes in the rehearsal data.'); process.exit(0); }

const windows = (sess.playbackWindows || []).filter((w) => (w.codes || []).length);
console.log(`real air session ${sess.id.slice(0, 8)} — ${windows.length} playback window(s), `
  + `broadcast started ${sess.broadcastStartedAt ? new Date(sess.broadcastStartedAt).toISOString() : 'unknown'}`);

const { startGateServer } = await import('./_gate-helpers.mjs');
const srv = await startGateServer({
  port: PORT, dataDir: DATA,
  env: {
    BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true',
    TWITCH_CLIENT_ID: process.env.TWITCH_CLIENT_ID,
    TWITCH_CLIENT_SECRET: process.env.TWITCH_CLIENT_SECRET,
    // Deliberately WRONG prior, far from the hand-measured ~16s. If calibration
    // is doing the work, the constant it starts from should not matter.
    BOUNTY_VOD_SKEW_MS: '0',
  },
});

try {
  const r = await fetch(`http://localhost:${PORT}/api/bounty/air-session/${sess.id}/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'real', sourceMode: 'vod' }),
  });
  const d = await r.json();
  const v = d.verification || {};
  const cal = v.calibration || {};
  console.log(`\nresult        : ${v.result}`);
  console.log(`verifiedClips : ${v.verifiedClips} of ${windows.length}`);
  console.log(`calibration   : ${cal.state} skew=${cal.skewMs}ms spread=${cal.spreadMs}ms `
    + `points=${cal.points?.length} grabs=${cal.grabs} residual=±${cal.residualMs}ms`);
  if (cal.points?.length) {
    console.log(`per-point Δ   : ${cal.points.map((p) => (p.estimateMs / 1000).toFixed(1)).join('s, ')}s`);
  }
  if (cal.detail) console.log(`detail        : ${String(cal.detail).slice(0, 200)}`);

  ok('calibration MEASURES the real VOD timeline from its own content',
    cal.state === 'MEASURED', `${cal.state}`);
  // The hand measurement was 15.0s and 16.7s on two samples. Anything in that
  // neighbourhood is the same number; the point is that it was DERIVED here,
  // starting from a deliberately wrong 0ms prior.
  ok('...landing near the hand-measured 15-17s, from a 0ms starting prior',
    cal.state === 'MEASURED' && cal.skewMs >= 11_000 && cal.skewMs <= 21_000,
    `${(cal.skewMs / 1000).toFixed(1)}s`);
  ok('...with enough agreeing points to not be luck',
    (cal.points?.length || 0) >= 3, `${cal.points?.length} points`);
  ok('the real broadcast STILL verifies every playback',
    v.verifiedClips === windows.length && ['PASS', 'PARTIAL'].includes(v.result),
    `${v.result} ${v.verifiedClips}/${windows.length}`);
  ok('...and the residual window is tighter than the old flat 20s',
    cal.residualMs > 0 && cal.residualMs < 20_000, `±${cal.residualMs}ms`);
} finally {
  srv.kill();
}
console.log(`\nRESULT: ${pass} pass, ${fail} fail${skipped ? ' (skipped)' : ''}`);
process.exit(fail === 0 ? 0 : 1);
