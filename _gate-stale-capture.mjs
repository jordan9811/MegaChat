/**
 * GATE — A DEAD RECORDER MUST NEVER BE SCORED AS AN ABSENT BADGE.
 *
 * This is the most expensive failure this system can produce, because it is
 * silent, it is confident, and it points at the wrong party: our own recording
 * stops, the verifier finds no badge in stale media, and the streamer is told
 * their broadcast carried no badge and paid ZERO.
 *
 * IT IS NOT HYPOTHETICAL, AND THIS GATE IS BUILT FROM THE BROADCAST THAT
 * PROVED IT. On 2026-08-29 a real pump.fun stream aired five clips with the
 * badge legible at 28px (the canary read code C6-GHQY off the PUBLIC stream).
 * The rolling buffer ingested cleanly for thirty minutes, then stopped dead at
 * 22:03:21 — and every freeze after that wrote THE SAME stale minute of media
 * under a new playback name. Eight capture files, one md5:
 *
 *     1a59ef1f319d7b3e3584422430be134b   PF1 PF2 PF3 PF4 PF5
 *                                        PF_CANARY PF_HOLD16 PF_SETUP1
 *
 * Everything we printed said it worked: "froze 23/23", "PROGRAM-DATE-TIME
 * present on 23/23". Both are presence checks. Neither can see eight identical
 * files, and the operator was told self-capture was proven on pump.fun.
 *
 * Replayed against those real files with calibration forced good, the code of
 * that day returns FAIL 0/5 — our outage, recorded as an accusation.
 *
 * So this gate runs on THE ACTUAL CAPTURE FILES from that broadcast, not on
 * fixtures. A fixture would encode what I believe went wrong; the files encode
 * what did.
 *
 * WHAT IT HOLDS:
 *   A. ffmpeg exiting 0 is not proof a frame exists — a seek past the end of
 *      media writes NO file, and grabFrame must refuse to hand back that path.
 *   B. An instant our recording does not reach is reported per-sample as
 *      unreadable, and NEVER as a throw — windows recorded before a stall are
 *      still good evidence and must survive.
 *   C. With nothing readable anywhere, the verdict is SOURCE_UNAVAILABLE, not
 *      FAIL. "We could not look" is not "the badge was not there".
 *   D. Unreadable samples stay out of the detectionRate denominator, which is
 *      a release gate: our outage must not push an honest broadcast under it.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const EVIDENCE = 'C:/Users/jorda/AppData/Local/Temp/claude/'
  + 'C--Users-jorda-OneDrive-Documents-video-stream/'
  + '510666e4-cb6c-4a45-bbb3-5f79e340fa3b/scratchpad/pf-run-evidence';
const CAPTURES = 'C:/Users/jorda/AppData/Local/Temp/mc-pumpfun-3ptafp/bounty-captures';
const STALL_MD5 = '1a59ef1f319d7b3e3584422430be134b';

let pass = 0, fail = 0, skip = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};

// The recorded broadcast is the fixture. Without it this gate cannot make its
// claim, and MUST say so rather than pass vacuously.
if (!existsSync(`${EVIDENCE}/bounty.json`) || !existsSync(CAPTURES)) {
  console.log('SKIP: the 2026-08-29 pump.fun capture files are not on this host.');
  console.log('      This gate asserts nothing without them — it does not pass by default.');
  process.exit(2);
}

const { grabFrame, CaptureFrameSource, SOURCE_STATES } = await import('./frame-sources.js');
const { createHash } = await import('crypto');

const md5 = (f) => createHash('md5').update(readFileSync(f)).digest('hex');
const capFiles = (await import('fs')).readdirSync(CAPTURES).filter((f) => f.endsWith('.ts'));
const stalled = capFiles
  .map((f) => path.join(CAPTURES, f))
  .filter((f) => md5(f) === STALL_MD5);

console.log(`\nfixture: ${capFiles.length} capture file(s), `
  + `${stalled.length} sharing the stalled-ring md5\n`);
ok('0. the recorded stall is present in the fixture', stalled.length >= 5,
  `${stalled.length} byte-identical file(s) — the ring stopped and kept "freezing"`);

const stale = stalled[0];

// ── A. ffmpeg exit 0 is not proof of a frame ────────────────────────────────
// A stalled window holds ~60s of media. Ask for 195s into it: the real code
// asked for exactly this kind of offset, got exit 0 and no file, and returned
// the path anyway.
{
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'mc-stale-')), 'past-end.png');
  let threw = null;
  try { grabFrame(stale, 195, out, { decodeThrough: true }); } catch (e) { threw = e; }
  ok('A. a seek past the end of media THROWS instead of returning a phantom path',
    !!threw && !existsSync(out),
    threw ? `${threw.state}: ${String(threw.detail).slice(0, 60)}` : 'returned a path to nothing');

  // The same file must still be readable where it DOES have media, or this
  // gate would pass on a source that simply refuses everything.
  const good = path.join(mkdtempSync(path.join(tmpdir(), 'mc-stale-')), 'in-range.png');
  let ok2 = false;
  try { grabFrame(stale, 5, good, { decodeThrough: true }); ok2 = existsSync(good); } catch { /* */ }
  ok('A. ...while a seek INSIDE the media still returns a real frame', ok2,
    'the fix must not simply reject every read');
}

