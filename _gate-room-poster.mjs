/**
 * GATE — the recent-rail poster.
 *
 * Three things worth holding, all of which are easy to get wrong in a way that
 * looks fine:
 *
 *   1. The frame is NOT the last frame. The last frame of a stream is an end
 *      card or black, which is exactly the placeholder this feature exists to
 *      replace. Assert the chosen offset is the MIDPOINT of the LONGEST
 *      playback, not the end of anything.
 *   2. A room with no capture gets a CARD, not a fake frame. Assert the kind
 *      differs, because the rail draws them differently and a generated card
 *      that could pass for a photograph is a lie about what we have.
 *   3. The poster survives the capture purge. This is the whole reason it does
 *      not live in bounty-captures/, and it is the failure that would only
 *      show up two weeks after launch.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-poster-'));
process.env.DATA_DIR = SCRATCH;

const { chooseFrame, buildPoster, buildCard, posterPathFor, POSTER_DIR } = await import('./room-poster.js');
const capture = await import('./bounty-capture.js');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};

console.log('\n── room poster ───────────────────────────────────────────');

// ── A. frame CHOICE, before any ffmpeg is involved ──────────────────────
{
  const records = [
    { file: 'a.ts', playbackId: 'p1', spanMs: 20_000, frozenAt: 1 },
    { file: 'b.ts', playbackId: 'p2', spanMs: 60_000, frozenAt: 2 },  // longest
    { file: 'c.ts', playbackId: 'p3', spanMs: 45_000, frozenAt: 3 },  // most recent
  ];
  const pick = chooseFrame(records);
  ok('A1 picks the LONGEST playback, not the most recent', pick.playbackId === 'p2', `chose ${pick.playbackId}`);
  ok('A2 seeks the MIDPOINT of it, not the end', pick.offsetS === 30, `offsetS=${pick.offsetS} of a 60s span`);
  ok('A3 and the midpoint is nowhere near the end card',
    pick.offsetS < (pick.spanMs / 1000) * 0.9, `${pick.offsetS}s into ${pick.spanMs / 1000}s`);

  ok('A4 a span-less record set yields no frame rather than a guess',
    chooseFrame([{ file: 'x.ts', spanMs: null }]) === null);
  ok('A5 and an empty set does too', chooseFrame([]) === null);
}

// ── B. a real extraction, if ffmpeg is here ─────────────────────────────
const haveFfmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;
if (!haveFfmpeg) {
  console.log('  SKIP  B. extraction — no ffmpeg on PATH');
} else {
  const src = path.join(SCRATCH, 'src.ts');
  // 6s of colour bars with a burnt-in timer, so the extracted frame is
  // provably from the MIDDLE and not the start or the end.
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10:duration=6',
    '-c:v', 'mpeg2video', '-f', 'mpegts', src], { encoding: 'utf8' });
  ok('B0 built a 6s fixture to extract from', fs.existsSync(src) && fs.statSync(src).size > 0);

  const poster = buildPoster('gateroom', [{ file: src, playbackId: 'pmid', spanMs: 6000, frozenAt: 1 }]);
  ok('B1 extracted a poster', !!poster && poster.kind === 'frame', poster ? `${poster.bytes} bytes` : 'null');
  ok('B2 from the midpoint', poster?.offsetMs === 3000, `offsetMs=${poster?.offsetMs}`);
  const out = posterPathFor('gateroom');
  ok('B3 the JPEG is on disk and non-empty', fs.existsSync(out) && fs.statSync(out).size > 0);
  ok('B4 it is small enough to be a card thumbnail', fs.statSync(out).size < 200_000,
    `${Math.round(fs.statSync(out).size / 1024)}KB`);

  // ── C. THE PURGE. The reason posters are not in bounty-captures/. ─────
  const capDir = path.join(SCRATCH, 'bounty-captures');
  fs.mkdirSync(capDir, { recursive: true });
  const stale = path.join(capDir, 'sess__p1.ts');
  fs.writeFileSync(stale, 'x');
  const old = Date.now() - (30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(stale, old / 1000, old / 1000);
  capture.purgeExpiredCaptures({ log: { log() {}, warn() {} } });
  ok('C1 the 30-day-old capture was swept', !fs.existsSync(stale));
  ok('C2 THE POSTER SURVIVED IT', fs.existsSync(out),
    `poster dir ${POSTER_DIR === capDir ? 'IS the capture dir — BUG' : 'is separate'}`);
  ok('C3 and they are genuinely different directories', POSTER_DIR !== capDir);

  // B5 — no frame from a file ffmpeg cannot read: exit 0 is not proof.
  const empty = path.join(SCRATCH, 'empty.ts');
  fs.writeFileSync(empty, '');
  ok('B5 an unreadable source yields null, not a zero-byte poster',
    buildPoster('badroom', [{ file: empty, playbackId: 'p', spanMs: 5000, frozenAt: 1 }], { log: { warn() {} } }) === null);
}

// ── D. the no-capture room gets a CARD, and it is distinguishable ───────
{
  const airing = {
    id: 'air1', startedAt: 1000, endedAt: 1000 + 42 * 60_000,
    moments: [
      { kind: 'seat', label: 'ripley', offsetMs: 5000 },
      { kind: 'megachat', label: 'dallas', offsetMs: 9000 },
      { kind: 'seat', label: 'ripley', offsetMs: 12000 },
      { kind: 'seat_leave', label: 'ripley', offsetMs: 20000 },
    ],
  };
  const card = buildCard(airing, { title: 'Gate Room' });
  ok('D1 a room with no capture gets a card', card.kind === 'card');
  ok('D2 which is NOT the same kind as a frame', card.kind !== 'frame');
  ok('D3 it carries a frozen snapshot, so the rail derives nothing',
    card.title === 'Gate Room' && card.durationMs === 42 * 60_000, `${card.durationMs}ms`);
  ok('D4 guests are deduped', card.guests.length === 2 && card.guests.includes('ripley'), card.guests.join(','));
  ok('D5 and it claims no source, because there is no picture behind it', card.source === null);
  ok('D6 a seat_leave is bookkeeping, not a moment the card counts', card.momentCount === 3, `momentCount=${card.momentCount} of 4 records`);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* windows lock */ }
process.exit(fail ? 1 : 0);
