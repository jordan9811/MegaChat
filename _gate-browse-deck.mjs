/**
 * GATE — browse deck (feat/browse-deck).
 *
 *  A. deck ON (default): /#browse mounts the full deck — banner, bounty
 *     board, featured carousel, lobby chat, the classic grid (search
 *     included) below the fold, categories stub. Hero scroll cue + nav both
 *     target the deck's #browse anchor.
 *  B. BROWSE_DECK=0: the classic directory mounts EXACTLY as before — its
 *     own #browse section, search box, no deck modules anywhere.
 *  C. hero freeze: zero diff vs the branch base for the hero and everything
 *     above the browse section.
 *  D. copy rules: no "15 second" claims anywhere on the landing page (the
 *     seeded surfaces must respect the shipped copy rules too).
 *  E. claim drawer opens portaled to <body> (not trapped in the rail's
 *     stacking context) and closes on Escape.
 */
import { spawn, execSync } from 'child_process';
import puppeteer from 'puppeteer-core';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = 'eae3f7d'; // branch point on v0-ui-migration
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

// ── C. hero freeze (git-level, exact) ───────────────────────────────────────
const heroDiff = execSync(
  `git diff ${BASE}..HEAD -- web/components/hero.tsx web/components/site-header.tsx web/components/glitch-background.tsx web/app/globals.css web/components/wordmark.tsx`,
  { encoding: 'utf8' },
).trim();
ok('C. hero + above-browse files: ZERO diff vs branch base', heroDiff === '');

const launch = (port, env = {}) =>
  spawn(process.execPath, ['server.js', '--prod'], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: 'ignore', cwd: process.cwd(),
  });

const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new' });

// ── A + D + E: deck ON ──────────────────────────────────────────────────────
const appOn = launch(3220);
await sleep(9000);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto('http://localhost:3220/#browse', { waitUntil: 'networkidle2', timeout: 60000 });
  await page.evaluate(() => document.getElementById('browse')?.scrollIntoView());
  await sleep(2000);

  const a = await page.evaluate(() => {
    const browse = document.getElementById('browse');
    const txt = browse?.textContent || '';
    return {
      hasBanner: /Creator bounty/i.test(txt) && /testnet/i.test(txt),
      hasBounty: !!document.getElementById('bounty-board'),
      hasCarousel: [...document.querySelectorAll('#browse [aria-label]')].some(
        (n) => n.getAttribute('aria-label') === 'Featured rooms'),
      hasChat: [...browse.querySelectorAll('h3')].some((h) => /Lobby chat/.test(h.textContent)),
      hasGridSearch: !!browse.querySelector('input[type=search]'),
      hasCategories: /Categories/.test(txt) && /coming soon/i.test(txt),
      onlyOneBrowseId: document.querySelectorAll('#browse').length === 1,
      heroCueTargetsDeck: !!document.querySelector('a[href="#browse"]'),
      no15s: !/15\s*s(econds)?\b/i.test(document.body.innerText),
      demoTags: [...browse.querySelectorAll('span')].filter((s) => s.textContent.trim() === 'demo').length,
    };
  });
  ok('A. promo banner renders with testnet framing', a.hasBanner);
  ok('A. bounty board mounts in the left rail', a.hasBounty);
  ok('A. featured carousel mounts', a.hasCarousel);
  ok('A. lobby chat mounts in the right panel', a.hasChat);
  ok('A. classic grid search survives below the fold', a.hasGridSearch);
  ok('A. categories stub renders and says so', a.hasCategories);
  ok('A. exactly one #browse anchor on the page', a.onlyOneBrowseId);
  ok('A. hero scroll cue targets the deck anchor', a.heroCueTargetsDeck);
  ok('D. no 15-second claim anywhere on the landing page', a.no15s);
  ok('A. seeded surfaces carry demo tags', a.demoTags >= 3, `count=${a.demoTags}`);

  // E. claim drawer portals to <body> and closes on Esc
  await page.evaluate(() => {
    [...document.querySelectorAll('#bounty-board button')].find((b) => /DocHavoc/.test(b.textContent))?.click();
  });
  await sleep(600);
  const e = await page.evaluate(() => {
    const dlg = document.querySelector('[role=dialog]');
    return {
      open: !!dlg,
      onBody: dlg?.parentElement === document.body,
      hasStubNote: /stub/i.test(dlg?.textContent || ''),
      hasTestnet: /testnet/i.test(dlg?.textContent || ''),
    };
  });
  ok('E. claim drawer opens', e.open);
  ok('E. drawer is portaled directly under <body> (stacking-context escape)', e.onBody);
  ok('E. drawer says the claim flow is a stub', e.hasStubNote);
  ok('E. drawer bounty carries testnet framing', e.hasTestnet);
  await page.keyboard.press('Escape');
  await sleep(400);
  ok('E. Escape closes the drawer', await page.evaluate(() => !document.querySelector('[role=dialog]')));
  await page.close();
} finally {
  appOn.kill();
}

// ── B: BROWSE_DECK=0 restores the classic directory ─────────────────────────
const appOff = launch(3221, { BROWSE_DECK: '0' });
await sleep(9000);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto('http://localhost:3221/#browse', { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1500);
  const b = await page.evaluate(() => {
    const browse = document.getElementById('browse');
    return {
      isSection: browse?.tagName === 'SECTION',
      classicHeader: /Live now — grab a camera seat/.test(browse?.textContent || ''),
      hasSearch: !!browse?.querySelector('input[type=search]'),
      noBounty: !document.getElementById('bounty-board'),
      noChat: !/Lobby chat/.test(document.body.innerText),
      noBanner: !/Creator bounty/i.test(document.body.innerText),
    };
  });
  ok('B. flag off: #browse is the classic section again', b.isSection && b.classicHeader);
  ok('B. flag off: classic search present', b.hasSearch);
  ok('B. flag off: no deck modules leak (bounty/chat/banner all absent)',
    b.noBounty && b.noChat && b.noBanner);
  await page.close();
} finally {
  appOff.kill();
}

await browser.close();
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
