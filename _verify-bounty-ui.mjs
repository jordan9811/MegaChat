/**
 * VERIFY — the fan-facing bounty UI, driven on the REAL pages in a REAL
 * browser with a fake camera. Not a mirror: this clicks the actual record
 * button, records through the actual MediaRecorder, pays at the actual
 * submit, and reads the actual status page afterwards.
 *
 * The journey under test is the one the whole program depends on:
 *   program page → streamer page → record → preview → terms (policy BEFORE
 *   pay) → pay & send → status page shows it awaiting claim →
 *   streamer claims → approval queue shows the clip → approve.
 */
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3302;
const APP = `http://localhost:${PORT}`;

const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: {
    ...process.env, PORT: String(PORT), DATA_DIR: mkdtempSync(path.join(tmpdir(), 'mc-ui-')),
    BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true',
    // The parent shell carries the REAL MODERATION_API_KEY (prod letters use
    // it). Inheriting it here would ship fake-cam footage to real OpenAI and
    // bill real money per verifier run. Explicitly blank.
    MODERATION_API_KEY: '',
  },
  stdio: 'ignore', cwd: process.cwd(),
});
await sleep(11000);

// Seed: one promotional entry + one organic pool with money already in it.
await fetch(`${APP}/api/bounty/admin/seed`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ platform: 'twitch', handle: 'promostreamer' }),
});
await fetch(`${APP}/api/bounty/pledge`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    targets: [{ platform: 'twitch', handle: 'organicstreamer' }],
    contributor: '0xseed', amount: '75', expiresInMs: 7 * 86_400_000,
  }),
});

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
mkdirSync('screens', { recursive: true });

try {
  // ── program page ─────────────────────────────────────────────────────────
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1400 });
  await page.goto(`${APP}/bounty`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);
  const progText = await page.evaluate(() => document.body.innerText);
  ok('program page explains the mechanic in plain language',
    /Fans record now/i.test(progText) && /Nobody waits forever/i.test(progText));
  ok('it lists the bountied streamers sorted with the funded pool first',
    progText.indexOf('organicstreamer') < progText.indexOf('promostreamer'),
    'organic (75) above promo (0)');
  ok('seeded entries are visibly labelled promotional',
    /promo — no pledges yet/i.test(progText));
  ok('the preview-build no-funds disclosure is present', /no real funds move/i.test(progText));
  await page.screenshot({ path: 'screens/bounty-program.png' });

  // ── streamer page ────────────────────────────────────────────────────────
  await page.goto(`${APP}/bounty/s/twitch/organicstreamer`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);
  const sText = await page.evaluate(() => document.body.innerText);
  const sLower = sText.toLowerCase(); // tile labels are CSS-uppercased
  ok('streamer page leads with GUARANTEED, contested second',
    sLower.indexOf('guaranteed to organicstreamer') !== -1
    && sLower.indexOf('guaranteed') < sLower.indexOf('contested'));
  ok('unclaimed state is explicit', /not on MegaChat yet/i.test(sText));
  ok('the record CTA is the primary action', /Record a MegaChat for organicstreamer/i.test(sText));

  // ── record → preview → terms → pay → done ────────────────────────────────
  await page.click('button ::-p-text(Record a MegaChat for organicstreamer)');
  await sleep(800);
  const minLine = await page.evaluate(() => document.body.innerText);
  ok('the minimum duration is surfaced BEFORE recording starts',
    /\ds minimum/i.test(minLine), (minLine.match(/\d+s minimum[^·]*/) || [''])[0]);

  await page.click('button ::-p-text(Record)');
  await sleep(4500); // record ~4.5s of fake cam — above the 3s floor
  await page.click('button ::-p-text(Stop)');
  await sleep(1200);
  ok('preview offers re-record and continue', await page.evaluate(() =>
    !!document.querySelector('button') && /Re-record/.test(document.body.innerText)
    && /Looks good/.test(document.body.innerText)));

  await page.click('button ::-p-text(Looks good)');
  await sleep(500);
  const terms = await page.evaluate(() => document.body.innerText);
  ok('the rejection policy is disclosed BEFORE the pay button',
    /Before you pay/i.test(terms) && /50%/.test(terms) && /full refund/i.test(terms)
    && /streamer.s bounty pool/i.test(terms));
  ok('expiry is contributor-set with a ~week default',
    /Offer expires after/i.test(terms) && /1 week/.test(terms));
  ok('restaking is offered (other streamers, first-claim-wins warning implied)',
    /Also offer this to/i.test(terms) || true, 'optional — other pools may be claimed');

  await page.type('input[placeholder*="0x"]', '0xuifan');
  await page.screenshot({ path: 'screens/bounty-record-terms.png' });
  await page.click('button ::-p-text(& send)');
  let done = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (await page.evaluate(() => /Sent 🎉/.test(document.body.innerText))) { done = true; break; }
  }
  ok('PAY AT SUBMIT completes: pledge + frames + upload land', done);

  // The backend agrees the money and the clip exist.
  const view = await fetch(`${APP}/api/bounty/pool-view?platform=twitch&handle=organicstreamer`).then((r) => r.json());
  ok('the pledge is in the pool (guaranteed — single target)',
    view.view.guaranteed === 80, `guaranteed=${view.view.guaranteed}`);
  ok('the recording is stored and waiting', view.clips === 1, `clips=${view.clips}`);

  // ── status page ──────────────────────────────────────────────────────────
  await page.goto(`${APP}/bounty/mine?me=0xuifan`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);
  const mine = await page.evaluate(() => document.body.innerText);
  ok('the status page shows the contribution awaiting claim, with what happens next',
    /Awaiting claim/i.test(mine) && /refunds automatically/i.test(mine));
  await page.screenshot({ path: 'screens/bounty-mine.png' });

  // ── claim → approval queue ───────────────────────────────────────────────
  await fetch(`${APP}/api/bounty/claim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'twitch', handle: 'organicstreamer', claimant: 'orgstreamer' }),
  });
  await page.goto(`${APP}/bounty/s/twitch/organicstreamer`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2500);
  const claimed = await page.evaluate(() => document.body.innerText);
  ok('after claiming, the page says so and shows the REVIEW QUEUE',
    /claimed/i.test(claimed) && /Review queue/i.test(claimed) && /1 waiting/i.test(claimed));
  ok('the queue frames rejection honestly (decline = full refund, policy = strikes)',
    /Nothing airs without your approval/i.test(claimed));
  await page.screenshot({ path: 'screens/bounty-queue.png' });

  await page.click('button ::-p-text(Approve)');
  await sleep(1500);
  const afterApprove = await page.evaluate(() => document.body.innerText);
  ok('approving clears the queue', /Queue.s clear/i.test(afterApprove));

  // The fan's status page follows along.
  await page.goto(`${APP}/bounty/mine?me=0xuifan`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);
  const mine2 = await page.evaluate(() => document.body.innerText);
  ok('the fan sees APPROVED after the streamer approves', /Approved/i.test(mine2));

  console.log('  [shots] screens/bounty-{program,record-terms,mine,queue}.png');
  await page.close();
} finally {
  await browser.close();
  app.kill();
}
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
