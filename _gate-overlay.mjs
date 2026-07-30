// Gate: overlay restyle (Part 1) + stingers (Part 2, when args passed).
// Usage: node gate-overlay.mjs [stingers]
import puppeteer from 'puppeteer-core';

const CHECK_STINGERS = process.argv[2] === 'stingers';
let failures = 0;
const ok = (m) => console.log('  OK ', m);
const bad = (m) => { failures++; console.error('  FAIL', m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Harness-spawned: this gate previously assumed a server already listening on
// :3000 and hard-crashed with ERR_CONNECTION_REFUSED on a clean checkout —
// which meant the overlay, the page that renders money-bearing badges, had no
// working gate at all.
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
const PORT = 3009;
const { startGateServer } = await import('./_gate-helpers.mjs');
const srv = await startGateServer({
  port: PORT, dataDir: mkdtempSync(path.join(tmpdir(), 'mc-ovl-')), label: 'overlay',
  env: { KEEP_ORPHAN_ROOMS: 'true' },
});

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
});
const page = await browser.newPage();
await page.setViewport({ width: 800, height: 700 });
page.on('pageerror', (e) => bad('page exception: ' + e.message));
await page.goto(`http://localhost:${PORT}/overlay?room=default`, { waitUntil: 'networkidle2', timeout: 30000 });
await sleep(800);

// Transparent canvas
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
(bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') ? ok('body transparent (' + bg + ')') : bad('body not transparent: ' + bg);

// Inject fake seat
await page.evaluate(() => window.OverlayTest.addSeat({
  id: 'gate-1', username: 'NEON_TESTER',
  viewUrl: 'https://vdo.ninja/?view=fakestream123&scene', expiresAt: Date.now() + 60000,
}));
await sleep(1000);

const tile = await page.evaluate(() => {
  const t = document.querySelector('.tile');
  if (!t) return null;
  const cs = getComputedStyle(t);
  const label = t.querySelector('.username-label');
  const lcs = label ? getComputedStyle(label) : null;
  return {
    count: document.querySelectorAll('.tile').length,
    w: t.offsetWidth, h: t.offsetHeight,
    border: cs.borderTopWidth + ' ' + cs.borderTopColor,
    timerEls: document.querySelectorAll('.timer').length,
    labelText: label?.textContent,
    labelFont: lcs?.fontFamily || '',
    labelAccent: lcs?.borderLeftWidth + ' ' + lcs?.borderLeftColor,
  };
});
if (!tile) bad('tile did not render');
else {
  tile.count === 1 ? ok('tile rendered') : bad('tile count ' + tile.count);
  (tile.w === 320 && tile.h === 180) ? ok('tile size unchanged 320x180') : bad(`tile size ${tile.w}x${tile.h}`);
  tile.timerEls === 0 ? ok('NO countdown element') : bad(tile.timerEls + ' timer elements still present');
  /Space Grotesk/i.test(tile.labelFont) ? ok('label uses Space Grotesk') : bad('label font: ' + tile.labelFont);
  /3px/.test(tile.labelAccent) ? ok('label magenta accent bar (' + tile.labelAccent + ')') : bad('label accent: ' + tile.labelAccent);
  tile.border.startsWith('1px') ? ok('tile hairline border (' + tile.border + ')') : bad('tile border: ' + tile.border);
  tile.labelText === 'NEON_TESTER' ? ok('username shown') : bad('label text: ' + tile.labelText);
}
await page.screenshot({ path: 'join-fix-evidence/night-P1-overlay-restyle.png' });
console.log('  shot -> join-fix-evidence/night-P1-overlay-restyle.png');

if (CHECK_STINGERS) {
  const IN = ['storm', 'proroll', 'callme', 'breaking', 'wildin'];
  const OUT = ['crt', 'crumble', 'zapped', 'wildout'];
  for (const fi of IN) {
    const id = 'st-' + fi;
    await page.evaluate((id, fi) => window.OverlayTest.addSeat({
      id, username: fi.toUpperCase(), viewUrl: 'https://vdo.ninja/?view=x' + fi,
      flyIn: fi, flyOut: 'crt',
    }), id, fi);
    await sleep(120);
    const anim = await page.evaluate((id) => {
      const t = document.querySelector(`[data-seat-id="${id}"]`);
      return t ? getComputedStyle(t).animationName + '|' + t.className : 'MISSING';
    }, id);
    (anim !== 'MISSING' && !/none\|/.test(anim)) ? ok(`fly-in "${fi}" animating (${anim.slice(0, 60)})`) : bad(`fly-in "${fi}": ${anim}`);
    await sleep(1600); // let it finish (<=1.5s budget)
    await page.evaluate((id) => window.OverlayTest.removeSeat(id), id);
    await sleep(1700);
  }
  for (const fo of OUT) {
    const id = 'sto-' + fo;
    await page.evaluate((id, fo) => window.OverlayTest.addSeat({
      id, username: fo.toUpperCase(), viewUrl: 'https://vdo.ninja/?view=y' + fo,
      flyIn: 'proroll', flyOut: fo,
    }), id, fo);
    await sleep(1600);
    await page.evaluate((id) => window.OverlayTest.removeSeat(id), id);
    await sleep(150);
    const anim = await page.evaluate((id) => {
      const t = document.querySelector(`[data-seat-id="${id}"]`);
      return t ? getComputedStyle(t).animationName + '|' + t.className : 'GONE-TOO-FAST';
    }, id);
    (anim !== 'GONE-TOO-FAST' && !/none\|/.test(anim)) ? ok(`fly-out "${fo}" animating (${anim.slice(0, 60)})`) : bad(`fly-out "${fo}": ${anim}`);
    await sleep(1700);
    const gone = await page.evaluate((id) => !document.querySelector(`[data-seat-id="${id}"]`), id);
    gone ? ok(`fly-out "${fo}" tile removed after animation`) : bad(`fly-out "${fo}" tile stuck in DOM`);
  }
  const clean = await page.evaluate(() => window.OverlayTest.count());
  clean === 1 ? ok('stage back to 1 tile (gate-1) after stinger runs') : bad('tiles left over: ' + clean);
}

// ── OBS audio environment (one-click run) ──────────────────────────────────
// The overlay pre-warms its AudioContext ONLY when OBS's injected
// window.obsstudio is present. A normal tab must not create a context at boot
// (autoplay policy makes that a rejected resume and a console warning farm).
{
  const norm = await page.evaluate(() => ({
    env: window.__audioEnv,
    ctxAtBoot: !!window.__sfxPlays && window.__audioEnv === 'browser',
  }));
  (norm.env === 'browser') ? ok('plain browser detected as env=browser') : bad('env should be browser, got ' + norm.env);

  const obsPage = await browser.newPage();
  await obsPage.evaluateOnNewDocument(() => {
    // What OBS injects into every browser source (subset we key on).
    window.obsstudio = { pluginVersion: '5.5.2' };
  });
  await obsPage.goto(`http://localhost:${PORT}/overlay?room=default`, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(600);
  const obs = await obsPage.evaluate(() => ({
    env: window.__audioEnv,
    hasObs: !!window.obsstudio,
  }));
  (obs.env === 'obs') ? ok('obsstudio-injected page detected as env=obs (audio pre-warm path)') : bad('env should be obs, got ' + obs.env);
  await obsPage.close();
}

await browser.close();
srv.kill();
console.log(failures === 0 ? 'GATE PASS' : `GATE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
