// Measure the opaque bounding box of the hero mic + grab slices, so the
// centering fix is arithmetic instead of eyeballing.
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'fs';

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
});
const page = await browser.newPage();
await page.goto('about:blank');

const measure = async (fileUrl) => page.evaluate(async (src) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let minX = c.width, maxX = -1, minY = c.height, maxY = -1;
  let massX = 0, mass = 0;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const a = d[(y * c.width + x) * 4 + 3];
      if (a > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        massX += x * a; mass += a;
      }
    }
  }
  return {
    w: c.width, h: c.height, minX, maxX, minY, maxY,
    bboxCenterX: (minX + maxX) / 2,
    centroidX: mass ? massX / mass : c.width / 2,
    canvasCenterX: c.width / 2,
  };
}, fileUrl);

for (const f of ['web/public/megachat-hero-mic.png', 'web/public/megachat-hero-grab.png', 'web/public/megachat-hero.png']) {
  const m = await measure(`data:image/png;base64,${readFileSync(f).toString('base64')}`);
  const offPx = m.bboxCenterX - m.canvasCenterX;
  console.log(f, JSON.stringify(m), `visual center off by ${offPx.toFixed(1)}px (${(100 * offPx / m.w).toFixed(2)}% of width)`);
}
await browser.close();
