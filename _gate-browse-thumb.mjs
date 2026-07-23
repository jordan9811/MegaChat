/**
 * GATE — browse-card stream thumbnail.
 *
 * The whole point of the server-side liveness check: Twitch 302s an OFFLINE
 * or nonexistent channel to a gray ttv-static/404_preview placeholder (HTTP
 * 200), so a naive <img> would show that gray tile instead of our branded
 * fallback. Proven here:
 *
 *  A. classification rule (pure): a live-shaped redirect target is "live", a
 *     404_preview target is "offline".
 *  B. end-to-end offline: a room whose Twitch channel is offline reports
 *     twitchLive=false and its card renders NO <img> (branded fallback only,
 *     never Twitch's gray placeholder).
 *  C. end-to-end no-Twitch: a room without a channel → fallback, no <img>.
 *  D. (opportunistic) if a live channel is found at runtime, its card DOES
 *     render the preview <img>. Skipped, not failed, when nothing is live.
 */
import { spawn } from 'child_process';
import puppeteer from 'puppeteer-core';

let pass = 0, fail = 0, skip = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 3219;
const APP = `http://localhost:${PORT}`;

// ── A. classification rule (the exact test server.js uses) ──────────────────
const classify = (loc) => (loc ? !/404_preview|ttv-static/i.test(loc) : false);
ok('classify: live-shaped redirect → live',
  classify('https://static-cdn.jtvnw.net/previews-live/some-real-frame-440x248.jpg') === true);
ok('classify: 404_preview placeholder → offline',
  classify('https://static-cdn.jtvnw.net/ttv-static/404_preview-440x248.jpg') === false);
ok('classify: empty (no redirect) → offline', classify('') === false);

// Find a live channel for the opportunistic positive case.
let liveChannel = null;
for (const ch of ['twitch', 'riotgames', 'valorant', 'esl_csgo', 'monstercat', 'fextralife', 'awashworld']) {
  try {
    const r = await fetch(`https://static-cdn.jtvnw.net/previews-ttv/live_user_${ch}-440x248.jpg`, { redirect: 'manual', signal: AbortSignal.timeout(4000) });
    if (classify(r.headers.get('location') || '')) { liveChannel = ch; break; }
  } catch { /* try next */ }
}
console.log(liveChannel ? `  [setup] live channel for positive case: ${liveChannel}` : '  [setup] no live channel found — positive case will be skipped');

const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore', cwd: process.cwd(),
});
await sleep(9000);

const mk = (name, cfg) => fetch(`${APP}/api/dashboard/create`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name, password: 'thumb-gate', config: cfg }),
}).then((r) => r.json());

try {
  await mk('Offline Twitch Room', { twitchChannel: 'twitch', passkeyTickPrice: '0.001' });
  await mk('No Twitch Room', { passkeyTickPrice: '0.001' });
  if (liveChannel) await mk('Live Twitch Room', { twitchChannel: liveChannel, passkeyTickPrice: '0.001' });

  // First call fires the fire-and-forget liveness probes; wait, then read.
  await fetch(`${APP}/api/rooms/public`).then((r) => r.json());
  await sleep(4000);
  const { rooms } = await fetch(`${APP}/api/rooms/public`).then((r) => r.json());

  const offline = rooms.find((r) => r.name === 'Offline Twitch Room');
  ok('B. API: offline channel carries channel but twitchLive=false',
    offline && offline.twitchChannel === 'twitch' && offline.twitchLive === false, JSON.stringify({ ch: offline?.twitchChannel, live: offline?.twitchLive }));

  const noTwitch = rooms.find((r) => r.name === 'No Twitch Room');
  ok('C. API: no-Twitch room has twitchLive=false and null channel',
    noTwitch && noTwitch.twitchChannel === null && noTwitch.twitchLive === false);

  let liveRoom = null;
  if (liveChannel) {
    liveRoom = rooms.find((r) => r.name === 'Live Twitch Room');
    ok('D. API: live channel reports twitchLive=true', liveRoom && liveRoom.twitchLive === true, JSON.stringify({ live: liveRoom?.twitchLive }));
  }

  // ── client render ─────────────────────────────────────────────────────────
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 2200 });
  await page.goto(`${APP}/#browse`, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.evaluate(() => document.getElementById('browse')?.scrollIntoView());
  await sleep(2500);

  const cardInfo = (name) => page.evaluate((n) => {
    const a = [...document.querySelectorAll('#browse a')].find((x) => x.querySelector('h3')?.textContent?.includes(n));
    if (!a) return null;
    return {
      hasThumbBox: !!a.querySelector('.aspect-video'),
      hasImg: !!a.querySelector('img'),
      fallbackMic: !!a.querySelector('.aspect-video span[aria-hidden]'),
    };
  }, name);

  const off = await cardInfo('Offline Twitch Room');
  ok('B. client: offline room renders NO <img> — branded fallback only (no gray Twitch tile)',
    off && off.hasThumbBox && !off.hasImg && off.fallbackMic, JSON.stringify(off));

  const noT = await cardInfo('No Twitch Room');
  ok('C. client: no-Twitch room shows the branded fallback',
    noT && noT.hasThumbBox && !noT.hasImg && noT.fallbackMic, JSON.stringify(noT));

  if (liveChannel && liveRoom?.twitchLive) {
    const lv = await cardInfo('Live Twitch Room');
    ok('D. client: live room DOES render the preview <img>', lv && lv.hasImg, JSON.stringify(lv));
  } else {
    skip++;
    console.log('  SKIP  D. client live-preview render — no live channel available at test time');
  }

  await browser.close();
} finally {
  app.kill();
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail, ${skip} skip`);
process.exit(fail === 0 ? 0 : 1);
