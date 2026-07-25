/** Screenshot the overlay health card in its resting (sleeping) state. */
import { spawn } from 'child_process';
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'fs';

mkdirSync('screens', { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3232;
const APP = `http://localhost:${PORT}`;

const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: {
    ...process.env, PORT: String(PORT),
    LIVEKIT_URL: 'ws://localhost:7880', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret',
  },
  stdio: 'ignore', cwd: process.cwd(),
});
await sleep(9000);

try {
  const room = await fetch(`${APP}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Health Shot', password: 'shot', config: { transport: 'livekit', passkeyTickPrice: '0.001' } }),
  }).then((r) => r.json()).then((d) => d.room);

  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  });

  // Overlay open (so health reports present + sleeping)
  const ov = await browser.newPage();
  await ov.goto(`${APP}/overlay?room=${room.id}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(3000);

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1400 });
  await page.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll('summary')].some((s) => /room id \+ password/i.test(s.textContent)),
    { timeout: 20000 },
  );
  await page.evaluate(() => {
    const s = [...document.querySelectorAll('summary')].find((x) => /room id \+ password/i.test(x.textContent));
    s?.closest('details')?.setAttribute('open', '');
  });
  await sleep(400);
  await page.type('#manage-room-id', room.id);
  await page.type('#manage-password', 'shot');
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => /unlock room/i.test(b.textContent))?.click();
  });
  await sleep(6000);

  const found = await page.evaluate(() => {
    const el = [...document.querySelectorAll('p')].find((p) => /Ready — sleeping|On air|Overlay not/i.test(p.textContent));
    if (el) el.closest('div')?.scrollIntoView({ block: 'center' });
    return el ? el.textContent : null;
  });
  console.log('health card:', found);
  await page.screenshot({ path: 'screens/lazy-overlay-health.png' });
  await browser.close();
} finally {
  app.kill();
}
