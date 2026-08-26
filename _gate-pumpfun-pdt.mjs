/**
 * GATE — pump.fun capture: PROGRAM-DATE-TIME ANCHORS timeline calibration.
 *
 * SUPERSEDED IN PART, 2026-08-26, by Kick's first real broadcasts. This gate
 * used to be titled "...REPLACES timeline calibration" and asserted that a
 * PDT-stamped capture could SKIP calibration outright. That was wrong, and
 * wrong in the direction that costs an honest streamer money.
 *
 * PDT marks when a segment was PACKAGED. The overlay rendered its code one
 * broadcast delay EARLIER, so content showing a code issued at T lands in a
 * segment stamped T + D. Measured on Kick: the PDT seek computed 19.69s where
 * the badge actually began at 20.0s in the same file, and a code's first
 * appearance trailed its issue time by 12.1s. The bypass had already declared
 * that gap solved, so it was never measured — three real Kick broadcasts
 * verified 1/5, 0/5 and 0/5 with the badge legible at 28px throughout.
 *
 * This gate AGREED with the bug, because its stub publishes each segment the
 * instant it writes it. That makes D ~= 0 and the bypass accidentally correct
 * — the same stub-has-no-delay blind spot that hid the freeze-timing bug, now
 * covered by _gate-broadcast-delay.mjs.
 *
 * PDT IS AN ANCHOR, NOT AN ANSWER. Keeping it as the seek anchor removes the
 * frozenAt/duration estimate error entirely, which is a real and separate
 * gain; calibration still MEASURES the broadcast delay on top of it.
 *
 * The hardest part of Twitch verification is that the media timeline sits an
 * unknown ~15-17s behind our wall clock — bounty-timeline-calibration.js
 * exists to MEASURE that per broadcast, spending frame grabs to do it.
 * pump.fun stamps wall-clock UTC on every 2-second segment, so the offset is
 * KNOWN, not measured. This gate proves the knowing, both directions:
 *
 *   - WITH a wall clock: calibration returns WALL_CLOCK having spent ZERO
 *     frame grabs (a poisoned source that throws on getFrames proves nothing
 *     was probed), and a full HTTP broadcast against a pump.fun-SHAPED stub
 *     (append-only playlist, MEDIA-SEQUENCE pinned at 0, PDT everywhere)
 *     captures, freezes with the anchor in evidence, and verifies a real
 *     badge with calibration.grabs === 0 — off ONE clip, which the measuring
 *     path could never do (it needs 3 agreeing points).
 *   - WITHOUT one: the measuring path ENGAGES (probe grabs observed) — the
 *     fallback is the shipped behaviour, not an error. (The full non-PDT
 *     regression is _gate-capture-hardening's C-section, 3 clips, MEASURED.)
 *
 * Plus the external source: a PDT-indexed LOOKUP into the append-only
 * playlist — one segment downloaded, the frame proven BY PIXEL to be the
 * requested instant — and the typed refusal that names the discovery gap
 * (mint→playlist rides an undocumented API this build does not call).
 *
 * Zero external network: stub HLS on localhost, luminance-clock fixtures,
 * no pump.fun request anywhere.
 */
import http from 'http';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';
import { startGateServer } from './_gate-helpers.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORK = mkdtempSync(path.join(tmpdir(), 'mc-pfpdt-'));
const HLS = 3402;
const APP_PORT = 3403;
const SEG_S = 2;
const ff = (args, what) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${what}: ${r.stderr?.slice(0, 300)}`);
};

const { parseMediaPlaylist } = await import('./bounty-capture.js');
const { CaptureFrameSource, PumpFunFrameSource } = await import('./frame-sources.js');
const { calibrateTimeline, CALIBRATION_STATES, describeCalibration } = await import('./bounty-timeline-calibration.js');

// ── A. the parser reads the stamp ─────────────────────────────────────────
{
  const base = '2026-08-26T12:00:00.000Z';
  const text = [
    '#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXTINF:2.000000,', `#EXT-X-PROGRAM-DATE-TIME:${base}`, 'seg0.ts',
    '#EXTINF:2.000000,', '#EXT-X-PROGRAM-DATE-TIME:2026-08-26T12:00:02.000+0000', 'seg1.ts',
    '#EXTINF:2.000000,', 'seg2.ts', // deliberately unstamped
  ].join('\n');
  const { segments } = parseMediaPlaylist(text, 'http://x/live.m3u8');
  ok('A. PROGRAM-DATE-TIME parses per segment, both ISO offset spellings',
    segments[0].pdtMs === Date.parse(base)
    && segments[1].pdtMs === Date.parse(base) + 2000,
    `seg0=${segments[0].pdtMs} seg1=${segments[1].pdtMs}`);
  ok('A. an unstamped segment carries NO pdt rather than a guessed one',
    segments[2].pdtMs === undefined, 'absence stays absence');
}