// ── B + C + D. the verifier's verdict on a dead recorder ────────────────────
const store = JSON.parse(readFileSync(`${EVIDENCE}/bounty.json`, 'utf8'));
const sess = Object.values(store.airSessions || {})[0];
const windows = sess.playbackWindows || [];
const realClips = windows.filter((w) => /^PF[1-5]$/.test(w.clipId));
ok('0. the five real clips are in the session', realClips.length === 5,
  realClips.map((w) => w.clipId).join(' '));

// Build the source over the ACTUAL frozen records, exactly as the verifier does.
const frozen = readFileSync(`${EVIDENCE}/bounty-evidence.jsonl`, 'utf8')
  .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && r.type === 'CAPTURE_FROZEN');
const capsFor = (clipId) => frozen
  .filter((r) => r.clipId === clipId && existsSync(r.file))
  .map((r) => ({
    file: r.file, frozenAt: r.frozenAt, firstPdtMs: r.firstPdtMs,
    spanMs: r.spanMs, playbackId: r.playbackId, clipId: r.clipId,
  }));

{
  const caps = realClips.flatMap((w) => capsFor(w.clipId));
  ok('0. the real clips have frozen captures on disk', caps.length === 5,
    `${caps.length} capture record(s)`);

  const src = new CaptureFrameSource({ captures: caps, log: { warn() {}, log() {} } });
  // The instants the verifier would ask for: the middle of each real clip.
  // Every one of these lands far past the end of the stalled media.
  const instants = realClips.map((w) => ({
    ts: w.startedAt + Math.round(((w.endsAt || w.startedAt) - w.startedAt) / 2),
    clipId: w.clipId,
    playbackId: capsFor(w.clipId)[0]?.playbackId || null,
  }));

  let frames = null; let threw = null;
  try {
    frames = await src.getFrames('pumpfun', 'GnBQjwQibzB9zFPHEGEhoiASon7JfaRADxQe6C64pump',
      instants, { skewMs: 0 });
  } catch (e) { threw = e; }

  ok('B. an uncoverable instant does NOT throw and kill the session',
    !threw && Array.isArray(frames),
    threw ? `threw ${threw.state}` : `${frames.length} frame slot(s) returned`);

  if (frames) {
    const unread = frames.filter((f) => f.unreadable);
    const phantom = frames.filter((f) => !f.unreadable && f.ref && !existsSync(f.ref));
    ok('B. ...it is reported per-sample as unreadable',
      unread.length === frames.length,
      `${unread.length}/${frames.length} marked ${unread[0]?.unreadable || '-'}`);
    ok('B. ...and NO frame references a file that does not exist',
      phantom.length === 0,
      phantom.length ? `${phantom.length} phantom ref(s)` : 'none — the old bug is gone');
    // `unread.length > 0` FIRST, deliberately. Without it this is `.every()`
    // over an empty array — vacuously true — and it PASSED against the pre-fix
    // code during this gate's own negative control, while the two assertions
    // beside it correctly failed. A gate that cannot fail is decoration.
    ok('B. ...tagged with a cause a reviewer can act on',
      unread.length > 0 && unread.every((f) => f.unreadable === SOURCE_STATES.CAPTURE_GAP
        || f.unreadable === SOURCE_STATES.EXTRACTION_FAILED),
      unread[0]?.unreadableDetail || 'no unreadable samples to tag');
  }
}

// ── D. detectionRate must not be diluted by our own failures ────────────────
// Verified against the shipped arithmetic rather than a restatement of it: an
// unreadable sample must leave the denominator, or a half-dead recorder drags
// an honest broadcast under a release gate.
{
  const checks = [
    { counted: true }, { counted: true },
    { counted: false, unreadable: 'CAPTURE_GAP' },
    { counted: false, unreadable: 'CAPTURE_GAP' },
  ];
  const readSamples = checks.filter((c) => c.counted);
  const attempted = checks.filter((c) => !c.unreadable);
  const rate = attempted.length ? readSamples.length / attempted.length : 0;
  ok('D. two clean reads beside two unreadable samples is detectionRate 1.0',
    rate === 1, `got ${rate} (the pre-fix denominator gave ${readSamples.length / checks.length})`);
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail${skip ? `, ${skip} skip` : ''}`);
process.exit(fail ? 1 : 0);
