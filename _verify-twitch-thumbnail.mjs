/**
 * VERIFY — the connected Twitch channel actually RENDERS as a thumbnail in the
 * browse grid, not merely that the setting saves.
 *
 * The setting saving was already proven (_verify-twitch-prefill.mjs 9/0). This
 * asks the next question: does anything downstream use it? A prefilled field
 * that no surface reads would look finished and do nothing.
 *
 * The channel has to be LIVE for the thumbnail to show — Twitch serves a grey
 * "unavailable" placeholder otherwise, which is uglier than our branded panel.
 * We cannot make a real channel go live, so the API response is intercepted to
 * assert BOTH branches of that decision against the real component.
 */
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3298;
const APP = `http://localhost:${PORT}`;

const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-thumb-'));
writeFileSync(path.join(dataDir, 'rooms.json'), JSON.stringify({
  rooms: {
    thumbroom: {
      id: 'thumbroom', name: 'Thumb Test', handle: 'thumbstreamer', active: true,
      config: { twitchChannel: 'thumbstreamer', twitchAuto: true },
    },
  },
}));

const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, KEEP_ORPHAN_ROOMS: 'true' },
  stdio: 'ignore', cwd: process.cwd(),
});
await sleep(10000);

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
});

try {
  // The channel must survive the round trip to the public listing at all.
  const listed = await fetch(`${APP}/api/rooms/public`).then((r) => r.json());
  const room = (listed.rooms || listed).find((r) => r.id === 'thumbroom');
  ok('the room config reaches the PUBLIC listing as twitchChannel',
    room?.twitchChannel === 'thumbstreamer', JSON.stringify(room?.twitchChannel));

  const openBrowse = async (forceLive) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1000 });
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      if (!req.url().includes('/api/rooms/public')) return req.continue();
      const res = await fetch(`${APP}/api/rooms/public`).then((r) => r.json());
      const rooms = (res.rooms || res).map((r) => (
        r.id === 'thumbroom' ? { ...r, twitchLive: forceLive } : r
      ));
      req.respond({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(Array.isArray(res) ? rooms : { ...res, rooms }),
      });
    });
    // Browse lives on the landing page — there is no /browse route (the deck
    // work folded it in). Navigating to /browse silently 404s and every
    // assertion below then fails for the wrong reason.
    await page.goto(`${APP}/`, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(1200);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(2500);
    return page;
  };

  // ── channel LIVE → the Twitch preview must actually be in the DOM ───────
  const live = await openBrowse(true);
  const liveImg = await live.evaluate(() => {
    const img = [...document.querySelectorAll('img')]
      .find((i) => i.src.includes('static-cdn.jtvnw.net'));
    return img ? { src: img.src, visible: img.style.display !== 'none' } : null;
  });
  ok('LIVE channel: the Twitch thumbnail IMG is rendered', !!liveImg, liveImg?.src);
  ok('...pointing at the connected channel, lowercased and @-stripped',
    /live_user_thumbstreamer-440x248\.jpg/.test(liveImg?.src || ''), liveImg?.src);
  await live.close();

  // ── channel OFFLINE → branded fallback, never a grey Twitch placeholder ──
  const offline = await openBrowse(false);
  const offImg = await offline.evaluate(() => [...document.querySelectorAll('img')]
    .some((i) => i.src.includes('static-cdn.jtvnw.net')));
  ok('OFFLINE channel: no Twitch image (branded panel shows instead)', offImg === false);
  const hasCard = await offline.evaluate(() => /thumbstreamer|Thumb Test/i.test(document.body.innerText));
  ok('...but the room card is still listed', hasCard === true);
  await offline.screenshot({ path: 'screens/twitch-thumbnail-offline.png' });
  await offline.close();

  const liveShot = await openBrowse(true);
  await liveShot.screenshot({ path: 'screens/twitch-thumbnail-live.png' });
  await liveShot.close();
  console.log('  [shots] screens/twitch-thumbnail-{live,offline}.png');
} finally {
  await browser.close();
  app.kill();
}
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
