import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new' });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 800 });
await p.goto('http://localhost:3000/#browse', { waitUntil: 'networkidle2', timeout: 60000 });
await p.evaluate(() => document.getElementById('browse')?.scrollIntoView());
await new Promise((r) => setTimeout(r, 1500));
await p.evaluate(() => {
  [...document.querySelectorAll('#bounty-board button')].find((x) => /DocHavoc/.test(x.textContent))?.click();
});
await new Promise((r) => setTimeout(r, 700));
await p.screenshot({ path: 'screens/deck-claim-drawer.png' });
await p.keyboard.press('Escape');
await new Promise((r) => setTimeout(r, 400));
console.log('drawer closed on Esc:', await p.evaluate(() => !document.querySelector('[role=dialog]')));
await b.close();
