/**
 * VERIFY — connected Twitch is adopted by default and is VISIBLE.
 *
 * The complaint: "twitch login still buried in advanced settings, if im
 * connected w twitch it should be prefilled by default and used as thumbnail
 * ... unless i opt out."
 */
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHmac } from 'crypto';
import puppeteer from 'puppeteer-core';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3280;
const APP = `http://localhost:${PORT}`;
const AUTH_SECRET = 'twitch-prefill-secret';

const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-twitch-'));
writeFileSync(path.join(dataDir, 'identities.json'), JSON.stringify({
  identities: {
    'twitch:tp1': {
      provider: 'twitch', platformId: 'tp1', username: 'wwse',
      handle: 'wwse', createdAt: new Date().toISOString(),
    },
  },
  handles: { wwse: 'twitch:tp1' },
}));
const seal = (o) => {
  const p = Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${p}.${createHmac('sha256', AUTH_SECRET).update(p).digest('base64url')}`;
};
const cookie = {
  name: 'mc_identity',
  value: encodeURIComponent(seal({ provider: 'twitch', platformId: 'tp1' })),
  domain: 'localhost', path: '/',
};

const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: { ...process.env, PORT: String(PORT), AUTH_SECRET, DATA_DIR: dataDir, KEEP_ORPHAN_ROOMS: 'true' },
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
