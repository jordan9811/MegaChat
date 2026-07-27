/**
 * VERIFY — the overlay identity stays stable across reloads WITH SESSIONSTORAGE
 * BLOCKED, driving the REAL overlay page.
 *
 * This is the case that matters: the overlay reloads itself whenever its
 * websocket drops, so an id that does not survive a reload mints a fresh
 * LiveKit identity every time and STACKS billed participants — the exact leak
 * lazy-connect was built to stop. The old fallback (`window.__mcOverlayInstance`)
 * was per-JS-context and therefore did not survive a reload at all.
 *
 * Per the standing guardrail: this drives the actual page, not a mirror of it.
 */
import { spawn } from 'child_process';
import puppeteer from 'puppeteer-core';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3297;
const APP = `http://localhost:${PORT}`;
const SCRATCH = `${process.env.TEMP || '/tmp'}/mc-idfallback-${Date.now()}`;

const health = await fetch('http://localhost:7880').then((r) => r.text()).catch(() => '');
if (!health.includes('OK')) {
  console.error('local livekit-server not running — start tools/livekit-server.exe --dev');
  process.exit(1);
}

const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: {
    ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH,
    LIVEKIT_URL: 'ws://localhost:7880',
    LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret',
    KEEP_ORPHAN_ROOMS: 'true',
  },
  stdio: 'ignore', cwd: process.cwd(),
});
await sleep(10000);

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

try {
  const rooms = await fetch(`${APP}/api/rooms/public`).then((r) => r.json());
  const roomId = (rooms.rooms || rooms)[0].id;

  // The instance id is minted when a TOKEN is requested, and with lazy connect
  // on an idle overlay never requests one. So every check below prewarms first
  // — otherwise this measures "nobody connected", not identity stability.
  const prewarm = () => fetch(`${APP}/api/livekit/prewarm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: roomId }),
  }).then((r) => r.json()).catch(() => null);

  // ── Normal path: sessionStorage available ──────────────────────────────
  const okPage = await browser.newPage();
  await okPage.goto(`${APP}/overlay?room=${roomId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1500); await prewarm(); await sleep(3500);
  const normal1 = await okPage.evaluate(() => sessionStorage.getItem('mc-overlay-instance'));
  await okPage.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1500); await prewarm(); await sleep(3500);
  const normal2 = await okPage.evaluate(() => sessionStorage.getItem('mc-overlay-instance'));
  ok('sessionStorage path: id is stable across a reload', !!normal1 && normal1 === normal2,
    `${normal1} -> ${normal2}`);
  await okPage.close();

  // ── sessionStorage BLOCKED: window.name must carry it ──────────────────
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() { throw new Error('sessionStorage blocked (simulating locked-down CEF)'); },
    });
  });
  await page.goto(`${APP}/overlay?room=${roomId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1500); await prewarm(); await sleep(3500);

  const name1 = await page.evaluate(() => window.name);
  ok('storage blocked: window.name carries a minted id',
    /^mc-overlay:.+/.test(name1 || ''), name1);

  // The real proof: reload and confirm the SAME id comes back.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1500); await prewarm(); await sleep(3500);
  const name2 = await page.evaluate(() => window.name);
  ok('STORAGE BLOCKED: THE ID SURVIVES A RELOAD (no participant stacking)',
    !!name1 && name1 === name2, `${name1} -> ${name2}`);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1500); await prewarm(); await sleep(3500);
  const name3 = await page.evaluate(() => window.name);
  ok('...and a third reload too', !!name1 && name1 === name3, name3);

  // A DIFFERENT source (new tab) must still get its own id, or two overlays
  // evict each other again.
  const other = await browser.newPage();
  await other.evaluateOnNewDocument(() => {
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() { throw new Error('blocked'); },
    });
  });
  await other.goto(`${APP}/overlay?room=${roomId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1500); await prewarm(); await sleep(3500);
  const otherName = await other.evaluate(() => window.name);
  ok('a SEPARATE source still gets its own id (no mutual eviction)',
    !!otherName && otherName !== name1, `${otherName} vs ${name1}`);

  // Both overlays should be connected to the SFU under distinct identities.
  // lkOverlayRoom is a script-scoped binding, not a window property, so it
  // has to be read the same way _verify-two-overlays.mjs does.
  const ids = await Promise.all([page, other].map((p) => p.evaluate(() => {
    const r = (typeof lkOverlayRoom !== 'undefined' && lkOverlayRoom) || null;
    return r ? r.localParticipant?.identity : null;
  })));
  ok('both connect under DISTINCT LiveKit identities',
    ids.every(Boolean) && ids[0] !== ids[1], JSON.stringify(ids));

  await other.close();
  await page.close();
} finally {
  await browser.close();
  app.kill();
}
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
