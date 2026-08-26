/**
 * PROBE — what does a pump.fun livestream actually serve?
 *
 *   node _probe-pumpfun.mjs                       # pick a live stream and look
 *   node _probe-pumpfun.mjs --url https://pump.fun/coin/<mint>
 *   node _probe-pumpfun.mjs --headful --seconds 45
 *   node _probe-pumpfun.mjs --sweep --sweep-n 6   # how many live streams serve HLS?
 *
 * NOT A GATE. It reaches the public internet, so it is deliberately named out
 * of the `_gate-` namespace — the gate suite stays zero-network, zero-spend.
 *
 * The question it settles: MegaChat can verify a broadcast on any platform
 * that exposes a stream we are allowed to pull. Twitch and Kick expose HLS.
 * pump.fun was assessed as "undocumented, LiveKit/WebRTC" — this opens a real
 * live page, records EVERY request the player makes, and reports what came
 * back rather than what was assumed.
 *
 * It answers three things at once:
 *   (a) is there an HLS manifest, and can we read it?
 *   (b) is there a LiveKit room + token visible client-side?
 *   (c) does the player render in HEADLESS Chrome, at what size, and at what
 *       CPU cost per concurrent verification?
 *
 * Written with puppeteer-core rather than Playwright: it is already a
 * dependency here, it drives the same real Chrome every other suite uses, and
 * CDP gives the same request-level visibility. No new install to run this.
 *
 * IT ACCEPTS NOTHING AND CLICKS NO CONSENT. If a terms/clickwrap dialog blocks
 * playback, that is REPORTED as a finding — agreeing to a platform's terms on
 * someone's behalf is not a thing a probe gets to do.
 */
import puppeteer from 'puppeteer-core';
import { spawnSync } from 'child_process';
import { existsSync, writeFileSync } from 'fs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? (argv[i + 1] ?? true) : d;
};
const SECONDS = Number(arg('seconds', 25));
const HEADFUL = argv.includes('--headful');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
if (!CHROME) {
  console.error('No Chrome found. Pass one with CHROME_PATH=... or install Chrome.');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * CPU seconds consumed by a browser process TREE, so the headless-render cost
 * can be quoted per concurrent verification rather than guessed.
 *
 * The driver's own process.cpuUsage() is nearly zero and says nothing: all the
 * work happens in chrome.exe and its renderer/GPU children. Quoting the driver
 * number would understate the cost by two orders of magnitude.
 */
function treeCpuSeconds(rootPid) {
  try {
    const ps = 'try { $ids=@(' + rootPid + '); $all=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId;'
      + ' for($i=0;$i -lt 4;$i++){ $ids += ($all | Where-Object { $ids -contains $_.ParentProcessId }).ProcessId }'
      + ' $ids = $ids | Sort-Object -Unique;'
      + ' $t=0.0; foreach($id in $ids){ $pr=Get-Process -Id $id -ErrorAction SilentlyContinue; if($pr){ $t += $pr.CPU } }'
      + ' Write-Output ([math]::Round($t,2)) } catch { Write-Output "NA" }';
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 30000 });
    const v = parseFloat(String(r.stdout).trim());
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

const hr = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);

/** The public listing the site's own frontend uses. Reverse-engineered, not
 *  sanctioned — fine for a probe, not a thing to build a money path on. */
async function findLive() {
  const r = await fetch(
    'https://frontend-api-v3.pump.fun/coins/currently-live?offset=0&limit=8&includeNsfw=false',
    { headers: { 'user-agent': UA, accept: 'application/json' } },
  );
  if (!r.ok) throw new Error(`currently-live returned ${r.status}`);
  const j = await r.json();
  const arr = Array.isArray(j) ? j : (j.coins || j.data || []);
  return arr.filter((c) => c.is_currently_live).map((c) => ({
    mint: c.mint || c.address,
    name: c.name,
    viewers: c.num_participants ?? c.participants ?? null,
  }));
}

const HLS_MANIFEST = /\.m3u8(\?|$)/i;
const HLS_SEGMENT = /\.(ts|m4s|mp4|cmfv|cmfa)(\?|$)/i;