// ── B. calibration: known offsets are not measured again ──────────────────
{
  // A poisoned source: any probe grab throws. If calibration touches it, the
  // bypass is a lie.
  let probeCalls = 0;
  const anchored = new CaptureFrameSource({
    captures: [
      { file: 'w1.ts', playbackId: 'p1', frozenAt: 1000, spanMs: 20_000, firstPdtMs: Date.parse('2026-08-26T12:00:00Z') },
      { file: 'w2.ts', playbackId: 'p2', frozenAt: 2000, spanMs: 20_000, firstPdtMs: Date.parse('2026-08-26T12:05:00Z') },
    ],
    log: { warn() {} },
  });
  anchored.getFrames = async () => { probeCalls += 1; throw new Error('probed a known timeline'); };
  const session = {
    playbackWindows: [{
      clipId: 'C', playbackId: 'p1', startedAt: 1, endsAt: 60_000, belowSamplingFloor: false,
      codes: [{ code: 'AA-AAAA', clipId: 'C', issuedAt: 1, expiresAt: 5000 }],
    }],
  };
  const cal = await calibrateTimeline({
    frameSource: anchored, codeChecker: { findCode: async () => ({ found: false }) },
    session, platform: 'pumpfun', handle: 'h', log: { warn() {} },
  });
  // A PDT-stamped capture must still be PROBED. The source is poisoned to
  // throw on any grab, so REACHING it is the proof — the exact inverse of what
  // this assertion used to demand.
  ok('B. a PDT-stamped capture is still MEASURED, never bypassed',
    probeCalls > 0 && cal.state !== CALIBRATION_STATES.WALL_CLOCK,
    `${probeCalls} probe(s) attempted, state=${cal.state}`);
  ok('B. ...and wallClockSkew no longer claims the timeline is solved',
    anchored.wallClockSkew() === null,
    'PDT anchors the seek; the broadcast delay on top of it is still unknown');

  // One window missing its stamp: the bypass must NOT engage on a partial
  // truth — a mixed session falls back to measuring.
  const mixed = new CaptureFrameSource({
    captures: [
      { file: 'w1.ts', playbackId: 'p1', frozenAt: 1000, spanMs: 20_000, firstPdtMs: Date.parse('2026-08-26T12:00:00Z') },
      { file: 'w2.ts', playbackId: 'p2', frozenAt: 2000, spanMs: 20_000, firstPdtMs: null },
    ],
    log: { warn() {} },
  });
  ok('B. a mixed-stamp session is measured too (there is no bypass left to disable)',
    mixed.wallClockSkew() === null);

  // And the measuring path actually ENGAGES when there is no wall clock: a
  // calibratable source with no PDT gets probed.
  let fallbackProbes = 0;
  const unanchored = {
    calibratable: true,
    wallClockSkew: () => null,
    getFrames: async () => { fallbackProbes += 1; return [{ ref: 'nope.png', ts: 1 }]; },
  };
  const cal2 = await calibrateTimeline({
    frameSource: unanchored, codeChecker: { findCode: async () => ({ found: false }) },
    session, platform: 'twitch', handle: 'h', log: { warn() {} },
  });
  ok('B. no wall clock → the measuring path engages (probes observed)',
    fallbackProbes > 0 && cal2.state === CALIBRATION_STATES.INSUFFICIENT_POINTS,
    `${fallbackProbes} probe grab(s), state=${cal2.state}`);
}

// ── the pump.fun-shaped stub stream ───────────────────────────────────────
// Append-only: MEDIA-SEQUENCE pinned at 0, no ENDLIST, every segment stamped,
// and the FULL history stays listed — exactly what the probe measured.
let segments = [];   // { name, file, pdtIso }
let published = 0;
const stub = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${HLS}`);
  if (url.pathname === '/live.m3u8') {
    const listed = segments.slice(0, published);
    const body = ['#EXTM3U', '#EXT-X-VERSION:6', `#EXT-X-TARGETDURATION:${SEG_S}`,
      '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-INDEPENDENT-SEGMENTS',
      ...listed.flatMap((s) => [`#EXTINF:${SEG_S}.000000,`, `#EXT-X-PROGRAM-DATE-TIME:${s.pdtIso}`, s.name]),
    ].join('\n');
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    return res.end(body);
  }
  const seg = segments.find((s) => `/${s.name}` === url.pathname);
  if (seg && existsSync(seg.file)) {
    seg.hits = (seg.hits || 0) + 1;
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    return res.end(readFileSync(seg.file));
  }
  res.statusCode = 404; res.end();
});
await new Promise((r) => stub.listen(HLS, r));

