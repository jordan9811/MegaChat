// Generate the Holler brand rasters and save them to web/public/:
//   og.png          1200x630 social card — the full mark, large, on the night
//                   ground with the tagline in Archivo
//   apple-icon.png  180x180 home-screen icon — the "icon" mark (strap fragment
//                   "H◉"), full-bleed square (iOS rounds the corners itself)
//   holler-logo.png the full mark on transparent, ~460x92 — the Privy sign-in
//                   modal's logo (appearance.logo in tempo-wallet.tsx)
// The mark is drawn with the SAME .hm CSS the site uses (read out of
// web/app/globals.css), so the rasters cannot drift from the component.
// Re-run whenever the brand look changes:
//   node scripts/generate-og.mjs
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'fs';

const globals = readFileSync('web/app/globals.css', 'utf8');
const start = globals.indexOf('/* ── Holler mark');
const end = globals.indexOf('/* ── Feature tags');
if (start < 0 || end < start) throw new Error('could not find the Holler mark section in web/app/globals.css');
const markCss = globals.slice(start, end);

const FONTS = 'https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&display=block';
const base = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --font-display: 'Archivo';
    --font-ui: 'Archivo';
    --hl-strap: #2f2ad8;
    --hl-record: #ff2d78;
    --hl-mark-glow: drop-shadow(0 0 18px color-mix(in srgb, #2f2ad8 60%, transparent));
  }
  ${markCss}
`;
const mark = (variant) => `<span class="hm hm--${variant}" role="img" aria-label="Holler"><span class="hm-strap"><span class="hm-l">H</span><span class="hm-o"></span>${variant === 'icon' ? '' : '<span class="hm-l">LLER</span>'}</span></span>`;

const og = `<!doctype html><html><head><meta charset="utf-8">
<link href="${FONTS}" rel="stylesheet">
<style>${base}
  body {
    width: 1200px; height: 630px; overflow: hidden;
    background:
      radial-gradient(620px 360px at 50% 44%, rgba(47, 42, 216, 0.34), transparent 70%),
      radial-gradient(420px 260px at 50% 46%, rgba(255, 45, 120, 0.08), transparent 70%),
      linear-gradient(rgba(255, 255, 255, 0.022) 1px, transparent 1px) 0 0 / 48px 48px,
      linear-gradient(90deg, rgba(255, 255, 255, 0.022) 1px, transparent 1px) 0 0 / 48px 48px,
      #060a17;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 46px;
    font-family: 'Archivo', sans-serif;
  }
  .hm.hm { font-size: 150px; filter: drop-shadow(0 0 42px rgba(47, 42, 216, 0.6)); }
  .tag {
    color: #f3f5fb; font-size: 58px; font-weight: 800; font-stretch: 112%;
    font-variation-settings: 'wdth' 112; letter-spacing: -0.01em; line-height: 1;
  }
</style></head><body>
  ${mark('full')}
  <div class="tag">Skip the chat. Be the stream.</div>
</body></html>`;

const appleIcon = `<!doctype html><html><head><meta charset="utf-8">
<link href="${FONTS}" rel="stylesheet">
<style>${base}
  body { width: 180px; height: 180px; overflow: hidden; background: #060a17; position: relative; }
  /* the strap bleeds off the left edge, the same cut as web/public/icon.svg */
  .hm.hm { position: absolute; left: 0; top: 50%; transform: translateY(-50%); font-size: 66px; }
  .hm .hm-strap { padding-left: 0.3em; }
</style></head><body>${mark('icon')}</body></html>`;

const logo = `<!doctype html><html><head><meta charset="utf-8">
<link href="${FONTS}" rel="stylesheet">
<style>${base}
  html, body { background: transparent; }
  body { display: inline-block; }
  .hm.hm { font-size: 80px; }
</style></head><body>${mark('full')}</body></html>`;

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
});
async function render(html, width, height, path, { transparent = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  const ok = await page.evaluate(() => document.fonts.check('900 1em Archivo'));
  if (!ok) throw new Error('Archivo did not load — check the network, then re-run');
  await new Promise((r) => setTimeout(r, 300));
  // a transparent raster is cropped to the mark itself
  const clip = transparent
    ? await page.evaluate(() => { const r = document.querySelector('.hm').getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) } })
    : { x: 0, y: 0, width, height };
  await page.screenshot({ path, clip, omitBackground: transparent });
  await page.close();
  console.log(`wrote ${path} (${clip.width}x${clip.height})`);
}
await render(og, 1200, 630, 'web/public/og.png');
await render(appleIcon, 180, 180, 'web/public/apple-icon.png');
await render(logo, 600, 200, 'web/public/holler-logo.png', { transparent: true });
await browser.close();