// ── sweep mode: how many live streams serve HLS at all? ───────────────────
// The single-page probe answers "what does THIS stream serve". That turned out
// to be the wrong question: pump.fun runs TWO delivery paths and a one-page
// sample tells you which one you happened to land on, with total confidence
// and a 50% chance of being wrong about the platform.
if (argv.includes('--sweep')) {
  const n = Number(arg('sweep-n', 6));
  const live = await findLive();
  console.log(`\nSWEEPING ${Math.min(n, live.length)} of ${live.length} live streams — `
    + 'which serve a pullable HLS manifest?\n');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--mute-audio'] });
  const rows = [];
  try {
    for (const c of live.slice(0, n)) {
      const page = await browser.newPage();
      await page.setUserAgent(UA);
      await page.setViewport({ width: 1280, height: 720 });
      const seen = { hls: [], lk: false };
      const cdp = await page.createCDPSession();
      await cdp.send('Network.enable');
      cdp.on('Network.webSocketCreated', ({ url: u }) => { if (/livekit/i.test(u)) seen.lk = true; });
      cdp.on('Network.responseReceived', ({ response }) => {
        if (HLS_MANIFEST.test(response.url)) seen.hls.push(response.url);
      });
      try {
        await page.goto(`https://pump.fun/coin/${c.mint}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await sleep(14_000);
      } catch { /* record what we got */ }
      const vid = await page.evaluate(() => {
        const v = document.querySelector('video');
        return v ? { w: v.videoWidth, h: v.videoHeight, ready: v.readyState } : null;
      }).catch(() => null);
      await page.close();
      const master = seen.hls.find((u) => /master/i.test(u)) || seen.hls[0] || null;
      rows.push({ name: c.name, mint: c.mint, hls: !!master, master, lk: seen.lk, vid });
      console.log(` ${c.name.slice(0, 18).padEnd(18)} HLS=${master ? 'YES' : 'no '} `
        + `LiveKit=${seen.lk ? 'YES' : 'no '} video=${vid ? `${vid.w}x${vid.h} rs${vid.ready}` : 'none'}`);
    }
  } finally { await browser.close(); }
  const withHls = rows.filter((r) => r.hls);
  console.log(`\n${withHls.length}/${rows.length} served a pullable HLS manifest; `
    + `${rows.filter((r) => r.lk).length}/${rows.length} opened a LiveKit socket.`);

  // Does the HLS FOLLOW the live edge? That is the whole requirement — a
  // finite recording proves a stream happened, a rolling one lets us capture.
  if (withHls.length) {
    const m = withHls[0];
    console.log(`\nIs ${m.name}'s HLS live-following? (media sequence over 12s)`);
    const media = async () => {
      const mr = await fetch(m.master, { headers: { 'user-agent': UA } });
      const body = await mr.text();
      const rel = body.split('\n').find((l) => l.trim() && !l.startsWith('#'));
      const mu = new URL(rel, m.master).href;
      const pr = await fetch(mu, { headers: { 'user-agent': UA } });
      const pb = await pr.text();
      const seq = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(pb)?.[1];
      const segs = pb.split('\n').filter((l) => l.trim() && !l.startsWith('#')).length;
      const endlist = pb.includes('#EXT-X-ENDLIST');
      const pdt = /#EXT-X-PROGRAM-DATE-TIME:(\S+)/.exec(pb)?.[1] || null;
      return { seq, segs, endlist, pdt, status: pr.status };
    };
    const a = await media();
    await sleep(12_000);
    const b = await media();
    console.log(`   t=0   seq=${a.seq} segments=${a.segs} ENDLIST=${a.endlist} PDT=${a.pdt}`);
    console.log(`   t=12s seq=${b.seq} segments=${b.segs} ENDLIST=${b.endlist} PDT=${b.pdt}`);
    // Growth shows up in the SEGMENT COUNT, not the sequence number: pump.fun
    // serves an APPEND-ONLY playlist (MEDIA-SEQUENCE stays 0, no ENDLIST, the
    // list just grows). Checking the sequence alone reported a live stream as
    // a fixed recording, which is the wrong answer to the only question here.
    console.log(`   → ${b.segs > a.segs || Number(b.seq) > Number(a.seq)
      ? `LIVE-FOLLOWING: +${b.segs - a.segs} segments in 12s — exactly what self-capture needs`
      : 'DID NOT ADVANCE in 12s — either the stream ended or this is a fixed recording'}`);
    console.log(`   playlist shape: MEDIA-SEQUENCE=${b.seq}, ${b.segs} entries, ENDLIST=${b.endlist}`
      + `${b.segs > 200 ? ' — APPEND-ONLY, and long' : ''}`);
  }
  process.exit(0);
}

let url = arg('url');
let picked = null;
if (!url) {
  const live = await findLive().catch((e) => { console.error(`could not list live streams: ${e.message}`); return []; });
  if (!live.length) {
    console.log('\nNO pump.fun STREAM IS LIVE RIGHT NOW (or the listing was unreachable).');
    console.log('Re-run later, or point it at a page directly:');
    console.log('  node _probe-pumpfun.mjs --url https://pump.fun/coin/<mint>\n');
    process.exit(1);
  }
  picked = live[0];
  url = `https://pump.fun/coin/${picked.mint}`;
  console.log(`\n${live.length} stream(s) live. Probing: ${picked.name} (${picked.mint})`);
}

hr(`PROBING ${url}\n${HEADFUL ? 'headful' : 'HEADLESS'} · ${SECONDS}s · Chrome ${CHROME}`);

const requests = [];   // {url, type, status, mime}
const sockets = [];    // websocket urls
const drm = [];        // EME calls the page attempted
const t0 = Date.now();

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: HEADFUL ? false : 'new',
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const cpuBefore = process.cpuUsage();
try {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1440, height: 900 });

  // Hook EME before any page script runs, so a DRM handshake cannot happen
  // without us seeing it. Records and passes through — never blocks.
  await page.evaluateOnNewDocument(() => {
    window.__probe = { eme: [], canvasReads: 0 };
    const orig = navigator.requestMediaKeySystemAccess?.bind(navigator);
    if (orig) {
      navigator.requestMediaKeySystemAccess = (ks, cfg) => {
        window.__probe.eme.push(ks);
        return orig(ks, cfg);
      };
    }
    // Canvas fingerprinting shows up as toDataURL/getImageData on a canvas the
    // page never displays. Counting it is enough to say whether it happens.
    const td = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...a) {
      window.__probe.canvasReads += 1; return td.apply(this, a);
    };
  });

  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketCreated', ({ url: u }) => sockets.push(u));
  cdp.on('Network.responseReceived', ({ response, type }) => {
    requests.push({ url: response.url, type, status: response.status, mime: response.mimeType });
  });

  const chromePid = browser.process()?.pid ?? null;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const cpuAtLoad = chromePid ? treeCpuSeconds(chromePid) : null;
  // Let the player do whatever it does. No clicking: a probe that accepts
  // terms to get a better answer has produced a worse one.
  await sleep(SECONDS * 1000);

  const dom = await page.evaluate(() => {
    const vids = [...document.querySelectorAll('video')].map((v) => ({
      src: v.currentSrc || v.src || null,
      w: v.videoWidth, h: v.videoHeight,
      readyState: v.readyState, paused: v.paused, muted: v.muted,
      duration: Number.isFinite(v.duration) ? v.duration : 'live/NaN',
    }));
    const blockers = [...document.querySelectorAll('[role="dialog"], dialog, [class*="clickwrap" i], [class*="consent" i]')]
      .map((e) => (e.innerText || '').trim().slice(0, 120)).filter(Boolean);
    return {
      videos: vids,
      blockers,
      eme: window.__probe?.eme || [],
      canvasReads: window.__probe?.canvasReads || 0,
      title: document.title,
    };
  });
  drm.push(...dom.eme);

  const shot = 'pumpfun-probe.png';
  await page.screenshot({ path: shot });

  // ── report ─────────────────────────────────────────────────────────────
  const manifests = requests.filter((r) => HLS_MANIFEST.test(r.url));
  const segments = requests.filter((r) => HLS_SEGMENT.test(r.url) && !HLS_MANIFEST.test(r.url));
  const mux = requests.filter((r) => /mux\.com|litix\.io/i.test(r.url));
  const livekit = [...requests.map((r) => r.url), ...sockets].filter((u) => /livekit/i.test(u));
  const hosts = [...new Set(requests.map((r) => { try { return new URL(r.url).host; } catch { return '?'; } }))];

  hr('(a) IS THERE A PULLABLE HLS STREAM?');
  console.log(`requests seen: ${requests.length} across ${hosts.length} hosts`);
  console.log(`HLS manifests (.m3u8): ${manifests.length}`);
  for (const m of manifests.slice(0, 10)) console.log(`   ${m.status} ${m.mime}  ${m.url}`);
  console.log(`media segments (.ts/.m4s/.mp4): ${segments.length}`);
  for (const s of segments.slice(0, 5)) console.log(`   ${s.status} ${s.mime}  ${s.url.slice(0, 120)}`);
  console.log(`Mux / Mux-Data requests: ${mux.length}`);
  for (const m of mux.slice(0, 8)) console.log(`   ${m.status} ${m.url.slice(0, 130)}`);

  // If a manifest showed up, try to read it from OUTSIDE the browser. That is
  // the actual MegaChat requirement: our SERVER must be able to pull it.
  if (manifests.length) {
    hr('CAN OUR SERVER PULL IT? (fetched outside the browser, no cookies)');
    for (const m of manifests.slice(0, 3)) {
      try {
        const r = await fetch(m.url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) });
        const body = await r.text();
        console.log(`\n${r.status} ${m.url}`);
        console.log(body.split('\n').slice(0, 14).map((l) => `   ${l}`).join('\n'));
      } catch (e) {
        console.log(`\nFAILED ${m.url} — ${e.message}`);
      }
    }
  }

  hr('(b) IS THERE A LIVEKIT ROOM/TOKEN CLIENT-SIDE?');
  console.log(`LiveKit-looking URLs: ${livekit.length}`);
  for (const u of [...new Set(livekit)].slice(0, 10)) {
    // A LiveKit join carries the JWT in the query string. Report ONLY that one
    // is present and how long it is — never the token itself.
    const tok = /[?&]access_token=([^&]+)/.exec(u);
    console.log(`   ${u.replace(/access_token=[^&]+/, 'access_token=<REDACTED>').slice(0, 140)}`
      + (tok ? `   [token present, ${tok[1].length} chars]` : ''));
  }
  console.log(`\nWebSockets opened: ${sockets.length}`);
  for (const u of [...new Set(sockets)].slice(0, 10)) {
    console.log(`   ${u.replace(/access_token=[^&]+/, 'access_token=<REDACTED>').slice(0, 140)}`);
  }

  hr('(c) DOES IT RENDER HEADLESS, AND WHAT DOES IT COST?');
  console.log(`page title: ${dom.title}`);
  console.log(`<video> elements: ${dom.videos.length}`);
  for (const v of dom.videos) {
    console.log(`   ${v.w}x${v.h} readyState=${v.readyState} paused=${v.paused} `
      + `duration=${v.duration} src=${String(v.src).slice(0, 90)}`);
  }
  console.log(`DRM (EME) key systems requested: ${drm.length ? drm.join(', ') : 'NONE'}`);
  console.log(`canvas toDataURL reads (fingerprinting signal): ${dom.canvasReads}`);
  if (dom.blockers.length) {
    console.log(`\nBLOCKING DIALOGS PRESENT (not dismissed — this probe accepts nothing):`);
    for (const b of dom.blockers.slice(0, 5)) console.log(`   "${b.replace(/\s+/g, ' ')}"`);
  }
  const cpuAtEnd = chromePid ? treeCpuSeconds(chromePid) : null;
  const cpu = process.cpuUsage(cpuBefore);
  const wall = (Date.now() - t0) / 1000;
  console.log(`\ndriver process: ${((cpu.user + cpu.system) / 1e6).toFixed(1)}s CPU over ${wall.toFixed(1)}s wall`
    + ' — meaningless on its own, all the work is in Chrome');
  if (cpuAtLoad != null && cpuAtEnd != null) {
    const playCpu = cpuAtEnd - cpuAtLoad;
    const perSec = playCpu / SECONDS;
    console.log(`CHROME TREE: ${cpuAtEnd.toFixed(1)}s CPU total (${cpuAtLoad.toFixed(1)}s of it just to LOAD the page), `
      + `${playCpu.toFixed(1)}s across ${SECONDS}s of playback`);
    console.log(`   → ${perSec.toFixed(2)} CPU-seconds per second of playback`
      + ` ≈ ${Math.max(1, Math.floor(1 / Math.max(0.01, perSec)))} concurrent renders per core, `
      + 'BEFORE frame extraction and OCR');
  } else {
    console.log('CHROME TREE: could not measure (non-Windows, or the tree exited first)');
  }
  console.log(`screenshot: ${shot}`);

  writeFileSync('pumpfun-probe.json', JSON.stringify({
    url, at: new Date().toISOString(), headless: !HEADFUL,
    counts: { requests: requests.length, manifests: manifests.length, segments: segments.length, mux: mux.length },
    hosts, manifests: manifests.map((m) => m.url), segments: segments.slice(0, 20).map((s) => s.url),
    livekit: [...new Set(livekit)].map((u) => u.replace(/access_token=[^&]+/, 'access_token=<REDACTED>')),
    sockets: [...new Set(sockets)].map((u) => u.replace(/access_token=[^&]+/, 'access_token=<REDACTED>')),
    videos: dom.videos, eme: drm, blockers: dom.blockers,
  }, null, 2));
  console.log('full record: pumpfun-probe.json');
} finally {
  await browser.close();
}
