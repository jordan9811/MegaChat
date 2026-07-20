// Generate the social-share OG image (1200x630) — mic + wordmark centered,
// correct landscape aspect — and save it to web/public/og.png.
// The old og:image was the 697x985 PORTRAIT hero PNG, which every link
// preview cropped badly. Re-run whenever the brand look changes:
//   node scripts/generate-og.mjs
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'fs';

const mic = readFileSync('web/public/megachat-hero-mic.png').toString('base64');

const html = `<!doctype html><html><head>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=Pacifico&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; overflow: hidden;
    background:
      radial-gradient(560px 560px at 78% 52%, oklch(0.68 0.27 340 / 0.28), transparent 70%),
      radial-gradient(420px 420px at 12% 8%, oklch(0.8 0.14 200 / 0.14), transparent 70%),
      #1a1029;
    display: flex; align-items: center;
    font-family: 'Space Grotesk', sans-serif;
  }
  .copy { flex: 1 1 56%; padding-left: 84px; }
  .mark {
    font-size: 118px; font-weight: 700; letter-spacing: -0.02em;
    background: linear-gradient(180deg, oklch(0.82 0.16 350) 0%, oklch(0.6 0.24 320) 55%, oklch(0.52 0.24 295) 100%);
    -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent;
    -webkit-text-stroke: 3px #f7f2fc;
    paint-order: stroke fill;
    filter: drop-shadow(0 0 26px oklch(0.68 0.27 340 / 0.55));
  }
  .tag {
    font-family: 'Pacifico', cursive;
    font-size: 52px; line-height: 1.35; color: #f4f2fa;
    transform: rotate(-3deg); transform-origin: left center;
    margin-top: 30px;
    text-shadow: 0 0 22px oklch(0.8 0.14 200 / 0.5);
  }
  .eq {
    margin-top: 44px; font-size: 25px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.08em; color: rgba(244,242,250,0.72);
  }
  .eq .op { color: oklch(0.8 0.14 200); }
  .eq .mc { color: oklch(0.88 0.22 128); text-shadow: 0 0 14px oklch(0.88 0.22 128 / 0.5); }
  .art { flex: 1 1 44%; height: 100%; display: flex; align-items: center; justify-content: center; }
  /* the mic canvas carries transparent right-padding — same +4.5% mass
     correction the landing hero uses (measured via _diag-mic-bbox.mjs) */
  .art img { height: 560px; translate: 4.5% 0; filter: drop-shadow(0 0 60px oklch(0.68 0.27 340 / 0.4)); }
</style></head><body>
  <div class="copy">
    <div class="mark">MegaChat</div>
    <div class="tag">Skip the chat.<br>Be the stream.</div>
    <div class="eq">Call-in show <span class="op">+</span> FaceTime <span class="op">+</span> Superchat <span class="op">=</span> <span class="mc">MegaChat</span></div>
  </div>
  <div class="art"><img src="data:image/png;base64,${mic}"></div>
</body></html>`;

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts.ready);
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: 'web/public/og.png', clip: { x: 0, y: 0, width: 1200, height: 630 } });
await browser.close();
console.log('wrote web/public/og.png (1200x630)');
