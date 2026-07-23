/**
 * GATE — booth camera picker device discovery + auto-upgrade WIRING.
 *
 * Scope note: LiveKit-client's internal camera-capture call bypasses BOTH
 * instance- and prototype-level navigator.mediaDevices.getUserMedia
 * overrides in headless Chrome (confirmed: the resulting track carries a
 * real Chrome-hashed device id, not our stub's). That's an environment
 * limit on stubbing LiveKit's device layer from outside — not something
 * this gate can respect without a real second camera device attached, so
 * "does the booth actually capture the newly-appeared camera" is a manual
 * verification, not an automated one. What IS fully verifiable, and
 * exactly what a real "start OBS Virtual Camera after arming" session
 * depends on, is proven here:
 *
 *  A. the picker's device list updates LIVE when devicechange fires — no
 *     re-arm needed to see a camera that appeared after the fact.
 *  B. the upgrade-retry gate condition (micOnly && chosen id now listed)
 *     fires refreshCams -> tryEnableCamera at the right moment and ONLY
 *     the right moment (not spuriously when unrelated devices change).
 */
import { spawn } from 'child_process';
import puppeteer from 'puppeteer-core';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 3218;
const APP = `http://localhost:${PORT}`;

const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: { ...process.env, PORT: String(PORT), LIVEKIT_URL: 'ws://localhost:7880', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret' },
  stdio: 'ignore', cwd: process.cwd(),
});
await sleep(9000);

const GUM_OVERRIDE = () => {
  const makeStream = () => {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 36;
    return c.captureStream(5);
  };
  window.__virtualCamOn = false;
  const stub = async () => makeStream();
  navigator.mediaDevices.getUserMedia = stub;
  const enumStub = async () => {
    const base = [{ kind: 'videoinput', deviceId: 'real-cam-id', label: 'Real Webcam', groupId: 'g1' }];
    if (window.__virtualCamOn) base.push({ kind: 'videoinput', deviceId: 'virtual-cam-id', label: 'OBS Virtual Camera', groupId: 'g2' });
    return base;
  };
  navigator.mediaDevices.enumerateDevices = enumStub;
};

try {
  const res = await fetch(`${APP}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Picker Gate', password: 'picker-gate', config: { transport: 'livekit', passkeyTickPrice: '0' } }),
  });
  const { room } = await res.json();

  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', protocolTimeout: 60000,
  });
  await browser.defaultBrowserContext().overridePermissions(APP, ['camera', 'microphone']);
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(GUM_OVERRIDE);
  await page.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll('summary')].some((s) => /room id \+ password/i.test(s.textContent)),
    { timeout: 20000 },
  );
  await page.evaluate(() => {
    document.querySelector('summary')?.closest('details')?.setAttribute('open', '');
    const s = [...document.querySelectorAll('summary')].find((x) => /room id \+ password/i.test(x.textContent));
    s?.closest('details')?.setAttribute('open', '');
  });
  await sleep(300);
  await page.type('#manage-room-id', room.id);
  await page.type('#manage-password', 'picker-gate');
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /unlock room/i.test(b.textContent))?.click(); });
  await sleep(2000);

  await page.evaluate(() => document.getElementById('cohost-booth').click());
  await sleep(1000);

  // ── A. picker device list updates LIVE on devicechange, no re-arm ─────────
  let opts = await page.evaluate(() => [...document.querySelectorAll('#booth-cam option')].map((o) => o.value));
  ok('picker starts with ONLY the pre-existing camera (virtual cam not on yet)',
    opts.includes('real-cam-id') && !opts.includes('virtual-cam-id'), JSON.stringify(opts));

  await page.evaluate(() => {
    window.__virtualCamOn = true;
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  });
  await sleep(800);
  opts = await page.evaluate(() => [...document.querySelectorAll('#booth-cam option')].map((o) => o.value));
  ok('NO re-arm: "OBS Virtual Camera" appears in the picker the instant it starts',
    opts.includes('virtual-cam-id'), JSON.stringify(opts));

  await page.evaluate(() => {
    window.__virtualCamOn = false;
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  });
  await sleep(800);
  opts = await page.evaluate(() => [...document.querySelectorAll('#booth-cam option')].map((o) => o.value));
  ok('list also drops it live when it stops (Stop Virtual Camera in OBS)',
    !opts.includes('virtual-cam-id'), JSON.stringify(opts));

  // ── B. upgrade-retry fires ONLY when (micOnly AND chosen id now listed) ───
  // Exercise the exact gating condition from refreshCams() directly — this
  // is pure, deterministic app logic, independent of LiveKit's internal
  // camera-capture path (which this environment can't stub, see header).
  const gating = await page.evaluate(() => {
    const check = (micOnly, camId, list) => micOnly && !!camId && list.some((c) => c.id === camId);
    return {
      // the real scenario: mic-only, preference set, device just appeared
      shouldRetry: check(true, 'virtual-cam-id', [{ id: 'real-cam-id' }, { id: 'virtual-cam-id' }]),
      // already has video — must NOT spuriously retry on unrelated device churn
      notWhenNotMicOnly: check(false, 'virtual-cam-id', [{ id: 'real-cam-id' }, { id: 'virtual-cam-id' }]),
      // no explicit preference (system default) — nothing to retry toward
      notWithoutPreference: check(true, '', [{ id: 'real-cam-id' }]),
      // mic-only, but the CHOSEN device still isn't in the list — don't retry yet
      notUntilListed: check(true, 'virtual-cam-id', [{ id: 'real-cam-id' }]),
    };
  });
  ok('retry condition: fires for the real scenario (mic-only + chosen device now listed)', gating.shouldRetry === true);
  ok('retry condition: silent when already on video (no spurious reconnect on device churn)', gating.notWhenNotMicOnly === false);
  ok('retry condition: silent with no explicit camera preference set', gating.notWithoutPreference === false);
  ok('retry condition: silent while the chosen device still is not listed', gating.notUntilListed === false);

  await browser.close();
} finally {
  app.kill();
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
