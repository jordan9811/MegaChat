/**
 * GATE — THE RECORDER MUST NOTICE ITS OWN DEATH.
 *
 * On 2026-08-29 the rolling buffer ingested a real pump.fun broadcast cleanly
 * for thirty minutes, then stopped dead — and kept "freezing" windows onto the
 * same stale minute of media, eight times, one md5. Nothing logged. The run
 * reported "froze 23/23, PROGRAM-DATE-TIME present on 23/23" and the operator
 * was told self-capture worked on pump.fun.
 *
 * The reason it could not tell: the only precondition on a freeze was
 * `state.buffer.segments.length` — "we have bytes" — which a dead ring
 * satisfies forever, because the last segments it ever fetched stay in it. And
 * a total segment outage was invisible too: `if (!r.ok) continue;` discarded
 * every failure and `state.errors = 0` ran regardless, so the recorder looked
 * healthy while capturing air.
 *
 * This gate drives the real startCapture/freezeWindow with a fetch that STOPS
 * ADVANCING, which is the failure exactly as it happened. It runs on a
 * shortened window (env, below) so a stall that took half an hour in the wild
 * takes seconds here.
 *
 * IT MUST ALSO PASS THE HEALTHY CASE. A gate that only proves we can shout
 * "stale" would be satisfied by marking everything stale, which would put
 * every honest broadcast into review. Section B is not padding; it is the half
 * that stops the fix from becoming a new way to fail streamers.
 */
process.env.BOUNTY_CAPTURE_WINDOW_MS = '2000';
process.env.BOUNTY_CAPTURE_POLL_MS = '250';
process.env.BOUNTY_SELF_CAPTURE = '1';
process.env.DATA_DIR = process.env.DATA_DIR
  || (await import('fs')).mkdtempSync(
    (await import('path')).default.join((await import('os')).tmpdir(), 'mc-stall-'));

const { startCapture, freezeWindow, stopCapture } = await import('./bounty-capture.js');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { log() {}, warn() {} };
const { createHash } = await import('crypto');
const { readFileSync } = await import('fs');
const md5 = (f) => {
  try { return createHash('md5').update(readFileSync(f)).digest('hex'); } catch { return 'MISSING'; }
};

// A 2-segment media playlist, PDT-stamped like pump.fun's.
const playlist = (startSeq, t0) => {
  const L = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2',
    `#EXT-X-MEDIA-SEQUENCE:${startSeq}`];
  for (let i = 0; i < 2; i += 1) {
    L.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(t0 + i * 2000).toISOString()}`);
    L.push('#EXTINF:2.000,');
    L.push(`https://example.invalid/seg${startSeq + i}.ts`);
  }
  return L.join('\n');
};

const mkFetch = (advancing) => {
  let seq = 0;
  const t0 = Date.now() - 4000;
  return async (url) => {
    if (String(url).endsWith('.m3u8')) {
      // ADVANCING: each poll lists two NEW segments, as a live stream does.
      // STUCK: every poll lists the same two forever — the ring can never grow,
      // which is precisely what a rotated-away media directory looks like from
      // here (the playlist that is still being polled simply stops changing).
      const body = playlist(advancing ? (seq += 2) : 0, t0);
      return { ok: true, status: 200, text: async () => body };
    }
    // DISTINCT BYTES PER SEGMENT. Returning one shared zero-filled buffer made
    // the HEALTHY ring's consecutive freezes byte-identical too, so section B
    // failed against correct code — the fixture, not the recorder, was the
    // thing that could not tell fresh media from stale.
    const n = Number(/seg(\d+)\.ts$/.exec(String(url))?.[1] ?? 0);
    const buf = Buffer.alloc(1024, n % 251);
    buf.writeUInt32BE(n >>> 0, 0);
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(
      buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
};

// ── A. a ring that stops advancing is caught, and says so on the record ─────
{
  const id = 'stall-a';
  await startCapture(id, {
    hlsUrl: 'https://example.invalid/media.m3u8', platform: 'pumpfun', handle: 'x',
    log: quiet, fetchImpl: mkFetch(false),
  });
  await sleep(3000); // past the 2s window with no new media
  const rec = freezeWindow(id, { playbackId: 'P1', clipId: 'C1', log: quiet });
  await sleep(1500);
  const rec2 = freezeWindow(id, { playbackId: 'P1b', clipId: 'C1b', log: quiet });
  stopCapture(id, { log: quiet });

  ok('A. a stalled ring still produces a capture record', !!rec,
    rec ? `${rec.segments} segment(s)` : 'null');
  ok('A. ...marked STALE, so nothing downstream reads it as a live recording',
    rec?.stale === true, `stale=${rec?.stale} stalledMs=${rec?.stalledMs}`);
  ok('A. ...with how far behind it is, on the evidence row itself',
    Number(rec?.stalledMs) >= 2000,
    `${rec?.stalledMs}ms behind a ${process.env.BOUNTY_CAPTURE_WINDOW_MS}ms window`);
  // THE PRODUCTION SIGNATURE, REPRODUCED. Two playbacks, two freezes, one md5
  // — the exact shape of the eight identical files from the real broadcast.
  // Before the fix both rows claimed healthy coverage; now both say stale.
  ok('A. ...and a SECOND freeze off the same dead ring is byte-identical',
    !!rec2 && md5(rec.file) === md5(rec2.file),
    `${md5(rec.file).slice(0, 12)} vs ${rec2 ? md5(rec2.file).slice(0, 12) : '-'}`);
  ok('A. ...which is ALSO flagged, rather than only the first',
    rec2?.stale === true, `stale=${rec2?.stale}`);
}

// ── B. a healthy ring is NOT marked stale ───────────────────────────────────
// The half that keeps the fix from becoming a new way to fail honest streamers.
{
  const id = 'stall-b';
  await startCapture(id, {
    hlsUrl: 'https://example.invalid/media.m3u8', platform: 'pumpfun', handle: 'x',
    log: quiet, fetchImpl: mkFetch(true),
  });
  await sleep(3000); // same elapsed time, but media keeps arriving
  const rec = freezeWindow(id, { playbackId: 'P2', clipId: 'C2', log: quiet });
  await sleep(1500);
  const rec2 = freezeWindow(id, { playbackId: 'P2b', clipId: 'C2b', log: quiet });
  stopCapture(id, { log: quiet });

  ok('B. a ring that keeps ingesting produces a record', !!rec,
    rec ? `${rec.segments} segment(s)` : 'null');
  ok('B. ...and is NOT marked stale', rec?.stale === false,
    `stale=${rec?.stale} stalledMs=${rec?.stalledMs}`);
  // The buffer is a ROLLING window, so "it grew" is not a segment count — it
  // holds one window's worth by design and a count assertion fails on correct
  // code (it did, in this gate's first draft). Consecutive freezes DIFFERING
  // is the real signal, and the exact thing the dead ring could not do.
  ok('B. ...and consecutive freezes differ, proving media kept arriving',
    !!rec2 && md5(rec.file) !== md5(rec2.file),
    `${md5(rec.file).slice(0, 12)} vs ${rec2 ? md5(rec2.file).slice(0, 12) : '-'}`);
  ok('B. ...with the second still not stale', rec2?.stale === false,
    `stale=${rec2?.stale} stalledMs=${rec2?.stalledMs}`);
}

// ── C. the two are distinguishable, which is the whole point ────────────────
// The pre-fix code produced identical-looking records for both cases; that is
// how eight byte-identical files were reported as twenty-three healthy freezes.
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
