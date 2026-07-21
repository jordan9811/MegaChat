// Capture every core screen, desktop + mobile, for a cold-eyes visual audit.
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHmac } from 'crypto';
import puppeteer from 'puppeteer-core';

try { process.loadEnvFile(); } catch { /* env external */ }

const PORT = 3222, APP = `http://localhost:${PORT}`, AUTH_SECRET = 'ui-shots';
const OUT = process.argv[2] || 'C:/Users/jorda/AppData/Local/Temp/claude/C--Users-jorda-OneDrive-Documents-video-stream/510666e4-cb6c-4a45-bbb3-5f79e340fa3b/scratchpad/ui-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-uishots-'));
writeFileSync(path.join(dataDir, 'identities.json'), JSON.stringify({
  identities: { 'twitch:ui1': { provider: 'twitch', platformId: 'ui1', username: 'yeak__', handle: 'yeak__', createdAt: new Date().toISOString() } },
  handles: { yeak__: 'twitch:ui1' },
}));
const seal = (obj) => {
  const p = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${p}.${createHmac('sha256', AUTH_SECRET).update(p).digest('base64url')}`;
};

const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: { ...process.env, PORT: String(PORT), AUTH_SECRET, DATA_DIR: dataDir },
  stdio: 'ignore', cwd: process.cwd(),
});
await sleep(9000);

try {
  const res = await fetch(`${APP}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'UI Audit Room', password: 'ui-shots', config: { passkeyTickPrice: '0', twitchChannel: 'megachattv' } }),
  });
  const { room } = await res.json();

  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', protocolTimeout: 90000,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--force-device-scale-factor=1'],
  });
  const page = await browser.newPage();
  await page.setCookie({ name: 'mc_identity', value: encodeURIComponent(seal({ provider: 'twitch', platformId: 'ui1' })), domain: 'localhost', path: '/' });

  const shot = async (name, url, { w = 1280, h = 900, full = true, after = null } = {}) => {
    await page.setViewport({ width: w, height: h });
    if (url) await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await sleep(1500);
    if (after) await after();
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
    console.log('shot', name);
  };

  await shot('landing-desktop', APP);
  await shot('landing-mobile', APP, { w: 375, h: 812 });
  await shot('join-desktop', `${APP}/join?room=${room.id}`);
  await shot('join-mobile', `${APP}/join?room=${room.id}`, { w: 375, h: 812 });
  await shot('dashboard-create-desktop', `${APP}/dashboard`);
  await shot('dashboard-create-mobile', `${APP}/dashboard`, { w: 375, h: 812 });
  // managing view: unlock with password through the real form
  await shot('dashboard-managing-desktop', `${APP}/dashboard`, {
    after: async () => {
      await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /manage existing/i.test(b.textContent))?.click(); });
      await sleep(400);
      await page.type('#manage-room-id', room.id);
      await page.type('#manage-password', 'ui-shots');
      await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /unlock room/i.test(b.textContent))?.click(); });
      await sleep(3000);
    },
  });
  await shot('dashboard-account-desktop', `${APP}/dashboard?section=account`);
  await shot('how-it-works-desktop', `${APP}/how-it-works`);

  await browser.close();
  console.log('DONE →', OUT);
} finally {
  app.kill();
}
