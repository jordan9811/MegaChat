/** Screenshot the bounty board + claim flow (flag on). */
import { spawn } from 'child_process';
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'fs';

mkdirSync('screens', { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3253;
const APP = `http://localhost:${PORT}`;

const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: { ...process.env, PORT: String(PORT), BOUNTY_CLAIM: '1',
    DATA_DIR: `${process.env.TEMP || '/tmp'}/bounty-shot-${Date.now()}` },
  stdio: 'ignore', cwd: process.cwd(),
});
await sleep(9000);

try {
  const seed = [
    { handle: 'riotmolly', amount: '2500', n: 12 },
    { handle: 'dochavoc', amount: '1500', n: 7 },
    { handle: 'gutterball', amount: '900', n: 4 },
  ];
  for (const s of seed) {
    for (let i = 0; i < s.n; i++) {
      await fetch(`${APP}/api/bounty/contribute`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: 'twitch', handle: s.handle, contributor: `0x${i}`,
          amount: String(Number(s.amount) / s.n), letterRef: `L${i}`,
        }),
      });
    }
  }

  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 1000 });
  await page.goto(`${APP}/bounty`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);
  await page.screenshot({ path: 'screens/bounty-board.png' });
  console.log('shot bounty-board');

  // open the claim flow
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => /This is me/i.test(b.textContent))?.click();
  });
  await sleep(1200);
  await page.screenshot({ path: 'screens/bounty-claim.png' });
  console.log('shot bounty-claim');

  // walk through to setup
  await page.type('#bounty-claimant', '0xMOLLY');
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => /Claim this handle/i.test(b.textContent))?.click();
  });
  await sleep(2500);
  await page.screenshot({ path: 'screens/bounty-setup.png' });
  console.log('shot bounty-setup');

  await browser.close();
} finally { app.kill(); }