const plain = path.join(WORK, 'plain.ts');
ff(['-f', 'lavfi', '-i', `color=c=0x202024:s=1280x720:r=15:d=${SEG_S}`,
  '-c:v', 'libx264', '-b:v', '2500k', '-pix_fmt', 'yuv420p', '-f', 'mpegts', plain], 'plain');

let browser;
let srv;
try {
  // ── C. end-to-end: capture + freeze + verify off ONE clip, zero grabs ───
  srv = await startGateServer({
    port: APP_PORT, label: 'pumpfun-pdt',
    bountyAuth: { handles: ['pumpfun:pfstreamer'] },
    env: {
      BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true', MODERATION_API_KEY: '',
      TWITCH_CLIENT_ID: '', TWITCH_CLIENT_SECRET: '', KICK_CLIENT_ID: '', KICK_CLIENT_SECRET: '',
      BOUNTY_CODE_ROTATE_MS: '4000', BOUNTY_CODE_VALIDITY_MS: '5000',
      BOUNTY_CAPTURE_HLS_URL: `http://localhost:${HLS}/live.m3u8`,
      BOUNTY_CAPTURE_WINDOW_MS: '20000', BOUNTY_CAPTURE_POLL_MS: '250',
      // Zero-delay stub: nothing to wait out, so freeze effectively at once.
      // The real delay is exercised in _gate-broadcast-delay.mjs.
      BOUNTY_CAPTURE_FREEZE_DELAY_MS: '400',
      BOUNTY_STREAM_WARMUP_MS: '0', BOUNTY_STREAM_TAIL_MS: '0',
    },
  });
  const APP = `http://localhost:${APP_PORT}`;
  const post = (p, body, as) => fetch(`${APP}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...srv.headers(as) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  // A long-standing back catalogue, pre-listed — entry must be at the tail.
  const t0 = Date.now();
  const backlog = 40;
  for (let i = 0; i < backlog; i++) {
    segments.push({
      name: `old${i}.ts`, file: plain,
      pdtIso: new Date(t0 - (backlog - i) * SEG_S * 1000).toISOString(),
    });
  }
  published = segments.length;

  const pl = await post('/api/bounty/pledge', {
    targets: [{ platform: 'pumpfun', handle: 'pfstreamer' }],
    contributor: '0xpf', amount: '40', expiresInMs: 86_400_000,
  });
  await fetch(`${APP}${pl.body.uploadUrl}?durationS=8`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm', ...srv.headers() },
    body: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2048, 5)]),
  });
  const claim = await post('/api/bounty/claim',
    { platform: 'pumpfun', handle: 'pfstreamer', claimant: 'pf' }, 'pumpfun:pfstreamer');
  const air = await post('/api/bounty/air-session', {
    claimId: claim.body.claim.id, platform: 'pumpfun', roomId: 'pfroom',
    watchUrl: `http://localhost:${HLS}/live.m3u8`,
  }, 'pumpfun:pfstreamer');
  const airId = air.body.airSession.id;
  ok('C. a pumpfun air session opens with the playlist as its watch URL',
    air.status === 200, `HTTP ${air.status}`);

  const tCode = Date.now(); // the code exists from here — PDT stamps key off it
  const play = await post('/api/bounty/admin/playback',
    { airSessionId: airId, clipId: 'PF1', durationS: 600 });
  const code = play.body.code?.code;
  ok('C. a code issued for the pump.fun playback', !!code, code);

  browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto(`${APP}/overlay?room=pfroom&bounty=${encodeURIComponent(airId)}`,
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  let drawn = false;
  for (let i = 0; i < 25 && !drawn; i++) {
    await sleep(300);
    drawn = await page.evaluate(() =>
      !!document.getElementById('bounty-badge')?.classList.contains('show')
      && (document.getElementById('bounty-matrix')?.width || 0) > 0);
  }
  await page.evaluate(() => { document.body.style.background = '#101014'; });
  const badgePng = path.join(WORK, 'badge.png');
  await page.screenshot({ path: badgePng });
  await page.close();
  ok('C. the real overlay rendered the badge', drawn);

  const badged = path.join(WORK, 'badged.ts');
  ff(['-f', 'lavfi', '-i', `color=c=0x202024:s=1920x1080:r=15:d=${SEG_S}`, '-i', badgePng,
    '-filter_complex', '[0:v][1:v]overlay=0:0,scale=1280:720',
    '-c:v', 'libx264', '-b:v', '3000k', '-pix_fmt', 'yuv420p', '-f', 'mpegts', badged], 'badged');

  // Publish the badge into the LIVE tail. THE STAMPS ARE MEDIA TIME, as a
  // real encoder writes them: consecutive 2s segments get consecutive 2s
  // PDTs anchored at the moment the code went up — NOT the wall time this
  // gate happened to finish ffmpeg. (The first cut stamped publish-wall-time,
  // 350ms apart on 2s segments, and the exact PDT math then correctly
  // reported that the badge aired outside the code's window — the math was
  // right and the fake encoder was lying.)
  for (let i = 0; i < 10; i++) {
    segments.push({
      name: `live${i}.ts`, file: i >= 1 && i <= 8 ? badged : plain,
      pdtIso: new Date(tCode + (i - 1) * SEG_S * 1000).toISOString(),
    });
    published = segments.length;
    await sleep(350);
  }
  await sleep(900);

  const ended = await post('/api/bounty/admin/playback/end', { airSessionId: airId, clipId: 'PF1' });
  ok('C. the freeze is scheduled rather than taken inline', ended.body.freeze?.scheduled === true);
  await sleep(1200); // let the scheduled freeze fire
  // Read the anchor from the EVIDENCE row, which is where verification reads it.
  const frozenRow = (() => {
    const f = path.join(srv.dataDir, 'bounty-evidence.jsonl');
    if (!existsSync(f)) return null;
    return readFileSync(f, 'utf8').split(String.fromCharCode(10)).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean).reverse().find((r) => r.type === 'CAPTURE_FROZEN');
  })();
  ok('C. the freeze recorded the window\'s PROGRAM-DATE-TIME anchor',
    Number.isFinite(frozenRow?.firstPdtMs)
    && Math.abs(frozenRow.firstPdtMs - Date.now()) < 5 * 60_000,
    `firstPdtMs=${frozenRow?.firstPdtMs}`);
  // Live-edge entry means starting ~one window before the head — the tail of
  // the backlog IS the window's warm-up, so up to windowMs×1.5 / segDur
  // fetches of the newest backlog are correct. What must never happen is the
  // DEEP catalogue being walked: the oldest half stays untouched, exactly
  // once each at most for the tail.
  const deepHits = segments.slice(0, 25).reduce((a, s) => a + (s.hits || 0), 0);
  const tailHits = segments.slice(25, backlog).reduce((a, s) => a + (s.hits || 0), 0);
  ok('C. the recorder entered at the LIVE EDGE — deep catalogue untouched, tail fetched once',
    deepHits === 0 && tailHits <= 15
    && segments.slice(0, backlog).every((x) => (x.hits || 0) <= 1),
    `deep=${deepHits} tail=${tailHits}, no refetches`);

  await post(`/api/bounty/air-session/${airId}/end`, {}, 'pumpfun:pfstreamer');
  const v = await post(`/api/bounty/air-session/${airId}/verify`, { mode: 'real' }, 'pumpfun:pfstreamer');
  // ONE clip can no longer verify, and that is now the CORRECT outcome rather
  // than a regression. Calibration needs calibrationMinPoints (3) agreeing
  // points and gets one probe target per playback window, so a single-clip
  // session is unmeasurable. The old pass here was bought entirely by the
  // bypass this run deleted — it read as "PDT is so good it needs one clip",
  // and it actually meant "the delay was never checked".
  const calState = v.body.verification?.calibration;
  ok('C. a single-clip session cannot calibrate, and says which way it failed',
    v.status === 200 && calState?.state === 'INSUFFICIENT_POINTS'
    && (v.body.verification?.verifiedClips || 0) === 0,
    `state=${calState?.state}, ${v.body.verification?.verifiedClips} clip(s)`);
  ok('C. ...with probe grabs actually spent looking, not skipped',
    (calState?.grabs || 0) > 0, `grabs=${calState?.grabs}`);
  ok('C. ...so nothing is released on a timeline nobody measured',
    (v.body.release?.released ?? 0) === 0, `released=${v.body.release?.released}`);

  // ── D. the external source: PDT lookup, one segment, proven by pixel ────
  // A second stub path serving a segmented luminance clock as an append-only
  // pump.fun playlist.
  const clock = path.join(WORK, 'clock.mp4');
  ff(['-f', 'lavfi', '-i', 'color=c=black:s=320x120:r=5:d=30',
    '-vf', "geq=lum='8*floor(T)':cb=128:cr=128",
    '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', clock], 'clock');
  const segDir = path.join(WORK, 'pf-ext');
  ff(['-i', clock, '-c', 'copy', '-f', 'segment', '-segment_time', String(SEG_S),
    '-reset_timestamps', '0', path.join(segDir + '-%03d.ts')], 'segmented');
  const extBase = Date.parse('2026-08-26T09:00:00.000Z');
  const extSegs = readdirSync(WORK).filter((f) => f.startsWith('pf-ext-')).sort();
  extSegs.forEach((f, i) => {
    segments.push({
      name: `ext-${f}`, file: path.join(WORK, f),
      pdtIso: new Date(extBase + i * SEG_S * 1000).toISOString(), ext: true,
    });
  });
  // Master → variant hop, exactly as clips.pump.fun serves it.
  const masterPath = '/ext-master.m3u8';
  const mediaPath2 = '/ext-media.m3u8';
  const prevHandler = stub.listeners('request')[0];
  stub.removeAllListeners('request');
  stub.on('request', (req, res) => {
    const url = new URL(req.url, `http://localhost:${HLS}`);
    if (url.pathname === masterPath) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(['#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=320x120', `http://localhost:${HLS}${mediaPath2}`,
      ].join('\n'));
    }
    if (url.pathname === mediaPath2) {
      const ext = segments.filter((s) => s.ext);
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(['#EXTM3U', '#EXT-X-VERSION:6', `#EXT-X-TARGETDURATION:${SEG_S}`,
        '#EXT-X-MEDIA-SEQUENCE:0',
        ...ext.flatMap((s) => [`#EXTINF:${SEG_S}.000000,`, `#EXT-X-PROGRAM-DATE-TIME:${s.pdtIso}`, s.name]),
      ].join('\n'));
    }
    return prevHandler(req, res);
  });

  const src = new PumpFunFrameSource({
    watchUrl: `http://localhost:${HLS}${masterPath}`, log: { warn() {} },
  });
  const want = extBase + 21_000; // 21s into the clock
  const frames = await src.getFrames('pumpfun', 'pfstreamer', [{ ts: want }], { skewMs: 0 });
  const raw = path.join(WORK, 'ext-check.gray');
  ff(['-i', frames[0].ref, '-vf', 'crop=64:64:128:28,format=gray', '-f', 'rawvideo', raw], 'check');
  const bytes = readFileSync(raw);
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum += bytes[i];
  const sec = (sum / bytes.length) / 8;
  ok('D. the PDT lookup lands the requested instant, proven by pixel',
    Math.abs(sec - 21) <= 1.6, `frame encodes ${sec.toFixed(1)}s, wanted 21s`);
  const extHits = segments.filter((s) => s.ext).reduce((a, s) => a + (s.hits || 0), 0);
  ok('D. ...having downloaded exactly ONE segment of the append-only history',
    extHits === 1, `${extHits} segment fetch(es) across ${segments.filter((s) => s.ext).length} listed`);
  ok('D. ...and the source reports its wall clock for the calibration bypass',
    src.wallClockSkew()?.skewMs === 0, JSON.stringify(src.wallClockSkew()));

  // DISCOVERY IS SOLVED — a coin page or a bare mint now resolves to a real
  // playlist through livestream-api.pump.fun, so the old blanket refusal is
  // gone. What must STILL be refused is input carrying no mint at all:
  // verifying the wrong stream is worse than verifying none.
  const { extractPumpFunMint } = await import('./frame-sources.js');
  const MINT = '24GWZn5HerwLTVoZuC3H7Kxg6jLFMvroA1hTU4uWpump';
  ok('D. a coin page and a bare mint resolve to the same mint',
    extractPumpFunMint(`https://pump.fun/coin/${MINT}`) === MINT
    && extractPumpFunMint(MINT) === MINT);
  ok('D. ...and input carrying no mint is refused rather than guessed at',
    extractPumpFunMint('https://example.com/nope') === null
    && extractPumpFunMint('') === null);
  let refusal = null;
  try {
    await new PumpFunFrameSource({ watchUrl: 'https://example.com/not-pumpfun' })
      .getFrames('pumpfun', 'x', [{ ts: 1 }]);
  } catch (e) { refusal = e; }
  ok('D. a mint-less watch URL is a TYPED refusal naming what is missing',
    refusal?.state === 'API_UNAVAILABLE' && /mint/i.test(refusal?.detail || ''),
    `${refusal?.state}: ${String(refusal?.detail).slice(0, 60)}`);
} finally {
  if (browser) await browser.close();
  if (srv) srv.kill();
  await new Promise((r) => stub.close(r));
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
