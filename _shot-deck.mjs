/**
 * Browse-deck screenshot walker → /screens. Runs against the dev server on
 * :3000 (or PORT env). Captures the deck's key states at desktop + mobile,
 * both themes, plus the claim drawer and mobile sheets.
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'fs';

const APP = `http://localhost:${process.env.PORT || 3000}`;
const OUT = 'screens';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
});
const page = await browser.newPage();

const shot = async (name, full = false) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
  console.log(`  shot ${name}`);
};
const gotoBrowse = async () => {
  await page.goto(`${APP}/#browse`, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.evaluate(() => document.getElementById('browse')?.scrollIntoView());
  await sleep(1600);
};

// ── desktop dark ────────────────────────────────────────────────────────────
await page.setViewport({ width: 1280, height: 800 });
await gotoBrowse();
await shot('deck-desktop-dark');
await shot('deck-desktop-dark-full', true);

// claim drawer
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('#bounty-board button')].find((b) =>
    /DocHavoc/.test(b.textContent));
  btn?.click();
});
await sleep(700);
await shot('deck-claim-drawer');
await page.keyboard.press('Escape');
await sleep(400);

// light theme (the site stores theme choice — flip via the header toggle)
await page.evaluate(() => {
  [...document.querySelectorAll('button')].find((b) =>
    /toggle theme/i.test(b.getAttribute('aria-label') || ''))?.click();
});
await sleep(900);
await shot('deck-desktop-light');
await page.evaluate(() => {
  [...document.querySelectorAll('button')].find((b) =>
    /toggle theme/i.test(b.getAttribute('aria-label') || ''))?.click();
});
await sleep(500);

// ── mobile dark ─────────────────────────────────────────────────────────────
await page.setViewport({ width: 375, height: 812 });
await gotoBrowse();
await shot('deck-mobile-dark');
await shot('deck-mobile-dark-full', true);

// rail sheet
await page.evaluate(() => {
  [...document.querySelectorAll('#browse button')].find((b) =>
    /Bounty board/.test(b.textContent))?.click();
});
await sleep(700);
await shot('deck-mobile-rail-sheet');
await page.keyboard.press('Escape');
await sleep(400);

// chat sheet
await page.evaluate(() => {
  [...document.querySelectorAll('#browse button')].find((b) =>
    /Lobby chat/.test(b.textContent))?.click();
});
await sleep(700);
await shot('deck-mobile-chat-sheet');

await browser.close();
console.log('done');
