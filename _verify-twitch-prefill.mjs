/**
 * VERIFY — connected Twitch is adopted by default and is VISIBLE.
 *
 * The complaint: "twitch login still buried in advanced settings, if im
 * connected w twitch it should be prefilled by default and used as thumbnail
 * ... unless i opt out."
 */
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';
import { assertFreshBuild } from './_gate-helpers.mjs';
import { sealSessionValue, seedAccountForLink } from './_gate-identity-helper.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
// ── G0. the build under test must not predate the source ──────────────────
// server.js --prod serves web/.next exactly as it sits on disk: an older build
// means this grades the PREVIOUS tree and reports it as current ("A browser
// gate is only as fresh as the last build", CLAUDE.md). Before anything boots.
{
  const fresh = assertFreshBuild();
  ok('G0. the build under test is newer than the source it renders', fresh.ok, fresh.detail);
  if (!fresh.ok) {
    console.log('\n  refusing to grade a stale build — rebuild and re-run.');
    console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
    process.exit(1);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3280;
const APP = `http://localhost:${PORT}`;
const AUTH_SECRET = 'twitch-prefill-secret';

// The account seeded before the server starts, and its session in the one
// shape auth.js accepts. This seeded identities.json until 2026-10-24, which
// no server has read since the account layer.
const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-twitch-'));
const cookie = {
  name: 'mc_identity',
  value: encodeURIComponent(sealSessionValue(
    seedAccountForLink(dataDir, { provider: 'twitch', platformId: 'tp1', username: 'wwse' }),
    { secret: AUTH_SECRET })),
  domain: 'localhost', path: '/',
};

const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: { ...process.env, PORT: String(PORT), AUTH_SECRET, DATA_DIR: dataDir, KEEP_ORPHAN_ROOMS: 'true', LIVEKIT_URL: '' },
  stdio: 'ignore', cwd: process.cwd(),
});
await sleep(10000);

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1400 });
  await page.setCookie(cookie);
  await page.goto(`${APP}/dashboard`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(4000);

  const linked = await page.evaluate(() => fetch('/api/account/linked').then((r) => r.json()));
  ok('linked Twitch account is visible to the app', linked.accounts?.[0]?.name === 'wwse',
    JSON.stringify(linked.accounts));

  const row = await page.evaluate(() => {
    const el = document.getElementById('twitch-auto');
    if (!el) return { present: false };
    const label = el.closest('label');
    const adv = !!el.closest('details');
    return {
      present: true, checked: el.checked, inAdvanced: adv,
      text: (label?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    };
  });
  ok('the connected-Twitch row RENDERS', row.present === true);
  ok('it is ON by default (adopted without being asked)', row.checked === true);
  ok('it is NOT buried in Advanced', row.inAdvanced === false);
  ok('it names the channel and says what it powers',
    /wwse/i.test(row.text) && /thumbnail/i.test(row.text) && /join page/i.test(row.text),
    row.text);

  const prefill = await page.evaluate(() => {
    const i = document.getElementById('twitch-channel');
    return i ? i.value : null;
  });
  ok('the Advanced channel field is PREFILLED with the linked account',
    prefill === 'wwse', String(prefill));

  // Opt out → clears the channel too, so there is no half-state.
  await page.click('#twitch-auto');
  await sleep(600);
  const afterOptOut = await page.evaluate(() => ({
    checked: document.getElementById('twitch-auto')?.checked,
    channel: document.getElementById('twitch-channel')?.value,
    text: (document.getElementById('twitch-auto')?.closest('label')?.innerText || '')
      .replace(/\s+/g, ' ').trim().slice(0, 120),
  }));
  ok('opting out unchecks and CLEARS the channel (no half-state)',
    afterOptOut.checked === false && afterOptOut.channel === '',
    `checked=${afterOptOut.checked} channel="${afterOptOut.channel}"`);
  ok('opted-out copy states the consequence',
    /won't show/i.test(afterOptOut.text), afterOptOut.text);

  // Opt back in → restores.
  await page.click('#twitch-auto');
  await sleep(600);
  const back = await page.evaluate(() => ({
    checked: document.getElementById('twitch-auto')?.checked,
    channel: document.getElementById('twitch-channel')?.value,
  }));
  ok('opting back in restores the channel', back.checked === true && back.channel === 'wwse',
    JSON.stringify(back));

  await page.screenshot({ path: 'screens/twitch-prefill.png' });
  console.log('  [shot] screens/twitch-prefill.png');
} finally {
  await browser.close();
  app.kill();
}
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
